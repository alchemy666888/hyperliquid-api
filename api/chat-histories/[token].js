import '../../lib/telegram-log-forwarder.js';
import { timingSafeEqual } from 'node:crypto';
import {
  getPostgresStatus,
  listTelegramChatHistories,
} from '../../lib/postgres.js';

const DEFAULT_CHAT_LIMIT = 50;
const MAX_CHAT_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function pathToken(req) {
  return String(firstQueryValue(req.query?.token) ?? '').trim();
}

export function authorizeChatHistoryRequest(req, env = process.env) {
  const expectedToken = readEnv(env, 'CHAT_HISTORY_API_TOKEN');
  if (!expectedToken) {
    return {
      ok: false,
      statusCode: 503,
      error: 'CHAT_HISTORY_API_TOKEN is required before chat history can be exposed.',
    };
  }

  const token = pathToken(req);
  if (!token || !safeEqual(token, expectedToken)) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: invalid chat history API token.',
    };
  }

  return { ok: true };
}

export function parsePositiveIntQuery(value, {
  name,
  defaultValue,
  max,
} = {}) {
  const raw = firstQueryValue(value);
  if (raw == null || raw === '') return defaultValue;

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== String(raw).trim()) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return Math.min(parsed, max);
}

function requestOptions(req) {
  const chatLimit = parsePositiveIntQuery(req.query?.limit ?? req.query?.chatLimit, {
    name: 'limit',
    defaultValue: DEFAULT_CHAT_LIMIT,
    max: MAX_CHAT_LIMIT,
  });
  const historyLimit = parsePositiveIntQuery(req.query?.historyLimit ?? req.query?.messagesPerChat, {
    name: 'historyLimit',
    defaultValue: DEFAULT_HISTORY_LIMIT,
    max: MAX_HISTORY_LIMIT,
  });

  return { chatLimit, historyLimit };
}

export function createChatHistoriesHandler({
  env = process.env,
  getStatus = getPostgresStatus,
  listHistories = listTelegramChatHistories,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const auth = authorizeChatHistoryRequest(req, env);
    if (!auth.ok) {
      res.status(auth.statusCode).json({
        error: auth.error,
        status: 'error',
      });
      return;
    }

    const postgresStatus = getStatus();
    if (!postgresStatus.configured) {
      res.status(503).json({
        error: 'PostgreSQL persistence is not configured',
        persistence: postgresStatus,
        status: 'error',
      });
      return;
    }

    let options;
    try {
      options = requestOptions(req);
    } catch (error) {
      res.status(400).json({
        error: error.message,
        status: 'error',
      });
      return;
    }

    try {
      const chatHistories = await listHistories(options);
      if (!chatHistories) {
        res.status(503).json({
          error: 'PostgreSQL persistence is not configured',
          persistence: getStatus(),
          status: 'error',
        });
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        status: 'ok',
        relatedChatIds: chatHistories.map(chat => chat.chatId),
        chatHistories,
        limits: options,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('chat histories api error:', error);
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString(),
        status: 'error',
      });
    }
  };
}

export default createChatHistoriesHandler();

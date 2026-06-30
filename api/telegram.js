import { ASSETS, getHyperliquidSnapshot } from '../lib/hyperliquid.js';
import {
  clearDecisionTreeAlerts,
  getPostgresStatus,
  listDecisionTreeAlerts,
  saveDecisionTreeAlerts,
} from '../lib/postgres.js';
import {
  normalizeAlertSymbol,
  parseDecisionTreeAlertText,
} from '../lib/decision-tree-alerts.js';
import { sendTelegramMessage } from '../lib/telegram-client.js';
import { timingSafeEqual } from 'node:crypto';

function getHeader(req, name) {
  const key = name.toLowerCase();
  return req.headers?.[key] ?? req.headers?.[name];
}

function parseUpdateBody(req) {
  if (typeof req.body === 'string') {
    return JSON.parse(req.body);
  }
  return req.body ?? {};
}

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseCommand(text) {
  const [, rawCommand = '', body = ''] = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  const command = rawCommand.split('@')[0].toLowerCase();
  const args = body.trim() ? body.trim().split(/\s+/) : [];
  return { command, args, body: body.trim() };
}

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const num = Number(value);
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function htmlMessage(text) {
  return { text, parseMode: 'HTML' };
}

function normalizeReply(reply) {
  if (typeof reply === 'string') {
    return { text: reply };
  }

  return {
    text: String(reply?.text ?? ''),
    parseMode: reply?.parseMode,
  };
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatAlertExpiry(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function formatRegime(regime) {
  return regime ? regime.replaceAll('_', ' ') : 'UNKNOWN';
}

function normalizeSymbol(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function findAsset(snapshot, input) {
  const symbol = normalizeSymbol(input);
  return snapshot.assets.find(asset => {
    const label = normalizeSymbol(asset.symbol);
    const coin = normalizeSymbol(asset.coin.replace('xyz:', ''));
    const base = label.endsWith('USDT') ? label.slice(0, -4) : label;
    return symbol === label || symbol === coin || symbol === base;
  });
}

function helpMessage() {
  return [
    'Hyperliquid Market Bot',
    '',
    'Commands:',
    '/prices - show all tracked prices and regimes',
    '/asset BTCUSDT - show 4H indicators for one asset',
    '/treealert - save pasted decision-tree alerts',
    '/alerts - list active decision-tree alerts',
    '/clearalerts [MU] - manually cancel active decision-tree alerts',
    '/help - show this help',
    '',
    'Decision-tree setup:',
    '/treealert',
    'MU above $1,164 and holds?',
    '-> Long toward $1,198',
    '',
    'Alerts expire after 24 hours unless manually cancelled with /clearalerts.',
    '',
    `Tracked assets: ${ASSETS.map(asset => asset.label).join(', ')}`,
  ].join('\n');
}

function pricesMessage(snapshot) {
  const lines = snapshot.assets.map(asset =>
    `${asset.symbol}: ${formatNumber(asset.price)} - ${formatRegime(asset.regime)}`
  );

  return [
    `Hyperliquid prices (${snapshot.interval})`,
    `Updated: ${snapshot.timestamp}`,
    '',
    ...lines,
  ].join('\n');
}

function assetMessage(asset, snapshot) {
  const indicators = asset.indicators ?? {};
  const macd = indicators.macd ?? {};

  return [
    `${asset.symbol} (${snapshot.interval})`,
    `Updated: ${snapshot.timestamp}`,
    '',
    `Price: ${formatNumber(asset.price)}`,
    `Regime: ${formatRegime(asset.regime)}`,
    `RSI 14: ${formatNumber(indicators.rsi14)}`,
    `ADX 14: ${formatNumber(indicators.adx14)}`,
    `EMA 20 / 50: ${formatNumber(indicators.ema20)} / ${formatNumber(indicators.ema50)}`,
    `MACD hist: ${formatNumber(macd.histogram)} (${macd.histogramDirection ?? 'n/a'})`,
    `ATR 14: ${formatNumber(indicators.atr14)}`,
    `Volume spike: ${formatNumber(indicators.volumeSpikeRatio)}x`,
    `Candles used: ${asset.candlesUsed ?? 0}`,
  ].join('\n');
}

function treeAlertUsage() {
  return [
    'Usage:',
    '/treealert',
    'MU above $1,164 and holds?',
    '-> Long toward $1,198',
    '',
    'Supported conditions: above, below/closes below, between, holds/rejects with a price range.',
    'Alerts expire after 24 hours or when cancelled with /clearalerts.',
  ].join('\n');
}

function postgresRequiredMessage() {
  const status = getPostgresStatus();
  const missing = status.missing?.length ? ` Missing: ${status.missing.join(', ')}` : '';
  return `Decision-tree alerts require PostgreSQL persistence to be configured.${missing}`;
}

function savedAlertsMessage(alerts) {
  const symbols = [...new Set(alerts.map(alert => alert.symbol))].join(', ');
  const header = `Saved ${alerts.length} decision-tree alert${alerts.length === 1 ? '' : 's'} for ${symbols}.`;
  return htmlMessage([
    `<b>${escapeTelegramHtml(header)}</b>`,
    'Alerts fire every 10-minute market refresh when a condition moves from inactive to active.',
    'They expire after 24 hours unless manually cancelled with /clearalerts.',
    '',
    ...alerts.map(formatRichDecisionTreeRule),
  ].join('\n\n'));
}

function formatRichDecisionTreeRule(alert) {
  const id = alert.id ? `#${alert.id}` : 'Alert';
  return [
    `<b>${escapeTelegramHtml(id)} ${escapeTelegramHtml(alert.symbol)}</b>`,
    `Condition: <code>${escapeTelegramHtml(alert.conditionText)}</code>`,
    `Action: ${escapeTelegramHtml(alert.actionText)}`,
    `Expires: <code>${escapeTelegramHtml(formatAlertExpiry(alert.expiresAt))}</code>`,
  ].join('\n');
}

function listAlertsMessage(alerts) {
  if (!alerts?.length) {
    return 'No active decision-tree alerts for this chat.';
  }

  return htmlMessage([
    '<b>Active decision-tree alerts</b>',
    '<i>Expire after 24 hours unless cancelled with /clearalerts.</i>',
    '',
    ...alerts.map(formatRichDecisionTreeRule),
  ].join('\n\n'));
}

async function setupTreeAlerts(body, chatId) {
  if (!body) return treeAlertUsage();
  if (!getPostgresStatus().configured) return postgresRequiredMessage();

  const parsed = parseDecisionTreeAlertText(body, { assets: ASSETS });
  if (parsed.errors.length) {
    return [
      'Could not save decision-tree alerts:',
      ...parsed.errors.map(error => `- ${error}`),
      '',
      treeAlertUsage(),
    ].join('\n');
  }

  if (!parsed.rules.length) return treeAlertUsage();

  const alerts = await saveDecisionTreeAlerts({
    chatId,
    rawTree: body,
    rules: parsed.rules,
  });

  if (!alerts) return postgresRequiredMessage();
  return savedAlertsMessage(alerts);
}

async function listTreeAlerts(chatId) {
  if (!getPostgresStatus().configured) return postgresRequiredMessage();
  const alerts = await listDecisionTreeAlerts(chatId);
  if (!alerts) return postgresRequiredMessage();
  return listAlertsMessage(alerts);
}

async function clearTreeAlerts(chatId, symbolInput) {
  if (!getPostgresStatus().configured) return postgresRequiredMessage();
  const input = symbolInput ? normalizeAlertSymbol(symbolInput) : '';
  const asset = input
    ? ASSETS.find(item => {
      const label = normalizeAlertSymbol(item.label);
      const coin = normalizeAlertSymbol(String(item.coin).replace('xyz:', ''));
      const base = label.endsWith('USDT') ? label.slice(0, -4) : label;
      return input === label || input === coin || input === base;
    })
    : null;
  const symbol = asset?.label ?? input;
  const cleared = await clearDecisionTreeAlerts(chatId, symbol);
  if (cleared == null) return postgresRequiredMessage();
  const scope = symbol ? ` for ${symbol}` : '';
  return `Cleared ${cleared} active decision-tree alert${cleared === 1 ? '' : 's'}${scope}.`;
}

async function buildReply(text, chatId) {
  const { command, args, body } = parseCommand(text);

  if (command === '/start' || command === '/help') {
    return helpMessage();
  }

  if (command === '/prices') {
    const snapshot = await getHyperliquidSnapshot();
    return pricesMessage(snapshot);
  }

  if (command === '/asset') {
    if (!args.length) {
      return 'Usage: /asset BTCUSDT';
    }

    const snapshot = await getHyperliquidSnapshot();
    const asset = findAsset(snapshot, args[0]);
    if (!asset) {
      return `Unknown asset "${args[0]}". Tracked assets: ${ASSETS.map(item => item.label).join(', ')}`;
    }

    return assetMessage(asset, snapshot);
  }

  if (command === '/treealert' || command === '/decisiontree') {
    return setupTreeAlerts(body, chatId);
  }

  if (command === '/alerts') {
    return listTreeAlerts(chatId);
  }

  if (command === '/clearalerts') {
    return clearTreeAlerts(chatId, args[0]);
  }

  return helpMessage();
}

export default async function handler(req, res) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const expectedSecret = readEnv('TELEGRAM_SECRET_TOKEN');

  if (req.method === 'GET') {
    res.status(200).json({
      status: 'ok',
      service: 'telegram-webhook',
      vercelEnv: process.env.VERCEL_ENV ?? 'unknown',
      config: {
        botTokenConfigured: Boolean(token),
        secretTokenConfigured: Boolean(expectedSecret),
        postgres: getPostgresStatus(),
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (expectedSecret) {
    const providedSecret = getHeader(req, 'x-telegram-bot-api-secret-token');
    if (!providedSecret || !safeEqual(String(providedSecret), expectedSecret)) {
      res.status(401).json({ error: 'Unauthorized: invalid webhook secret token' });
      return;
    }
  }

  if (!token) {
    console.error('Missing TELEGRAM_BOT_TOKEN in environment');
    res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN in environment' });
    return;
  }

  try {
    const update = parseUpdateBody(req);
    const message = update.message ?? update.edited_message;
    const chatId = message?.chat?.id;
    const text = message?.text;

    if (!chatId || !text) {
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const reply = normalizeReply(await buildReply(text, chatId));
    await sendTelegramMessage(token, chatId, reply.text, { parseMode: reply.parseMode });
    res.status(200).json({ status: 'sent' });
  } catch (error) {
    console.error('telegram handler error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'error',
    });
  }
}

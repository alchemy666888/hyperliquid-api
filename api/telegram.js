import { ASSETS, getHyperliquidSnapshot } from '../lib/hyperliquid.js';
import { getPostgresStatus } from '../lib/postgres.js';
import { timingSafeEqual } from 'node:crypto';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

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
  const [rawCommand = '', ...args] = text.trim().split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  return { command, args };
}

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const num = Number(value);
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 6 });
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
    '/help - show this help',
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

async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage HTTP ${response.status}: ${body}`);
  }
}

async function buildReply(text) {
  const { command, args } = parseCommand(text);

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

    const reply = await buildReply(text);
    await sendTelegramMessage(token, chatId, reply);
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

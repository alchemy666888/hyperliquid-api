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
import {
  escapeTelegramHtml,
  formatTelegramDate,
  htmlMessage,
} from '../lib/telegram-format.js';
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

function normalizeReply(reply) {
  if (typeof reply === 'string') {
    return htmlMessage(escapeTelegramHtml(reply));
  }

  return {
    text: String(reply?.text ?? ''),
    parseMode: reply?.parseMode,
  };
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
  return htmlMessage([
    '<b>Hyperliquid Market Bot</b>',
    '',
    '<b>Commands</b>',
    '<code>/prices</code> - show all tracked prices and regimes',
    '<code>/asset BTCUSDT</code> - show 4H indicators for one asset',
    '<code>/treealert</code> - save pasted decision-tree alerts',
    '<code>/alerts</code> - list active decision-tree alerts',
    '<code>/clearalerts [MU]</code> - manually cancel active decision-tree alerts',
    '<code>/help</code> - show this help',
    '',
    '<b>Decision-tree setup</b>',
    '<code>/treealert</code>',
    '<code>MU above $1,164 and holds?</code>',
    '<code>-&gt; Long toward $1,198</code>',
    '',
    '<i>Alerts expire after 24 hours unless manually cancelled with /clearalerts.</i>',
    '',
    `<b>Tracked assets:</b> ${escapeTelegramHtml(ASSETS.map(asset => asset.label).join(', '))}`,
  ].join('\n'));
}

function pricesMessage(snapshot) {
  const lines = snapshot.assets.map(asset =>
    `<code>${escapeTelegramHtml(asset.symbol)}</code> ${escapeTelegramHtml(formatNumber(asset.price))} - ${escapeTelegramHtml(formatRegime(asset.regime))}`
  );

  return htmlMessage([
    `<b>Hyperliquid prices (${escapeTelegramHtml(snapshot.interval)})</b>`,
    `<i>Updated: ${escapeTelegramHtml(formatTelegramDate(snapshot.timestamp))}</i>`,
    '',
    ...lines,
  ].join('\n'));
}

function assetMessage(asset, snapshot) {
  const indicators = asset.indicators ?? {};
  const macd = indicators.macd ?? {};

  return htmlMessage([
    `<b>${escapeTelegramHtml(asset.symbol)} (${escapeTelegramHtml(snapshot.interval)})</b>`,
    `<i>Updated: ${escapeTelegramHtml(formatTelegramDate(snapshot.timestamp))}</i>`,
    '',
    `<b>Price:</b> ${escapeTelegramHtml(formatNumber(asset.price))}`,
    `<b>Regime:</b> ${escapeTelegramHtml(formatRegime(asset.regime))}`,
    `<b>RSI 14:</b> ${escapeTelegramHtml(formatNumber(indicators.rsi14))}`,
    `<b>ADX 14:</b> ${escapeTelegramHtml(formatNumber(indicators.adx14))}`,
    `<b>EMA 20 / 50:</b> ${escapeTelegramHtml(formatNumber(indicators.ema20))} / ${escapeTelegramHtml(formatNumber(indicators.ema50))}`,
    `<b>MACD hist:</b> ${escapeTelegramHtml(formatNumber(macd.histogram))} (${escapeTelegramHtml(macd.histogramDirection ?? 'n/a')})`,
    `<b>ATR 14:</b> ${escapeTelegramHtml(formatNumber(indicators.atr14))}`,
    `<b>Volume spike:</b> ${escapeTelegramHtml(formatNumber(indicators.volumeSpikeRatio))}x`,
    `<b>Candles used:</b> ${escapeTelegramHtml(asset.candlesUsed ?? 0)}`,
  ].join('\n'));
}

function treeAlertUsage() {
  return htmlMessage([
    '<b>Usage</b>',
    '<code>/treealert</code>',
    '<code>MU above $1,164 and holds?</code>',
    '<code>-&gt; Long toward $1,198</code>',
    '',
    '<b>Supported conditions:</b> above, below/closes below, between, holds/rejects with a price range.',
    '<i>Alerts expire after 24 hours or when cancelled with /clearalerts.</i>',
  ].join('\n'));
}

function postgresRequiredMessage() {
  const status = getPostgresStatus();
  const missing = status.missing?.length ? ` Missing: ${status.missing.join(', ')}` : '';
  return htmlMessage([
    '<b>Decision-tree alerts require PostgreSQL persistence.</b>',
    missing ? escapeTelegramHtml(missing.trim()) : '',
  ].filter(Boolean).join('\n'));
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
    `Expires: <code>${escapeTelegramHtml(formatTelegramDate(alert.expiresAt))}</code>`,
  ].join('\n');
}

function listAlertsMessage(alerts) {
  if (!alerts?.length) {
    return htmlMessage('<b>No active decision-tree alerts for this chat.</b>');
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
    return htmlMessage([
      '<b>Could not save decision-tree alerts</b>',
      ...parsed.errors.map(error => `- ${escapeTelegramHtml(error)}`),
      '',
      treeAlertUsage().text,
    ].join('\n'));
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
  return htmlMessage([
    '<b>Decision-tree alerts cancelled</b>',
    escapeTelegramHtml(`Cleared ${cleared} active decision-tree alert${cleared === 1 ? '' : 's'}${scope}.`),
  ].join('\n'));
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
      return htmlMessage([
        `<b>Unknown asset:</b> <code>${escapeTelegramHtml(args[0])}</code>`,
        `<b>Tracked assets:</b> ${escapeTelegramHtml(ASSETS.map(item => item.label).join(', '))}`,
      ].join('\n'));
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

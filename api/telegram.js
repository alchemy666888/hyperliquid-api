import { ASSETS, getHyperliquidSnapshot } from '../lib/hyperliquid.js';
import {
  clearDecisionTreeAlerts,
  getPostgresStatus,
  getDecisionTreeAlertsForSymbol,
  listDecisionTreeAlerts,
  saveTelegramChatMessage,
  saveDecisionTreeAlerts,
} from '../lib/postgres.js';
import {
  normalizeAlertSymbol,
  parseDecisionTreeAlertTextWithAi,
} from '../lib/decision-tree-alerts.js';
import { classifyAssetDecisionTreeCondition } from '../lib/ai-decision-tree-alerts.js';
import { answerResearchChat, answerStatelessAiChat } from '../lib/conversational-ai.js';
import { getAiStatus } from '../lib/ai-client.js';
import { getSearchStatus } from '../lib/search.js';
import { sendTelegramMessage } from '../lib/telegram-client.js';
import {
  formatTelegramDate,
  telegramTableMessage,
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

const DEFAULT_TELEGRAM_BOT_USERNAME = 'trading_alchemist_bot';

function normalizeBotUsername(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
}

function getBotUsernames(botUsernameInput = '') {
  const configuredUsername = normalizeBotUsername(botUsernameInput);
  const fallbackUsername = normalizeBotUsername(DEFAULT_TELEGRAM_BOT_USERNAME);
  return new Set([configuredUsername || fallbackUsername].filter(Boolean));
}

function usernameMatchesBot(value, botUsernames) {
  return botUsernames.has(normalizeBotUsername(value));
}

function isGroupChat(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

function sliceTelegramEntity(text, entity) {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function isBotMentionEntity(text, entity, botUsernames) {
  if (entity?.type === 'mention') {
    return usernameMatchesBot(sliceTelegramEntity(text, entity), botUsernames);
  }

  if (entity?.type === 'text_mention') {
    return usernameMatchesBot(entity?.user?.username, botUsernames);
  }

  return false;
}

function isBotCommandEntity(text, entity, botUsernames) {
  if (entity?.type !== 'bot_command') return false;
  const command = sliceTelegramEntity(text, entity);
  const [, suffix = ''] = command.match(/^\/\S+@([^@\s]+)$/) ?? [];
  return usernameMatchesBot(suffix, botUsernames);
}

function removeTelegramEntity(text, entity) {
  const before = text.slice(0, entity.offset);
  const after = text.slice(entity.offset + entity.length);
  return `${before}${after}`.replace(/[ \t]{2,}/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBotMentionInText(text, botUsernames) {
  for (const username of botUsernames) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(username)}(?![A-Za-z0-9_])`, 'i');
    const match = pattern.exec(text);
    if (match) {
      return {
        offset: match.index + match[1].length,
        length: username.length + 1,
      };
    }
  }

  return null;
}

function isBotCommandText(text, botUsernames) {
  const [, suffix = ''] = text.trim().match(/^\/\S+@([^@\s]+)(?:\s|$)/) ?? [];
  return usernameMatchesBot(suffix, botUsernames);
}

export function getProcessableTelegramText(message, botUsernameInput = '') {
  const text = message?.text;
  if (typeof text !== 'string' || !text.trim()) return '';

  if (!isGroupChat(message?.chat)) return text;

  const botUsernames = getBotUsernames(botUsernameInput);
  const entities = message.entities ?? [];
  const mention = entities.find(entity => isBotMentionEntity(text, entity, botUsernames))
    ?? findBotMentionInText(text, botUsernames);
  if (mention) return removeTelegramEntity(text, mention);

  const command = entities.find(entity => isBotCommandEntity(text, entity, botUsernames));
  if (command || isBotCommandText(text, botUsernames)) return text;

  return '';
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

function isSlashCommand(text) {
  return text.trim().startsWith('/');
}

function telegramMessageType(text) {
  return isSlashCommand(text) ? 'command' : 'ai_chat';
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
    return telegramTableMessage('Hyperliquid Market Bot', [
      ['Message', reply],
    ]);
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
  return telegramTableMessage('Hyperliquid Market Bot', [
    ['Chat', 'Send a normal message to ask AI about the current market. No command needed.'],
    ['/prices', 'Show all tracked prices and regimes'],
    ['/asset BTCUSDT', 'Show 4H indicators for one asset'],
    ['/rsh BTC latest catalysts', 'Research fresh market/news context'],
    ['/treealert', 'AI-analyze and save pasted decision-tree alerts'],
    ['/condition MU', 'Classify current saved tree condition'],
    ['/alerts', 'List active decision-tree alerts'],
    ['/clearalerts [MU]', 'Manually cancel active decision-tree alerts'],
    ['/help', 'Show this help'],
    { separator: true },
    ['Setup', '/treealert | MU above $1,164 and holds? | -> Long toward $1,198'],
    ['Check', '/condition MU'],
    ['Expiry', 'Alerts expire after 24 hours unless manually cancelled with /clearalerts.'],
    ['AI memory', 'Chat history is saved when PostgreSQL is configured, but AI replies only use your current request.'],
    ['Assets', ASSETS.map(asset => asset.label).join(', ')],
  ]);
}

function pricesMessage(snapshot) {
  const lines = snapshot.assets.map(asset =>
    [asset.symbol, `${formatNumber(asset.price)} - ${formatRegime(asset.regime)}`]
  );

  return telegramTableMessage(`Hyperliquid prices (${snapshot.interval})`, [
    ['Updated', formatTelegramDate(snapshot.timestamp)],
    { separator: true },
    ...lines,
  ]);
}

function assetMessage(asset, snapshot) {
  const indicators = asset.indicators ?? {};
  const macd = indicators.macd ?? {};

  return telegramTableMessage(`${asset.symbol} (${snapshot.interval})`, [
    ['Updated', formatTelegramDate(snapshot.timestamp)],
    ['Price', formatNumber(asset.price)],
    ['Regime', formatRegime(asset.regime)],
    ['RSI 14', formatNumber(indicators.rsi14)],
    ['ADX 14', formatNumber(indicators.adx14)],
    ['EMA 20 / 50', `${formatNumber(indicators.ema20)} / ${formatNumber(indicators.ema50)}`],
    ['MACD hist', `${formatNumber(macd.histogram)} (${macd.histogramDirection ?? 'n/a'})`],
    ['ATR 14', formatNumber(indicators.atr14)],
    ['Volume spike', `${formatNumber(indicators.volumeSpikeRatio)}x`],
    ['Candles used', asset.candlesUsed ?? 0],
  ]);
}

function treeAlertUsage() {
  return telegramTableMessage('Decision-tree alert usage', [
    ['Command', '/treealert'],
    ['Condition', 'MU above $1,164 and holds?'],
    ['Action', '-> Long toward $1,198'],
    ['AI', 'Pasted content is analyzed before trigger-ready alerts are saved.'],
    ['Supported', 'above, below/closes below, between, holds/rejects with a price range'],
    ['Expiry', 'Alerts expire after 24 hours or when cancelled with /clearalerts.'],
  ]);
}

function postgresRequiredMessage() {
  const status = getPostgresStatus();
  const rows = [
    ['Status', 'Decision-tree alerts require PostgreSQL persistence.'],
  ];
  if (status.missing?.length) {
    rows.push(['Missing', status.missing.join(', ')]);
  }
  return telegramTableMessage('PostgreSQL required', rows);
}

function savedAlertsMessage(alerts) {
  const symbols = [...new Set(alerts.map(alert => alert.symbol))].join(', ');
  const header = `Saved ${alerts.length} decision-tree alert${alerts.length === 1 ? '' : 's'} for ${symbols}.`;
  return telegramTableMessage(header, [
    ['Refresh', 'Every 10 minutes'],
    ['Trigger', 'Condition moves from inactive to active'],
    ['Expiry', '24 hours unless manually cancelled with /clearalerts'],
    { separator: true },
    ...alerts.map(formatRichDecisionTreeRule),
  ]);
}

function formatRichDecisionTreeRule(alert) {
  const id = alert.id ? `#${alert.id}` : 'Alert';
  return [
    `${id} ${alert.symbol}`,
    `${alert.conditionText} -> ${alert.actionText} | expires ${formatTelegramDate(alert.expiresAt)}`,
  ];
}

function listAlertsMessage(alerts) {
  if (!alerts?.length) {
    return telegramTableMessage('Active decision-tree alerts', [
      ['Status', 'No active decision-tree alerts for this chat.'],
    ]);
  }

  return telegramTableMessage('Active decision-tree alerts', [
    ['Expiry', '24 hours unless cancelled with /clearalerts'],
    { separator: true },
    ...alerts.map(formatRichDecisionTreeRule),
  ]);
}

async function setupTreeAlerts(body, chatId, deps = {}) {
  if (!body) return treeAlertUsage();
  if (!getPostgresStatus().configured) return postgresRequiredMessage();

  const parseAlerts = deps.parseDecisionTreeAlertTextWithAi ?? parseDecisionTreeAlertTextWithAi;
  const parsed = await parseAlerts(body, {
    assets: ASSETS,
    aiRequest: deps.aiJson,
    deepSeekRequest: deps.deepSeekJson,
  });
  if (parsed.errors.length && !parsed.rules.length) {
    const rows = parsed.errors.map((error, index) => [`Error ${index + 1}`, error]);
    if (parsed.aiMessage) rows.push([parsed.aiUnavailable ? 'AI unavailable' : 'AI analysis', parsed.aiMessage]);
    return telegramTableMessage('Could not save decision-tree alerts', [
      ...rows,
      { separator: true },
      ['Usage', '/treealert | MU above $1,164 and holds? | -> Long toward $1,198'],
    ]);
  }

  if (!parsed.rules.length) return treeAlertUsage();

  const saveAlerts = deps.saveDecisionTreeAlerts ?? saveDecisionTreeAlerts;
  const alerts = await saveAlerts({
    chatId,
    rawTree: body,
    rules: parsed.rules,
  });

  if (!alerts) return postgresRequiredMessage();
  const message = savedAlertsMessage(alerts);
  if (parsed.aiMessage || parsed.source === 'ai') {
    const note = parsed.source === 'ai'
      ? 'Analyzed with AI first and saved as trigger-ready alerts.'
      : parsed.aiMessage;
    return { ...message, text: `${message.text}\n\n<i>${note}</i>` };
  }
  return message;
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
  return telegramTableMessage('Decision-tree alerts cancelled', [
    ['Cleared', `${cleared} active decision-tree alert${cleared === 1 ? '' : 's'}${scope}`],
  ]);
}

async function evaluateAssetCondition({ chatId, asset, deps = {} }) {
  const alerts = await (deps.getDecisionTreeAlertsForSymbol ?? getDecisionTreeAlertsForSymbol)(chatId, asset.symbol);
  if (!alerts) return { status: 'postgres-required', asset };
  if (!alerts.length) {
    return {
      status: 'no-active-tree',
      asset,
      condition: 'No active decision tree',
      action: 'Create one with /treealert.',
    };
  }

  const classification = await (deps.classifyAssetDecisionTreeCondition ?? classifyAssetDecisionTreeCondition)({
    asset,
    currentPrice: asset.price,
    indicators: asset.indicators ?? {},
    activeRules: alerts,
    rawTree: alerts[0]?.rawTree ?? '',
  });
  const matchedRuleIds = (classification.matchedRuleIds ?? []).map(String);
  const matched = alerts.filter(alert => matchedRuleIds.includes(String(alert.id)));
  const condition = matched.map(alert => alert.conditionText).join('; ') || classification.currentCondition;
  const action = matched.map(alert => alert.actionText).join('; ') || classification.decision;

  return {
    status: 'ok',
    asset,
    classification,
    condition,
    action,
  };
}

function singleAssetConditionMessage(result) {
  if (result.status === 'no-active-tree') {
    return telegramTableMessage('No active decision tree', [
      ['Symbol', result.asset.symbol],
      ['Next step', result.action],
    ]);
  }

  const { asset, classification, condition, action } = result;
  return telegramTableMessage(`Decision-tree condition: ${asset.symbol}`, [
    ['Symbol', asset.symbol],
    ['Price', formatNumber(classification.price ?? asset.price)],
    ['Matched/current condition', condition],
    ['Plan/action', action],
    ['Confidence', `${Math.round(Number(classification.confidence ?? 0) * 100)}% (${classification.source ?? 'ai'})`],
    ['AI reasoning', classification.reasoningSummary],
  ]);
}

function allAssetConditionsMessage(results, snapshot) {
  const rows = results
    .toSorted((a, b) => a.asset.symbol.localeCompare(b.asset.symbol))
    .map(result => {
      if (result.status === 'no-active-tree') {
        return [result.asset.symbol, 'No active decision tree'];
      }

      const price = formatNumber(result.classification.price ?? result.asset.price);
      return [
        result.asset.symbol,
        `${price} | ${result.condition} | ${result.action}`,
      ];
    });

  return telegramTableMessage('Decision-tree conditions', [
    ['Updated', formatTelegramDate(snapshot.timestamp)],
    { separator: true },
    ...rows,
  ]);
}

async function conditionMessage({ chatId, symbolInput, deps = {} }) {
  if (!getPostgresStatus().configured) return postgresRequiredMessage();

  const snapshot = await (deps.getHyperliquidSnapshot ?? getHyperliquidSnapshot)();

  if (symbolInput) {
    const asset = findAsset(snapshot, symbolInput);
    if (!asset) {
      return telegramTableMessage('Unknown asset', [
        ['Input', symbolInput],
        ['Tracked', ASSETS.map(item => item.label).join(', ')],
      ]);
    }

    const result = await evaluateAssetCondition({ chatId, asset, deps });
    if (result.status === 'postgres-required') return postgresRequiredMessage();
    return singleAssetConditionMessage(result);
  }

  const assets = [...(snapshot.assets ?? [])];
  if (!assets.length) {
    return telegramTableMessage('Decision-tree conditions', [
      ['Status', 'No configured assets are available to evaluate.'],
    ]);
  }

  const results = [];
  for (const asset of assets) {
    const result = await evaluateAssetCondition({ chatId, asset, deps });
    if (result.status === 'postgres-required') return postgresRequiredMessage();
    results.push(result);
  }

  return allAssetConditionsMessage(results, snapshot);
}

export async function buildReply(text, chatId, deps = {}) {
  const { command, args, body } = parseCommand(text);

  if (command === '/start' || command === '/help') {
    return helpMessage();
  }

  if (command === '/prices') {
    const snapshot = await (deps.getHyperliquidSnapshot ?? getHyperliquidSnapshot)();
    return pricesMessage(snapshot);
  }

  if (command === '/asset') {
    if (!args.length) {
      return telegramTableMessage('Asset command usage', [
        ['Usage', '/asset BTCUSDT'],
      ]);
    }

    const snapshot = await (deps.getHyperliquidSnapshot ?? getHyperliquidSnapshot)();
    const asset = findAsset(snapshot, args[0]);
    if (!asset) {
      return telegramTableMessage('Unknown asset', [
        ['Input', args[0]],
        ['Tracked', ASSETS.map(item => item.label).join(', ')],
      ]);
    }

    return assetMessage(asset, snapshot);
  }

  if (command === '/condition' || command === '/treecondition') {
    return conditionMessage({ chatId, symbolInput: args[0], deps });
  }

  if (command === '/rsh' || command === '/research') {
    return (deps.answerResearchChat ?? answerResearchChat)({
      message: body,
      getSnapshot: deps.getHyperliquidSnapshot,
      getSearch: deps.getSearch,
      aiJson: deps.aiJson,
      extractSearchQuery: deps.extractSearchQuery,
      extractionCache: deps.extractionCache,
      deepSeekChat: deps.deepSeekChat,
    });
  }

  if (command === '/treealert' || command === '/decisiontree') {
    return setupTreeAlerts(body, chatId, deps);
  }

  if (command === '/alerts') {
    return listTreeAlerts(chatId);
  }

  if (command === '/clearalerts') {
    return clearTreeAlerts(chatId, args[0]);
  }

  if (!isSlashCommand(text)) {
    return (deps.answerStatelessAiChat ?? answerStatelessAiChat)({
      message: text,
      getSnapshot: deps.getHyperliquidSnapshot,
      getSearch: deps.getSearch,
      aiJson: deps.aiJson,
      extractSearchQuery: deps.extractSearchQuery,
      extractionCache: deps.extractionCache,
      deepSeekChat: deps.deepSeekChat,
    });
  }

  return helpMessage();
}

async function persistTelegramChatMessage({
  chatId,
  direction,
  messageText,
  messageType,
  telegramMessageId,
  deps = {},
}) {
  const saveMessage = deps.saveTelegramChatMessage ?? saveTelegramChatMessage;
  try {
    return await saveMessage({
      chatId,
      direction,
      messageText,
      messageType,
      telegramMessageId,
    });
  } catch (error) {
    console.warn('telegram chat message persistence failed:', error);
    return null;
  }
}

export async function processTelegramText({
  text,
  chatId,
  telegramMessageId,
  deps = {},
} = {}) {
  const messageType = telegramMessageType(text);
  await persistTelegramChatMessage({
    chatId,
    direction: 'inbound',
    messageText: text,
    messageType,
    telegramMessageId,
    deps,
  });

  const reply = normalizeReply(await buildReply(text, chatId, deps));

  await persistTelegramChatMessage({
    chatId,
    direction: 'outbound',
    messageText: reply.text,
    messageType,
    deps,
  });

  return reply;
}

export default async function handler(req, res) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const expectedSecret = readEnv('TELEGRAM_SECRET_TOKEN');
  const botUsername = readEnv('TELEGRAM_BOT_USERNAME');

  if (req.method === 'GET') {
    const aiStatus = getAiStatus();
    res.status(200).json({
      status: 'ok',
      service: 'telegram-webhook',
      vercelEnv: process.env.VERCEL_ENV ?? 'unknown',
      config: {
        botTokenConfigured: Boolean(token),
        botUsernameConfigured: Boolean(botUsername),
        secretTokenConfigured: Boolean(expectedSecret),
        postgres: getPostgresStatus(),
        ai: aiStatus,
        deepseek: aiStatus.deepseek,
        search: getSearchStatus(),
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
    const text = getProcessableTelegramText(message, botUsername);

    if (!chatId || !text) {
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const reply = await processTelegramText({
      text,
      chatId,
      telegramMessageId: message.message_id,
    });
    await sendTelegramMessage(token, chatId, reply.text, {
      parseMode: reply.parseMode,
      messageThreadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
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

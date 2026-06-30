import { getHyperliquidSnapshot } from './hyperliquid.js';
import { requestDeepSeekChat } from './deepseek-client.js';
import {
  escapeTelegramHtml,
  formatTelegramDate,
  htmlMessage,
  telegramTableMessage,
} from './telegram-format.js';

const MAX_TELEGRAM_TEXT_LENGTH = 3900;
const MARKET_TOPIC_PATTERN = /\b(?:asset|assets|bitcoin|btc|coin|coins|crypto|cryptocurrency|entry|entries|equity|equities|forex|future|futures|gold|hyperliquid|indicator|indicators|invest|investing|investment|long|market|markets|nasdaq|portfolio|price|prices|rsi|short|stock|stocks|symbol|symbols|ticker|tickers|trade|trades|trading|trend|volume)\b|[$€£¥]\s?\d/i;

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const num = Number(value);
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatAssetForPrompt(asset) {
  const indicators = asset.indicators ?? {};
  const macd = indicators.macd ?? {};
  return {
    symbol: asset.symbol,
    price: asset.price,
    regime: asset.regime,
    rsi14: indicators.rsi14,
    adx14: indicators.adx14,
    ema20: indicators.ema20,
    ema50: indicators.ema50,
    macdHistogram: macd.histogram,
    macdHistogramDirection: macd.histogramDirection,
    atr14: indicators.atr14,
    volumeSpikeRatio: indicators.volumeSpikeRatio,
  };
}

function summarizeSnapshot(snapshot) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  return {
    timestamp: snapshot?.timestamp,
    interval: snapshot?.interval,
    assets: assets.map(formatAssetForPrompt),
  };
}

function fallbackSnapshotContext(error) {
  return {
    timestamp: new Date().toISOString(),
    interval: 'unknown',
    assets: [],
    warning: `Fresh market snapshot unavailable: ${error.message}`,
  };
}

function trimTelegramText(value) {
  const text = String(value ?? '').trim();
  if (text.length <= MAX_TELEGRAM_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TELEGRAM_TEXT_LENGTH - 40).trimEnd()}\n\n[Reply shortened for Telegram.]`;
}

function assetAliases(asset) {
  const symbol = String(asset?.symbol ?? '').toUpperCase();
  const coin = String(asset?.coin ?? '').replace(/^xyz:/i, '').toUpperCase();
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  return [symbol, coin, base].filter(Boolean);
}

function isMarketRelatedRequest(message, snapshotContext) {
  const text = String(message ?? '').trim();
  if (!text) return false;
  if (MARKET_TOPIC_PATTERN.test(text)) return true;

  const normalizedWords = text.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const words = new Set(normalizedWords);
  return (snapshotContext.assets ?? []).some(asset =>
    assetAliases(asset).some(alias => words.has(alias))
  );
}

export async function answerStatelessAiChat({
  message,
  getSnapshot = getHyperliquidSnapshot,
  deepSeekChat = requestDeepSeekChat,
} = {}) {
  const currentMessage = String(message ?? '').trim();
  if (!currentMessage) {
    return telegramTableMessage('AI chat', [
      ['Status', 'Send a message and I will answer using the current request only.'],
    ]);
  }

  let snapshotContext;
  try {
    snapshotContext = summarizeSnapshot(await getSnapshot());
  } catch (error) {
    snapshotContext = fallbackSnapshotContext(error);
  }
  const marketRelatedRequest = isMarketRelatedRequest(currentMessage, snapshotContext);

  const result = await deepSeekChat({
    messages: [
      {
        role: 'system',
        content: [
          'You are a stateless AI assistant inside a Telegram bot.',
          'Answer the user naturally without requiring slash commands, including friendly daily-life topics such as routines, food, travel, hobbies, planning, and casual conversation.',
          'Use only the current user request and the fresh market context in this prompt.',
          'Do not refer to or infer previous conversation history, even if history is stored elsewhere.',
          'Use the market context only when the request is about markets, assets, prices, trading, or investing; do not force market commentary into ordinary daily-life replies.',
          'Be concise enough for Telegram. If discussing markets, trades, or investing, be clear that it is informational and not financial advice.',
          'The bot can also handle slash commands: /prices, /asset SYMBOL, /treealert, /condition SYMBOL, /alerts, /clearalerts.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          currentRequest: currentMessage,
          marketRelatedRequest,
          marketContext: snapshotContext,
        }),
      },
    ],
  });

  if (!result.ok) {
    return telegramTableMessage('AI chat unavailable', [
      ['Status', result.error ?? 'DeepSeek could not answer right now.'],
      ['Next step', 'Check DEEPSEEK_API_KEY configuration or try again later.'],
    ]);
  }

  let replyText = result.text;
  if (marketRelatedRequest) {
    const updatedAt = snapshotContext.timestamp ? formatTelegramDate(snapshotContext.timestamp) : 'n/a';
    const marketLine = snapshotContext.assets.length
      ? `Market context: ${snapshotContext.assets.map(asset => `${asset.symbol} ${formatNumber(asset.price)}`).join(', ')}`
      : 'Market context was unavailable for this reply.';
    replyText = `${replyText}\n\n${marketLine}\nUpdated: ${updatedAt}\n\nInformational only, not financial advice.`;
  }
  const text = trimTelegramText(replyText);

  return htmlMessage(escapeTelegramHtml(text));
}

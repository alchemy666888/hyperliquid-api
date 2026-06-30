import { getHyperliquidSnapshot } from './hyperliquid.js';
import { requestDeepSeekChat } from './deepseek-client.js';
import {
  escapeTelegramHtml,
  htmlMessage,
  telegramTableMessage,
} from './telegram-format.js';

const MAX_TELEGRAM_TEXT_LENGTH = 3900;

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

  const result = await deepSeekChat({
    messages: [
      {
        role: 'system',
        content: [
          'You are a stateless AI assistant inside a Telegram bot for Hyperliquid market data.',
          'Answer the user naturally without requiring slash commands.',
          'Use only the current user request and the fresh market context in this prompt.',
          'Do not refer to or infer previous conversation history, even if history is stored elsewhere.',
          'Be concise enough for Telegram and write in plain text without Markdown formatting.',
          'If discussing markets or trades, be clear that it is informational and not financial advice.',
          'The bot can also handle slash commands: /prices, /asset SYMBOL, /treealert, /condition SYMBOL, /alerts, /clearalerts.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          currentRequest: currentMessage,
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

  return htmlMessage(escapeTelegramHtml(trimTelegramText(result.text)));
}

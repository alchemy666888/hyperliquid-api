import { getHyperliquidSnapshot } from './hyperliquid.js';
import { requestAiChat } from './ai-client.js';
import {
  extractWeatherLocation,
  formatWeatherPlace,
  getDefaultWeatherLocation,
  getWeatherSnapshot,
  isWeatherRelatedRequest,
  weatherCodeDescription,
} from './weather.js';
import {
  escapeTelegramHtml,
  formatTelegramDate,
  htmlMessage,
  telegramTableMessage,
} from './telegram-format.js';

const MAX_TELEGRAM_TEXT_LENGTH = 3900;
const MARKET_TOPIC_PATTERN = /\b(?:asset|assets|bitcoin|btc|coin|coins|crypto|cryptocurrency|entry|entries|equity|equities|forex|future|futures|gold|hyperliquid|indicator|indicators|invest|investing|investment|long|market|markets|nasdaq|portfolio|price|prices|rsi|short|stock|stocks|symbol|symbols|ticker|tickers|trade|trades|trading|trend|volume)\b|[$€£¥]\s?\d/i;
const ALLOWED_AI_HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
]);

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const num = Number(value);
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatMeasurement(value, unit = '', digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const rounded = Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
  return `${rounded}${unit}`;
}

function formatPercent(value) {
  return value == null || Number.isNaN(Number(value)) ? 'n/a' : `${Math.round(Number(value))}%`;
}

function hasChineseText(value) {
  return /[\u3400-\u9fff]/.test(String(value ?? ''));
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

function convertCommonMarkdownToHtml(value) {
  return String(value ?? '')
    .replace(/```(?:\w+)?\s*([\s\S]*?)\s*```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*\*([^*\n][^*\n]*?)\*\*/g, '$1<b>$2</b>');
}

function sanitizeTelegramAiHtml(value) {
  const input = convertCommonMarkdownToHtml(value);
  const tagPattern = /<\/?([a-z][a-z0-9]*)(?:\s[^>]*)?>/gi;
  let sanitized = '';
  let cursor = 0;
  let match;

  while ((match = tagPattern.exec(input)) !== null) {
    sanitized += escapeTelegramHtml(input.slice(cursor, match.index));

    const tag = match[1].toLowerCase();
    if (ALLOWED_AI_HTML_TAGS.has(tag)) {
      sanitized += match[0].startsWith('</') ? `</${tag}>` : `<${tag}>`;
    } else {
      sanitized += escapeTelegramHtml(match[0]);
    }

    cursor = match.index + match[0].length;
  }

  sanitized += escapeTelegramHtml(input.slice(cursor));
  return sanitized;
}

function formatWeatherAnswer(weather, { currentMessage, usedDefaultLocation }) {
  const chinese = hasChineseText(currentMessage);
  const place = formatWeatherPlace(weather.location) || weather.requestedLocation;
  const current = weather.current ?? {};
  const today = weather.today ?? {};
  const currentUnits = weather.currentUnits ?? {};
  const dailyUnits = weather.dailyUnits ?? {};
  const currentDescription = weatherCodeDescription(current.weather_code, chinese);
  const todayDescription = weatherCodeDescription(today.weatherCode, chinese);
  const temperatureUnit = currentUnits.temperature_2m ?? '°C';
  const windUnit = currentUnits.wind_speed_10m ?? 'km/h';
  const dailyTemperatureUnit = dailyUnits.temperature_2m_max ?? '°C';
  const updatedAt = current.time ? formatTelegramDate(current.time) : 'n/a';

  if (chinese) {
    const defaultLine = usedDefaultLocation ? `未指定城市，按默认地点 ${place} 查询。` : `${place} 的天气：`;
    return htmlMessage(sanitizeTelegramAiHtml(trimTelegramText([
      '<b>天气</b>',
      defaultLine,
      `当前：${currentDescription}，${formatMeasurement(current.temperature_2m, temperatureUnit)}，体感 ${formatMeasurement(current.apparent_temperature, temperatureUnit)}，湿度 ${formatPercent(current.relative_humidity_2m)}。`,
      `今日：${todayDescription}，${formatMeasurement(today.temperatureMin, dailyTemperatureUnit)} - ${formatMeasurement(today.temperatureMax, dailyTemperatureUnit)}，最高降雨概率 ${formatPercent(today.precipitationProbabilityMax)}。`,
      `风速：${formatMeasurement(current.wind_speed_10m, windUnit)}。`,
      `更新时间：${updatedAt}`,
    ].join('\n'))));
  }

  const defaultLine = usedDefaultLocation ? `No location was specified, so I used the default location: ${place}.` : `Weather for ${place}:`;
  return htmlMessage(sanitizeTelegramAiHtml(trimTelegramText([
    '<b>Weather</b>',
    defaultLine,
    `Current: ${currentDescription}, ${formatMeasurement(current.temperature_2m, temperatureUnit)}, feels like ${formatMeasurement(current.apparent_temperature, temperatureUnit)}, humidity ${formatPercent(current.relative_humidity_2m)}.`,
    `Today: ${todayDescription}, ${formatMeasurement(today.temperatureMin, dailyTemperatureUnit)} - ${formatMeasurement(today.temperatureMax, dailyTemperatureUnit)}, max rain chance ${formatPercent(today.precipitationProbabilityMax)}.`,
    `Wind: ${formatMeasurement(current.wind_speed_10m, windUnit)}.`,
    `Updated: ${updatedAt}`,
  ].join('\n'))));
}

function weatherUnavailableAnswer(error, currentMessage) {
  if (hasChineseText(currentMessage)) {
    return telegramTableMessage('天气查询不可用', [
      ['状态', error.message ?? '暂时无法获取天气。'],
      ['下一步', '请带上城市再试一次，例如：吉隆坡今天天气如何。'],
    ]);
  }

  return telegramTableMessage('Weather unavailable', [
    ['Status', error.message ?? 'Weather could not be fetched right now.'],
    ['Next step', 'Try again with a city, for example: weather in Kuala Lumpur today.'],
  ]);
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
  getWeather = getWeatherSnapshot,
  deepSeekChat,
  aiChat = deepSeekChat ?? requestAiChat,
} = {}) {
  const currentMessage = String(message ?? '').trim();
  if (!currentMessage) {
    return telegramTableMessage('AI chat', [
      ['Status', 'Send a message and I will answer using the current request only.'],
    ]);
  }

  if (isWeatherRelatedRequest(currentMessage)) {
    const explicitLocation = extractWeatherLocation(currentMessage);
    const location = explicitLocation || getDefaultWeatherLocation();

    try {
      const weather = await getWeather({ location });
      return formatWeatherAnswer(weather, {
        currentMessage,
        usedDefaultLocation: !explicitLocation,
      });
    } catch (error) {
      return weatherUnavailableAnswer(error, currentMessage);
    }
  }

  let snapshotContext;
  try {
    snapshotContext = summarizeSnapshot(await getSnapshot());
  } catch (error) {
    snapshotContext = fallbackSnapshotContext(error);
  }
  const marketRelatedRequest = isMarketRelatedRequest(currentMessage, snapshotContext);

  const result = await aiChat({
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
          'Format replies as Telegram-compatible HTML, not Markdown. Use only simple tags such as <b>, <i>, <u>, <code>, and <pre> when formatting helps. Do not use Markdown syntax like **bold**, _italic_, # headings, or fenced code blocks.',
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
    const missing = Array.isArray(result.missing) && result.missing.length
      ? result.missing.join(', ')
      : 'AI_MODEL_PROVIDER, CLAUDE_API_KEY, or DEEPSEEK_API_KEY';
    return telegramTableMessage('AI chat unavailable', [
      ['Status', result.error ?? 'AI could not answer right now.'],
      ['Next step', `Check ${missing} configuration or try again later.`],
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

  return htmlMessage(sanitizeTelegramAiHtml(text));
}

import { requestAiJson } from '../ai-client.js';

const MAX_QUERY_LENGTH = 400;
const DEFAULT_GL = 'us';
const DEFAULT_HL = 'en';
const DEFAULT_FRESHNESS = 'd';
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60;

export const FRESHNESS_TBS = {
  h: 'qdr:h,sbd:1',
  d: 'qdr:d,sbd:1',
  w: 'qdr:w,sbd:1',
  m: 'qdr:m,sbd:1',
};

const CRYPTO_TICKERS = new Map([
  ['BTC', 'Bitcoin'],
  ['ETH', 'Ethereum'],
  ['SOL', 'Solana'],
  ['HYPE', 'Hyperliquid'],
  ['ZEC', 'Zcash'],
]);

const TRACKED_TICKERS = new Map([
  ['BTCUSDT', 'Bitcoin'],
  ['HYPEUSDT', 'Hyperliquid'],
  ['ZECUSDT', 'Zcash'],
  ['XAUUSD', 'Gold'],
  ['CLUSD', 'WTI crude oil'],
  ['EURUSD', 'Euro US dollar'],
  ['NVDA', 'NVIDIA'],
  ['MU', 'Micron Technology'],
  ['INTC', 'Intel'],
  ['MRVL', 'Marvell Technology'],
  ['SPCX', '"$SPCX"'],
  ['SNDK', '"$SNDK"'],
]);

const TAIWAN_MARKET_PATTERN = /(?:台股|臺股|台湾股票|台灣股票|TWSE|TPEX|\b\d{4}\.TW\b|\b\d{4}\s*台股\b|台積電|聯發科|鴻海)/i;
const SEARCH_INTENT_PATTERN = /\b(?:analyse|analyze|analysis|breaking|catalyst|catalysts|earnings|event|events|fresh|headline|headlines|latest|macro|market|markets|news|now|opportunity|opportunities|research|search|today|trade|trading|update|updates|why)\b|(?:分析|新聞|消息|最新|即時|实时|現在|机会|機會|做多|做空|利多|利空|台股|臺股)/i;
const HOURLY_FRESHNESS_PATTERN = /\b(?:now|rn|right now|latest|breaking|fresh|live)\b|(?:最新|即時|实时|現在|剛剛|马上|立刻)/i;
const WEEKLY_FRESHNESS_PATTERN = /\b(?:past week|last week|this week|weekly)\b|(?:過去一週|过去一周|本週|本周|近一週|近一周)/i;
const MONTHLY_FRESHNESS_PATTERN = /\b(?:past month|last month|this month|monthly)\b|(?:過去一月|过去一月|本月|近一月|近一个月)/i;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function compactText(value, maxLength = MAX_QUERY_LENGTH) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeMessage(value) {
  return compactText(value).toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeFreshness(value, fallback = DEFAULT_FRESHNESS) {
  const freshness = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(FRESHNESS_TBS, freshness) ? freshness : fallback;
}

function detectFreshness(message) {
  const text = String(message ?? '');
  if (MONTHLY_FRESHNESS_PATTERN.test(text)) return 'm';
  if (WEEKLY_FRESHNESS_PATTERN.test(text)) return 'w';
  if (HOURLY_FRESHNESS_PATTERN.test(text)) return 'h';
  return DEFAULT_FRESHNESS;
}

function hasTaiwanMarketIntent(message) {
  return TAIWAN_MARKET_PATTERN.test(String(message ?? ''));
}

function localeForMessage(message) {
  return hasTaiwanMarketIntent(message)
    ? { gl: 'tw', hl: 'zh-TW' }
    : { gl: DEFAULT_GL, hl: DEFAULT_HL };
}

function normalizeGl(value, fallback = DEFAULT_GL) {
  const gl = String(value ?? '').trim().toLowerCase();
  return gl === 'tw' ? 'tw' : gl === 'us' ? 'us' : fallback;
}

function normalizeHl(value, fallback = DEFAULT_HL) {
  const hl = String(value ?? '').trim();
  return hl === 'zh-TW' ? 'zh-TW' : hl.toLowerCase() === 'en' ? 'en' : fallback;
}

function tokenizeMessage(message) {
  return String(message ?? '').match(/\$?[A-Za-z]{2,8}(?:USDT|USD)?|\d{4}(?:\.TW)?/g) ?? [];
}

function canonicalToken(token) {
  const normalized = String(token ?? '').replace(/^\$/, '').toUpperCase();
  if (TRACKED_TICKERS.has(normalized)) return TRACKED_TICKERS.get(normalized);
  if (CRYPTO_TICKERS.has(normalized)) return CRYPTO_TICKERS.get(normalized);
  if (/^\d{4}\.TW$/.test(normalized)) return `"${normalized}"`;
  return '';
}

export function detectFastPathSearchQuery(message) {
  const terms = unique(tokenizeMessage(message).map(canonicalToken));
  if (!terms.length) return null;

  return {
    q: terms.join(' '),
    ...localeForMessage(message),
    freshness: detectFreshness(message),
    needs_search: true,
    source: 'fast-path',
  };
}

export function isLikelySearchRequest(message, { marketRelatedRequest = false } = {}) {
  const text = String(message ?? '').trim();
  if (!text) return false;
  if (marketRelatedRequest) return true;
  if (detectFastPathSearchQuery(text)) return true;
  return SEARCH_INTENT_PATTERN.test(text);
}

function normalizeExtractedShape(value, { fallbackMessage } = {}) {
  const baseLocale = localeForMessage(fallbackMessage);
  const q = compactText(value?.q ?? '');
  const needsSearch = Boolean(value?.needs_search) && Boolean(q);

  return {
    q,
    gl: normalizeGl(value?.gl, baseLocale.gl),
    hl: normalizeHl(value?.hl, baseLocale.hl),
    freshness: normalizeFreshness(value?.freshness),
    needs_search: needsSearch,
  };
}

function fallbackExtracted(message, reason = 'extractor-fallback') {
  return {
    q: compactText(message),
    ...localeForMessage(message),
    freshness: DEFAULT_FRESHNESS,
    needs_search: Boolean(compactText(message)),
    source: reason,
  };
}

function cacheKey(message) {
  return `search-query:v1:${normalizeMessage(message)}`;
}

async function readCachedExtraction(cache, key) {
  if (!cache || typeof cache.get !== 'function') return null;

  try {
    const cached = await cache.get(key);
    if (!cached) return null;
    if (typeof cached === 'string') return JSON.parse(cached);
    return cached;
  } catch (error) {
    console.warn('Search query extraction cache read failed', { error: error.message });
    return null;
  }
}

async function writeCachedExtraction(cache, key, value) {
  if (!cache || typeof cache.set !== 'function') return;

  try {
    await cache.set(key, value, { ttlSeconds: DEFAULT_CACHE_TTL_SECONDS });
  } catch (error) {
    console.warn('Search query extraction cache write failed', { error: error.message });
  }
}

function coerceAiJsonResult(result) {
  if (!result) return null;
  if (result.ok === false) return null;
  if (result.json && typeof result.json === 'object' && !Array.isArray(result.json)) return result.json;
  if (typeof result === 'object' && !Array.isArray(result) && Object.hasOwn(result, 'q')) return result;
  return null;
}

function extractorMessages(message) {
  return [
    {
      role: 'system',
      content: [
        'Convert one Telegram user message into SearchApi Google News parameters.',
        'Return JSON only with keys q, gl, hl, freshness, needs_search.',
        'The q value must be clean keywords only: entities, tickers, asset names, or event terms; no conversational framing or questions.',
        'Use needs_search=false for chit-chat, preferences, coding help, weather, or any request that does not need current market/news data.',
        'Use gl=us and hl=en for crypto, commodities, US equities, and global macro.',
        'Use gl=tw and hl=zh-TW for Taiwan equities.',
        'Map BTC to Bitcoin, ETH to Ethereum, SOL to Solana. Wrap ambiguous short tickers in quotes, for example "$SPCX".',
        'Default freshness is d. Use h only for now, rn, latest, breaking, live, or equivalent Chinese wording. Use w or m only when explicitly requested.',
      ].join(' '),
    },
    {
      role: 'user',
      content: message,
    },
  ];
}

export async function extractSearchQuery({
  message,
  aiJson = requestAiJson,
  cache,
  env = process.env,
} = {}) {
  void env;
  const text = compactText(message);
  if (!text) {
    return {
      q: '',
      gl: DEFAULT_GL,
      hl: DEFAULT_HL,
      freshness: DEFAULT_FRESHNESS,
      needs_search: false,
      source: 'empty',
    };
  }

  const fastPath = detectFastPathSearchQuery(text);
  if (fastPath) return fastPath;

  const key = cacheKey(text);
  const cached = await readCachedExtraction(cache, key);
  if (cached) {
    return {
      ...normalizeExtractedShape(cached, { fallbackMessage: text }),
      source: 'cache',
    };
  }

  let result;
  try {
    result = await aiJson({
      messages: extractorMessages(text),
      temperature: 0,
      maxTokens: 300,
      task: 'extractor',
    });
  } catch (error) {
    console.warn('Search query extractor failed', { error: error.message });
    return fallbackExtracted(text, 'extractor-error');
  }

  const payload = coerceAiJsonResult(result);
  if (!payload) return fallbackExtracted(text, 'extractor-invalid-json');

  const extracted = {
    ...normalizeExtractedShape(payload, { fallbackMessage: text }),
    source: 'extractor',
  };
  await writeCachedExtraction(cache, key, extracted);
  return extracted;
}

function parseSiteList(value) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(item));
}

function appendSourceOperators(query, env = process.env) {
  const includeSites = parseSiteList(readEnv(env, 'SEARCH_QUERY_INCLUDE_SITES'));
  const excludeSites = parseSiteList(readEnv(env, 'SEARCH_QUERY_EXCLUDE_SITES'));
  const operators = [
    ...includeSites.map(site => `site:${site}`),
    ...excludeSites.map(site => `-site:${site}`),
  ];
  return operators.length ? `${query} ${operators.join(' ')}` : query;
}

export function buildSearchApiParams(extracted = {}, { env = process.env } = {}) {
  if (!extracted?.needs_search) return null;
  const q = compactText(appendSourceOperators(extracted.q, env));
  if (!q) return null;

  return {
    engine: 'google_news',
    q,
    gl: normalizeGl(extracted.gl),
    hl: normalizeHl(extracted.hl),
    tbs: FRESHNESS_TBS[normalizeFreshness(extracted.freshness)],
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRedisExtractionCache({ env = process.env, fetchImpl = fetch } = {}) {
  const url = readEnv(env, 'REDIS_REST_URL') || readEnv(env, 'UPSTASH_REDIS_REST_URL');
  const token = readEnv(env, 'REDIS_REST_TOKEN') || readEnv(env, 'UPSTASH_REDIS_REST_TOKEN');
  const ttlSeconds = parsePositiveInt(
    readEnv(env, 'SEARCH_QUERY_CACHE_TTL_SECONDS'),
    DEFAULT_CACHE_TTL_SECONDS
  );

  if (!url || !token) return null;
  const baseUrl = url.replace(/\/+$/, '');

  async function command(parts) {
    const response = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
    });
    if (!response.ok) throw new Error(`Redis REST returned HTTP ${response.status}.`);
    return response.json();
  }

  return {
    async get(key) {
      const payload = await command(['GET', key]);
      const result = payload?.result;
      return result ? JSON.parse(result) : null;
    },
    async set(key, value, options = {}) {
      const ttl = parsePositiveInt(options.ttlSeconds, ttlSeconds);
      await command(['SET', key, JSON.stringify(value), 'EX', String(ttl)]);
    },
  };
}

let defaultExtractionCache;

export function getSearchExtractionCache(options = {}) {
  if (defaultExtractionCache !== undefined) return defaultExtractionCache;
  defaultExtractionCache = createRedisExtractionCache(options);
  return defaultExtractionCache;
}

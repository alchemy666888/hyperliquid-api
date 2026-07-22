import { providerMeta } from './market-data-quality.js';

const BASE_URL = 'https://fapi.binance.com';
export const INTRADAY_INTERVALS = ['5m', '15m', '1h'];
const INTERVAL_MS = { '5m': 300000, '15m': 900000, '1h': 3600000 };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export function parseBinanceKline(row, interval, { now = Date.now() } = {}) {
  const openTime = num(row?.[0]);
  const closeTime = num(row?.[6]);
  const baseAssetVolume = num(row?.[5]);
  const quoteAssetVolume = num(row?.[7]);
  return {
    interval,
    openTime: new Date(openTime).toISOString(),
    closeTime: new Date(closeTime).toISOString(),
    isClosed: closeTime < now,
    open: num(row?.[1]), high: num(row?.[2]), low: num(row?.[3]), close: num(row?.[4]),
    baseAssetVolume,
    quoteAssetVolume,
    vwap: baseAssetVolume && quoteAssetVolume != null ? quoteAssetVolume / baseAssetVolume : null,
    numberOfTrades: num(row?.[8]),
    takerBuyBaseVolume: num(row?.[9]),
    takerBuyQuoteVolume: num(row?.[10]),
    units: { price: 'USDT per BTC', baseAssetVolume: 'BTC', quoteAssetVolume: 'USDT', vwap: 'USDT per BTC' },
  };
}

export function splitCurrentAndCompleted(klines, interval, { now = Date.now() } = {}) {
  const parsed = klines.map(k => parseBinanceKline(k, interval, { now })).sort((a, b) => new Date(a.openTime) - new Date(b.openTime));
  const current = [...parsed].reverse().find(k => !k.isClosed) ?? parsed.at(-1) ?? null;
  const completed = [...parsed].reverse().find(k => k.isClosed && k.openTime !== current?.openTime) ?? null;
  return { current, completed };
}

export async function fetchBinanceInterval(interval, { fetchImpl = fetch, signal, symbol = 'BTCUSDT', now = Date.now() } = {}) {
  if (!INTERVAL_MS[interval]) throw new Error(`Unsupported Binance interval ${interval}`);
  const url = new URL('/fapi/v1/klines', BASE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', '3');
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Binance klines ${interval} HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Binance klines ${interval} shape`);
  return splitCurrentAndCompleted(data, interval, { now });
}

export async function fetchBtcIntradayBars({ fetchImpl = fetch, signal, now = Date.now(), symbol = 'BTCUSDT' } = {}) {
  const entries = await Promise.all(INTRADAY_INTERVALS.map(async interval => [interval, await fetchBinanceInterval(interval, { fetchImpl, signal, now, symbol })]));
  return {
    ...providerMeta({ source: 'Binance USD-M', asOf: now, receivedAt: now, status: 'live', method: 'public REST /fapi/v1/klines; VWAP = quoteAssetVolume / baseAssetVolume', now }),
    symbol,
    exactness: 'venue-specific-exchange-reported-bars',
    timeframes: Object.fromEntries(entries),
  };
}

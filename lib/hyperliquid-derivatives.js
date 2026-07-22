import { providerMeta } from './market-data-quality.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const SOURCE = 'Hyperliquid';
const METHOD = 'info/metaAndAssetCtxs universe-index match';

export function parseFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseBtcPerpetualContext(payload, { now = Date.now() } = {}) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0]?.universe) || !Array.isArray(payload[1])) {
    throw new Error('Unexpected Hyperliquid metaAndAssetCtxs shape');
  }
  const universe = payload[0].universe;
  const index = universe.findIndex(asset => String(asset?.name ?? '').toUpperCase() === 'BTC');
  if (index < 0) throw new Error('BTC not found in Hyperliquid universe');
  const ctx = payload[1][index];
  if (!ctx) throw new Error('BTC context missing at matched universe index');
  const markPrice = parseFiniteNumber(ctx.markPx ?? ctx.markPrice);
  const openInterestBtc = parseFiniteNumber(ctx.openInterest ?? ctx.oi);
  const fundingRateHourly = parseFiniteNumber(ctx.funding);
  const openInterestUsd = markPrice != null && openInterestBtc != null ? openInterestBtc * markPrice : null;
  return {
    ...providerMeta({ source: SOURCE, asOf: now, receivedAt: now, status: 'live', method: METHOD, now }),
    coin: 'BTC',
    universeIndex: index,
    markPrice,
    midPrice: parseFiniteNumber(ctx.midPx ?? ctx.midPrice),
    oraclePrice: parseFiniteNumber(ctx.oraclePx ?? ctx.oraclePrice),
    fundingRateHourly,
    fundingAprSimple: fundingRateHourly == null ? null : fundingRateHourly * 24 * 365,
    fundingAprMethod: 'non-compounded simple annualization: hourly funding * 24 * 365',
    openInterestBtc,
    openInterestUsd,
    units: { markPrice: 'USD per BTC', midPrice: 'USD per BTC', oraclePrice: 'USD per BTC', fundingRateHourly: 'decimal per hour', fundingAprSimple: 'decimal APR, simple non-compounded', openInterestBtc: 'BTC', openInterestUsd: 'USD notional' },
  };
}

export async function fetchBtcPerpetualContext({ fetchImpl = fetch, signal, now = Date.now() } = {}) {
  const res = await fetchImpl(HL_INFO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal });
  if (!res.ok) throw new Error(`Hyperliquid metaAndAssetCtxs HTTP ${res.status}`);
  return parseBtcPerpetualContext(await res.json(), { now });
}

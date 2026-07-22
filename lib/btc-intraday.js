import { fetchBtcIntradayBars } from './binance-futures.js';
import { fetchBtcPerpetualContext } from './hyperliquid-derivatives.js';
import { readLiquidationAggregates } from './liquidation-aggregator.js';
import { fetchDeribitOptions } from './deribit-options.js';
import { buildQuality, unavailableProvider, withTimeout } from './market-data-quality.js';

const TIMEOUTS = { hyperliquid: 4000, binance: 4000, redis: 2000, deribit: 8000 };

function errBlock(source, method, error, now) { return unavailableProvider({ source, method, reason: error?.message ?? String(error), now }); }

export async function buildBtcIntradaySnapshot({ fetchImpl = fetch, redisClient, env = process.env, now = Date.now, timeouts = TIMEOUTS } = {}) {
  const startedAt = now();
  const tasks = {
    binance: withTimeout(signal => fetchBtcIntradayBars({ fetchImpl, signal, now: now() }), timeouts.binance, 'Binance'),
    hyperliquid: withTimeout(signal => fetchBtcPerpetualContext({ fetchImpl, signal, now: now() }), timeouts.hyperliquid, 'Hyperliquid'),
    liquidations: withTimeout(signal => readLiquidationAggregates({ redisClient, env, fetchImpl, signal, now: now() }), timeouts.redis, 'Redis liquidations'),
    deribit: withTimeout(signal => fetchDeribitOptions({ fetchImpl, signal, now: now() }), timeouts.deribit, 'Deribit'),
  };
  const settled = await Promise.allSettled(Object.values(tasks));
  const names = Object.keys(tasks);
  const result = Object.fromEntries(settled.map((r,i)=>[names[i], r.status === 'fulfilled' ? r.value : r.reason]));
  const binance = result.binance instanceof Error ? errBlock('Binance USD-M','public REST /fapi/v1/klines',result.binance,now()) : result.binance;
  const perpetual = result.hyperliquid instanceof Error ? errBlock('Hyperliquid','info/metaAndAssetCtxs universe-index match',result.hyperliquid,now()) : result.hyperliquid;
  const liquidations = result.liquidations instanceof Error ? errBlock('Binance USD-M liquidation stream via Redis','Redis REST cached worker aggregates',result.liquidations,now()) : result.liquidations;
  const options = result.deribit instanceof Error ? errBlock('Deribit','public get_instruments + bounded public/ticker requests',result.deribit,now()) : result.deribit;
  const providers = { binance, hyperliquid: perpetual, liquidations, deribit: options };
  const missingFields = [];
  if (binance.status !== 'live') missingFields.push('btcIntraday.timeframes');
  if (perpetual.status !== 'live') missingFields.push('btcIntraday.perpetual');
  if (!['live','partial','stale'].includes(liquidations.status)) missingFields.push('btcIntraday.liquidations');
  if (options.status !== 'live') missingFields.push('btcIntraday.options');
  const warnings = Object.entries(providers).filter(([,v])=>v.status !== 'live').map(([k,v])=>`${k}: ${v.reason ?? v.status}`);
  const finishedAt = now();
  return { schemaVersion: '2.0', btcIntraday: { symbol: 'BTCUSDT', asOf: new Date(finishedAt).toISOString(), timeframes: binance.timeframes ?? {}, perpetual, liquidations, options, quality: buildQuality({ startedAt, finishedAt, providers, warnings, missingFields }) } };
}

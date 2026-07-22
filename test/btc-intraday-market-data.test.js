import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBtcPerpetualContext } from '../lib/hyperliquid-derivatives.js';
import { parseBinanceKline, splitCurrentAndCompleted } from '../lib/binance-futures.js';
import { parseDeribitInstrument, selectExpiries, filterStrikesAroundUnderlying, mapWithConcurrency, calculateExpiryAnalytics } from '../lib/deribit-options.js';
import { LiquidationAggregator, parseLiquidationEvent, readLiquidationAggregates } from '../lib/liquidation-aggregator.js';
import { buildBtcIntradaySnapshot } from '../lib/btc-intraday.js';
import { reconnectDelay } from '../scripts/market-stream-worker.js';

const now = Date.parse('2026-07-22T00:10:00.000Z');

test('Hyperliquid matches BTC by universe index and parses funding/OI', () => {
  const parsed = parseBtcPerpetualContext([[{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }][0], [{ markPx: '3000' }, { markPx: '100000', midPx: '100010', oraclePx: '99990', funding: '0.00001', openInterest: '12.5' }]], { now });
  assert.equal(parsed.universeIndex, 1);
  assert.equal(parsed.openInterestUsd, 1_250_000);
  assert.equal(Number(parsed.fundingAprSimple.toFixed(4)), 0.0876);
  assert.equal(parsed.units.openInterestBtc, 'BTC');
});

test('Hyperliquid reports BTC not found', () => {
  assert.throws(() => parseBtcPerpetualContext([{ universe: [{ name: 'ETH' }] }, [{}]], { now }), /BTC not found/);
});

test('Binance klines parse exact VWAP and zero base volume', () => {
  const row = [now, '1', '3', '0.5', '2', '10', now + 299999, '25', 7, '4', '11'];
  const parsed = parseBinanceKline(row, '5m', { now });
  assert.equal(parsed.vwap, 2.5);
  assert.equal(parsed.quoteAssetVolume, 25);
  assert.equal(parseBinanceKline([...row.slice(0,5), '0', ...row.slice(6)], '5m', { now }).vwap, null);
});

test('Binance detects current and completed klines', () => {
  const closed = [now - 600000, '1','1','1','1','1', now - 300001, '2', 1, '1', '2'];
  const current = [now - 300000, '1','1','1','1','1', now + 1, '2', 1, '1', '2'];
  const split = splitCurrentAndCompleted([closed, current], '5m', { now });
  assert.equal(split.current.isClosed, false);
  assert.equal(split.completed.openTime, new Date(now - 600000).toISOString());
});

test('Deribit parses instruments, selects expiries, filters strikes, bounds concurrency', async () => {
  const inst = [0,1,2,3].flatMap(i => [{ instrument_name:`BTC-${i}-100000-C`, expiration_timestamp: now + (i+1)*86400000, strike: 100000, option_type:'call', is_active:true }]).map(i=>parseDeribitInstrument(i,{now}));
  assert.deepEqual(selectExpiries(inst,{maxCount:3,now}), inst.slice(0,3).map(i=>i.expiryTimestamp));
  assert.equal(filterStrikesAroundUnderlying([...inst, { ...inst[0], strike: 200000 }], 100000, { rangePct: 15 }).length, 4);
  const out = await mapWithConcurrency([1,2,3,4,5], 2, async x => { await new Promise(r=>setTimeout(r,1)); return x; });
  assert.equal(out.maxActive <= 2, true);
});

test('Options analytics calculate ATM, 25d interpolation/fallback, RR and butterfly', () => {
  const opts = [
    { instrumentName:'c20', optionType:'call', strike:99000, underlyingPrice:100000, markIv:50, delta:0.20 },
    { instrumentName:'c30', optionType:'call', strike:101000, underlyingPrice:100000, markIv:60, delta:0.30 },
    { instrumentName:'p25', optionType:'put', strike:99000, underlyingPrice:100000, markIv:55, delta:-0.25 },
    { instrumentName:'atm', optionType:'call', strike:100000, underlyingPrice:100000, markIv:52, delta:0.5 },
  ];
  const a = calculateExpiryAnalytics(opts, { now });
  assert.equal(a.call25Delta.iv, 55);
  assert.equal(a.put25Delta.iv, 55);
  assert.equal(a.riskReversal25d, 0);
  assert.equal(a.butterfly25d, 3);
  const missing = calculateExpiryAnalytics(opts.filter(o=>o.optionType==='call'), { now });
  assert.equal(missing.put25Delta.iv, null);
});

test('Liquidation side mapping, rolling expiration and deduplication', () => {
  let t = now;
  const agg = new LiquidationAggregator({ now: () => t });
  const sell = { E: t, o: { s:'BTCUSDT', S:'SELL', T:t, ap:'100', z:'2' } };
  const buy = { E: t, o: { s:'BTCUSDT', S:'BUY', T:t+1, ap:'50', z:'1' } };
  assert.equal(parseLiquidationEvent(sell).liquidationSide, 'long');
  assert.equal(parseLiquidationEvent(buy).liquidationSide, 'short');
  assert.equal(agg.add(sell).accepted, true);
  assert.equal(agg.add(sell).accepted, false);
  agg.add(buy);
  assert.equal(agg.snapshot().windows['5m'].totalLiquidationUsd, 250);
  t += 3600001;
  assert.equal(agg.snapshot().windows['1h'].eventCount, 0);
});

test('Worker reconnect delay increases with jitter', () => {
  assert.equal(reconnectDelay(2, { baseMs: 100, maxMs: 10000, jitter: () => 0.5 }), 900);
});

test('Stale Redis liquidation data preserves values but status is stale', async () => {
  const data = { asOf: new Date(now - 1000000).toISOString(), windows: { '5m': { totalLiquidationUsd: 1 } } };
  const result = await readLiquidationAggregates({ redisClient: { get: async () => JSON.stringify(data) }, now, staleMs: 1000 });
  assert.equal(result.status, 'stale');
  assert.equal(result.windows['5m'].totalLiquidationUsd, 1);
});

test('BTC intraday orchestrator returns partial response for provider failures and no unknown zeroes', async () => {
  const result = await buildBtcIntradaySnapshot({ now: () => now, env: {}, fetchImpl: async url => {
    const s = String(url);
    if (s.includes('hyperliquid')) return { ok: true, json: async () => [{ universe:[{ name:'BTC' }] }, [{ markPx:'100', funding:'0.1', openInterest:'2' }]] };
    if (s.includes('binance')) throw new Error('binance down');
    if (s.includes('get_instruments')) return { ok: true, json: async () => ({ result: [] }) };
    throw new Error('unexpected');
  }});
  assert.equal(result.schemaVersion, '2.0');
  assert.equal(result.btcIntraday.perpetual.openInterestUsd, 200);
  assert.equal(result.btcIntraday.quality.status, 'partial');
  assert.equal(result.btcIntraday.timeframes['5m'], undefined);
  assert.equal(result.btcIntraday.liquidations.windows['5m'].totalLiquidationUsd, null);
});

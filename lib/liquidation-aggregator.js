import { createRedisRestClient } from './redis-rest.js';
import { emptyMetricWindows, providerMeta } from './market-data-quality.js';

export const LIQUIDATION_WINDOWS = { '5m': 300000, '15m': 900000, '1h': 3600000 };
export const LIQUIDATION_REDIS_KEY = 'market:binance-usdm:BTCUSDT:liquidations:v1';

const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };

export function parseLiquidationEvent(message) {
  const order = message?.o ?? message;
  const side = String(order?.S ?? '').toUpperCase();
  const price = n(order?.ap ?? order?.p);
  const quantity = n(order?.z ?? order?.q);
  const eventTime = n(message?.E ?? order?.T) ?? Date.now();
  if (!['SELL', 'BUY'].includes(side) || price == null || quantity == null) return null;
  const notionalUsd = price * quantity;
  return { eventKey: [order?.s, side, order?.T, price, quantity].join(':'), symbol: order?.s ?? 'BTCUSDT', eventTime, side, liquidationSide: side === 'SELL' ? 'long' : 'short', price, quantity, notionalUsd };
}

export class LiquidationAggregator {
  constructor({ now = () => Date.now(), windows = LIQUIDATION_WINDOWS } = {}) { this.now = now; this.windows = windows; this.events = []; this.seen = new Set(); }
  add(raw) {
    const event = parseLiquidationEvent(raw);
    if (!event || this.seen.has(event.eventKey)) return { accepted: false, event };
    this.seen.add(event.eventKey); this.events.push(event); this.prune(); return { accepted: true, event };
  }
  prune() {
    const cutoff = this.now() - Math.max(...Object.values(this.windows));
    this.events = this.events.filter(e => e.eventTime >= cutoff);
    this.seen = new Set(this.events.map(e => e.eventKey));
  }
  snapshot() {
    this.prune();
    const now = this.now();
    const windows = {};
    for (const [label, ms] of Object.entries(this.windows)) {
      const evs = this.events.filter(e => e.eventTime >= now - ms);
      const longLiquidationUsd = evs.filter(e => e.liquidationSide === 'long').reduce((a, e) => a + e.notionalUsd, 0);
      const shortLiquidationUsd = evs.filter(e => e.liquidationSide === 'short').reduce((a, e) => a + e.notionalUsd, 0);
      windows[label] = { longLiquidationUsd, shortLiquidationUsd, totalLiquidationUsd: longLiquidationUsd + shortLiquidationUsd, eventCount: evs.length, largestLiquidationUsd: evs.length ? Math.max(...evs.map(e => e.notionalUsd)) : 0, lastEventTimestamp: evs.length ? new Date(Math.max(...evs.map(e => e.eventTime))).toISOString() : null };
    }
    return { source: 'Binance USD-M liquidation stream', exactness: 'exchange-reported-snapshots', asOf: new Date(now).toISOString(), windows, collector: { status: 'live', eventCount: this.events.length, lastEventTimestamp: this.events.length ? new Date(Math.max(...this.events.map(e => e.eventTime))).toISOString() : null } };
  }
}

export function normalizeLiquidationUnavailable(reason, { status = 'unavailable', now = Date.now() } = {}) {
  return { ...providerMeta({ source: 'Binance USD-M liquidation stream via Redis', asOf: null, receivedAt: now, status, method: 'Redis REST cached worker aggregates', reason, now }), exactness: 'exchange-reported-snapshots', windows: emptyMetricWindows(), units: { liquidationUsd: 'USD notional' } };
}

export async function readLiquidationAggregates({ redisClient, env = process.env, fetchImpl = fetch, signal, now = Date.now(), staleMs = Number(process.env.LIQUIDATION_STALE_MS || 120000) } = {}) {
  let client = redisClient;
  if (!client) { const created = createRedisRestClient({ env, fetchImpl }); if (!created.client) return normalizeLiquidationUnavailable(`Redis is not configured: ${created.config.missing.join(', ')}`, { now }); client = created.client; }
  const raw = await client.get(LIQUIDATION_REDIS_KEY, { signal });
  if (!raw) return normalizeLiquidationUnavailable('No liquidation aggregate found in Redis', { now });
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const asOfMs = new Date(data.asOf).getTime();
  const status = Number.isFinite(asOfMs) && now - asOfMs <= staleMs ? 'live' : 'stale';
  return { ...providerMeta({ source: 'Binance USD-M liquidation stream via Redis', asOf: data.asOf, receivedAt: now, status, method: 'Redis REST cached worker aggregates', reason: status === 'stale' ? 'Liquidation aggregate is stale' : null, now }), exactness: 'exchange-reported-snapshots', windows: data.windows ?? emptyMetricWindows(), collector: data.collector ?? null, units: { liquidationUsd: 'USD notional' } };
}

export async function writeLiquidationAggregates(redisClient, snapshot, { ttlSeconds = 7200 } = {}) { return redisClient.set(LIQUIDATION_REDIS_KEY, snapshot, { ttlSeconds }); }

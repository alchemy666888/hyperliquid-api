#!/usr/bin/env node
import { LiquidationAggregator, writeLiquidationAggregates } from '../lib/liquidation-aggregator.js';
import { createRedisRestClient } from '../lib/redis-rest.js';

const STREAM_URL = 'wss://fstream.binance.com/ws/btcusdt@forceOrder';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function reconnectDelay(attempt, { baseMs = 1000, maxMs = 30000, jitter = Math.random } = {}) { return Math.min(maxMs, baseMs * 2 ** attempt) + Math.floor(jitter() * 1000); }

export async function runWorker({ WebSocketImpl = globalThis.WebSocket, redisClient, url = STREAM_URL } = {}) {
  if (!WebSocketImpl) throw new Error('WebSocket is not available in this Node runtime');
  const created = redisClient ? { client: redisClient } : createRedisRestClient();
  if (!created.client) throw new Error('Redis REST is not configured');
  const aggregator = new LiquidationAggregator();
  let attempt = 0;
  for (;;) {
    await new Promise(resolve => {
      const ws = new WebSocketImpl(url);
      ws.onopen = () => { attempt = 0; console.log('liquidation worker connected'); };
      ws.onmessage = async evt => { try { const parsed = JSON.parse(evt.data); aggregator.add(parsed); await writeLiquidationAggregates(created.client, aggregator.snapshot()); } catch (e) { console.warn('liquidation message skipped', e.message); } };
      ws.onerror = err => console.warn('liquidation websocket error', err?.message ?? err);
      ws.onclose = () => resolve();
    });
    const delay = reconnectDelay(attempt++);
    console.warn(`liquidation worker reconnecting in ${delay}ms`);
    await sleep(delay);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) runWorker().catch(e => { console.error('liquidation worker fatal', e.message); process.exit(1); });

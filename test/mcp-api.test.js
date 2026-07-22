import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler } from '../api/mcp.js';

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

async function callTool(name, service) {
  const handler = createMcpHandler(service);
  const res = mockResponse();
  await handler({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.id, 1);
  return JSON.parse(res.body.result.content[0].text);
}

test('MCP lists thin Hyperliquid API tools', async () => {
  const handler = createMcpHandler({});
  const res = mockResponse();
  await handler({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);

  assert.deepEqual(res.body.result.tools.map(tool => tool.name), [
    'get_btc_intraday_market_data',
    'get_legacy_hyperliquid_snapshot',
    'get_latest_stored_btc_intraday_snapshot',
  ]);
});

test('get_btc_intraday_market_data returns JSON from injected API function', async () => {
  const payload = { schemaVersion: '2.0', btcIntraday: { quality: { status: 'complete' } } };
  const result = await callTool('get_btc_intraday_market_data', {
    getBtcIntradayMarketData: async () => ({ body: payload }),
  });

  assert.deepEqual(result, payload);
});

test('MCP tool output redacts sensitive configuration-shaped fields', async () => {
  const result = await callTool('get_btc_intraday_market_data', {
    getBtcIntradayMarketData: async () => ({ body: { postgresUrl: 'postgres://secret', nested: { telegramToken: 'bot-token' } } }),
  });

  assert.equal(result.postgresUrl, '[redacted]');
  assert.equal(result.nested.telegramToken, '[redacted]');
});

test('get_legacy_hyperliquid_snapshot returns JSON from injected API function', async () => {
  const payload = { timestamp: '2026-07-22T00:00:00.000Z', assets: [{ symbol: 'BTC' }], alerts: [] };
  const result = await callTool('get_legacy_hyperliquid_snapshot', {
    getLegacyHyperliquidSnapshot: async () => ({ body: payload }),
  });

  assert.deepEqual(result, payload);
});

test('get_latest_stored_btc_intraday_snapshot returns JSON from injected API function', async () => {
  const payload = { btcIntraday: { quality: { status: 'partial' } }, persistence: { enabled: true, saved: true, id: 7 } };
  const result = await callTool('get_latest_stored_btc_intraday_snapshot', {
    getLatestStoredBtcIntradaySnapshot: async () => ({ body: payload }),
  });

  assert.deepEqual(result, payload);
});

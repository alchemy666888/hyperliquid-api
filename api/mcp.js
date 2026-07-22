import { hyperliquidApiService } from '../lib/hyperliquid-api-service.js';

const JSON_RPC_VERSION = '2.0';

const TOOL_DEFINITIONS = [
  {
    name: 'get_btc_intraday_market_data',
    description: 'Return the same BTC intraday market-data payload as GET /api/hyperliquid?profile=btc-intraday, including btcIntraday quality metadata.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_legacy_hyperliquid_snapshot',
    description: 'Return the legacy 4h Hyperliquid market snapshot contract from GET /api/hyperliquid.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_latest_stored_btc_intraday_snapshot',
    description: 'Return the latest persisted BTC intraday snapshot from GET /api/hyperliquid?stored=latest&profile=btc-intraday.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

function jsonRpcResult(id, result) {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

const SENSITIVE_KEY_PATTERN = /(secret|token|password|api[_-]?key|authorization|redis|postgres|telegram)/i;

function redactSensitiveOutput(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveOutput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redactSensitiveOutput(entry),
  ]));
}

function toolContent(value) {
  return { content: [{ type: 'text', text: JSON.stringify(redactSensitiveOutput(value)) }] };
}

export function createMcpHandler(service = hyperliquidApiService) {
  const toolHandlers = {
    get_btc_intraday_market_data: async () => toolContent((await service.getBtcIntradayMarketData()).body),
    get_legacy_hyperliquid_snapshot: async () => toolContent((await service.getLegacyHyperliquidSnapshot()).body),
    get_latest_stored_btc_intraday_snapshot: async () => toolContent((await service.getLatestStoredBtcIntradaySnapshot()).body),
  };

  return async function mcpHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const request = req.body ?? {};
    try {
      if (request.method === 'initialize') {
        res.json(jsonRpcResult(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hyperliquid-api-mcp', version: '1.0.0' },
        }));
        return;
      }

      if (request.method === 'tools/list') {
        res.json(jsonRpcResult(request.id, { tools: TOOL_DEFINITIONS }));
        return;
      }

      if (request.method === 'tools/call') {
        const name = request.params?.name;
        const handler = toolHandlers[name];
        if (!handler) {
          res.status(400).json(jsonRpcError(request.id, -32602, `Unknown tool: ${name}`));
          return;
        }
        res.json(jsonRpcResult(request.id, await handler(request.params?.arguments ?? {})));
        return;
      }

      res.status(400).json(jsonRpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`));
    } catch (error) {
      console.error('mcp handler error:', error);
      res.status(500).json(jsonRpcError(request.id, -32603, error.message));
    }
  };
}

export default createMcpHandler();

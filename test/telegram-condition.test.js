import assert from 'node:assert/strict';
import test from 'node:test';

process.env.POSTGRES_URL = 'postgres://example';

const { buildReply } = await import('../api/telegram.js');

const snapshot = {
  interval: '4h',
  timestamp: '2026-06-30T00:00:00.000Z',
  assets: [
    { symbol: 'MU', coin: 'xyz:MU', price: 1170, regime: 'bull', indicators: { rsi14: 61 } },
  ],
};

const alert = {
  id: 7,
  symbol: 'MU',
  conditionText: 'MU above $1,164 and holds?',
  conditionKind: 'above',
  lowerPrice: 1164,
  actionText: 'Long toward $1,198.',
  rawTree: 'MU above $1,164 and holds? -> Long toward $1,198.',
};

test('/condition returns unknown symbol message', async () => {
  const reply = await buildReply('/condition DOGE', 123, {
    getHyperliquidSnapshot: async () => snapshot,
    getDecisionTreeAlertsForSymbol: async () => { throw new Error('should not query alerts'); },
  });

  assert.match(reply.text, /<b>Unknown asset<\/b>/);
  assert.match(reply.text, /DOGE/);
});

test('/condition tells users to create a tree when no saved alerts exist', async () => {
  const reply = await buildReply('/condition MU', 123, {
    getHyperliquidSnapshot: async () => snapshot,
    getDecisionTreeAlertsForSymbol: async (chatId, symbol) => {
      assert.equal(chatId, 123);
      assert.equal(symbol, 'MU');
      return [];
    },
  });

  assert.match(reply.text, /<b>No active decision tree<\/b>/);
  assert.match(reply.text, /Create one with \/treealert/);
});

test('/condition routes through classifier and formats table', async () => {
  const reply = await buildReply('/treecondition MU', 123, {
    getHyperliquidSnapshot: async () => snapshot,
    getDecisionTreeAlertsForSymbol: async () => [alert],
    classifyAssetDecisionTreeCondition: async ({ activeRules, currentPrice }) => {
      assert.equal(currentPrice, 1170);
      assert.deepEqual(activeRules, [alert]);
      return {
        symbol: 'MU',
        currentCondition: 'Breakout hold',
        matchedRuleIds: [7],
        decision: 'Stay long',
        reasoningSummary: 'Price is holding above the trigger.',
        confidence: 0.91,
        price: 1170,
        source: 'deepseek',
      };
    },
  });

  assert.match(reply.text, /<b>Decision-tree condition: MU<\/b>/);
  assert.match(reply.text, /MU above \$1,164 and holds\?/);
  assert.match(reply.text, /Long toward \$1,198\./);
  assert.match(reply.text, /91% \(deepseek\)/);
  assert.match(reply.text, /Price is holding above the trigger\./);
});

const multiAssetSnapshot = {
  interval: '4h',
  timestamp: '2026-06-30T00:00:00.000Z',
  assets: [
    { symbol: 'ETH', coin: 'xyz:ETH', price: 3400, regime: 'bull', indicators: { rsi14: 58 } },
    { symbol: 'BTC', coin: 'xyz:BTC', price: 61000, regime: 'bull', indicators: { rsi14: 64 } },
  ],
};

test('/condition BTC evaluates only the requested asset', async () => {
  const calls = [];
  const reply = await buildReply('/condition BTC', 123, {
    getHyperliquidSnapshot: async () => multiAssetSnapshot,
    getDecisionTreeAlertsForSymbol: async (chatId, symbol) => {
      calls.push(symbol);
      return [{ ...alert, id: 21, symbol, conditionText: `${symbol} above trigger?`, actionText: 'Hold trend.' }];
    },
    classifyAssetDecisionTreeCondition: async ({ asset, activeRules }) => {
      assert.equal(asset.symbol, 'BTC');
      assert.equal(activeRules[0].symbol, 'BTC');
      return {
        symbol: 'BTC',
        currentCondition: 'BTC trend hold',
        matchedRuleIds: [21],
        decision: 'Hold trend.',
        reasoningSummary: 'BTC is above the trigger.',
        confidence: 0.8,
        price: asset.price,
        source: 'test',
      };
    },
  });

  assert.deepEqual(calls, ['BTC']);
  assert.match(reply.text, /<b>Decision-tree condition: BTC<\/b>/);
  assert.match(reply.text, /BTC above trigger\?/);
  assert.doesNotMatch(reply.text, /ETH/);
});

test('/condition without a symbol returns all configured assets', async () => {
  const evaluated = [];
  const reply = await buildReply('/condition', 123, {
    getHyperliquidSnapshot: async () => multiAssetSnapshot,
    getDecisionTreeAlertsForSymbol: async (_chatId, symbol) => [
      { ...alert, id: symbol === 'BTC' ? 31 : 32, symbol, conditionText: `${symbol} above trigger?`, actionText: `${symbol} plan.` },
    ],
    classifyAssetDecisionTreeCondition: async ({ asset, activeRules }) => {
      evaluated.push(asset.symbol);
      return {
        symbol: asset.symbol,
        currentCondition: `${asset.symbol} condition`,
        matchedRuleIds: [activeRules[0].id],
        decision: `${asset.symbol} plan.`,
        reasoningSummary: `${asset.symbol} reasoning.`,
        confidence: 0.75,
        price: asset.price,
        source: 'test',
      };
    },
  });

  assert.deepEqual(evaluated, ['ETH', 'BTC']);
  assert.match(reply.text, /<b>Decision-tree conditions<\/b>/);
  assert.match(reply.text, /BTC above trigger\?/);
  assert.match(reply.text, /ETH above trigger\?/);
  assert.ok(reply.text.indexOf('BTC') < reply.text.indexOf('ETH'));
});

test('/condition without a symbol handles an empty asset universe', async () => {
  const reply = await buildReply('/condition', 123, {
    getHyperliquidSnapshot: async () => ({ interval: '4h', timestamp: '2026-06-30T00:00:00.000Z', assets: [] }),
    getDecisionTreeAlertsForSymbol: async () => { throw new Error('should not query alerts'); },
  });

  assert.match(reply.text, /<b>Decision-tree conditions<\/b>/);
  assert.match(reply.text, /No configured assets are available to evaluate\./);
});

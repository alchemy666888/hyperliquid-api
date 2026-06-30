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

import assert from 'node:assert/strict';
import test from 'node:test';

const { buildReply } = await import('../api/telegram.js');

test('/plan routes to injected plan command handler', async () => {
  let payload;
  const reply = await buildReply('/plan@trading_alchemist_bot MU long 2w', 123, {
    runPlanCommand: async (input) => {
      payload = input;
      return { text: '<b>fake plan</b>', parseMode: 'HTML' };
    },
  });

  assert.equal(reply.text, '<b>fake plan</b>');
  assert.equal(reply.parseMode, 'HTML');
  assert.equal(payload.symbolInput, 'MU');
  assert.deepEqual(payload.args, ['MU', 'long', '2w']);
  assert.equal(payload.body, 'MU long 2w');
  assert.equal(payload.chatId, 123);
});

test('/prices remains on the existing route when plan handler is injected', async () => {
  const reply = await buildReply('/prices', 123, {
    runPlanCommand: async () => {
      throw new Error('should not call plan handler for /prices');
    },
    getHyperliquidSnapshot: async () => ({
      interval: '4h',
      timestamp: '2026-07-02T00:00:00.000Z',
      assets: [],
    }),
  });

  assert.match(reply.text, /<b>Hyperliquid prices \(4h\)<\/b>/);
});

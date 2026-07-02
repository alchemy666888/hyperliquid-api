import assert from 'node:assert/strict';
import test from 'node:test';
import { processDecisionTreeAlerts } from '../lib/alert-processor.js';

test('processes price and technical rules with transition semantics', async () => {
  const evaluations = [];
  const notifications = [];
  const rules = [
    {
      id: 1,
      chatId: '123',
      symbol: 'MU',
      conditionKind: 'above',
      conditionText: 'MU above $95?',
      lowerPrice: 95,
      upperPrice: null,
      actionText: 'Price trigger.',
      lastMatched: false,
    },
    {
      id: 2,
      chatId: '123',
      symbol: 'MU',
      conditionKind: 'rsi_below',
      conditionText: 'MU RSI below 30?',
      lowerPrice: null,
      upperPrice: null,
      actionText: 'Technical trigger.',
      indicatorParams: { kind: 'rsi', threshold: 30, fast: null, slow: null },
      lastMatched: false,
    },
    {
      id: 3,
      chatId: '123',
      symbol: 'HYPEUSDT',
      conditionKind: 'ema_cross_up',
      conditionText: 'HYPE EMA20 crosses above EMA50?',
      lowerPrice: null,
      upperPrice: null,
      actionText: 'Missing indicators should not fire.',
      indicatorParams: { kind: 'ema', threshold: null, fast: 20, slow: 50 },
      lastMatched: false,
    },
    {
      id: 4,
      chatId: '123',
      symbol: 'MU',
      conditionKind: 'rsi_below',
      conditionText: 'MU RSI still below 30?',
      lowerPrice: null,
      upperPrice: null,
      actionText: 'Already active technical rule.',
      indicatorParams: { kind: 'rsi', threshold: 30, fast: null, slow: null },
      lastMatched: true,
    },
  ];

  const result = await processDecisionTreeAlerts(
    {
      prices: { MU: 100, HYPEUSDT: 40 },
      assets: [
        { symbol: 'MU', coin: 'xyz:MU', price: 100, indicators: { rsi14: 25 } },
        { symbol: 'HYPEUSDT', coin: 'HYPE', price: 40, indicators: null },
      ],
    },
    async (chatId, message) => {
      notifications.push({ chatId, message });
    },
    {
      expireDecisionTreeAlerts: async () => 0,
      getActiveDecisionTreeAlerts: async () => rules,
      updateDecisionTreeAlertEvaluation: async (evaluation) => {
        evaluations.push(evaluation);
        return evaluation;
      },
    },
  );

  assert.equal(result.checked, 4);
  assert.equal(result.triggered, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(
    evaluations.map(item => ({ id: item.id, matched: item.matched, triggered: item.triggered })),
    [
      { id: 1, matched: true, triggered: true },
      { id: 2, matched: true, triggered: true },
      { id: 3, matched: false, triggered: false },
      { id: 4, matched: true, triggered: false },
    ],
  );
  assert.equal(notifications.length, 2);
  assert.match(notifications[0].message.text, /Price trigger\./);
  assert.match(notifications[1].message.text, /Technical trigger\./);
});

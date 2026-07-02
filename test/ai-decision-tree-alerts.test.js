import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAssetDecisionTreeCondition } from '../lib/ai-decision-tree-alerts.js';

const asset = { symbol: 'MU', price: 1170, indicators: { rsi14: 61 } };
const rules = [
  { id: 1, symbol: 'MU', conditionText: 'MU above $1,164 and holds?', conditionKind: 'above', lowerPrice: 1164, actionText: 'Long toward $1,198.', rawTree: 'tree' },
  { id: 2, symbol: 'MU', conditionText: 'MU closes below $1,111?', conditionKind: 'below', upperPrice: 1111, actionText: 'Short toward $1,059.', rawTree: 'tree' },
];

test('falls back to deterministic rule matching when DeepSeek is unavailable', async () => {
  const result = await classifyAssetDecisionTreeCondition({
    asset,
    currentPrice: 1170,
    activeRules: rules,
    rawTree: 'tree',
    deepSeekJson: async () => { throw new Error('network down'); },
  });

  assert.equal(result.source, 'deterministic');
  assert.deepEqual(result.matchedRuleIds, [1]);
  assert.equal(result.decision, 'Long toward $1,198.');
  assert.match(result.reasoningSummary, /AI classification unavailable/);
});

test('validates successful DeepSeek classification response', async () => {
  const result = await classifyAssetDecisionTreeCondition({
    asset,
    currentPrice: 1170,
    activeRules: rules,
    rawTree: 'tree',
    deepSeekJson: async () => ({
      symbol: 'MU',
      currentCondition: 'Breakout hold',
      matchedRuleIds: [1, 999],
      decision: 'Stay long',
      reasoningSummary: 'Price is holding above the breakout level.',
      confidence: 0.83,
      price: 1170,
    }),
  });

  assert.equal(result.source, 'deepseek');
  assert.deepEqual(result.matchedRuleIds, [1]);
  assert.equal(result.currentCondition, 'Breakout hold');
  assert.equal(result.confidence, 0.83);
});

test('falls back to deterministic technical rule matching with indicators', async () => {
  const result = await classifyAssetDecisionTreeCondition({
    asset: { symbol: 'MU', price: 1170, indicators: { rsi14: 28 } },
    currentPrice: 1170,
    indicators: { rsi14: 28 },
    activeRules: [
      {
        id: 3,
        symbol: 'MU',
        conditionText: 'MU RSI(14) below 30?',
        conditionKind: 'rsi_below',
        indicatorParams: { kind: 'rsi', threshold: 30, fast: null, slow: null },
        actionText: 'Watch reset.',
        rawTree: 'tree',
      },
    ],
    rawTree: 'tree',
    deepSeekJson: async () => { throw new Error('network down'); },
  });

  assert.equal(result.source, 'deterministic');
  assert.deepEqual(result.matchedRuleIds, [3]);
  assert.equal(result.decision, 'Watch reset.');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlanRulesToAlerts } from '../lib/plan-alerts.js';

const ASSETS = [{ label: 'MU', coin: 'xyz:MU' }];

test('normalizes valid price conditions into alert rules locked to the plan symbol', () => {
  const { rules, rejected } = normalizePlanRulesToAlerts(
    [
      {
        symbol: 'TSLA',
        kind: 'above',
        price: '$100',
        conditionText: 'AI supplied text?',
        actionText: 'Watch breakout.',
      },
      {
        conditionKind: 'between',
        lowerPrice: 90,
        upperPrice: 80,
        label: 'Watch range.',
      },
    ],
    { assets: ASSETS, symbol: 'xyz:MU' },
  );

  assert.deepEqual(rejected, []);
  assert.equal(rules[0].symbol, 'MU');
  assert.equal(rules[0].conditionKind, 'above');
  assert.equal(rules[0].lowerPrice, 100);
  assert.equal(rules[0].upperPrice, null);
  assert.equal(rules[0].indicatorParams, null);
  assert.equal(rules[1].symbol, 'MU');
  assert.equal(rules[1].lowerPrice, 80);
  assert.equal(rules[1].upperPrice, 90);
});

test('normalizes valid RSI, MACD, and EMA technical conditions', () => {
  const { rules, rejected } = normalizePlanRulesToAlerts(
    [
      { kind: 'rsi_below', threshold: 30, action: 'Watch oversold.' },
      { kind: 'macd_cross_up', actionText: 'Momentum turns up.' },
      { kind: 'ema_cross_down', indicatorParams: { fast: 13, slow: 48 }, label: 'Trend weakens.' },
    ],
    { assets: ASSETS, symbol: 'MU' },
  );

  assert.deepEqual(rejected, []);
  assert.deepEqual(
    rules.map(rule => rule.indicatorParams),
    [
      { kind: 'rsi', threshold: 30, fast: null, slow: null },
      { kind: 'macd', threshold: null, fast: 12, slow: 26 },
      { kind: 'ema', threshold: null, fast: 13, slow: 48 },
    ],
  );
  assert.deepEqual(rules.map(rule => rule.lowerPrice), [null, null, null]);
  assert.deepEqual(rules.map(rule => rule.upperPrice), [null, null, null]);
});

test('rejects unsupported kinds and unevaluatable conditions', () => {
  const { rules, rejected } = normalizePlanRulesToAlerts(
    [
      { kind: 'sideways', price: 100, actionText: 'Unsupported.' },
      { kind: 'above', actionText: 'Missing price.' },
      { kind: 'rsi_above', actionText: 'Missing threshold.' },
    ],
    { assets: ASSETS, symbol: 'MU' },
  );

  assert.deepEqual(rules, []);
  assert.deepEqual(
    rejected.map(item => item.reason),
    ['unsupported-condition-kind', 'missing-price-bound', 'missing-indicator-threshold'],
  );
});

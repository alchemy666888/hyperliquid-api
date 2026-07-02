import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesDecisionTreeRule,
  normalizeConditionKind,
} from '../lib/decision-tree-alerts.js';

const PRICE_RULE = {
  symbol: 'MU',
  conditionText: 'MU above $100?',
  conditionKind: 'above',
  lowerPrice: 100,
  upperPrice: null,
  actionText: 'Watch upside.',
};

test('normalizes supported technical condition kinds', () => {
  assert.equal(normalizeConditionKind('RSI_BELOW'), 'rsi_below');
  assert.equal(normalizeConditionKind('macd_cross_up'), 'macd_cross_up');
  assert.equal(normalizeConditionKind('ema_cross_down'), 'ema_cross_down');
  assert.equal(normalizeConditionKind('sideways'), '');
});

test('keeps existing two-argument price rule matching behavior', () => {
  assert.equal(matchesDecisionTreeRule(PRICE_RULE, 100), true);
  assert.equal(matchesDecisionTreeRule(PRICE_RULE, 99.99), false);
});

test('matches RSI threshold technical conditions', () => {
  assert.equal(
    matchesDecisionTreeRule(
      { ...PRICE_RULE, conditionKind: 'rsi_below', indicatorParams: { threshold: 30 } },
      100,
      { rsi14: 29.9 },
    ),
    true,
  );
  assert.equal(
    matchesDecisionTreeRule(
      { ...PRICE_RULE, conditionKind: 'rsi_above', indicatorParams: { threshold: 70 } },
      100,
      { rsi14: 70 },
    ),
    true,
  );
  assert.equal(
    matchesDecisionTreeRule(
      { ...PRICE_RULE, conditionKind: 'rsi_below', indicatorParams: { threshold: 30 } },
      100,
      { rsi14: 30.1 },
    ),
    false,
  );
  assert.equal(
    matchesDecisionTreeRule(
      { ...PRICE_RULE, conditionKind: 'rsi_above', indicatorParams: { threshold: 70 } },
      100,
      {},
    ),
    false,
  );
});

test('matches MACD cross technical conditions from histogram direction', () => {
  const crossUp = { macd: { macd: 1.2, signal: 1.1, histogram: 0.1, histogramDirection: 'increasing' } };
  const crossDown = { macd: { macd: 1.1, signal: 1.2, histogram: -0.1, histogramDirection: 'decreasing' } };

  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'macd_cross_up' }, 100, crossUp), true);
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'macd_cross_up' }, 100, crossDown), false);
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'macd_cross_down' }, 100, crossDown), true);
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'macd_cross_down' }, 100, {}), false);
});

test('matches EMA cross technical conditions and treats missing indicators as not matched', () => {
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'ema_cross_up' }, 100, { ema20: 105, ema50: 100 }), true);
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'ema_cross_up' }, 100, { ema20: 99, ema50: 100 }), false);
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'ema_cross_down' }, 100, { ema20: 99, ema50: 100 }), true);
  assert.equal(matchesDecisionTreeRule({ ...PRICE_RULE, conditionKind: 'ema_cross_down' }, 100, { ema20: 100 }), false);
});

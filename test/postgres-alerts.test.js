import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertRuleIndicatorParams,
  normalizeAlertRow,
} from '../lib/postgres.js';

const BASE_ROW = {
  id: 12,
  chat_id: '123',
  symbol: 'MU',
  condition_text: 'MU above $100?',
  condition_kind: 'above',
  lower_price: '100',
  upper_price: null,
  action_text: 'Watch upside.',
  raw_tree: 'raw plan',
  active: true,
  last_matched: false,
  last_checked_at: null,
  last_checked_price: null,
  last_triggered_at: null,
  last_triggered_price: null,
  expires_at: '2026-07-03T00:00:00.000Z',
  created_at: '2026-07-02T00:00:00.000Z',
};

test('normalizes technical alert indicator columns into indicatorParams', () => {
  const row = normalizeAlertRow({
    ...BASE_ROW,
    condition_kind: 'rsi_below',
    lower_price: null,
    indicator_kind: 'rsi',
    indicator_threshold: '30',
    indicator_fast: null,
    indicator_slow: null,
  });

  assert.deepEqual(row.indicatorParams, {
    kind: 'rsi',
    threshold: 30,
    fast: null,
    slow: null,
  });
  assert.equal(row.conditionKind, 'rsi_below');
  assert.equal(row.lowerPrice, null);
  assert.equal(row.upperPrice, null);
});

test('normalizes price alert rows with null indicatorParams and unchanged price fields', () => {
  const row = normalizeAlertRow({
    ...BASE_ROW,
    indicator_kind: null,
    indicator_threshold: null,
    indicator_fast: null,
    indicator_slow: null,
  });

  assert.equal(row.indicatorParams, null);
  assert.equal(row.conditionKind, 'above');
  assert.equal(row.lowerPrice, 100);
  assert.equal(row.upperPrice, null);
  assert.equal(row.expiresAt, '2026-07-03T00:00:00.000Z');
});

test('builds nullable indicator insert values from alert rules', () => {
  assert.deepEqual(
    alertRuleIndicatorParams({
      indicatorParams: { kind: 'ema', threshold: null, fast: 20, slow: 50 },
    }),
    ['ema', null, 20, 50],
  );
  assert.deepEqual(alertRuleIndicatorParams({}), [null, null, null, null]);
});

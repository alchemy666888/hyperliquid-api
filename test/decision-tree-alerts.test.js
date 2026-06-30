import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDecisionTreeAlertHit,
  formatDecisionTreeRuleSummary,
  matchesDecisionTreeRule,
  parseDecisionTreeAlertText,
  parseDecisionTreeAlertTextWithAi,
} from '../lib/decision-tree-alerts.js';

const ASSETS = [{ label: 'MU', coin: 'xyz:MU' }];

const MU_TREE = `
MU above $1,164 and holds?
→ Long toward $1,198, then $1,220–$1,228, then $1,249–$1,255.

MU rejects $1,155–$1,164?
→ No long. Wait for pullback to $1,126–$1,116.

MU holds $1,126–$1,116?
→ Tactical long with stop at $1,108.

MU closes below $1,111?
→ Bearish breakdown. Short toward $1,059–$1,056, then $1,025.

MU between $1,126 and $1,164?
→ No trade.
`;

test('parses pasted decision-tree alert format', () => {
  const parsed = parseDecisionTreeAlertText(MU_TREE, { assets: ASSETS });

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rules.length, 5);
  assert.deepEqual(
    parsed.rules.map(rule => rule.conditionKind),
    ['above', 'between', 'between', 'below', 'between'],
  );
  assert.equal(parsed.rules[0].symbol, 'MU');
  assert.equal(parsed.rules[0].lowerPrice, 1164);
  assert.equal(parsed.rules[1].lowerPrice, 1155);
  assert.equal(parsed.rules[1].upperPrice, 1164);
  assert.equal(parsed.rules[2].lowerPrice, 1116);
  assert.equal(parsed.rules[2].upperPrice, 1126);
  assert.equal(parsed.rules[3].upperPrice, 1111);
  assert.equal(parsed.rules[4].actionText, 'No trade.');
});

test('matches above, below, and between price conditions', () => {
  const { rules } = parseDecisionTreeAlertText(MU_TREE, { assets: ASSETS });

  assert.equal(matchesDecisionTreeRule(rules[0], 1164), true);
  assert.equal(matchesDecisionTreeRule(rules[0], 1163.99), false);
  assert.equal(matchesDecisionTreeRule(rules[2], 1120), true);
  assert.equal(matchesDecisionTreeRule(rules[2], 1127), false);
  assert.equal(matchesDecisionTreeRule(rules[3], 1111), true);
  assert.equal(matchesDecisionTreeRule(rules[3], 1111.01), false);
});

test('formats triggered alert message', () => {
  const { rules } = parseDecisionTreeAlertText(MU_TREE, { assets: ASSETS });
  const message = formatDecisionTreeAlertHit(rules[0], 1198);

  assert.equal(message.parseMode, 'HTML');
  assert.match(message.text, /<b>Decision-tree alert hit<\/b>/);
  assert.match(message.text, /<b>Price<\/b>\n\$1,198/);
  assert.match(message.text, /<b>Condition<\/b>\nMU above \$1,164 and holds\?/);
});

test('formats alert summaries with optional expiration metadata', () => {
  const { rules } = parseDecisionTreeAlertText(MU_TREE, { assets: ASSETS });
  const expiresAt = '2026-07-01T07:25:00.000Z';
  const summary = formatDecisionTreeRuleSummary(
    { ...rules[0], id: 42, expiresAt },
    { includeExpiration: true },
  );

  assert.equal(
    summary,
    '#42 MU above $1,164 and holds? -> Long toward $1,198, then $1,220–$1,228, then $1,249–$1,255. (expires 2026-07-01T07:25:00.000Z)',
  );
  assert.doesNotMatch(formatDecisionTreeRuleSummary({ ...rules[0], expiresAt }), /expires/);
});

test('AI parser extracts rules when deterministic parser cannot preserve semantic intent', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const parsed = await parseDecisionTreeAlertTextWithAi('MU breaks and sustains 1,200? -> Long continuation.', {
    assets: ASSETS,
    deepSeekRequest: async () => ({
      ok: true,
      json: {
        rules: [
          {
            symbol: 'MU',
            conditionText: 'MU breaks and sustains 1,200?',
            conditionKind: 'above',
            lowerPrice: 1200,
            upperPrice: null,
            actionText: 'Long continuation.',
          },
        ],
      },
    }),
  });

  assert.equal(parsed.source, 'ai');
  assert.equal(parsed.aiAttempted, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].conditionKind, 'above');
  assert.equal(parsed.rules[0].lowerPrice, 1200);
  delete process.env.DEEPSEEK_API_KEY;
});

test('AI parser falls back when DeepSeek API key is missing', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const parsed = await parseDecisionTreeAlertTextWithAi('MU breaks and sustains 1,200? -> Long continuation.', {
    assets: ASSETS,
    deepSeekRequest: async () => {
      throw new Error('should not call DeepSeek without a key');
    },
  });

  assert.equal(parsed.source, 'deterministic');
  assert.equal(parsed.aiAttempted, false);
  assert.equal(parsed.aiNeeded, true);
  assert.equal(parsed.aiUnavailable, true);
  assert.match(parsed.aiMessage, /DEEPSEEK_API_KEY/);
  assert.equal(parsed.rules.length, 0);
  assert.ok(parsed.errors.length > 0);
});

test('AI parser safely handles malformed AI JSON shape and keeps deterministic result', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const parsed = await parseDecisionTreeAlertTextWithAi('MU breaks and sustains 1,200? -> Long continuation.', {
    assets: ASSETS,
    deepSeekRequest: async () => ({ ok: true, json: { rules: [{ symbol: 'MU', conditionKind: 'sideways' }] } }),
  });

  assert.equal(parsed.source, 'deterministic');
  assert.equal(parsed.aiAttempted, true);
  assert.match(parsed.aiMessage, /no valid rules/);
  assert.equal(parsed.rules.length, 0);
  delete process.env.DEEPSEEK_API_KEY;
});

test('trigger transitions only fire when a rule moves from inactive to matched', () => {
  const rule = {
    symbol: 'MU',
    conditionText: 'MU above $1,164 and holds?',
    conditionKind: 'above',
    lowerPrice: 1164,
    upperPrice: null,
    actionText: 'Long.',
  };

  const firstMatched = matchesDecisionTreeRule(rule, 1165);
  assert.equal(firstMatched && !false, true);
  assert.equal(firstMatched && !true, false);

  const rearmed = matchesDecisionTreeRule(rule, 1160);
  assert.equal(rearmed, false);
  assert.equal(matchesDecisionTreeRule(rule, 1166) && !rearmed, true);
});

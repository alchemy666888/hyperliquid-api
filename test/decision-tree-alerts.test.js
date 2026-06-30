import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDecisionTreeAlertHit,
  matchesDecisionTreeRule,
  parseDecisionTreeAlertText,
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

  assert.match(message, /Decision-tree alert hit: MU/);
  assert.match(message, /Price: \$1,198/);
  assert.match(message, /Condition: MU above \$1,164 and holds\?/);
});

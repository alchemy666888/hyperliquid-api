import {
  escapeTelegramHtml,
  formatTelegramDate,
  htmlMessage,
} from './telegram-format.js';

const ARROW_PATTERN = /^(?:→|->|=>)\s*(.+)$/;
const SAME_LINE_PATTERN = /^(.+\?)\s*(?:→|->|=>)\s*(.+)$/;
const PRICE_PATTERN = String.raw`\$?\s*([0-9][0-9,]*(?:\.\d+)?)`;

function moneyRegex(pattern, flags = 'i') {
  return new RegExp(pattern.replaceAll('{PRICE}', PRICE_PATTERN), flags);
}

function parsePrice(value) {
  const parsed = Number.parseFloat(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeAlertSymbol(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function resolveAlertSymbol(input, assets) {
  const symbol = normalizeAlertSymbol(input);
  const match = assets.find(asset => {
    const label = normalizeAlertSymbol(asset.label);
    const coin = normalizeAlertSymbol(String(asset.coin ?? '').replace('xyz:', ''));
    const base = label.endsWith('USDT') ? label.slice(0, -4) : label;
    return symbol === label || symbol === coin || symbol === base;
  });

  return match?.label ?? symbol;
}

function normalizeRange(first, second) {
  const a = parsePrice(first);
  const b = parsePrice(second);
  if (a == null || b == null) return null;
  return {
    lowerPrice: Math.min(a, b),
    upperPrice: Math.max(a, b),
  };
}

function parseConditionLine(line, lineNumber, assets) {
  const conditionText = line.trim().replace(/\?+$/, '?');
  const match = conditionText.match(/^([A-Za-z][A-Za-z0-9._:-]*)\s+(.+)\?$/);
  if (!match) {
    return {
      error: `Line ${lineNumber}: expected a condition like "MU above $1,164 and holds?"`,
    };
  }

  const [, rawSymbol, phrase] = match;
  const symbol = resolveAlertSymbol(rawSymbol, assets);

  const between = phrase.match(moneyRegex(String.raw`\bbetween\s+{PRICE}\s*(?:and|to|-|–|—)\s*{PRICE}`));
  if (between) {
    const range = normalizeRange(between[1], between[2]);
    if (range) {
      return {
        rule: {
          symbol,
          conditionText,
          conditionKind: 'between',
          ...range,
        },
      };
    }
  }

  const range = phrase.match(moneyRegex(String.raw`\b(?:holds?|rejects?|tests?|reclaims?|pullbacks?|pulls?\s+back\s+to)\s+{PRICE}\s*(?:-|–|—|to|and)\s*{PRICE}`));
  if (range) {
    const parsedRange = normalizeRange(range[1], range[2]);
    if (parsedRange) {
      return {
        rule: {
          symbol,
          conditionText,
          conditionKind: 'between',
          ...parsedRange,
        },
      };
    }
  }

  const above = phrase.match(moneyRegex(String.raw`\babove\s+{PRICE}`));
  if (above) {
    const price = parsePrice(above[1]);
    if (price != null) {
      return {
        rule: {
          symbol,
          conditionText,
          conditionKind: 'above',
          lowerPrice: price,
          upperPrice: null,
        },
      };
    }
  }

  const below = phrase.match(moneyRegex(String.raw`\b(?:closes?\s+)?below\s+{PRICE}`));
  if (below) {
    const price = parsePrice(below[1]);
    if (price != null) {
      return {
        rule: {
          symbol,
          conditionText,
          conditionKind: 'below',
          lowerPrice: null,
          upperPrice: price,
        },
      };
    }
  }

  return {
    error: `Line ${lineNumber}: unsupported condition "${conditionText}". Use above, below/closes below, between, or holds/rejects with a price range.`,
  };
}

function stripCodeFence(line) {
  return line.trim().startsWith('```');
}

export function parseDecisionTreeAlertText(input, { assets = [] } = {}) {
  const rules = [];
  const errors = [];
  let pendingCondition = null;

  const lines = String(input ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || stripCodeFence(line)) continue;

    const sameLine = line.match(SAME_LINE_PATTERN);
    if (sameLine) {
      const [, condition, action] = sameLine;
      const parsed = parseConditionLine(condition, lineNumber, assets);
      if (parsed.error) {
        errors.push(parsed.error);
      } else {
        rules.push({ ...parsed.rule, actionText: action.trim() });
      }
      pendingCondition = null;
      continue;
    }

    const arrow = line.match(ARROW_PATTERN);
    if (arrow) {
      if (!pendingCondition) {
        errors.push(`Line ${lineNumber}: found an action without a condition.`);
        continue;
      }

      const parsed = parseConditionLine(pendingCondition.text, pendingCondition.lineNumber, assets);
      if (parsed.error) {
        errors.push(parsed.error);
      } else {
        rules.push({ ...parsed.rule, actionText: arrow[1].trim() });
      }
      pendingCondition = null;
      continue;
    }

    if (!line.endsWith('?')) {
      errors.push(`Line ${lineNumber}: expected a question-style condition or an arrow action.`);
      continue;
    }

    if (pendingCondition) {
      errors.push(`Line ${pendingCondition.lineNumber}: condition is missing its arrow action.`);
    }
    pendingCondition = { text: line, lineNumber };
  }

  if (pendingCondition) {
    errors.push(`Line ${pendingCondition.lineNumber}: condition is missing its arrow action.`);
  }

  return { rules, errors };
}

export function matchesDecisionTreeRule(rule, price) {
  const currentPrice = Number(price);
  if (!Number.isFinite(currentPrice)) return false;

  const lowerPrice = rule.lowerPrice == null ? null : Number(rule.lowerPrice);
  const upperPrice = rule.upperPrice == null ? null : Number(rule.upperPrice);

  if (rule.conditionKind === 'above') {
    return lowerPrice != null && currentPrice >= lowerPrice;
  }

  if (rule.conditionKind === 'below') {
    return upperPrice != null && currentPrice <= upperPrice;
  }

  if (rule.conditionKind === 'between') {
    return lowerPrice != null
      && upperPrice != null
      && currentPrice >= lowerPrice
      && currentPrice <= upperPrice;
  }

  return false;
}

export function formatAlertPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 'n/a';
  return `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function formatAlertTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function formatDecisionTreeRuleSummary(rule, { includeExpiration = false } = {}) {
  const prefix = rule.id ? `#${rule.id} ` : '';
  const expiration = includeExpiration ? formatAlertTimestamp(rule.expiresAt) : null;
  const suffix = expiration ? ` (expires ${expiration})` : '';
  return `${prefix}${rule.conditionText} -> ${rule.actionText}${suffix}`;
}

export function formatDecisionTreeAlertHit(rule, price) {
  return htmlMessage([
    `<b>Decision-tree alert hit: ${escapeTelegramHtml(rule.symbol)}</b>`,
    `<b>Price:</b> <code>${escapeTelegramHtml(formatAlertPrice(price))}</code>`,
    `<b>Condition:</b> <code>${escapeTelegramHtml(rule.conditionText)}</code>`,
    `<b>Plan:</b> ${escapeTelegramHtml(rule.actionText)}`,
    rule.expiresAt ? `<b>Expires:</b> <code>${escapeTelegramHtml(formatTelegramDate(rule.expiresAt))}</code>` : '',
  ].filter(Boolean).join('\n'));
}

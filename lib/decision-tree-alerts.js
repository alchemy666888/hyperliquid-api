import {
  formatTelegramDate,
  telegramTableMessage,
} from './telegram-format.js';
import { getDeepSeekConfig, requestDeepSeekJson } from './deepseek-client.js';

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

function hasSupportedSemanticIntent(line) {
  return /\b(above|below|between|holds?|rejects?|tests?|reclaims?|pullbacks?|pulls?\s+back\s+to|closes?)\b/i.test(line);
}

function deterministicParseNeedsAi(input, parsed) {
  if (!parsed.rules.length) return true;
  const conditionLines = String(input ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !stripCodeFence(line))
    .filter(line => line.includes('?'));

  return conditionLines.some(line => !hasSupportedSemanticIntent(line));
}

function normalizeAiConditionKind(value) {
  const kind = String(value ?? '').trim().toLowerCase();
  return ['above', 'below', 'between'].includes(kind) ? kind : '';
}

function normalizeAiRule(rule, assets) {
  const conditionKind = normalizeAiConditionKind(rule?.conditionKind);
  const symbol = resolveAlertSymbol(rule?.symbol, assets);
  const conditionText = String(rule?.conditionText ?? '').trim();
  const actionText = String(rule?.actionText ?? '').trim();
  const lowerPrice = rule?.lowerPrice == null ? null : parsePrice(rule.lowerPrice);
  const upperPrice = rule?.upperPrice == null ? null : parsePrice(rule.upperPrice);

  if (!symbol || !conditionText || !conditionKind || !actionText) return null;
  if (conditionKind === 'above' && lowerPrice == null) return null;
  if (conditionKind === 'below' && upperPrice == null) return null;
  if (conditionKind === 'between' && (lowerPrice == null || upperPrice == null)) return null;

  const range = conditionKind === 'between' ? normalizeRange(lowerPrice, upperPrice) : {};
  return {
    symbol,
    conditionText,
    conditionKind,
    lowerPrice: conditionKind === 'below' ? null : (range.lowerPrice ?? lowerPrice),
    upperPrice: conditionKind === 'above' ? null : (range.upperPrice ?? upperPrice),
    actionText,
  };
}

function normalizeAiRules(json, assets) {
  const rawRules = Array.isArray(json?.rules) ? json.rules : [];
  return rawRules.map(rule => normalizeAiRule(rule, assets)).filter(Boolean);
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
  const rows = [
    ['Symbol', rule.symbol],
    ['Price', formatAlertPrice(price)],
    ['Condition', rule.conditionText],
    ['Plan', rule.actionText],
  ];

  if (rule.expiresAt) {
    rows.push(['Expires', formatTelegramDate(rule.expiresAt)]);
  }

  return telegramTableMessage('Decision-tree alert hit', rows);
}


export async function parseDecisionTreeAlertTextWithAi(input, { assets = [], deepSeekRequest = requestDeepSeekJson } = {}) {
  const deterministic = parseDecisionTreeAlertText(input, { assets });
  if (!deterministic.errors.length && !deterministicParseNeedsAi(input, deterministic)) {
    return { ...deterministic, source: 'deterministic', aiAttempted: false, aiNeeded: false };
  }

  const config = getDeepSeekConfig();
  if (!config.configured) {
    return {
      ...deterministic,
      source: 'deterministic',
      aiAttempted: false,
      aiNeeded: true,
      aiUnavailable: true,
      aiMessage: `AI parsing needs ${config.missing.join(', ')}. Saved deterministic rules only if any were recognized.`,
    };
  }

  const assetLabels = assets.map(asset => asset.label).filter(Boolean).join(', ');
  const response = await deepSeekRequest({
    temperature: 0,
    maxTokens: 1400,
    messages: [
      {
        role: 'system',
        content: [
          'Extract decision-tree trading alerts as strict JSON only.',
          'Return an object with a rules array.',
          'Each rule must have symbol, conditionText, conditionKind, lowerPrice, upperPrice, actionText.',
          'conditionKind must be one of above, below, between.',
          'Use null for unused price bounds. Do not include confidence or explanations.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Tracked symbols: ${assetLabels || 'unknown'}\n\nAlert text:\n${String(input ?? '')}`,
      },
    ],
  });

  if (!response.ok) {
    return {
      ...deterministic,
      source: 'deterministic',
      aiAttempted: true,
      aiNeeded: true,
      aiMessage: response.error || 'AI parsing failed.',
    };
  }

  const rules = normalizeAiRules(response.json, assets);
  if (!rules.length) {
    return {
      ...deterministic,
      source: 'deterministic',
      aiAttempted: true,
      aiNeeded: true,
      aiMessage: 'AI parsing returned no valid rules.',
    };
  }

  return { rules, errors: [], source: 'ai', aiAttempted: true, aiNeeded: true };
}

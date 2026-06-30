import { matchesDecisionTreeRule, normalizeAlertSymbol } from './decision-tree-alerts.js';
import { requestDeepSeekJson } from './deepseek-client.js';

function deterministicClassification({ asset, currentPrice, activeRules }) {
  const matchedRules = activeRules.filter(rule => matchesDecisionTreeRule(rule, currentPrice));
  const primary = matchedRules[0];
  return {
    symbol: asset?.symbol ?? activeRules[0]?.symbol ?? '',
    currentCondition: primary?.conditionText ?? 'No saved rule currently matches price.',
    matchedRuleIds: matchedRules.map(rule => rule.id).filter(id => id != null),
    decision: primary?.actionText ?? 'No saved decision-tree action is active at the current price.',
    reasoningSummary: matchedRules.length
      ? `Current price matches ${matchedRules.length} saved deterministic rule${matchedRules.length === 1 ? '' : 's'}.`
      : 'Current price does not match any active saved deterministic rule.',
    confidence: matchedRules.length ? 0.7 : 0.55,
    price: Number(currentPrice),
    source: 'deterministic',
  };
}

function normalizeMatchedIds(value, activeRules) {
  if (!Array.isArray(value)) return [];
  const validIds = new Set(activeRules.map(rule => String(rule.id)).filter(id => id !== 'undefined'));
  return value.filter(id => validIds.has(String(id)));
}

function validateClassification(value, activeRules, fallback) {
  if (!value || typeof value !== 'object') throw new Error('classification must be an object');
  const confidence = Number(value.confidence);
  const price = Number(value.price);
  return {
    symbol: normalizeAlertSymbol(value.symbol) || fallback.symbol,
    currentCondition: String(value.currentCondition || fallback.currentCondition).slice(0, 240),
    matchedRuleIds: normalizeMatchedIds(value.matchedRuleIds, activeRules),
    decision: String(value.decision || fallback.decision).slice(0, 240),
    reasoningSummary: String(value.reasoningSummary || fallback.reasoningSummary).slice(0, 320),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : fallback.confidence,
    price: Number.isFinite(price) ? price : fallback.price,
    source: 'deepseek',
  };
}

export async function classifyAssetDecisionTreeCondition({
  asset,
  currentPrice,
  indicators = {},
  activeRules = [],
  rawTree = '',
  deepSeekJson = requestDeepSeekJson,
} = {}) {
  const price = Number(currentPrice ?? asset?.price);
  const rules = Array.isArray(activeRules) ? activeRules : [];
  const fallback = deterministicClassification({ asset, currentPrice: price, activeRules: rules });

  try {
    const result = await deepSeekJson({
      messages: [
        {
          role: 'system',
          content: 'Classify a saved trading decision tree against the current asset snapshot. Return strict JSON only with symbol, currentCondition, matchedRuleIds, decision, reasoningSummary, confidence, and price.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            assetSnapshot: asset,
            currentPrice: price,
            indicators,
            activeSavedRules: rules,
            rawTree,
          }),
        },
      ],
    });
    return validateClassification(result, rules, fallback);
  } catch (error) {
    return {
      ...fallback,
      reasoningSummary: `${fallback.reasoningSummary} AI classification unavailable; used saved price-rule matching.`,
      error: error.message,
    };
  }
}

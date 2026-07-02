import {
  normalizeAlertSymbol,
  normalizeConditionKind,
  SUPPORTED_PRICE_KINDS,
  SUPPORTED_TECHNICAL_KINDS,
} from './decision-tree-alerts.js';

function parseNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(String(value).replaceAll(',', '').replace(/^\$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolvePlanAlertSymbol(symbol, assets = []) {
  const input = normalizeAlertSymbol(String(symbol ?? '').replace(/^xyz:/i, ''));
  const match = assets.find(asset => {
    const label = normalizeAlertSymbol(asset.label);
    const coin = normalizeAlertSymbol(String(asset.coin ?? '').replace(/^xyz:/i, ''));
    const base = label.endsWith('USDT') ? label.slice(0, -4) : label;
    return input === label || input === coin || input === base;
  });

  return match?.label ?? input;
}

function conditionTextFor(condition, symbol, conditionKind, lowerPrice, upperPrice, threshold) {
  const text = String(condition?.conditionText ?? condition?.text ?? '').trim();
  if (text) return text;

  if (conditionKind === 'above') return `${symbol} above ${lowerPrice}?`;
  if (conditionKind === 'below') return `${symbol} below ${upperPrice}?`;
  if (conditionKind === 'between') return `${symbol} between ${lowerPrice} and ${upperPrice}?`;
  if (conditionKind === 'rsi_below') return `${symbol} RSI(14) below ${threshold}?`;
  if (conditionKind === 'rsi_above') return `${symbol} RSI(14) above ${threshold}?`;
  if (conditionKind === 'macd_cross_up') return `${symbol} MACD crosses up on 4H?`;
  if (conditionKind === 'macd_cross_down') return `${symbol} MACD crosses down on 4H?`;
  if (conditionKind === 'ema_cross_up') return `${symbol} EMA20 crosses above EMA50?`;
  if (conditionKind === 'ema_cross_down') return `${symbol} EMA20 crosses below EMA50?`;
  return `${symbol} plan condition?`;
}

function actionTextFor(condition, conditionText) {
  return String(
    condition?.actionText
      ?? condition?.action
      ?? condition?.label
      ?? condition?.title
      ?? conditionText
  ).trim();
}

function normalizePriceRule(condition, symbol, conditionKind) {
  const rawLower = condition?.lowerPrice ?? condition?.lower ?? condition?.price ?? condition?.threshold;
  const rawUpper = condition?.upperPrice ?? condition?.upper ?? condition?.price ?? condition?.threshold;
  const lowerPrice = parseNumber(rawLower);
  const upperPrice = parseNumber(rawUpper);
  const abovePrice = lowerPrice ?? upperPrice;
  const belowPrice = upperPrice ?? lowerPrice;

  if (conditionKind === 'above' && abovePrice == null) {
    return { error: 'missing-price-bound' };
  }

  if (conditionKind === 'below' && belowPrice == null) {
    return { error: 'missing-price-bound' };
  }

  if (conditionKind === 'between' && (lowerPrice == null || upperPrice == null)) {
    return { error: 'missing-price-bound' };
  }

  const range = conditionKind === 'between'
    ? {
        lowerPrice: Math.min(lowerPrice, upperPrice),
        upperPrice: Math.max(lowerPrice, upperPrice),
      }
    : null;
  const finalLower = conditionKind === 'above' ? abovePrice : (range?.lowerPrice ?? null);
  const finalUpper = conditionKind === 'below' ? belowPrice : (range?.upperPrice ?? null);
  const conditionText = conditionTextFor(condition, symbol, conditionKind, finalLower, finalUpper, null);
  const actionText = actionTextFor(condition, conditionText);

  if (!actionText) return { error: 'missing-action-text' };

  return {
    rule: {
      symbol,
      conditionText,
      conditionKind,
      lowerPrice: finalLower,
      upperPrice: finalUpper,
      actionText,
      indicatorParams: null,
    },
  };
}

function indicatorParam(condition, key) {
  return condition?.indicatorParams?.[key] ?? condition?.[key] ?? null;
}

function normalizeTechnicalRule(condition, symbol, conditionKind) {
  const threshold = parseNumber(indicatorParam(condition, 'threshold'));
  const fast = parseNumber(indicatorParam(condition, 'fast'));
  const slow = parseNumber(indicatorParam(condition, 'slow'));
  let indicatorParams;

  if (conditionKind === 'rsi_below' || conditionKind === 'rsi_above') {
    if (threshold == null) return { error: 'missing-indicator-threshold' };
    indicatorParams = { kind: 'rsi', threshold, fast: null, slow: null };
  } else if (conditionKind === 'macd_cross_up' || conditionKind === 'macd_cross_down') {
    indicatorParams = { kind: 'macd', threshold: null, fast: fast ?? 12, slow: slow ?? 26 };
  } else {
    indicatorParams = { kind: 'ema', threshold: null, fast: fast ?? 20, slow: slow ?? 50 };
  }

  const conditionText = conditionTextFor(
    condition,
    symbol,
    conditionKind,
    null,
    null,
    indicatorParams.threshold,
  );
  const actionText = actionTextFor(condition, conditionText);
  if (!actionText) return { error: 'missing-action-text' };

  return {
    rule: {
      symbol,
      conditionText,
      conditionKind,
      lowerPrice: null,
      upperPrice: null,
      actionText,
      indicatorParams,
    },
  };
}

export function normalizePlanRulesToAlerts(planConditions, { assets = [], symbol } = {}) {
  const conditions = Array.isArray(planConditions) ? planConditions : [];
  const resolvedSymbol = resolvePlanAlertSymbol(symbol, assets);
  const rules = [];
  const rejected = [];

  for (const condition of conditions) {
    const conditionKind = normalizeConditionKind(condition?.conditionKind ?? condition?.kind);
    if (!conditionKind) {
      rejected.push({ condition, reason: 'unsupported-condition-kind' });
      continue;
    }

    const normalized = SUPPORTED_PRICE_KINDS.has(conditionKind)
      ? normalizePriceRule(condition, resolvedSymbol, conditionKind)
      : SUPPORTED_TECHNICAL_KINDS.has(conditionKind)
        ? normalizeTechnicalRule(condition, resolvedSymbol, conditionKind)
        : { error: 'unsupported-condition-kind' };

    if (normalized.rule) {
      rules.push(normalized.rule);
    } else {
      rejected.push({ condition, reason: normalized.error ?? 'invalid-condition' });
    }
  }

  return { rules, rejected };
}

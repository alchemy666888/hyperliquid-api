import {
  formatDecisionTreeAlertHit,
  matchesDecisionTreeRule,
  normalizeAlertSymbol,
} from './decision-tree-alerts.js';
import {
  expireDecisionTreeAlerts,
  getActiveDecisionTreeAlerts,
  updateDecisionTreeAlertEvaluation,
} from './postgres.js';

function snapshotPriceMap(snapshot) {
  const prices = new Map();

  for (const [symbol, price] of Object.entries(snapshot?.prices ?? {})) {
    prices.set(normalizeAlertSymbol(symbol), price);
  }

  for (const asset of snapshot?.assets ?? []) {
    prices.set(normalizeAlertSymbol(asset.symbol), asset.price);
    prices.set(normalizeAlertSymbol(asset.coin), asset.price);
  }

  return prices;
}

function snapshotIndicatorMap(snapshot) {
  const indicators = new Map();

  for (const asset of snapshot?.assets ?? []) {
    indicators.set(normalizeAlertSymbol(asset.symbol), asset.indicators ?? null);
    indicators.set(normalizeAlertSymbol(asset.coin), asset.indicators ?? null);
  }

  return indicators;
}

export async function processDecisionTreeAlerts(snapshot, notify, deps = {}) {
  const expired = await (deps.expireDecisionTreeAlerts ?? expireDecisionTreeAlerts)();
  const rules = await (deps.getActiveDecisionTreeAlerts ?? getActiveDecisionTreeAlerts)();
  const prices = snapshotPriceMap(snapshot);
  const indicators = snapshotIndicatorMap(snapshot);
  const result = {
    enabled: true,
    checked: 0,
    triggered: 0,
    skipped: 0,
    expired,
    notificationFailures: 0,
  };

  for (const rule of rules) {
    const symbol = normalizeAlertSymbol(rule.symbol);
    const price = prices.get(symbol);
    if (price == null) {
      result.skipped += 1;
      continue;
    }

    result.checked += 1;
    const indicatorsForSymbol = indicators.get(symbol);
    const matched = matchesDecisionTreeRule(rule, price, indicatorsForSymbol);
    const triggered = matched && !rule.lastMatched;

    await (deps.updateDecisionTreeAlertEvaluation ?? updateDecisionTreeAlertEvaluation)({
      id: rule.id,
      matched,
      price,
      triggered,
    });

    if (!triggered) continue;

    try {
      await notify(rule.chatId, formatDecisionTreeAlertHit(rule, price));
      result.triggered += 1;
    } catch (error) {
      result.notificationFailures += 1;
      console.error(`decision-tree alert notify failed for ${rule.id}:`, error);
    }
  }

  return result;
}

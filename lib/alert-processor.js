import {
  formatDecisionTreeAlertHit,
  matchesDecisionTreeRule,
  normalizeAlertSymbol,
} from './decision-tree-alerts.js';
import {
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

export async function processDecisionTreeAlerts(snapshot, notify) {
  const rules = await getActiveDecisionTreeAlerts();
  const prices = snapshotPriceMap(snapshot);
  const result = {
    enabled: true,
    checked: 0,
    triggered: 0,
    skipped: 0,
    notificationFailures: 0,
  };

  for (const rule of rules) {
    const price = prices.get(normalizeAlertSymbol(rule.symbol));
    if (price == null) {
      result.skipped += 1;
      continue;
    }

    result.checked += 1;
    const matched = matchesDecisionTreeRule(rule, price);
    const triggered = matched && !rule.lastMatched;

    await updateDecisionTreeAlertEvaluation({
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

export const STATUSES = new Set(['live', 'stale', 'partial', 'unavailable', 'error']);

export function toIso(ms) {
  if (ms == null) return null;
  const date = ms instanceof Date ? ms : new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function ageMs(asOf, now = Date.now()) {
  const time = asOf == null ? NaN : new Date(asOf).getTime();
  return Number.isFinite(time) ? Math.max(0, now - time) : null;
}

export function providerMeta({ source, asOf, receivedAt, status = 'live', method, reason = null, now = Date.now() }) {
  const normalizedStatus = STATUSES.has(status) ? status : 'error';
  return {
    source,
    asOf: toIso(asOf),
    receivedAt: toIso(receivedAt ?? now),
    ageMs: ageMs(asOf, now),
    status: normalizedStatus,
    method,
    reason,
  };
}

export function unavailableProvider({ source, method, reason, now = Date.now() }) {
  return providerMeta({ source, asOf: null, receivedAt: now, status: 'unavailable', method, reason, now });
}

export function emptyMetricWindows(windows = ['5m', '15m', '1h']) {
  return Object.fromEntries(windows.map(window => [window, {
    longLiquidationUsd: null,
    shortLiquidationUsd: null,
    totalLiquidationUsd: null,
    eventCount: null,
    largestLiquidationUsd: null,
    lastEventTimestamp: null,
  }]));
}

export function buildQuality({ startedAt, finishedAt = Date.now(), providers = {}, warnings = [], missingFields = [], schemaVersion = '2.0' }) {
  const statuses = Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, {
    status: value?.status ?? 'unavailable',
    asOf: value?.asOf ?? null,
    ageMs: value?.ageMs ?? null,
    source: value?.source ?? name,
    reason: value?.reason ?? null,
  }]));
  const providerStatuses = Object.values(statuses).map(v => v.status);
  const completeness = missingFields.length === 0 && providerStatuses.every(s => s === 'live');
  const status = completeness ? 'live' : providerStatuses.some(s => s === 'live' || s === 'partial') ? 'partial' : 'unavailable';
  return { status, completeness, missingFields, warnings, sources: statuses, generationDurationMs: finishedAt - startedAt, schemaVersion };
}

export async function withTimeout(task, ms, label, { AbortControllerImpl = AbortController } = {}) {
  const controller = new AbortControllerImpl();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await task(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${ms}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

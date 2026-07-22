import { getLatestHyperliquidSnapshot, getPostgresStatus, saveHyperliquidSnapshot } from './postgres.js';
import { refreshMarketDataAndProcessAlerts } from './alert-runner.js';
import { buildBtcIntradaySnapshot } from './btc-intraday.js';

export function createHyperliquidApiService(deps = {}) {
  const refreshMarketData = deps.refreshMarketDataAndProcessAlerts ?? refreshMarketDataAndProcessAlerts;
  const buildBtcIntraday = deps.buildBtcIntradaySnapshot ?? buildBtcIntradaySnapshot;
  const postgresStatus = deps.getPostgresStatus ?? getPostgresStatus;
  const latestSnapshot = deps.getLatestHyperliquidSnapshot ?? getLatestHyperliquidSnapshot;
  const saveSnapshot = deps.saveHyperliquidSnapshot ?? saveHyperliquidSnapshot;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  async function getLegacyHyperliquidSnapshot() {
    const { snapshot, alerts } = await refreshMarketData();
    return { body: { ...snapshot, alerts }, cacheControl: 's-maxage=60, stale-while-revalidate=120' };
  }

  async function getBtcIntradayMarketData() {
    const { snapshot, alerts } = await refreshMarketData();
    const enriched = { ...snapshot, ...(await buildBtcIntraday()), alerts };
    const status = postgresStatus();
    if (status.configured) {
      try {
        const persisted = await saveSnapshot(enriched);
        enriched.persistence = { enabled: true, saved: Boolean(persisted), id: persisted?.id, capturedAt: persisted?.capturedAt };
      } catch (error) {
        logger.error?.('postgres enriched snapshot save error:', error);
        enriched.persistence = { enabled: true, saved: false, error: 'PostgreSQL persistence failed' };
      }
    }
    return { body: enriched, cacheControl: 's-maxage=5, stale-while-revalidate=10' };
  }

  async function getLatestStoredBtcIntradaySnapshot(options = {}) {
    const status = postgresStatus();
    if (!status.configured) {
      return {
        statusCode: 503,
        body: { error: 'PostgreSQL persistence is not configured', persistence: status, timestamp: now().toISOString(), status: 'error' },
      };
    }

    const latest = await latestSnapshot();
    if (!latest) {
      return { statusCode: 404, body: { error: 'No persisted Hyperliquid snapshot found', timestamp: now().toISOString(), status: 'error' } };
    }

    const storedSnapshot = { ...latest.snapshot };
    if (options.btcIntradayProfile !== false && !storedSnapshot.btcIntraday) {
      storedSnapshot.schemaVersion = storedSnapshot.schemaVersion ?? '2.0';
      storedSnapshot.btcIntraday = {
        symbol: 'BTCUSDT',
        asOf: now().toISOString(),
        timeframes: {},
        perpetual: {},
        liquidations: {},
        options: {},
        quality: {
          status: 'unavailable',
          completeness: false,
          missingFields: ['btcIntraday'],
          warnings: ['Latest stored snapshot is legacy-only; btcIntraday profile is unavailable in this record.'],
          sources: {},
          generationDurationMs: 0,
          schemaVersion: '2.0',
        },
      };
    }

    return {
      body: {
        ...storedSnapshot,
        persistence: { enabled: true, saved: true, id: latest.id, capturedAt: latest.capturedAt },
      },
      cacheControl: 's-maxage=5, stale-while-revalidate=10',
    };
  }

  return { getLegacyHyperliquidSnapshot, getBtcIntradayMarketData, getLatestStoredBtcIntradaySnapshot };
}

export const hyperliquidApiService = createHyperliquidApiService();

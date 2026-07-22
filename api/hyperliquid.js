import '../lib/telegram-log-forwarder.js';
// Hyperliquid market-data endpoint for the AI trading prompt.
// Returns price + 4H technicals (ADX, RSI, MACD, EMA20/50, BB, ATR, volume)
// + a coarse regime classification for each of the 12 prompt assets.

import { getLatestHyperliquidSnapshot, getPostgresStatus, saveHyperliquidSnapshot } from '../lib/postgres.js';
import { refreshMarketDataAndProcessAlerts } from '../lib/alert-runner.js';
import { buildBtcIntradaySnapshot } from '../lib/btc-intraday.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const profile = String(req.query?.profile ?? '').trim();
    const btcIntradayProfile = profile === 'btc-intraday';

    if (req.query?.stored === 'latest') {
      const postgresStatus = getPostgresStatus();
      if (!postgresStatus.configured) {
        res.status(503).json({
          error: 'PostgreSQL persistence is not configured',
          persistence: postgresStatus,
          timestamp: new Date().toISOString(),
          status: 'error',
        });
        return;
      }

      const latest = await getLatestHyperliquidSnapshot();
      if (!latest) {
        res.status(404).json({
          error: 'No persisted Hyperliquid snapshot found',
          timestamp: new Date().toISOString(),
          status: 'error',
        });
        return;
      }

      res.setHeader('Cache-Control', btcIntradayProfile ? 's-maxage=5, stale-while-revalidate=10' : 's-maxage=30, stale-while-revalidate=60');
      const storedSnapshot = { ...latest.snapshot };
      if (btcIntradayProfile && !storedSnapshot.btcIntraday) {
        storedSnapshot.schemaVersion = storedSnapshot.schemaVersion ?? '2.0';
        storedSnapshot.btcIntraday = {
          symbol: 'BTCUSDT',
          asOf: new Date().toISOString(),
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
      res.json({
        ...storedSnapshot,
        persistence: {
          enabled: true,
          saved: true,
          id: latest.id,
          capturedAt: latest.capturedAt,
        },
      });
      return;
    }

    const { snapshot, alerts } = await refreshMarketDataAndProcessAlerts();

    if (btcIntradayProfile) {
      const enriched = { ...snapshot, ...(await buildBtcIntradaySnapshot()), alerts };
      const postgresStatus = getPostgresStatus();
      if (postgresStatus.configured) {
        try {
          const persisted = await saveHyperliquidSnapshot(enriched);
          enriched.persistence = { enabled: true, saved: Boolean(persisted), id: persisted?.id, capturedAt: persisted?.capturedAt };
        } catch (error) {
          console.error('postgres enriched snapshot save error:', error);
          enriched.persistence = { enabled: true, saved: false, error: 'PostgreSQL persistence failed' };
        }
      }
      res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
      res.json(enriched);
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.json({ ...snapshot, alerts });
  } catch (error) {
    console.error('handler error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'error',
    });
  }
}

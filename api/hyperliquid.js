// Hyperliquid market-data endpoint for the AI trading prompt.
// Returns price + 4H technicals (ADX, RSI, MACD, EMA20/50, BB, ATR, volume)
// + a coarse regime classification for each of the 12 prompt assets.

import { getHyperliquidSnapshot } from '../lib/hyperliquid.js';
import { getLatestHyperliquidSnapshot, getPostgresStatus } from '../lib/postgres.js';
import { processDecisionTreeAlerts } from '../lib/alert-processor.js';
import { sendTelegramMessage } from '../lib/telegram-client.js';

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

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

      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      res.json({
        ...latest.snapshot,
        persistence: {
          enabled: true,
          saved: true,
          id: latest.id,
          capturedAt: latest.capturedAt,
        },
      });
      return;
    }

    const snapshot = await getHyperliquidSnapshot();
    let alerts = { enabled: false, checked: 0, triggered: 0 };
    const token = readEnv('TELEGRAM_BOT_TOKEN');
    const postgresStatus = getPostgresStatus();
    if (token && postgresStatus.configured) {
      try {
        alerts = await processDecisionTreeAlerts(
          snapshot,
          (chatId, text) => sendTelegramMessage(token, chatId, text),
        );
      } catch (error) {
        console.error('decision-tree alert processing error:', error);
        alerts = {
          enabled: true,
          checked: 0,
          triggered: 0,
          error: 'Decision-tree alert processing failed',
        };
      }
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

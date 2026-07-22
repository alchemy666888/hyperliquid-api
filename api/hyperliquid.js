import '../lib/telegram-log-forwarder.js';
// Hyperliquid market-data endpoint for the AI trading prompt.
// Returns price + 4H technicals (ADX, RSI, MACD, EMA20/50, BB, ATR, volume)
// + a coarse regime classification for each of the 12 prompt assets.

import { hyperliquidApiService } from '../lib/hyperliquid-api-service.js';

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
      const result = await hyperliquidApiService.getLatestStoredBtcIntradaySnapshot({ btcIntradayProfile });
      res.setHeader('Cache-Control', btcIntradayProfile ? result.cacheControl ?? 's-maxage=5, stale-while-revalidate=10' : 's-maxage=30, stale-while-revalidate=60');
      if (result.statusCode) res.status(result.statusCode);
      res.json(result.body);
      return;
    }

    if (btcIntradayProfile) {
      const result = await hyperliquidApiService.getBtcIntradayMarketData();
      res.setHeader('Cache-Control', result.cacheControl);
      res.json(result.body);
      return;
    }

    const result = await hyperliquidApiService.getLegacyHyperliquidSnapshot();
    res.setHeader('Cache-Control', result.cacheControl);
    res.json(result.body);
  } catch (error) {
    console.error('handler error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'error',
    });
  }
}

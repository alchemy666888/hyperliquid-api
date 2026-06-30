// Hyperliquid market-data endpoint for the AI trading prompt.
// Returns price + 4H technicals (ADX, RSI, MACD, EMA20/50, BB, ATR, volume)
// + a coarse regime classification for each of the 12 prompt assets.

import { getHyperliquidSnapshot } from '../lib/hyperliquid.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const snapshot = await getHyperliquidSnapshot();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.json(snapshot);
  } catch (error) {
    console.error('handler error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'error',
    });
  }
}

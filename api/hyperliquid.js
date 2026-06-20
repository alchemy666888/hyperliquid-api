export default async function handler(req, res) {
  try {
    const midsResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    
    if (!midsResponse.ok) {
      throw new Error(`Hyperliquid API returned ${midsResponse.status}`);
    }
    
    const mids = await midsResponse.json();
    
    // Show ALL available symbols
    const allSymbols = Object.keys(mids).sort();
    
    res.json({ 
      timestamp: new Date().toISOString(), 
      totalSymbols: allSymbols.length,
      allSymbols: allSymbols,
      samplePrices: {
        BTC: mids['BTC'],
        HYPE: mids['HYPE'],
        ZEC: mids['ZEC'],
        GOLD: mids['GOLD'],
        CL: mids['CL'],
        AUDUSD: mids['AUDUSD'],
        NVDA: mids['NVDA'],
        MU: mids['MU']
      }
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
export default async function handler(req, res) {
const coins = [
                'BTC',      // Bitcoin
                'HYPE',     // Hyperliquid
                'ZEC',      // Zcash
                'xyz:GOLD',     // Gold (not XAUUSD)
                'xyz:CL',       // Crude Oil (not CLUSD, not WTIOIL)
                'xyz:EURUSD',   // Australian Dollar
                'xyz:NVDA',     // NVIDIA
                'xyz:MU',       // Micron Technology
                'xyz:MRVL',     // Marvell Technology
                'xyz:INTC',     // Intel
                'xyz:SNDK',     // SanDisk
                'xyz:SPCX'      // SpaceX
              ];
  
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
    const filtered = coins.reduce((acc, coin) => {
      acc[coin] = mids[coin];
      return acc;
    }, {});
    
    res.json({ 
      timestamp: new Date().toISOString(), 
      prices: filtered,
      status: 'success'
    });
  } catch (error) {
    console.error('Error fetching Hyperliquid data:', error);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'error'
    });
  }
}
export default async function handler(req, res) {
  const coins = [
    'BTC', 'HYPE', 'ZEC',           // Main DEX (crypto)
    'xyz:GOLD', 'xyz:CL',            // HIP3 DEX (xyz)
    'xyz:EURUSD',
    'xyz:NVDA', 'xyz:MU', 'xyz:MRVL',
    'xyz:INTC', 'xyz:SNDK', 'xyz:SPCX'
  ];
  
  try {
    // Fetch MAIN DEX (crypto)
    const mainResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    
    const mainMids = await mainResponse.json();
    
    // Fetch HIP3 DEX (stocks, commodities, FX)
    const hip3Response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids', dex: 'xyz' })  // ✅ Add dex param
    });
    
    const hip3Mids = await hip3Response.json();
    
    // Combine both
    const allMids = { ...mainMids, ...hip3Mids };
    
    // Filter for your coins
    const filtered = coins.reduce((acc, coin) => {
      if (allMids[coin]) {
        acc[coin] = allMids[coin];
      }
      return acc;
    }, {});
    
    res.json({ 
      timestamp: new Date().toISOString(), 
      prices: filtered,
      status: 'success'
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      status: 'error'
    });
  }
}
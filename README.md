# Hyperliquid Real-Time Data API

A Vercel serverless function that fetches real-time market prices from Hyperliquid exchange for trading analysis.

## Features

- ✅ Fetches live prices from Hyperliquid API
- ✅ Supports 12 trading assets (BTC, HYPE, ZEC, XAUUSD, CLUSD, AUDUSD, NVDA, MU, SPCX, SNDK, INTC, MRVL)
- ✅ Returns JSON with timestamp for synced analysis
- ✅ Error handling & logging
- ✅ CORS enabled for cross-origin requests
- ✅ No authentication required

## Deployment

### Quick Deploy to Vercel

1. Fork/clone this repo
2. Go to [vercel.com](https://vercel.com)
3. Import project → select your GitHub repo
4. Click Deploy
5. Your API is live immediately!

### Manual Setup

```bash
# Clone repo
git clone https://github.com/your-username/hyperliquid-api
cd hyperliquid-api

# Install Vercel CLI (optional)
npm install -g vercel

# Deploy
vercel
```

## API Usage

### Endpoint
```
GET https://hyperliquid-api-xxxxx.vercel.app/api/hyperliquid
```

### Response
```json
{
  "timestamp": "2026-06-20T15:30:45.123Z",
  "prices": {
    "BTC": "67234.50",
    "HYPE": "12.45",
    "ZEC": "89.12",
    "XAUUSD": "2385.30",
    "CLUSD": "72.15",
    "AUDUSD": "0.6875",
    "NVDA": "245.50",
    "MU": "128.75",
    "SPCX": "125.00",
    "SNDK": "89.30",
    "INTC": "32.45",
    "MRVL": "56.80"
  },
  "status": "success"
}
```

### Error Response
```json
{
  "error": "Error message details",
  "timestamp": "2026-06-20T15:30:45.123Z",
  "status": "error"
}
```

## Testing

```bash
# In browser
https://hyperliquid-api-xxxxx.vercel.app/api/hyperliquid

# With curl
curl https://hyperliquid-api-xxxxx.vercel.app/api/hyperliquid

# With fetch
fetch('https://hyperliquid-api-xxxxx.vercel.app/api/hyperliquid')
  .then(r => r.json())
  .then(data => console.log(data))
```

## Configuration

Edit `api/hyperliquid.js` to:
- Add/remove coins from the `coins` array
- Modify response format
- Add logging/analytics

Edit `vercel.json` to:
- Change function memory (128 MB default)
- Adjust timeout (10 seconds default)
- Add environment variables

## Data Source

- **Exchange:** Hyperliquid
- **Endpoint:** https://api.hyperliquid.xyz/info
- **Update Frequency:** Real-time (call as needed)
- **Rate Limit:** No auth required, fair-use policy applies

## Project Structure

```
hyperliquid-api/
├── api/
│   └── hyperliquid.js       # Main serverless function
├── vercel.json              # Vercel configuration
├── .gitignore               # Git ignore rules
└── README.md                # This file
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 404 Not Found | Check file path is `api/hyperliquid.js` |
| 500 Server Error | Check Vercel Logs for details |
| Empty prices | Hyperliquid API might be rate-limited, retry in 30s |
| Slow response | Increase function memory in `vercel.json` |

## License

MIT - Free to use and modify

## Support

For issues, open a GitHub issue or check Vercel deployment logs.
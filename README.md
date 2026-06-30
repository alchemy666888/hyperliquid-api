# Hyperliquid Telegram Bot and Data API

A Vercel serverless project that exposes Hyperliquid market data through both:

- A Telegram bot webhook for quick chat commands
- A JSON API endpoint for integrations and trading analysis

## Features

- Fetches live prices from Hyperliquid
- Computes 4H technical indicators: ADX, RSI, MACD, EMA20/50, Bollinger Bands, ATR, and volume
- Classifies each asset into a coarse market regime
- Supports Telegram commands for market summaries and per-asset details
- Keeps the existing `/api/hyperliquid` JSON endpoint available

## Tracked Assets

`BTCUSDT`, `HYPEUSDT`, `ZECUSDT`, `XAUUSD`, `CLUSD`, `EURUSD`, `NVDA`, `MU`, `SPCX`, `SNDK`, `INTC`, `MRVL`

## Telegram Bot Setup

1. Create a bot with [BotFather](https://t.me/BotFather) and copy the bot token.
2. Add Vercel environment variables (CLI or Dashboard):

```bash
vercel env add TELEGRAM_BOT_TOKEN
vercel env add TELEGRAM_SECRET_TOKEN
```

`TELEGRAM_SECRET_TOKEN` is optional, but recommended. Use a long random string.

Dashboard path: `Project -> Settings -> Environment Variables`.

3. Deploy or redeploy the project so Vercel Functions load the latest values:

```bash
vercel deploy --prod
```

4. Verify env loading (no secrets are exposed):

```text
GET https://your-domain.vercel.app/api/telegram
```

Expected response includes:
- `config.botTokenConfigured: true`
- `config.secretTokenConfigured: true` (if you set secret token)

5. Register the Telegram webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.vercel.app/api/telegram",
    "secret_token": "your-telegram-secret-token"
  }'
```

If you do not set `TELEGRAM_SECRET_TOKEN`, omit `secret_token` from the request.
When `TELEGRAM_SECRET_TOKEN` is set, `/api/telegram` validates `x-telegram-bot-api-secret-token` for every webhook call.

## Telegram Commands

```text
/start
/help
/prices
/asset BTCUSDT
```

`/prices` returns all tracked prices and regimes. `/asset <symbol>` returns a detailed 4H indicator snapshot for one asset.

## API Usage

### Endpoint

```text
GET https://your-domain.vercel.app/api/hyperliquid
```

### Response

```json
{
  "timestamp": "2026-06-20T15:30:45.123Z",
  "interval": "4h",
  "source": "hyperliquid",
  "prices": {
    "BTCUSDT": 67234.5,
    "HYPEUSDT": 12.45
  },
  "assets": [
    {
      "symbol": "BTCUSDT",
      "coin": "BTC",
      "price": 67234.5,
      "regime": "TRENDING_UP",
      "candlesUsed": 200,
      "indicators": {}
    }
  ],
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

## Local Development

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000/api/hyperliquid
http://localhost:3000/api/telegram
```

Telegram webhook delivery requires a public HTTPS URL, so test full bot behavior after deploying to Vercel.

## Project Structure

```text
hyperliquid-api/
├── api/
│   ├── hyperliquid.js       # JSON market-data endpoint
│   └── telegram.js          # Telegram webhook endpoint
├── lib/
│   └── hyperliquid.js       # Shared Hyperliquid fetch + indicator logic
├── public/
│   └── index.html
├── vercel.json
└── README.md
```

## Data Source

- Exchange: Hyperliquid
- Endpoint: `https://api.hyperliquid.xyz/info`
- Update frequency: real-time on request
- Rate limit: no authentication required, fair-use policy applies

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot does not reply | Confirm `/api/telegram` shows `botTokenConfigured: true`, then redeploy. |
| Webhook returns 401 | Check that Telegram `secret_token` matches `TELEGRAM_SECRET_TOKEN`. |
| `/prices` is slow | Hyperliquid candle requests can take several seconds; check Vercel logs. |
| Empty prices | Hyperliquid may be rate-limited or returning no candles; retry later. |
| API 404 | Confirm the deployed URL uses `/api/hyperliquid` or `/api/telegram`. |

## License

MIT - Free to use and modify

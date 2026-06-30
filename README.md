# Hyperliquid Telegram Bot and Data API

A Vercel serverless project that exposes Hyperliquid market data through both:

- A Telegram bot webhook for quick chat commands
- A JSON API endpoint for integrations and trading analysis

## Features

- Fetches live prices from Hyperliquid
- Computes 4H technical indicators: ADX, RSI, MACD, EMA20/50, Bollinger Bands, ATR, and volume
- Classifies each asset into a coarse market regime
- Persists Hyperliquid snapshots and 24-hour Telegram decision-tree alerts to PostgreSQL when Vercel database env vars are configured
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

## PostgreSQL Persistence Setup

The API stores each successful Hyperliquid snapshot in PostgreSQL JSONB when database environment variables are present.

Add these variables in Vercel (`Project -> Settings -> Environment Variables`):

```bash
vercel env add POSTGRES_HOST
vercel env add POSTGRES_PORT
vercel env add POSTGRES_USER
vercel env add POSTGRES_PASSWORD
vercel env add POSTGRES_DATABASE
```

`POSTGRES_USERNAME` can be used instead of `POSTGRES_USER`, and `POSTGRES_DB` can be used instead of `POSTGRES_DATABASE`.

Optional variables:

```bash
vercel env add POSTGRES_SSL
vercel env add POSTGRES_MAX_CONNECTIONS
```

`POSTGRES_SSL` defaults to enabled on Vercel. `POSTGRES_MAX_CONNECTIONS` defaults to `1`, which keeps serverless database usage conservative.

The persistence layer creates this table and index automatically on first use:

```sql
CREATE TABLE IF NOT EXISTS hyperliquid_snapshots (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  interval TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'success',
  snapshot JSONB NOT NULL
);
```

Configuration can be checked without exposing secrets:

```text
GET https://your-domain.vercel.app/api/telegram
```

Expected response includes `config.postgres.configured: true` after all database env vars are set.

## Telegram Commands

```text
/start
/help
/prices
/asset BTCUSDT
/treealert
/condition MU
/alerts
/clearalerts [MU]
```

`/prices` returns all tracked prices and regimes. `/asset <symbol>` returns a detailed 4H indicator snapshot for one asset. `/condition <symbol>` (or `/treecondition <symbol>`) classifies the current price against that chat's saved decision tree.

### Decision-tree alerts

Use `/treealert` followed by a pasted decision tree to save price alerts for the current Telegram chat:

```text
/treealert
MU above $1,164 and holds?
→ Long toward $1,198, then $1,220–$1,228, then $1,249–$1,255.

MU rejects $1,155–$1,164?
→ No long. Wait for pullback to $1,126–$1,116.

MU holds $1,126–$1,116?
→ Tactical long with stop at $1,108.

MU closes below $1,111?
→ Bearish breakdown. Short toward $1,059–$1,056, then $1,025.

MU between $1,126 and $1,164?
→ No trade.
```

Supported condition styles are `above`, `below`/`closes below`, `between`, and range conditions such as `holds $1,126–$1,116` or `rejects $1,155–$1,164`.

Alerts expire 24 hours after they are saved, or sooner when cancelled with `/clearalerts [symbol]`. Active alerts are scoped to the Telegram chat that created them; `/alerts`, `/clearalerts`, and alert notifications only use that chat's saved alerts.

Run the JavaScript alert scheduler to fetch the latest prices and process active alerts every 10 minutes. The bot sends a Telegram message when a saved condition changes from inactive to active, then rearms after the price leaves that condition. Use `/alerts` to list active alerts, `/condition [symbol]` to inspect the current matched tree condition and AI plan, and `/clearalerts [symbol]` to deactivate them manually.

```bash
npm run alert-scheduler
```

The scheduler is a long-running Node process. Set `ALERT_SCHEDULER_INTERVAL_MS` to override the default 10-minute interval.

## API Usage

### Endpoint

```text
GET https://your-domain.vercel.app/api/hyperliquid
```

Fetches live market data and saves the snapshot to PostgreSQL when configured.
Manual requests to this endpoint also process active alerts. For automatic alert checks, run the JavaScript scheduler with `npm run alert-scheduler`.

```text
GET https://your-domain.vercel.app/api/hyperliquid?stored=latest
```

Returns the latest PostgreSQL snapshot without fetching fresh market data.

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
  "status": "success",
  "persistence": {
    "enabled": true,
    "saved": true,
    "id": "1",
    "capturedAt": "2026-06-20T15:30:45.123Z"
  }
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
│   ├── hyperliquid.js       # Shared Hyperliquid fetch + indicator logic
│   └── postgres.js          # PostgreSQL persistence helpers
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
| Snapshots are not saved | Confirm `/api/telegram` shows `config.postgres.configured: true`, then redeploy. |
| `/prices` is slow | Hyperliquid candle requests can take several seconds; check Vercel logs. |
| Empty prices | Hyperliquid may be rate-limited or returning no candles; retry later. |
| API 404 | Confirm the deployed URL uses `/api/hyperliquid` or `/api/telegram`. |

## License

MIT - Free to use and modify

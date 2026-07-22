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
vercel env add TELEGRAM_BOT_USERNAME
vercel env add TELEGRAM_SECRET_TOKEN
vercel env add TG_LOG_CHAT_ID
```

`TELEGRAM_BOT_USERNAME` is the bot username from BotFather, without or with the leading `@`.
It is recommended for group and supergroup chats so the bot can recognize mentions and commands
targeted to it, such as `@YourBotUsername say something` or `/help@YourBotUsername`. If this value
is omitted, this project recognizes `@trading_alchemist_bot` by default. The bot ignores normal
group messages, bare group slash commands, and reply-only messages that do not explicitly mention
the bot.
`TELEGRAM_SECRET_TOKEN` is optional, but recommended. Use a long random string.
`TG_LOG_CHAT_ID` is optional. When it is set with `TELEGRAM_BOT_TOKEN`, Vercel function and scheduler `console.debug`, `console.log`, `console.info`, `console.warn`, and `console.error` messages are also forwarded to that Telegram chat.

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


## AI Model Setup

The bot uses the configured AI provider for `/condition <symbol>` classification, `/rsh` research, and normal no-command AI chat. No-command chat is stateless: each reply only uses the current user message, SearchApi.io results when the request needs current market/news data, and fresh Hyperliquid market context when the message is trading-related or mentions a tracked symbol, even though the raw communication history is persisted when PostgreSQL is configured.

Choose the provider with `AI_MODEL_PROVIDER`. Supported values are `DEEPSEEK` and `CLAUDE`; if this variable is omitted, the bot keeps the existing default of `DEEPSEEK`.

```bash
vercel env add AI_MODEL_PROVIDER
```

Required variable for DeepSeek:

```bash
vercel env add DEEPSEEK_API_KEY
```

Required variable for Claude:

```bash
vercel env add CLAUDE_API_KEY
```

Optional DeepSeek variables:

```bash
vercel env add DEEPSEEK_BASE_URL
vercel env add DEEPSEEK_MODEL
```

Use DeepSeek API model IDs such as `deepseek-chat`, `deepseek-v4-pro`, or `deepseek-v4-flash` for `DEEPSEEK_MODEL`. Descriptive UI-style names like `deepseek-v4-pro-thinking-search` are normalized to `deepseek-v4-pro` before API calls so Vercel env vars copied from product labels do not trigger DeepSeek HTTP 400 responses.

Optional Claude variables:

```bash
vercel env add CLAUDE_BASE_URL
vercel env add CLAUDE_MODEL
vercel env add CLAUDE_EXTRACTOR_MODEL
vercel env add CLAUDE_ANTHROPIC_VERSION
```

Optional weather variable for bare weather questions such as `今天天气如何`:

```bash
vercel env add DEFAULT_WEATHER_LOCATION
```

Weather forecast times and Telegram timestamps are rendered in Hong Kong Time (`Asia/Hong_Kong`, `HKT`).

Required SearchApi.io variable for `/rsh` and current market/news chat when using the default search provider:

```bash
vercel env add SEARCHAPI_API_KEY
```

To use Tinyfish instead of SearchApi.io, set the provider and store the Tinyfish API key as Vercel environment variables:

```bash
vercel env add SEARCH_PROVIDER       # TINYFISH
vercel env add TINYFISH_API_KEY
```

Tinyfish calls `https://api.search.tinyfish.ai?query=...` with the API key in the `X-API-Key` header. `TINYFISH_SEARCH_API_KEY` is also accepted as a fallback variable name.

To use the `websearch-deepseek` MCP server instead of SearchApi.io, expose that MCP server through a streamable HTTP JSON-RPC endpoint and set:

```bash
vercel env add SEARCH_PROVIDER              # WEBSEARCH_DEEPSEEK
vercel env add WEBSEARCH_DEEPSEEK_MCP_URL  # e.g. https://your-mcp-host.example.com/mcp
```

`WEBSEARCH_DEEPSEEK_TOOL` is optional and defaults to `web_search`. If your MCP gateway requires static headers, store a JSON object in `WEBSEARCH_DEEPSEEK_MCP_HEADERS`. This lets `/rsh` and current market/news chat use DeepSeek-backed web search without consuming SearchApi.io credits.

Market/news research uses a query-tuning layer before the configured search provider. The bot first extracts clean keywords and freshness parameters, then calls SearchApi.io with `engine=google_news`, deliberate locale params, and chronological `tbs` filtering, calls Tinyfish with the normalized `query`, or calls `websearch-deepseek` MCP with the same normalized query. The raw chat sentence is preserved for the final AI analysis prompt, but it is not sent to SearchApi directly except as a malformed-extractor fallback.

No-command AI chat performs configured-provider web searches only when the request appears to need current market/news data. Casual chat and weather requests do not burn search credits. Trading, price, indicator, and tracked-symbol questions also use the existing Hyperliquid snapshot as the market source of truth. Set `SEARCH_PROVIDER=TINYFISH` and `TINYFISH_API_KEY` to use Tinyfish. Set `SEARCHAPI_ENGINE` to change the default SearchApi.io engine; it defaults to `google_news`. Set `SEARCHAPI_RESULT_LIMIT` to tune how many results are passed to the AI; the default is `8` and the maximum is `10`.

Optional query extraction/cache variables:

```bash
vercel env add SEARCH_QUERY_INCLUDE_SITES
vercel env add SEARCH_QUERY_EXCLUDE_SITES
vercel env add SEARCH_QUERY_CACHE_TTL_SECONDS
vercel env add REDIS_REST_URL
vercel env add REDIS_REST_TOKEN
```

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are also supported. Redis is optional; without it, extraction still works.

`DEEPSEEK_BASE_URL` and `CLAUDE_BASE_URL` are optional when using the providers' default API endpoints. `DEEPSEEK_MODEL`, `CLAUDE_MODEL`, and `CLAUDE_EXTRACTOR_MODEL` are optional when the app default models are acceptable. Redeploy after changing environment variables:

```bash
vercel deploy --prod
```

Configuration can be checked without exposing secret values:

```text
GET https://your-domain.vercel.app/api/telegram
```

Expected response includes `config.ai.provider` and `config.ai.configured: true` when the selected provider has its API key set. It also includes `config.search.configured` for SearchApi.io. The GET config response exposes only non-secret provider names, missing variable names, and booleans such as `configured`, `baseUrlConfigured`, and `modelConfigured`; it does not return API keys, base URLs, or model values.

## PostgreSQL Persistence Setup

The API stores each successful Hyperliquid snapshot in PostgreSQL JSONB when database environment variables are present. Telegram communication history is also stored per chat when PostgreSQL is configured, but that stored history is not loaded into AI chat prompts.

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
vercel env add CHAT_HISTORY_API_TOKEN
```

`POSTGRES_SSL` defaults to enabled on Vercel. `POSTGRES_MAX_CONNECTIONS` defaults to `1`, which keeps serverless database usage conservative.
`CHAT_HISTORY_API_TOKEN` is required for the chat history REST API because it returns raw Telegram conversation text.

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

Telegram text messages are persisted in a separate table:

```sql
CREATE TABLE IF NOT EXISTS telegram_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_text TEXT NOT NULL,
  message_type TEXT NOT NULL,
  telegram_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Configuration can be checked without exposing secrets:

```text
GET https://your-domain.vercel.app/api/telegram
```

Expected response includes `config.postgres.configured: true` after all database env vars are set.

## Telegram Commands

You can talk to the bot normally without a slash command, for example:

```text
What is happening with BTC right now?
```

The AI reply uses only that current request, SearchApi.io results when current market/news research is needed, and a fresh Hyperliquid market snapshot when the request is trading-related or mentions a tracked symbol. Previous communication history is saved to PostgreSQL when configured, but it is not considered as chat memory.

```text
/start
/help
/prices
/asset BTCUSDT
/rsh BTC latest catalysts
/plan MU long 2w
/planstatus MU
/treealert
/condition MU
/alerts
/clearalerts [MU]
```

`/prices` returns all tracked prices and regimes. `/asset <symbol>` returns a detailed 4H indicator snapshot for one asset. `/rsh <question>` runs a fresh Google News research flow with query extraction before SearchApi. `/plan <symbol> [long|short|both] [horizon]` queues a staged SwingScope research workflow and immediately confirms the request was accepted. `/planstatus [symbol]` checks queued or recently completed plan progress. `/condition <symbol>` (or `/treecondition <symbol>`) classifies the current price against that chat's saved decision tree for one asset; `/condition` without a symbol evaluates every tracked asset.

### SwingScope plan workflow

`/plan` is asynchronous. The Telegram command creates a durable row in `plan_jobs`; it does not run all research inline. An external scheduler must call the plan runner API periodically to move jobs through these stages:

```text
collect -> fact_check -> infer -> levels -> plan -> send
```

Each API call processes at most one pending job for the stage named in the URL. To keep plans moving on Vercel Cloud without Vercel Cron, configure your external scheduler to call these public endpoints in stage order, for example once per minute:

```bash
curl -i https://your-domain.vercel.app/api/plan-runner/collect

curl -i https://your-domain.vercel.app/api/plan-runner/fact_check

curl -i https://your-domain.vercel.app/api/plan-runner/infer

curl -i https://your-domain.vercel.app/api/plan-runner/levels

curl -i https://your-domain.vercel.app/api/plan-runner/plan

curl -i https://your-domain.vercel.app/api/plan-runner/send
```

`fact-check` is also accepted as a path alias for `fact_check`. The API returns JSON with an event such as `plan_stage_runner_complete` or `plan_stage_runner_noop`. If `/planstatus <symbol>` shows `Waiting: Collect (step 1/6)` for several minutes, call `/api/plan-runner/collect` first; that is the stage that claims newly queued jobs.

Required Vercel environment variables for this workflow:

```bash
vercel env add POSTGRES_URL
vercel env add TELEGRAM_BOT_TOKEN
vercel env add SEARCHAPI_API_KEY  # or set SEARCH_PROVIDER=TINYFISH and TINYFISH_API_KEY
vercel env add AI_MODEL_PROVIDER
vercel env add DEEPSEEK_API_KEY
```

`DATABASE_URL` can be used instead of `POSTGRES_URL`. If you use Claude, set `CLAUDE_API_KEY` instead of `DEEPSEEK_API_KEY`.

### Decision-tree alerts

Use `/treealert` followed by a pasted decision tree. The bot sends the content to the configured AI provider first, normalizes it into trigger-ready price alerts, then saves those alerts for the current Telegram chat:

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

The AI analysis stores supported trigger styles as `above`, `below`/`closes below`, `between`, and range conditions such as `holds $1,126–$1,116` or `rejects $1,155–$1,164`. If AI analysis is unavailable, the bot falls back to deterministic parsing only for any rules it can safely recognize.

Alerts expire 24 hours after they are saved, or sooner when cancelled with `/clearalerts [symbol]`. Active alerts are scoped to the Telegram chat that created them; `/alerts`, `/clearalerts`, and alert notifications only use that chat's saved alerts.

Run the JavaScript alert scheduler to fetch the latest prices and process active alerts every 10 minutes. The bot sends a Telegram message when a saved condition changes from inactive to active, then rearms after the price leaves that condition. Use `/alerts` to list active alerts, `/condition [symbol]` to inspect the current matched tree condition and AI plan for one asset or all tracked assets, and `/clearalerts [symbol]` to deactivate them manually.

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

### Plan runner endpoint

```text
GET or POST https://your-domain.vercel.app/api/plan-runner/:stage
```

This endpoint is public and does not require an `Authorization` header.

Allowed `stage` values:

```text
collect
fact_check
infer
levels
plan
send
```

Example response when a job is advanced:

```json
{
  "status": "ok",
  "result": {
    "event": "plan_stage_runner_complete",
    "stage": "collect",
    "jobId": "42",
    "symbol": "SPCX"
  }
}
```

Example response when there is no job waiting at that stage:

```json
{
  "status": "ok",
  "result": {
    "event": "plan_stage_runner_noop",
    "stage": "collect"
  }
}
```

### Chat histories endpoint

```text
GET https://your-domain.vercel.app/api/chat-histories/<CHAT_HISTORY_API_TOKEN>?limit=50&historyLimit=20
```

Returns persisted Telegram chat IDs with the latest messages for each chat. `limit` controls
how many chats are returned (max `200`), and `historyLimit` controls how many recent messages
are returned per chat (max `100`). The token is supplied as the path variable after
`/api/chat-histories/`.

```json
{
  "status": "ok",
  "relatedChatIds": ["456", "123"],
  "chatHistories": [
    {
      "chatId": "456",
      "latestMessageAt": "2026-07-20T06:00:00.000Z",
      "messageCount": 2,
      "messages": [
        {
          "id": "1",
          "chatId": "456",
          "direction": "inbound",
          "messageText": "Hello",
          "messageType": "ai_chat",
          "telegramMessageId": "11",
          "createdAt": "2026-07-20T05:59:00.000Z"
        }
      ]
    }
  ],
  "limits": {
    "chatLimit": 50,
    "historyLimit": 20
  }
}
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
| `/condition` says AI is not configured | Set `AI_MODEL_PROVIDER` to `CLAUDE` or `DEEPSEEK`, add the matching `CLAUDE_API_KEY` or `DEEPSEEK_API_KEY`, redeploy, and confirm `/api/telegram` shows `config.ai.configured: true`. |
| Malformed AI response | The selected AI provider returned text that could not be parsed into the expected classification format; retry the command and check Vercel logs for the non-secret parse error. |
| Fallback deterministic behavior | If the selected AI provider is unavailable or its response is malformed, the bot should fall back to deterministic rule evaluation from the saved decision tree so no secret values are logged or exposed. |
| `/prices` is slow | Hyperliquid candle requests can take several seconds; check Vercel logs. |
| Empty prices | Hyperliquid may be rate-limited or returning no candles; retry later. |
| API 404 | Confirm the deployed URL uses `/api/hyperliquid` or `/api/telegram`. |

## License

MIT - Free to use and modify

## Next.js DeepSeek AI SDK Example

A complete, runnable Next.js example for DeepSeek through the Vercel AI SDK lives in `examples/next-deepseek-ai-sdk`.

The example intentionally stores only the base model ID in environment variables:

```bash
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-v4-pro
```

Do not append capability suffixes such as `-thinking-search` to `DEEPSEEK_MODEL`. The example validates that the model is exactly `deepseek-v4-pro`, then enables reasoning and web search on every AI SDK request by passing:

```js
{
  reasoning: { effort: 'high' },
  enableSearch: true,
}
```

Run it locally with:

```bash
cd examples/next-deepseek-ai-sdk
npm install
npm run dev
```

The route at `app/api/chat/route.js` uses `streamText` and emits newline-delimited JSON events with separate `reasoning` and `text` event types. The page at `app/page.jsx` reads the stream and renders the thinking process separately from the final answer.

## BTC Intraday Market-Data Profile

The legacy endpoint is unchanged:

```text
GET /api/hyperliquid
```

It still returns the existing 4-hour Hyperliquid technical-analysis snapshot, top-level `timestamp`, `interval`, `source`, `prices`, `assets`, `status`, `persistence`, and `alerts` fields, and continues to process existing Telegram decision-tree alerts.

The new additive BTC workflow is available with:

```text
GET /api/hyperliquid?profile=btc-intraday
GET /api/hyperliquid?stored=latest&profile=btc-intraday
```

This profile returns all legacy fields plus `schemaVersion: "2.0"` and `btcIntraday`. The stored route returns the latest persisted JSONB snapshot. If that record is legacy-only, the response says the `btcIntraday` section is unavailable instead of fabricating data.

### Example enriched response

```json
{
  "timestamp": "2026-07-22T00:00:00.000Z",
  "interval": "4h",
  "source": "hyperliquid",
  "prices": { "BTCUSDT": 100000 },
  "assets": [],
  "status": "success",
  "persistence": { "enabled": true, "saved": true, "id": "123" },
  "alerts": { "enabled": true, "checked": 2, "triggered": 0 },
  "schemaVersion": "2.0",
  "btcIntraday": {
    "symbol": "BTCUSDT",
    "asOf": "2026-07-22T00:00:01.000Z",
    "timeframes": {
      "5m": {
        "current": {
          "interval": "5m",
          "openTime": "2026-07-22T00:00:00.000Z",
          "closeTime": "2026-07-22T00:04:59.999Z",
          "isClosed": false,
          "open": 100000,
          "high": 100500,
          "low": 99800,
          "close": 100200,
          "baseAssetVolume": 120.5,
          "quoteAssetVolume": 12074100,
          "vwap": 100200,
          "numberOfTrades": 15000,
          "takerBuyBaseVolume": 61.1,
          "takerBuyQuoteVolume": 6122220,
          "units": { "baseAssetVolume": "BTC", "quoteAssetVolume": "USDT", "vwap": "USDT per BTC" }
        },
        "completed": {}
      },
      "15m": { "current": {}, "completed": {} },
      "1h": { "current": {}, "completed": {} }
    },
    "perpetual": {
      "source": "Hyperliquid",
      "status": "live",
      "method": "info/metaAndAssetCtxs universe-index match",
      "markPrice": 100000,
      "midPrice": 100010,
      "oraclePrice": 99990,
      "fundingRateHourly": 0.00001,
      "fundingAprSimple": 0.0876,
      "openInterestBtc": 12500,
      "openInterestUsd": 1250000000
    },
    "liquidations": {
      "source": "Binance USD-M liquidation stream via Redis",
      "status": "live",
      "exactness": "exchange-reported-snapshots",
      "windows": {
        "5m": { "longLiquidationUsd": 1000, "shortLiquidationUsd": 500, "totalLiquidationUsd": 1500, "eventCount": 2 },
        "15m": {},
        "1h": {}
      }
    },
    "options": {
      "source": "Deribit",
      "currency": "BTC",
      "ivUnits": "percentage points",
      "expiries": [
        {
          "expiry": "2026-07-24T08:00:00.000Z",
          "contracts": [
            { "instrumentName": "BTC-24JUL26-100000-C", "strike": 100000, "optionType": "call", "markIv": 52.5, "delta": 0.5 }
          ],
          "analytics": {
            "atm": { "strike": 100000, "iv": 52.5, "method": "nearest-strike" },
            "call25Delta": { "iv": 55, "method": "linear-delta-interpolation" },
            "put25Delta": { "iv": 58, "method": "nearest-delta fallback" },
            "riskReversal25d": -3,
            "butterfly25d": 4
          }
        }
      ]
    },
    "quality": { "status": "partial", "completeness": false, "missingFields": [], "warnings": [], "generationDurationMs": 1234, "schemaVersion": "2.0" }
  }
}
```

### Sources, units, and formulas

- Binance volume and VWAP are Binance USD-M BTCUSDT futures venue metrics, not Hyperliquid volume. The exact bar VWAP formula is `quoteAssetVolume / baseAssetVolume`; when base volume is zero, VWAP is `null`.
- Hyperliquid funding and open interest are Hyperliquid perpetual metrics from `info` `metaAndAssetCtxs`. Funding is an hourly decimal rate. `fundingAprSimple` is explicitly non-compounded simple annualization: `fundingRateHourly * 24 * 365`. Open interest is reported in BTC and USD notional, with `openInterestUsd = openInterestBtc * markPrice`.
- Deribit options metrics are Deribit BTC option metrics. IV values are percentage points. Risk reversal is `call25DeltaIv - put25DeltaIv`; butterfly is `((call25DeltaIv + put25DeltaIv) / 2) - atmIv`.
- Liquidation aggregates are Binance USD-M forced-order stream snapshots collected by the separate worker. They are not global market totals, not inferred from OI changes, and not guaranteed tick-complete.

### Freshness and failure semantics

Every provider block includes `source`, `asOf`, `receivedAt`, `ageMs`, `status`, `method`, and `reason`. Allowed statuses are `live`, `stale`, `partial`, `unavailable`, and `error`. Missing or failed numerical values are `null`, never zero. The top-level `btcIntraday.quality` block summarizes completeness, missing fields, per-source freshness, warnings, schema version, and generation duration.

### Redis and stream worker

The API reads liquidation aggregates from Upstash-compatible Redis using one of these pairs:

```bash
REDIS_REST_URL
REDIS_REST_TOKEN
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Start the always-on collector outside Vercel serverless functions:

```bash
npm run market-stream-worker
```

Vercel serves HTTP requests and must not be treated as the persistent WebSocket host. Deploy the worker on an always-on process manager, VM, container, or worker platform that can maintain outbound WebSocket connections. The API is market-data only; it is not an execution venue, not an order-placement API, and not a guaranteed tick-complete feed.

### Optional BTC intraday variables

```bash
OPTIONS_EXPIRY_COUNT=3
OPTIONS_STRIKE_RANGE_PCT=15
OPTIONS_MAX_CONCURRENCY=8
LIQUIDATION_STALE_MS=120000
```

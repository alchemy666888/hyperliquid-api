# BTC intraday market data v2 design

The enhancement is an additive profile implemented outside the legacy Hyperliquid 4h code path. `api/hyperliquid.js` continues to call `refreshMarketDataAndProcessAlerts()` for unprofiled requests. For `profile=btc-intraday`, it first builds the legacy snapshot, then calls `buildBtcIntradaySnapshot()` and persists the combined JSONB snapshot with the existing `saveHyperliquidSnapshot()` helper.

Provider modules:
- `lib/binance-futures.js`: bounded REST kline adapter for Binance USD-M BTCUSDT intraday bars.
- `lib/hyperliquid-derivatives.js`: Hyperliquid `metaAndAssetCtxs` adapter for BTC funding and OI.
- `lib/liquidation-aggregator.js`: in-memory rolling-window liquidation aggregator and Redis API adapter.
- `lib/redis-rest.js`: shared Upstash-compatible REST helper.
- `lib/deribit-options.js`: Deribit instruments/tickers adapter plus options analytics.
- `lib/market-data-quality.js`: shared provider metadata and quality aggregation helpers.
- `lib/btc-intraday.js`: orchestration with timeouts and `Promise.allSettled`.

A separate `scripts/market-stream-worker.js` maintains Binance USD-M forced-order stream aggregates in Redis. Serverless requests do not open persistent WebSockets.

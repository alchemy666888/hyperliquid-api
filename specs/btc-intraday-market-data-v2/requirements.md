# BTC intraday market data v2 requirements

## Acceptance criteria
- `/api/hyperliquid` remains the legacy 4h Hyperliquid snapshot and alert-processing path.
- `/api/hyperliquid?profile=btc-intraday` returns the legacy fields plus `schemaVersion: "2.0"` and `btcIntraday`.
- Binance USD-M BTCUSDT `5m`, `15m`, and `1h` bars expose current and completed bars, exact base/quote volume, and VWAP as quote volume divided by base volume; zero base volume produces `null` VWAP.
- Hyperliquid perpetual context is read from `metaAndAssetCtxs`, matching BTC by universe index, and exposes funding and open interest units/source metadata.
- Liquidations are collected by a separate worker into Redis; the Vercel API reads Redis only and marks unavailable/stale data with `null` numeric fields.
- Deribit options are bounded by expiry count, strike range, and ticker concurrency, and expose IV, Greeks, OI, volume, ATM, 25-delta skew, risk reversal, and butterfly analytics.
- Provider failures produce partial responses with quality metadata rather than failing the whole request.
- Enriched snapshots persist through the existing JSONB persistence path and can be returned via `stored=latest&profile=btc-intraday`.
- Unknown/missing metrics are represented as `null`, never zero.
- Tests avoid live network calls and cover parsing, analytics, aggregation, partial failure, response contracts, persistence shape, and missing-data semantics.

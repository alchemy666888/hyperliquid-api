# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single **Vercel serverless** app (`hyperliquid-api`) with no database and
no runtime npm dependencies. See `README.md` for the canonical commands and the full
product description. Notes below are the non-obvious bits for running it in this environment.

### Services

- **`GET /api/hyperliquid`** — JSON snapshot of live Hyperliquid prices + 4H indicators for 12 assets (`api/hyperliquid.js` → `lib/hyperliquid.js`).
- **`POST /api/telegram`** — Telegram bot webhook; `GET /api/telegram` is a config/health probe (`api/telegram.js`).
- **`/`** — static landing page (`public/index.html`).

### Runtime / dev server

- Node **24.x** is required (`package.json` `engines`) and is preinstalled via `nvm` as the default. Note a separate `/exec-daemon/node` shim exists; the active `node`/`npm`/`vercel` already resolve to the nvm v24 install, so no manual switching is needed.
- The dev server is `npm run dev` (= `vercel dev`, port 3000). **`vercel dev` requires Vercel auth** — it starts an interactive OAuth device-login flow if no credentials are present. To run it non-interactively, set a `VERCEL_TOKEN` (env/secret) and link the project (`vercel link` or `vercel dev --yes`). Without auth, the dev server cannot start.
- No `lint` or `test` scripts are defined. Use `node --check <file>` for a quick syntax check.

### Testing core functionality without Vercel auth

The handlers are plain `(req, res)` functions and the data pipeline needs no auth, only
outbound access to `https://api.hyperliquid.xyz` (available here; no API key). Smoke-test
the core logic directly:

```bash
node --input-type=module -e 'import {getHyperliquidSnapshot} from "./lib/hyperliquid.js"; const s = await getHyperliquidSnapshot(); console.log(s.status, s.assets.length); console.log(s.prices);'
```

### Telegram bot caveats

- Full bot E2E needs `TELEGRAM_BOT_TOKEN` (+ optional `TELEGRAM_SECRET_TOKEN`) **and** a public HTTPS webhook URL, so it cannot be fully exercised on `localhost` — test it after deploying (`npm run deploy`).
- `POST /api/telegram` returns HTTP 500 `Missing TELEGRAM_BOT_TOKEN` when the token env var is unset; this is expected, not a bug.

# Requirements: Search Query Tuning

## Goal
Transform Telegram research and market/news chat messages into clean SearchApi Google News queries before calling SearchApi. Preserve the original user message for the final AI analysis prompt.

## Functional Requirements
- Add `/rsh <question>` as an explicit Telegram research command.
- Route `/rsh` through query extraction, SearchApi news search, then final AI analysis.
- For no-command chat, only search when the message is likely market/news/current-data related.
- Never send raw conversational text to SearchApi except as the explicit malformed-extractor fallback.
- Use `engine=google_news`, locale params, and chronological `tbs` freshness filters.
- Normalize SearchApi results to `{ title, source, date, snippet, link }`.
- Return final answers in the user's language.

## Query Extraction
- Fast-path obvious tickers such as `BTC`, `ETH`, and `SOL` without an LLM call.
- Use an LLM extractor for messy conversational messages.
- Extractor returns JSON only:
  - `q`
  - `gl`
  - `hl`
  - `freshness`
  - `needs_search`
- Default freshness is `d`; use `h` for now/latest/breaking intent.
- Use `gl=us&hl=en` for crypto/global macro and `gl=tw&hl=zh-TW` for Taiwan equities.

## Non-Functional Requirements
- Use a cheap/fast extractor model when Claude is configured via `CLAUDE_EXTRACTOR_MODEL`, defaulting to Haiku.
- Keep Redis extraction caching optional.
- If extraction JSON is invalid, fall back to raw message search with daily chronological freshness.
- Gate casual chat to avoid burning SearchApi credits.

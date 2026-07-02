# Vibe Coding Prompt: Search Query Tuning

Implement a Telegram search-intelligence layer for this repo.

Keep the implementation dependency-light and testable. Add `lib/intelligence/search-query.js` to convert user messages into structured SearchApi params. Use deterministic ticker fast paths first, then a JSON-only LLM extractor, then a malformed-output fallback that searches the raw message with `qdr:d,sbd:1`.

Wire `/rsh <question>` in `api/telegram.js` and make ordinary stateless AI chat search only when the new gate says the message needs current market/news data. Weather and casual chat should not call SearchApi.

SearchApi should use `google_news`, deliberate locale params, chronological `tbs`, and normalized news result fields. The final AI prompt must include the original user message and the fresh articles so retrieval keywords do not replace user intent.

# Tasks: Search Query Tuning

- [x] Add query intelligence module with fast path, LLM extractor, fallback, freshness mapping, and optional Redis cache.
- [x] Extend AI client so extractor calls can use `CLAUDE_EXTRACTOR_MODEL`.
- [x] Extend SearchApi wrapper to accept structured params and normalize news results.
- [x] Add `/rsh` Telegram command.
- [x] Update normal chat so SearchApi is gated and uses transformed params.
- [x] Add spec docs and update README behavior.
- [x] Add unit tests for extraction, SearchApi params/results, `/rsh`, casual chat gating, and weather bypass.
- [x] Run `npm test`.

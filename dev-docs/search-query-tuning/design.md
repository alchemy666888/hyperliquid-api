# Design: Search Query Tuning

## Components
- `lib/intelligence/search-query.js` owns fast-path ticker extraction, LLM extraction, SearchApi param building, optional Redis REST caching, and search-intent gating.
- `lib/search.js` accepts either legacy string queries or structured SearchApi params.
- `lib/conversational-ai.js` decides whether ordinary chat needs search and powers `/rsh` analysis.
- `api/telegram.js` exposes `/rsh` and passes injected dependencies through for tests.

## Flow
```text
Telegram message
  -> search intent gate
  -> fast-path or LLM extractor
  -> build SearchApi params
  -> SearchApi google_news
  -> final AI analysis with original message + fresh articles
```

Weather requests exit before search. Casual chat skips SearchApi and goes straight to the normal stateless AI reply.

## SearchApi Params
Freshness maps to:
- `h`: `qdr:h,sbd:1`
- `d`: `qdr:d,sbd:1`
- `w`: `qdr:w,sbd:1`
- `m`: `qdr:m,sbd:1`

The builder emits:
```json
{
  "engine": "google_news",
  "q": "Bitcoin",
  "gl": "us",
  "hl": "en",
  "tbs": "qdr:d,sbd:1"
}
```

## Caching
The extraction cache is optional. If `REDIS_REST_URL`/`REDIS_REST_TOKEN` or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are present, extraction results are cached under normalized message keys. Missing or failing cache never blocks a reply.

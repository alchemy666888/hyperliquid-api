# Design: SwingScope P1–P8 `/plan` Pipeline

## Overview

This design extends the existing durable `plan_jobs` state machine from 5 analytical
stages to a full P1–P8 SwingScope pipeline plus an agentic research loop, without changing
the concurrency model that already keeps each stage inside a single Vercel function
invocation. The command layer (`enqueuePlanJob`, `planStatusCommand`) is largely unchanged;
the work is in (a) new `plan_jobs` columns and a wider `PLAN_STAGES` set, (b) a new
`collect` behavior (entity resolution) and a new re-entrant `research` stage (iterative
search loop), (c) six new analytical stage runners mirroring the SwingScope phases, and
(d) a section-splitting Telegram renderer for long output.

The stack is unchanged: Node.js ESM on Vercel, PostgreSQL (`pg` Pool) for durable state,
DeepSeek via `lib/ai-client.js` (`requestAiChat` / `requestAiJson`), SearchApi.io via
`lib/search.js`, Hyperliquid via `lib/hyperliquid.js`, and Telegram via
`lib/telegram-client.js` + `lib/telegram-format.js`. Jobs advance via the ~45s
`scripts/plan-scheduler.js` tick and/or the `/api/plan-runner/[stage].js` endpoints.

## Architecture

```
Telegram /plan  ──▶ enqueuePlanJob ──▶ INSERT plan_jobs (stage=collect, status=pending)
                                              │
        scheduler tick / plan-runner ─────────┤ claim one pending job at a stage
                                              ▼
                                     advanceOneStage(job)
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ collect → research* → technical → positioning → sentiment_macro → catalysts →  │
   │ asset_specific → factor_assembly → asymmetry → levels → plan → send → done      │
   └──────────────────────────────────────────────────────────────────────────────┘
        * research is re-entrant: stays on itself across ticks until loop terminates
                                              │
                                     send stage ──▶ section-split Telegram messages
                                                └─▶ (tracked symbol) save decision-tree alerts
```

Each non-`research` stage consumes prior stages' JSONB outputs, makes one bounded AI call
(or the SearchApi.io fan already done in `research`), persists its own output column, and
advances. `research` loops on itself: each tick does one search+assess iteration and
persists incremental state, only advancing to `technical` when the loop terminates.

Stage granularity note: `collect` (entity resolution + snapshot) and `research` (search
loop) together replace the old monolithic `collect`. `technical`, `positioning`,
`sentiment_macro`, `catalysts`, `asset_specific`, `factor_assembly`, and `asymmetry` are
the new P1–P8 analytical stages. `levels`, `plan`, and `send` are retained with minor
input changes. (Serves Req 1.)

## Components and Responsibilities

### `lib/plan-jobs.js` — state machine & persistence
- Responsibility: schema, claim/commit/reap, and now the wider stage set + new columns and
  a research-loop state accessor.
- Changes:
  - `PLAN_STAGES` gains `research`, `technical`, `positioning`, `sentiment_macro`,
    `catalysts`, `asset_specific`, `factor_assembly`, `asymmetry` (order preserved for
    display).
  - `OUTPUT_COLUMNS` gains the new stage output columns (below).
  - `ensurePlanJobsSchema` adds new `JSONB` output columns + a `research_state JSONB` column
    (accumulated results, running call count, keyword queue, iteration trace) and an
    integer `search_call_count`.
  - New `commitResearchProgress(client, jobId, { researchState, searchCallCount })` that
    updates research state **without** changing `stage` (keeps job on `research`,
    status back to `pending`, clears lock, resets `retry_count`). Distinct from
    `commitStage`, which advances.
  - `normalizePlanJobRow` maps the new snake_case columns to camelCase.
- Key interfaces: `commitStage` (unchanged signature; new `outputColumn` values allowed),
  `commitResearchProgress` (new), `claimOneJobAtStage`, `reapStaleJobs` (unchanged logic).
- Requirements served: Req 1, Req 4 (re-entrancy), Req 16.

### `lib/plan-entity.js` — symbol entity resolution (new)
- Responsibility: resolve a symbol to a structured entity profile and an initial ranked
  keyword set; seed from the tracked-symbol map first.
- Key interface:
  `resolveEntityProfile({ symbol, resolvedSymbol, alertable, aiJson, deps }) →
   { primary, assetClass, relatedEntities[], seedKeywords[], source }`.
- Behavior: if the symbol is a tracked asset, seed `primary`/`assetClass` from the existing
  `TRACKED_TICKERS`/`CRYPTO_TICKERS` maps in `lib/intelligence/search-query.js`, then ask
  DeepSeek (`requestAiJson`, strict JSON) to expand related entities and rank seed keywords.
  On AI failure, fall back to `extractSearchQuery` output as a single seed keyword.
- Requirements served: Req 3.

### `lib/plan-research.js` — iterative search loop (new)
- Responsibility: one loop iteration per call — issue SearchApi.io queries for the current
  keyword set, dedupe/accumulate, run the AI coverage assessment (with the mandatory-facet
  floor), compute the next keyword set, and report whether the loop is complete.
- Key interfaces:
  - `runResearchIteration({ job, deps }) → { researchState, searchCallCount, done, reason }`.
  - Internal `assessCoverage({ results, mandatoryFacets, aiJson }) →
     { sufficient, facetsCovered, gapKeywords[] }` enforcing overview + latest news +
     ≥1 catalyst before `sufficient` may be true.
- Budget/termination: reads `PLAN_MAX_SEARCH_CALLS` (default 10). `done=true` when
  `sufficient && floor met`, or `gapKeywords` empty, or `searchCallCount >= cap`. Never
  exceeds the cap; when the cap is hit with facets uncovered, records the uncovered facets
  in `researchState.gapNote`.
- Dedup: maintains a `seenQueries` set (normalized query strings) and a `seenLinks` set in
  `research_state`; skips duplicate queries, filters duplicate results by link/title.
- Requirements served: Req 4, Req 12 (foundational context for non-tracked).

### `lib/plan-workflow.js` — stage orchestration
- Responsibility: `advanceOneStage` + per-stage runners. This file already owns
  `runCollectStage`, `runFactCheckStage`, `runInferStage`, `runLevelsStage`, `runPlanStage`,
  `runSendStage`. It gains the new analytical runners and special re-entrant handling for
  `research`.
- Changes:
  - `STAGE_TRANSITIONS` rewritten for the new linear order (each maps to its output column
    and next stage). `research` is **not** in `STAGE_TRANSITIONS`; it is handled by a
    dedicated branch in `advanceOneStage`.
  - New `runCollectStage`: now only entity resolution + snapshot attach (delegates to
    `plan-entity.js`), writes `collect_output`, advances to `research`.
  - New `advanceResearchStage(job, deps)`: calls `runResearchIteration`; if `done`, writes
    `research_output` (the finalized accumulated corpus) via `commitStage` and advances to
    `technical`; else calls `commitResearchProgress` and leaves the job on `research`.
  - New analytical runners: `runTechnicalStage`, `runPositioningStage`,
    `runSentimentMacroStage`, `runCatalystsStage`, `runAssetSpecificStage`,
    `runFactorAssemblyStage`, `runAsymmetryStage`. Each is a bounded `requestAiChat` call
    with a phase-specific system prompt (see Prompts) reading upstream outputs, returning
    `{ stage, <field>, generatedAt }`.
  - `runLevelsStage`, `runPlanStage`, `runSendStage`: retained; inputs widened to read the
    new analytical outputs (levels/plan get facts from `technical`+`factor_assembly` rather
    than the old `fact_check`).
  - `pipelineFromJob`: extended to assemble all new outputs for the send renderer.
- Requirements served: Req 1, Req 2, Req 4–Req 11, Req 13.

### `lib/plan-stage-runner.js` & `scripts/plan-scheduler.js` — drivers
- Responsibility: claim + advance one job per tick, reap stale, push failures.
- Changes: `PLAN_RUNNER_STAGES` gains all new stage names (so `/api/plan-runner/research`
  etc. work). The scheduler's `claimOneJob` (stage-agnostic) already advances whatever
  stage a job is on, so it handles `research` re-entry automatically; the per-stage runner
  gains a `research` path. No change to reaper/retry logic — a stuck `research` iteration is
  reaped like any running job (Req 4.12).
- Requirements served: Req 1, Req 4, Req 16.

### `lib/plan-command.js` — command surface & renderer
- Responsibility: `parsePlanArgs`, `enqueuePlanJob`, `planStatusCommand`, `assemblePlan`,
  `formatPlanReply`.
- Changes:
  - `assemblePlan` unchanged in contract; inputs come from new stages.
  - `formatPlanReply` replaced/augmented by a **section-splitting renderer** (see
    `telegram-format.js`) that returns an ordered array of messages.
  - `PLAN_STAGE_STEPS` updated to the new 12-step ladder for `/planstatus`; `research`
    renders as `Research (calls X/10)` using `research_state.searchCallCount`.
  - `planQueuedMessage` step text updated.
- Requirements served: Req 14, Req 16.

### `lib/telegram-format.js` — section splitter (extended)
- Responsibility: HTML-safe message construction. Add `splitTelegramSections(sections[]) →
  messages[]` that packs labeled sections into ≤4096-char messages, never splitting inside
  an HTML tag, splitting a single oversized section on paragraph/line boundaries.
- Requirements served: Req 14.

### `api/plan-runner/[stage].js` — HTTP driver (unchanged code, wider allow-list)
- Accepts the new stage names via the widened `PLAN_RUNNER_STAGES`. No structural change.
- Requirements served: Req 1, Req 16.

## Data Model

### `plan_jobs` table (new/changed columns)

| Column | Type | Notes |
|--------|------|-------|
| stage | TEXT | now one of collect, research, technical, positioning, sentiment_macro, catalysts, asset_specific, factor_assembly, asymmetry, levels, plan, send, done |
| collect_output | JSONB | entity profile + snapshot + seed keywords (Req 3) |
| research_state | JSONB | **new** — in-progress loop state: `{ keywordQueue[], accumulatedResults[], seenQueries[], seenLinks[], iterations[], searchCallCount, facetsCovered{}, gapNote }` (Req 4) |
| search_call_count | INT NOT NULL DEFAULT 0 | **new** — running SearchApi.io calls; enforces the 10-cap across ticks (Req 4.7) |
| research_output | JSONB | **new** — finalized research corpus handed to analytical stages (Req 4.6) |
| technical_output | JSONB | **new** (Req 2) |
| positioning_output | JSONB | **new** (Req 5) |
| sentiment_macro_output | JSONB | **new** (Req 6) |
| catalysts_output | JSONB | **new** (Req 7) |
| asset_specific_output | JSONB | **new** (Req 8) |
| factor_output | JSONB | **new** — four inventories (Req 9) |
| asymmetry_output | JSONB | **new** (Req 10) |
| levels_output | JSONB | retained (Req 11) |
| plan_output | JSONB | retained (Req 11) |

Existing columns (`id, chat_id, symbol, resolved_symbol, alertable, direction, horizon,
status, locked_at, retry_count, reply_sent_at, error, created_at, updated_at`) are
unchanged. `factcheck_output` and `infer_output` are **dropped from active use**; the
migration keeps them nullable for backward compatibility but no stage writes them.

### Entity profile (in `collect_output.entity`)

| Field | Type | Notes |
|-------|------|-------|
| primary | string | e.g. "SpaceX" for `$SPCX` |
| assetClass | enum | crypto \| equity \| commodity \| etf_index \| ambiguous |
| relatedEntities | string[] | ranked, e.g. ["Elon Musk","Starlink","Tesla",...] |
| seedKeywords | string[] | ranked initial query set |
| source | enum | tracked-map \| ai \| fallback-extractor |

### Research state (in `research_state`)

| Field | Type | Notes |
|-------|------|-------|
| keywordQueue | string[] | queries not yet issued, ranked |
| accumulatedResults | object[] | deduped SearchApi.io results |
| seenQueries | string[] | normalized issued queries (no re-issue) |
| seenLinks | string[] | dedup keys |
| iterations | object[] | trace: `{ queries[], assessment, gapKeywords[], callsAfter }` |
| facetsCovered | object | `{ overview:bool, latestNews:bool, catalyst:bool, ... }` |
| gapNote | string \| null | set when cap hit with mandatory facets uncovered |

## Key Flows

### Flow A — Queue and entity resolution (Req 3)
1. `/plan SPCX long 2w` → `enqueuePlanJob` inserts a row at `stage=collect, status=pending`.
2. Scheduler claims it, `advanceOneStage` runs `runCollectStage`.
3. `resolveEntityProfile` seeds from tracked map if applicable (SPCX is tracked → primary
   `"$SPCX"`), then DeepSeek expands → `{ primary:"SpaceX", relatedEntities:["Elon Musk",
   "Starlink","Tesla",...], seedKeywords:[...] }`. Snapshot attached if tracked.
4. `commitStage` writes `collect_output`, advances to `research` (status `pending`).

### Flow B — Research loop, one iteration per tick (Req 4)
1. Scheduler claims the job at `research`; `advanceResearchStage` runs one
   `runResearchIteration`.
2. Iteration issues the next SearchApi.io queries from `keywordQueue` (respecting remaining
   budget = `cap - search_call_count`), dedupes results into `accumulatedResults`,
   increments `search_call_count`.
3. `assessCoverage` (DeepSeek) evaluates the corpus; returns `sufficient` + `facetsCovered`
   + `gapKeywords`. The floor: `sufficient` is forced to false unless overview + latest
   news + ≥1 catalyst are covered.
4. If not done → `commitResearchProgress` persists `research_state` + `search_call_count`,
   leaves job on `research/pending`. Next tick repeats.
5. If done (sufficient+floor, or empty queue, or cap) → write `research_output`, advance to
   `technical`. If cap hit with facets uncovered, `gapNote` travels downstream. (Req 4.4)

### Flow C — Analytical phases (Req 2, 5–10)
Each stage claims the job, reads upstream outputs, makes one `requestAiChat` call with a
phase system prompt, writes its output column, advances. Fact-vs-inference discipline and
the neutral-stage prohibition are enforced in every prompt (Req 13). `factor_assembly`
reads technical+positioning+sentiment_macro+catalysts+asset_specific and emits the four
inventories; `asymmetry` reads `factor_output` and emits pure inference.

### Flow D — Levels, plan, send (Req 11, 14)
1. `runLevelsStage` derives neutral areas from `research_output` facts + snapshot.
2. `runPlanStage` (`assemblePlan`) emits per-side entries/stop/targets/rationale +
   `conditions[]`. Only this stage may emit executable levels (Req 13.4).
3. `runSendStage` builds ordered sections, calls `splitTelegramSections`, sends each
   message in order (preserving the `markReplySent` idempotency guard), and—if the symbol
   is tracked—normalizes conditions to decision-tree alerts and saves them, appending the
   saved/rejected status line. Advances to `done`.

## Error Handling

- **Entity resolution failure (Req 3.5):** `resolveEntityProfile` returns a
  `fallback-extractor` profile from `extractSearchQuery`; pipeline continues.
- **Coverage-assessment failure (Req 4):** if the AI assess call fails, the iteration treats
  coverage as insufficient but decrements available retries; if it keeps failing the reaper
  fails the job (Req 4.12). If SearchApi.io fails on an iteration, that iteration records
  the error, still counts toward nothing (only successful HTTP calls increment the cap —
  design choice: failed calls do not consume budget), and retries next tick until stale
  budget.
- **Cap reached without floor (Req 4.4):** terminate, set `gapNote`, continue to
  `technical`; downstream stages note the gap rather than failing.
- **Analytical AI failure (Req 1.4):** each analytical runner throws `PlanStageError(stage)`
  on missing/invalid AI output; the runner/scheduler applies retry/stale-reap then marks
  `failed` and pushes the failure message.
- **Snapshot missing (Req 2.3, 12.2):** technical/positioning stages note the gap, use
  web-derived facts, never invent indicator values.
- **Plan JSON unassemblable (Req 11.5):** `assemblePlan` degrades to an analysis summary +
  `degraded` flag; job still completes.
- **Telegram over-length (Req 14.2):** `splitTelegramSections` guarantees ≤4096 chars per
  message with no broken HTML; send is ordered and idempotent.
- **Postgres unavailable (Req 16.4):** `enqueuePlanJob`/`planStatusCommand` return the
  existing persistence-unavailable message.

## Testing Strategy

- **`plan-entity.test.js`** (new): tracked-symbol seeding, AI expansion parsing, fallback
  on AI failure. (Req 3)
- **`plan-research.test.js`** (new): budget cap never exceeded across simulated ticks;
  mandatory-facet floor blocks premature `sufficient`; cap-with-gap sets `gapNote`; dedup of
  queries and links; termination reasons. Uses injected `deps` (fake search + fake aiJson).
  (Req 4)
- **`plan-jobs.test.js`** (extend): new columns persist; `commitResearchProgress` keeps
  stage on `research` and resets lock/retry; `commitStage` advances through the new order;
  reaper still fails a stuck `research` job. (Req 1, Req 4)
- **`plan-workflow.test.js`** (extend): `advanceOneStage` walks the full 13-state order;
  each analytical runner returns its field and is reused if output already present;
  `advanceResearchStage` loops then advances. (Req 1, Req 2, Req 5–11)
- **`plan-command.test.js`** (extend): `/planstatus` renders `Research (calls X/10)` and the
  new step ladder; queued message updated. (Req 16)
- **`telegram-format` test** (extend): `splitTelegramSections` respects 4096, never splits a
  tag, splits oversized sections on boundaries, preserves order. (Req 14)
- **Neutral-stage discipline**: assert analytical/levels prompts carry the prohibition and
  only `plan` emits executable levels. (Req 13.4)
- All new tests follow the existing dependency-injection pattern (pass `deps` with fakes;
  no live network).

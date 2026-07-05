# Tasks: SwingScope P1–P8 `/plan` Pipeline

> Work through these in order. Check off each task only when its outcome is verified
> (a test passes, a stage advances, a message renders). If a task can't be completed as
> written, stop and flag it rather than improvising outside the spec. All new tests follow
> the existing dependency-injection pattern — pass `deps` with fakes, no live network.
>
> Repo: `alchemy666888/hyperliquid-api`. Stack: Node.js ESM on Vercel, PostgreSQL (`pg`),
> DeepSeek via `lib/ai-client.js`, SearchApi.io via `lib/search.js`, Hyperliquid via
> `lib/hyperliquid.js`, Telegram via `lib/telegram-client.js` + `lib/telegram-format.js`.

## Phase 1: State machine foundation

- [ ] 1. Widen the stage set and columns in `lib/plan-jobs.js`. _(Req 1, Req 4, Req 16)_
  - [ ] 1a. Add `research, technical, positioning, sentiment_macro, catalysts,
    asset_specific, factor_assembly, asymmetry` to `PLAN_STAGES` (preserve display order:
    `collect → research → technical → positioning → sentiment_macro → catalysts →
    asset_specific → factor_assembly → asymmetry → levels → plan → send → done`).
  - [ ] 1b. Add the new output columns to `OUTPUT_COLUMNS`: `research_output`,
    `technical_output`, `positioning_output`, `sentiment_macro_output`, `catalysts_output`,
    `asset_specific_output`, `factor_output`, `asymmetry_output`.
  - [ ] 1c. Extend `ensurePlanJobsSchema` with `ADD COLUMN IF NOT EXISTS` for all new JSONB
    output columns, plus `research_state JSONB` and `search_call_count INT NOT NULL
    DEFAULT 0`. Keep legacy `factcheck_output`/`infer_output` nullable (no drop).
  - [ ] 1d. Extend `normalizePlanJobRow` to map the new snake_case columns to camelCase
    (`researchState`, `searchCallCount`, `technicalOutput`, …).
- [ ] 2. Add re-entrant persistence to `lib/plan-jobs.js`. _(Req 1.7, Req 4.5, Req 4.7)_
  - [ ] 2a. Implement `commitResearchProgress(client, jobId, { researchState,
    searchCallCount })`: updates `research_state`, `search_call_count`, sets `status =
    'pending'`, `locked_at = NULL`, `retry_count = 0`, `updated_at = NOW()`, and leaves
    `stage = 'research'` unchanged. Wrap in BEGIN/COMMIT like `commitStage`.
  - [ ] 2b. Confirm `claimOneJobAtStage` and `claimOneJob` accept `research` (they read
    `PLAN_STAGES`; no change expected — add a test).
- [ ] 3. Extend `plan-jobs.test.js`. _(Req 1, Req 4)_
  - [ ] 3a. New columns round-trip through insert/normalize.
  - [ ] 3b. `commitResearchProgress` keeps `stage='research'`, resets lock/retry, bumps
    `search_call_count`.
  - [ ] 3c. `commitStage` advances through the new order (collect→research, research→
    technical, … asymmetry→levels).
  - [ ] 3d. `reapStaleJobs` still fails a stuck `research` job past the retry budget.

## Phase 2: Entity resolution (collect)

- [ ] 4. Create `lib/plan-entity.js`. _(Req 3)_
  - [ ] 4a. `resolveEntityProfile({ symbol, resolvedSymbol, alertable, aiJson, deps })`
    returning `{ primary, assetClass, relatedEntities[], seedKeywords[], source }`.
  - [ ] 4b. Seed `primary`/`assetClass` from the tracked maps in
    `lib/intelligence/search-query.js` (`TRACKED_TICKERS`, `CRYPTO_TICKERS`) when the symbol
    is tracked; set `source='tracked-map'`. _(Req 3.2)_
  - [ ] 4c. Call `requestAiJson` (strict JSON, low temperature, bounded tokens) to expand
    related entities + rank seed keywords; merge with any seed; `source='ai'`. _(Req 3.1)_
  - [ ] 4d. On AI failure/empty, fall back to `extractSearchQuery` as a single seed keyword;
    `source='fallback-extractor'`. _(Req 3.5)_
- [ ] 5. Rewrite `runCollectStage` in `lib/plan-workflow.js`. _(Req 3.3, Req 3.4)_
  - [ ] 5a. Call `resolveEntityProfile`; attach the live Hyperliquid snapshot for tracked
    symbols (reuse existing snapshot helpers), noting any gap.
  - [ ] 5b. Write `collect_output = { entity, snapshot, seedKeywords, notes }` and advance to
    `research` via `commitStage` (`outputColumn: 'collect_output'`, `nextStage: 'research'`).
  - [ ] 5c. Remove the old inline search from collect (search now lives in `research`).
- [ ] 6. Create `plan-entity.test.js`. _(Req 3)_ — tracked seeding, AI-expansion parsing,
  fallback path, ambiguous asset class.

## Phase 3: Iterative research loop

- [ ] 7. Create `lib/plan-research.js`. _(Req 4)_
  - [ ] 7a. `PLAN_MAX_SEARCH_CALLS` from env (default 10). _(Req 4.7)_
  - [ ] 7b. `runResearchIteration({ job, deps }) → { researchState, searchCallCount, done,
    reason }`. Initialize `research_state` from `collect_output.seedKeywords` on first
    iteration.
  - [ ] 7c. Issue next queries from `keywordQueue` limited to remaining budget
    (`cap - searchCallCount`); skip any query already in `seenQueries`; increment
    `search_call_count` only on successful SearchApi.io HTTP calls. _(Req 4.7, Req 4.8, Req 4.9)_
  - [ ] 7d. Accumulate + dedupe results by link/title into `accumulatedResults`; update
    `seenQueries`/`seenLinks`. _(Req 4.9)_
  - [ ] 7e. `assessCoverage({ results, aiJson })` via DeepSeek returning `{ sufficient,
    facetsCovered, gapKeywords[] }`; **force `sufficient=false` unless overview + latest
    news + ≥1 catalyst are all covered**. _(Req 4.2, Req 4.3)_
  - [ ] 7f. Termination: `done=true` when (`sufficient` && floor met) OR `keywordQueue`
    empty OR `searchCallCount >= cap`. When cap hit with facets uncovered, set
    `research_state.gapNote`. Never exceed cap. _(Req 4.4, Req 4.6, Req 4.7)_
  - [ ] 7g. Append an `iterations[]` trace entry each call (queries, assessment,
    gapKeywords, callsAfter, facet status). _(Req 4.10)_
  - [ ] 7h. AI assessment must not increment `search_call_count`. _(Req 4.11)_
- [ ] 8. Add `advanceResearchStage(job, deps)` + wire into `advanceOneStage` in
  `lib/plan-workflow.js`. _(Req 4.5, Req 4.6)_
  - [ ] 8a. Branch on `stage === 'research'` in `advanceOneStage` (research is NOT in
    `STAGE_TRANSITIONS`).
  - [ ] 8b. Call `runResearchIteration`; if `!done` → `commitResearchProgress` (stays on
    `research`); if `done` → write `research_output` (finalized deduped corpus + gapNote)
    via `commitStage` and advance to `technical`.
- [ ] 9. Create `plan-research.test.js`. _(Req 4)_
  - [ ] 9a. Cap never exceeded across simulated multi-tick runs; count spans ticks.
  - [ ] 9b. Floor blocks premature `sufficient` (missing catalyst ⇒ not sufficient).
  - [ ] 9c. Cap-with-gap sets `gapNote` and still terminates.
  - [ ] 9d. Duplicate queries skipped; duplicate links filtered.
  - [ ] 9e. Failed SearchApi.io call does not consume budget; retried next iteration.
  - [ ] 9f. All termination reasons reported correctly.

## Phase 4: Analytical phases (P1–P8)

> Each runner is one bounded `requestAiChat` call reading upstream JSONB outputs, writing
> its own output column, advancing to the next stage. Every prompt enforces fact-vs-
> inference separation and the neutral-stage prohibition (no entry/stop/target). Each is
> reused if its output already exists on the job (mirror existing stage reuse). _(Req 13)_

- [ ] 10. `runTechnicalStage` — P1 from Hyperliquid snapshot + research corpus. _(Req 2)_
  - [ ] 10a. Trend regime, momentum, volatility, S/R as labeled fact/inference; quantify.
  - [ ] 10b. If snapshot missing, note gap and derive best-effort from web; never invent
    indicator values. _(Req 2.3, Req 12.2)_
- [ ] 11. `runPositioningStage` — P2. _(Req 5)_ — Hyperliquid OI/funding where available +
  web; mark "Not found — [what searched]" for unsourceable metrics; classify crowding as
  labeled inference. _(Req 5.2, Req 5.3)_
- [ ] 12. `runSentimentMacroStage` — P3+P4. _(Req 6)_ — headlines/tone (attributed), macro/
  cross-asset regime, sentiment-vs-price divergence (inference); state when web context
  unverifiable. _(Req 6.3, Req 6.4)_
- [ ] 13. `runCatalystsStage` — P5. _(Req 7)_ — forward ~60d/30d-focus dated calendar with
  type + direction skew; horizon-bound; "Not found" for unsourceable dates. _(Req 7.2, Req 7.3)_
- [ ] 14. `runAssetSpecificStage` — asset-class phase. _(Req 8)_ — detect class; crypto
  (supply/unlocks/holders/flows) | equity (earnings/analyst/SI/catalysts) | commodity or
  etf_index (inventory/curve/positioning); ambiguous ⇒ best-effort multi-class + note. _(Req 8.2–8.5)_
- [ ] 15. `runFactorAssemblyStage` — two-sided factors. _(Req 9)_ — read technical+
  positioning+sentiment_macro+catalysts+asset_specific; emit four inventories (Risks While
  Long, Risks While Short, Drivers Favoring Long, Drivers Favoring Short); each item
  fact+source, labeled inference, quantification; both sides even when direction≠both. _(Req 9.2–9.4)_
- [ ] 16. `runAsymmetryStage` — P8 pure inference. _(Req 10)_ — which side has more visible
  drivers (count+magnitude), where vol concentrates, invalidating binary events, biggest
  known unknown; phrased as asymmetry; built only on `factor_output`. _(Req 10.1–10.3)_
- [ ] 17. Rewrite `STAGE_TRANSITIONS` + the runner dispatch map in `advanceOneStage` for the
  full linear order (collect→research handled specially; technical…asymmetry→levels→plan→
  send→done). Ensure output-reuse short-circuit for every analytical stage. _(Req 1.2, Req 1.3)_
- [ ] 18. Define per-stage token budget constants and keep DeepSeek as the provider for every
  analytical/assembly/assessment call. _(Req 15)_
  - [ ] 18a. Add named `*_MAX_TOKENS` constants sized for full-fidelity phase output
    (env-overridable), replacing the old shared 900-token budgets. _(Req 15.2)_
  - [ ] 18b. All analytical runners, `assessCoverage`, `resolveEntityProfile`, `assemblePlan`
    call the existing `lib/ai-client.js` (`requestAiChat`/`requestAiJson`) — no new provider.
    _(Req 15.1)_
  - [ ] 18c. Keep each call a single bounded stage (no fidelity that would need a longer-than-
    timeout call); if more is needed, it is a separate stage. _(Req 15.3)_
- [ ] 19. Extend `plan-workflow.test.js`. _(Req 1, Req 2, Req 5–Req 10)_
  - [ ] 19a. `advanceOneStage` walks the full 13-state order end to end (with fakes).
  - [ ] 19b. Each analytical runner returns its field; reused when output already present.
  - [ ] 19c. `advanceResearchStage` loops (commitResearchProgress) then advances on done.
  - [ ] 19d. Assert every analytical + levels prompt carries the neutral prohibition. _(Req 13.4)_

## Phase 5: Levels, plan, and send

- [ ] 20. Update `runLevelsStage` inputs to read `research_output` facts + technical output
  + snapshot (was `fact_check`). Keep neutral. _(Req 11.1)_
- [ ] 21. Confirm/adjust `runPlanStage` + `assemblePlan` to consume the new upstream fields;
  keep per-side entries/stop/targets/rationale + supported `conditions[]`; only stage that
  emits executable levels. Degrade to analysis summary + `degraded` flag on JSON failure.
  _(Req 11.2, Req 11.5, Req 13.4)_
- [ ] 22. Add `splitTelegramSections(sections[]) → messages[]` to `lib/telegram-format.js`.
  _(Req 14.1, Req 14.2)_
  - [ ] 22a. Pack labeled sections into ≤4096-char HTML-safe messages; never split inside a
    tag; split an oversized single section on paragraph/line boundaries.
  - [ ] 22b. Unit-test: 4096 respected, no broken tags, oversized section split, order
    preserved.
- [ ] 23. Rework `runSendStage` (`lib/plan-workflow.js`) + `formatPlanReply`
  (`lib/plan-command.js`). _(Req 14)_
  - [ ] 23a. Build ordered sections: Technical, Positioning, Sentiment & Macro, Catalysts,
    Asset-Specific, Risks While Long, Risks While Short, Drivers Favoring Long, Drivers
    Favoring Short, Asymmetry, Execution, Notes. _(Req 14.1)_
  - [ ] 23b. Send each split message in order; preserve the `markReplySent` idempotency
    guard so a re-run never double-posts. _(Req 14.3)_
  - [ ] 23c. Tracked symbol: normalize `conditions[]` → decision-tree alerts, save, append
    saved/rejected status line; non-tracked: skip alert save + note why. _(Req 11.3, Req 11.4, Req 14.4)_

## Phase 6: Command surface, drivers, non-tracked depth

- [ ] 24. Update `PLAN_RUNNER_STAGES` in `lib/plan-stage-runner.js` to include all new
  stage names so `/api/plan-runner/<stage>` works (research, technical, …, asymmetry).
  _(Req 1, Req 4, Req 16)_
- [ ] 25. Update `/planstatus` rendering in `lib/plan-command.js`. _(Req 16.2, Req 16.3)_
  - [ ] 25a. Update `PLAN_STAGE_STEPS` to the new 12-step ladder.
  - [ ] 25b. Render `research` as `Research (calls X/10)` from `research_state` /
    `search_call_count`. _(Req 16.3)_
  - [ ] 25c. Update `planQueuedMessage` step text.
- [ ] 26. Non-tracked full-depth confirmation. _(Req 12)_ — verify all P1–P8 stages run for a
  non-tracked symbol; entity expansion + research loop supply foundational context; snapshot
  gaps noted (snapshot-based vs web-derived); levels still produced, alert save skipped. Add
  a workflow test with a non-tracked fake symbol. _(Req 12.1–12.4)_
- [ ] 27. Extend `plan-command.test.js`. _(Req 16)_ — `/planstatus` new ladder +
  `Research (calls X/10)`; queued message; persistence-unavailable path unchanged; one-open-
  job-per-chat-per-symbol guard intact.

## Phase 7: Docs & end-to-end verification

- [ ] 28. Update `README.md` `/plan` section: new stage list, the research loop + 10-call
  cap, `PLAN_MAX_SEARCH_CALLS`, per-stage runner curls for the new stages, updated
  `/planstatus` output. _(Req 1, Req 4, Req 16)_
- [ ] 29. End-to-end dry run (fakes): queue `$SPCX` → collect resolves SpaceX/Elon/
  Starlink/Tesla → research loops within cap and meets the facet floor (or terminates at cap
  with gapNote) → all P1–P8 stages populate → levels+plan produce executable levels →
  send emits ordered ≤4096 section messages, alerts saved (tracked) / skipped (non-tracked).
  _(Req 1–Req 16)_
- [ ] 30. Requirement-coverage sweep: confirm every requirement ID (Req 1–Req 16, including
  sub-criteria) is referenced by at least one completed task before closing out. _(all)_

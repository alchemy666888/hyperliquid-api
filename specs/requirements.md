# Requirements: SwingScope P1–P8 `/plan` Pipeline

## Introduction

The Telegram `/plan` command currently runs a durable, event-driven state machine
(`collect → fact_check → infer → levels → plan → send → done`) over a `plan_jobs`
PostgreSQL table, moved forward by a ~45s scheduler tick (or the
`/api/plan-runner/:stage` endpoints). Each stage does one bounded DeepSeek call so no
single Vercel function times out.

This feature **restructures that pipeline to full P1–P8 fidelity** of the SwingScope
multi-asset swing-trading analyst instruction: technical, positioning/flows, sentiment,
macro/cross-asset, catalyst calendar, an asset-specific phase, a two-sided factor
assembly, and an asymmetry/edge map — feeding a final executable plan. Market data comes
from the Hyperliquid API; latest news and foundational context come from SearchApi.io.
Unlike the source instruction, this build **intentionally keeps execution levels**
(entry / stop / target) and the saved-alert integration.

## Goals

- Reproduce the SwingScope P1–P8 analytical structure inside the existing durable
  `plan_jobs` state machine, one stage per phase group, so each stage stays a small,
  timeout-safe AI call.
- Source **market/technical data from the Hyperliquid API** and **news + foundational
  context from SearchApi.io** for every symbol.
- **Resolve the symbol to its full entity graph before searching** (e.g. `$SPCX` →
  SpaceX, Elon Musk, Starlink, Tesla), then run an **iterative agentic search loop**
  (SearchApi.io → AI assesses coverage & proposes gap keywords → SearchApi.io → …) until
  results are sufficient or the **10-call cap** is hit, so the report is grounded in the
  real company/token and its related entities, not just the raw ticker.
- Analyze non-tracked symbols at the **same depth** as the 12 tracked Hyperliquid assets,
  best-effort, rather than degrading them to analysis-only.
- Preserve **fact-vs-inference discipline**: facts carry source + UTC; inferences are
  labeled and never blurred into facts.
- Produce **symmetric two-sided coverage** (Risks While Long, Risks While Short, Drivers
  Favoring Long, Drivers Favoring Short) plus an Asymmetry & Edge map.
- **Keep executable levels** (entry / stop / target) and the existing saved-alert path for
  tracked symbols. (This deliberately overrides the source prompt's no-recommendation rule.)
- Deliver the full report to Telegram, **auto-split into labeled sections** to respect the
  4096-character limit.
- Reuse the existing DeepSeek `ai-client`, with **raised per-stage token budgets**.

## Non-Goals

- No new external data providers (no CoinGlass, CFTC COT, EIA, Nansen, UnusualWhales,
  etc.). Positioning/flow/macro/catalyst *facts* come only from what Hyperliquid exposes
  plus SearchApi.io web results; items that cannot be sourced are marked "Not found".
- Entity expansion and the iterative search loop use only the DeepSeek AI client's own
  knowledge to resolve entities and assess result coverage; they do **not** add a new
  symbol-directory / ticker-database provider. Every search call still goes to
  SearchApi.io only.
- No new output surface. Telegram only — no Canvas, web report, or email.
- No change to the `/planstatus`, `/prices`, `/asset`, `/rsh`, `/condition`, or alert-engine
  commands beyond what the new `plan_jobs` columns require.
- No change to the external-scheduler contract other than adding the new per-stage runner
  paths. The `collect → … → send → done` orchestration model is retained.
- No switch away from DeepSeek to another AI provider.
- No multi-year fundamental theses without a near-term catalyst, and no intraday-noise
  analysis (swing horizon discipline is retained).

## Requirements

### Requirement 1: Phase-group staged pipeline
**User story:** As the bot operator, I want the `/plan` workflow to run each SwingScope
phase group as its own durable stage, so that full P1–P8 analysis completes without any
single Vercel function timing out.

**Acceptance criteria:**
1. The system SHALL execute plan jobs through the ordered stages
   `collect → research → technical → positioning → sentiment_macro → catalysts →
   asset_specific → factor_assembly → asymmetry → levels → plan → send → done`.
2. WHEN a stage completes THEN the system SHALL persist that stage's output to its own
   `plan_jobs` column and advance the job to the next stage with status `pending`.
3. WHEN a stage's output already exists on the job row THEN the system SHALL reuse it and
   SHALL NOT re-run that stage's AI call.
4. IF a stage's AI call fails with a missing-data or provider error THEN the system SHALL
   raise a `PlanStageError` naming the stage, and the runner SHALL apply the existing
   retry/stale-reap budget before marking the job `failed`.
5. WHILE a job is `running` and its lock is older than the configured stale window the
   system SHALL reap it back to `pending` (or `failed` past the retry budget), exactly as
   the current machine does.
6. The system SHALL keep processing at most one job per stage per runner/scheduler tick.
7. WHERE a stage is re-entrant (the `research` stage) THEN the system SHALL allow the job
   to remain on that stage across multiple ticks, persisting incremental progress each
   tick, and SHALL advance to the next stage only when that stage signals completion.

### Requirement 2: P1 Technical stage
**User story:** As a swing trader, I want a technical read grounded in live Hyperliquid
data, so that price structure, trend regime, and momentum are quantified.

**Acceptance criteria:**
1. WHEN the technical stage runs THEN the system SHALL use the Hyperliquid snapshot
   (price, regime, EMAs, RSI, MACD, Bollinger, ATR, ADX/DI, recent highs/lows, volume vs
   average) as the factual technical base.
2. The system SHALL report trend regime (up / down / range / breakout / breakdown-pending),
   momentum, volatility, and nearby support/resistance areas, each as a labeled fact or
   labeled inference.
3. IF a live Hyperliquid snapshot is unavailable for the symbol THEN the system SHALL note
   the gap and derive technical context best-effort from web results, without inventing
   indicator values.
4. The system SHALL quantify each technical claim (numeric value, % distance, or ratio)
   wherever a number is available.

### Requirement 3: Symbol entity expansion (collect stage)
**User story:** As a swing trader, I want the bot to understand *what* my ticker actually
is before it searches, so that a request for `$SPCX` is anchored to SpaceX, Elon Musk,
Starlink, Tesla, and related context — not just the literal string "SPCX".

**Acceptance criteria:**
1. WHEN the collect stage runs THEN the system SHALL call the DeepSeek AI client to resolve
   the requested symbol into a structured entity profile: the primary company/token name,
   asset class, and a ranked list of related search entities (aliases, parent/related
   companies, key people, products/tickers).
2. IF a symbol is one of the 12 tracked assets with a known mapping (e.g. `BTCUSDT` →
   Bitcoin) THEN the system SHALL seed the entity profile from that mapping before AI
   expansion, and MAY still expand to related entities.
3. WHEN the symbol is one of the tracked assets THEN the collect stage SHALL also attach
   the live Hyperliquid snapshot for the symbol (as today), noting any gap.
4. WHEN entity resolution completes THEN the system SHALL persist the entity profile and an
   initial ranked keyword set to the collect output and advance the job to the `research`
   stage.
5. IF entity resolution fails or returns nothing usable THEN the system SHALL persist a
   fallback profile built from the existing single-query extraction path, so `research`
   still has a starting keyword set.

### Requirement 4: Iterative agentic search loop (research stage)
**User story:** As a swing trader, I want the bot to keep refining its searches based on
what it finds, so that it fills gaps (catalysts, earnings, sentiment) across follow-up
searches instead of stopping after one shot.

**Acceptance criteria:**
1. WHEN the research stage runs for a job THEN the system SHALL, on each scheduler tick,
   perform one loop iteration: issue one or more SearchApi.io calls for the job's current
   keyword set, accumulate and deduplicate results, then call the DeepSeek AI client to
   assess coverage.
2. The AI coverage assessment SHALL return either `sufficient: true` or a ranked set of
   follow-up keywords targeting the specific gaps it identifies (overview, latest news,
   catalysts, earnings/financials, sentiment, sector/peers, macro).
3. The system SHALL NOT allow the assessment to return `sufficient: true` UNLESS the
   accumulated results cover **all three** mandatory facets: (a) entity overview /
   what-the-symbol-is, (b) latest news, and (c) at least one dated or near-term catalyst.
   WHILE any mandatory facet is uncovered the system SHALL treat the result as insufficient
   and SHALL require follow-up keywords targeting the missing facet(s).
4. WHERE the mandatory-facet floor cannot be satisfied before the call cap is reached THEN
   the system SHALL terminate anyway at the cap, mark which mandatory facets remain
   uncovered, and pass that gap note downstream (it SHALL NOT loop past the cap to chase
   them).
5. WHEN the research stage completes an iteration THEN the system SHALL persist the updated
   accumulated results, the running SearchApi.io call count, the AI assessment, and the
   next keyword set back to the job row, keeping the job on the `research` stage.
6. The system SHALL terminate the loop and advance to the `technical` stage when any of
   these is true: the AI returns `sufficient: true` with the mandatory-facet floor met; the
   follow-up keyword set is empty; or the total SearchApi.io call count reaches the cap.
7. The system SHALL cap total SearchApi.io calls at **10 per plan request**
   (`PLAN_MAX_SEARCH_CALLS`, default 10) and SHALL never exceed it regardless of AI output;
   the running count SHALL persist across ticks so the cap spans the whole job, not one
   tick.
8. WHERE the AI proposes more follow-up queries than the remaining budget allows THEN the
   system SHALL issue only the highest-ranked queries that fit and note the truncation.
9. The system SHALL NOT re-issue an identical query already run in an earlier iteration and
   SHALL deduplicate results across all iterations by link/title.
10. The system SHALL record an auditable loop trace on the job: each iteration's issued
    queries, the AI's per-iteration sufficiency assessment and gap keywords, the running
    call count, mandatory-facet coverage status, and the loop-termination reason.
11. Only SearchApi.io calls SHALL count toward the 10-call cap; the per-iteration AI
    assessment SHALL NOT consume that budget.
12. IF the research stage exceeds its retry/stale budget without terminating THEN the
    existing reaper SHALL fail the job, exactly as for any other stage.

### Requirement 5: P2 Positioning & Flows stage
**User story:** As a swing trader, I want positioning and flow context, so that I can see
crowding and directional pressure.

**Acceptance criteria:**
1. WHEN the positioning stage runs THEN the system SHALL surface any positioning/flow
   signals obtainable from the Hyperliquid API (e.g. open interest, funding, where exposed)
   and from SearchApi.io results.
2. WHERE a positioning metric named in the SwingScope instruction cannot be sourced from
   Hyperliquid or the web THEN the system SHALL emit "Not found — [what was searched]"
   rather than fabricating a value.
3. The system SHALL classify positioning as crowded-long, crowded-short, or neutral when
   the available data supports it, as a labeled inference.

### Requirement 6: P3 + P4 Sentiment & Macro stage
**User story:** As a swing trader, I want sentiment and macro/cross-asset context, so that
I understand the regime the symbol trades inside.

**Acceptance criteria:**
1. WHEN the sentiment_macro stage runs THEN the system SHALL summarize recent headlines,
   notable stances, and sentiment tone from SearchApi.io results, each attributed to a
   source.
2. The system SHALL summarize the macro/cross-asset regime relevant to the symbol (risk
   regime, USD, rates, and the asset-class-appropriate correlations) from available web
   context.
3. IF sentiment or macro context cannot be verified from web results THEN the system SHALL
   state that current context could not be verified and continue.
4. The system SHALL flag any sentiment-vs-price divergence it can infer, labeled as
   inference.

### Requirement 7: P5 Catalyst calendar stage
**User story:** As a swing trader, I want upcoming catalysts inside my horizon, so that I
know which events can move the symbol.

**Acceptance criteria:**
1. WHEN the catalysts stage runs THEN the system SHALL produce a forward calendar
   (≈60-day window, 30-day focus) of dated events with type and a direction skew, from
   available web context.
2. The system SHALL restrict emphasis to catalysts relevant within the job's horizon and
   SHALL omit multi-year items with no near-term catalyst.
3. WHERE a catalyst date or magnitude cannot be sourced THEN the system SHALL mark it
   "Not found" rather than inventing a date.

### Requirement 8: Asset-specific stage
**User story:** As a swing trader, I want the phase that matters most for this asset class,
so that crypto/equity/commodity-specific drivers are covered.

**Acceptance criteria:**
1. WHEN the asset_specific stage runs THEN the system SHALL detect the asset class
   (crypto / equity / commodity / ETF-index) from the symbol.
2. WHERE the asset is crypto THEN the system SHALL cover supply/unlocks, holder
   concentration, and flow posture to the extent sourceable.
3. WHERE the asset is an equity THEN the system SHALL cover earnings posture, analyst
   revisions, short interest, and known catalysts to the extent sourceable.
4. WHERE the asset is a commodity or ETF/index THEN the system SHALL cover the
   inventory/curve/positioning drivers appropriate to it, to the extent sourceable.
5. IF asset class is ambiguous THEN the system SHALL default to best-effort multi-class
   treatment and note the ambiguity, rather than blocking the pipeline.

### Requirement 9: Two-sided factor assembly stage
**User story:** As a swing trader, I want every factor framed for both sides, so that I get
bias-free situational awareness.

**Acceptance criteria:**
1. WHEN the factor_assembly stage runs THEN the system SHALL, for each factor group
   (technical, positioning, flow, catalysts, macro, liquidity, asset-specific, sentiment),
   identify both bearish triggers and bullish triggers present in the assembled evidence.
2. The system SHALL organize output into four inventories: Risks While Long, Risks While
   Short, Drivers Favoring Long, Drivers Favoring Short.
3. Each item SHALL carry a fact (with source), a labeled inference, and a quantification
   where a number exists.
4. WHERE the job direction is `long` or `short` (not `both`) THEN the system SHALL still
   inventory both-side risks and drivers, but MAY emphasize the requested side.

### Requirement 10: Asymmetry & edge map stage
**User story:** As a swing trader, I want a pure-inference asymmetry read, so that I can see
which side has more visible drivers and where volatility concentrates.

**Acceptance criteria:**
1. WHEN the asymmetry stage runs THEN the system SHALL state which side carries more
   visible drivers (count and magnitude) and which carries more visible risks.
2. The system SHALL identify where volatility concentrates, which binary events could
   invalidate the technical setup, and the biggest known unknown.
3. The system SHALL phrase this as asymmetry (e.g. "drivers weight toward [side] N vs M"),
   as labeled inference built only on prior stages.

### Requirement 11: Executable levels + plan stages (retained)
**User story:** As a swing trader, I want concrete entry / stop / target levels, so that I
can act and arm alerts.

**Acceptance criteria:**
1. WHEN the levels stage runs THEN the system SHALL derive neutral support/resistance,
   volatility, and monitorable signal areas from the assembled facts and Hyperliquid
   snapshot.
2. WHEN the plan stage runs THEN the system SHALL emit, per requested side, `entries[]`,
   `stop`, `targets[]`, and `rationale`, plus machine-evaluatable `conditions[]` using only
   the supported condition kinds.
3. WHERE the symbol is one of the 12 tracked assets THEN the system SHALL normalize plan
   conditions into decision-tree alerts and save them, as it does today.
4. WHERE the symbol is not tracked THEN the system SHALL still produce entry / stop / target
   levels but SHALL skip alert saving and note why.
5. IF the plan JSON cannot be assembled THEN the system SHALL degrade gracefully to an
   analysis summary and flag the degradation, without failing the whole job.

### Requirement 12: Non-tracked symbols at full depth
**User story:** As a swing trader, I want any symbol analyzed at the same depth as the
tracked twelve, so that coverage isn't limited to Hyperliquid's fixed list.

**Acceptance criteria:**
1. WHEN a `/plan` is queued for a non-tracked symbol THEN the system SHALL run all P1–P8
   stages and produce entry / stop / target levels.
2. IF the Hyperliquid snapshot lacks the symbol THEN the system SHALL fetch what market
   data the Hyperliquid API can provide for it and fill remaining technical/positioning
   context from SearchApi.io, without fabricating indicator values.
3. WHEN the symbol is non-tracked THEN the system SHALL rely on the entity expansion
   (Requirement 3) and iterative search loop (Requirement 4) to build foundational context,
   since the raw ticker alone is least likely to resolve for obscure symbols.
4. The system SHALL clearly note, in the output, which inputs were snapshot-based versus
   web-derived.

### Requirement 13: Fact-vs-inference & data integrity discipline
**User story:** As a swing trader, I want facts and inferences visibly separated and
timestamped, so that I can trust the report's provenance.

**Acceptance criteria:**
1. The system SHALL keep facts and inferences visibly distinct in every analytical stage
   ("Fact: … [source]" vs "Inference: …") and SHALL NOT blur them.
2. The system SHALL attribute factual web claims to a source and SHALL timestamp
   time-sensitive data (UTC) where the source provides it.
3. IF a datum cannot be found THEN the system SHALL write "Not found — [what was searched]"
   instead of inventing it.
4. The system SHALL retain the neutral-stage prohibition on emitting entry/stop/target in
   every stage **except** the final `plan` stage, which is the only stage permitted to emit
   executable levels.

### Requirement 14: Telegram section-split delivery
**User story:** As a Telegram user, I want the full report delivered readably, so that long
P1–P8 output isn't truncated by Telegram's message cap.

**Acceptance criteria:**
1. WHEN the send stage runs THEN the system SHALL render the report as labeled sections:
   Technical, Positioning, Sentiment & Macro, Catalysts, Asset-Specific, Risks While Long,
   Risks While Short, Drivers Favoring Long, Drivers Favoring Short, Asymmetry, Execution,
   Notes.
2. WHERE a rendered section would exceed the Telegram 4096-character limit THEN the system
   SHALL split it across multiple messages without breaking HTML formatting.
3. The system SHALL send sections in order and SHALL preserve the existing idempotent
   "reply already sent" guard so a re-run never double-posts.
4. WHEN alerts are saved (tracked symbol) THEN the system SHALL include the saved/rejected
   alert status line, as it does today.

### Requirement 15: DeepSeek reuse with raised budgets
**User story:** As the bot operator, I want each new stage to use the existing AI client
with enough tokens, so that richer phases aren't truncated but the provider stays the same.

**Acceptance criteria:**
1. The system SHALL call the existing DeepSeek `ai-client` (`requestAiChat` /
   `requestAiJson`) for every analytical and assembly stage.
2. The system SHALL apply per-stage maximum token budgets sized for full-fidelity phase
   output, configurable via constants/env.
3. WHILE any single stage runs the system SHALL keep that one AI call within Vercel's
   function time limit; if fidelity would require more, the phase SHALL be a separate stage
   rather than a larger single call.

### Requirement 16: Backward-compatible command surface
**User story:** As an existing user, I want `/plan` and `/planstatus` to keep working, so
that the richer pipeline doesn't break current behavior.

**Acceptance criteria:**
1. The system SHALL keep the `/plan <symbol> [long|short|both] [horizon]` argument parsing
   and the immediate "queued" acknowledgement.
2. The system SHALL keep `/planstatus [symbol]`, updating its stage-progress display to the
   new stage set and step counts.
3. WHILE a job is on the re-entrant `research` stage THEN `/planstatus` SHALL show search
   progress (e.g. calls used out of the cap) rather than a single static step, so the user
   can see the loop advancing.
4. IF PostgreSQL persistence is unavailable THEN the system SHALL return the existing
   "plan requires database persistence" message and SHALL NOT attempt the pipeline.
5. The system SHALL preserve the one-open-job-per-chat-per-symbol guard.

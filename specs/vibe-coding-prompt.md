# Build Prompt: SwingScope P1–P8 `/plan` Pipeline

You are an autonomous coding agent (Codex) working in the existing repository
`alchemy666888/hyperliquid-api`. A complete spec already exists in
`specs/swingscope-plan-p1-p8/`. Your job is to **implement it, not redesign it**.

You are extending a live Telegram trading bot. The `/plan` command already runs a durable,
event-driven state machine over a `plan_jobs` PostgreSQL table, advanced by a scheduler
tick and per-stage HTTP runners. You are widening that pipeline to full SwingScope P1–P8
analytical fidelity and adding an agentic, iterative web-search loop. Do **not** rebuild the
state machine or change its concurrency model — build on it.

## Read first (source of truth)

- `specs/swingscope-plan-p1-p8/requirements.md` — what to build; acceptance criteria in
  EARS format (Req 1–Req 16).
- `specs/swingscope-plan-p1-p8/design.md` — architecture, the new `plan_jobs` columns,
  component responsibilities, data model, and the four key flows.
- `specs/swingscope-plan-p1-p8/tasks.md` — the ordered checklist (Tasks 1–30) you will
  execute.

Read all three before writing any code. Also read the existing implementation you are
extending, since the spec references it by name:
`lib/plan-jobs.js`, `lib/plan-workflow.js`, `lib/plan-stage-runner.js`,
`lib/plan-command.js`, `lib/plan-alerts.js`, `lib/intelligence/search-query.js`,
`lib/search.js`, `lib/hyperliquid.js`, `lib/ai-client.js`, `lib/telegram-format.js`,
`scripts/plan-scheduler.js`, and `api/plan-runner/[stage].js`.

## How to work

1. Work through `tasks.md` top to bottom, one task at a time. Do not jump ahead.
2. After completing a task, verify its outcome (run the relevant tests), then check its box
   in `tasks.md`.
3. **The spec is authoritative. If a task is ambiguous, conflicts with the design, or looks
   wrong, STOP and ask — do not improvise outside the spec.** This is the most important
   rule. An eager guess that adds unspecified behavior is worse than a question.
4. Keep each change scoped to the task at hand. Do not refactor unrelated code, rename
   existing exports, or change behavior of commands other than `/plan` and `/planstatus`.
5. Match the existing code style: Node.js ESM, no new runtime dependencies beyond `pg`
   (already present), dependency-injection via a `deps` object for testability, and the
   existing patterns in the files you are editing.

## Critical implementation guardrails

These are the spots most likely to be built wrong. Honor them exactly:

- **`research` is a re-entrant stage.** It is NOT in `STAGE_TRANSITIONS`. On each tick it
  does one search+assess iteration; if not done it calls `commitResearchProgress` and
  **stays on `research`**; only when the loop terminates does it write `research_output`
  and advance to `technical`. (design.md Flow B; Req 1.7, Req 4.)
- **The 10-call cap spans the whole job, not one tick.** `search_call_count` is a top-level
  INT column and persists across ticks. Never exceed `PLAN_MAX_SEARCH_CALLS` (default 10)
  regardless of AI output. (Req 4.7.)
- **Sufficiency floor.** The coverage assessment may return `sufficient: true` only when the
  corpus covers all three: entity overview + latest news + at least one catalyst. If the cap
  is hit before the floor is met, terminate anyway, set `research_state.gapNote`, and pass
  the gap downstream — do not loop past the cap. (Req 4.3, Req 4.4.)
- **Failed SearchApi.io calls do not consume the budget** — only successful HTTP calls
  increment `search_call_count`. AI assessment calls never count. (Req 4.11; design.md Error
  Handling.)
- **Neutral-stage prohibition.** Every analytical stage and the `levels` stage must carry
  the no-entry/stop/target prohibition in its prompt. The `plan` stage is the ONLY stage
  permitted to emit executable levels. (Req 13.4.)
- **Execution levels are intentionally kept.** This build deliberately overrides the source
  SwingScope prompt's "no recommendations" rule — the `plan` stage emits entries/stop/
  targets and, for tracked symbols, saves decision-tree alerts. Do not strip them. (Req 11.)
- **Schema migration is additive.** Use `ADD COLUMN IF NOT EXISTS`. Keep legacy
  `factcheck_output`/`infer_output` columns nullable; no destructive drops. (Task 1c.)
- **Idempotent send.** Preserve the `markReplySent` guard so a re-run never double-posts,
  even when output is split across multiple Telegram messages. (Req 14.3.)

## Environment

- Stack: Node.js 24 (ESM), Vercel serverless, PostgreSQL via `pg` Pool, DeepSeek via
  `lib/ai-client.js` (`requestAiChat` / `requestAiJson`), SearchApi.io via `lib/search.js`,
  Hyperliquid via `lib/hyperliquid.js`, Telegram via `lib/telegram-client.js`.
- Install: `npm install`
- Test: `npm test` (runs `node --test`). Run after every task that has tests.
- Single scheduler tick (useful for manually walking a job through stages):
  `npm run plan-scheduler-once`
- Local dev server: `npm run dev` (`vercel dev`) — exposes `/api/plan-runner/<stage>`.
- Do not deploy. Do not run `npm run deploy`.

## Config you introduce

- `PLAN_MAX_SEARCH_CALLS` (default 10) — the per-plan SearchApi.io call cap.
- Per-stage `*_MAX_TOKENS` constants (env-overridable) for the raised DeepSeek budgets.
  Keep DeepSeek as the provider everywhere; do not add another AI provider. (Req 15.)

Do not commit secrets. Assume existing env vars (`POSTGRES_*`, `TELEGRAM_BOT_TOKEN`,
`SEARCHAPI_API_KEY`, DeepSeek keys) are already configured in the deployment environment.

## Definition of done

- Every task in `tasks.md` (1–30) is checked off.
- Every acceptance criterion in `requirements.md` (Req 1–Req 16) is satisfied.
- `npm test` passes, including the new `plan-entity.test.js`, `plan-research.test.js`, and
  the extended `plan-jobs`, `plan-workflow`, `plan-command`, and `telegram-format` tests.
- The end-to-end dry run in Task 29 walks a `$SPCX` job from `collect` through `done`:
  entity resolution → research loop within the cap (meeting the facet floor or terminating
  at the cap with a `gapNote`) → all P1–P8 stages populated → `plan` emits executable levels
  → `send` posts ordered, ≤4096-char section messages (alerts saved for tracked symbols,
  skipped with a note for non-tracked).
- `README.md`'s `/plan` section reflects the new 13-stage flow, the research loop and cap,
  `PLAN_MAX_SEARCH_CALLS`, and the updated per-stage runner endpoints (Task 28).
- The Task 30 requirement-coverage sweep confirms every requirement ID maps to completed
  work.

Start by reading the three spec files and the existing `plan-*` implementation, confirm
your understanding of the re-entrant `research` stage and the search-budget rules, then
begin Task 1.

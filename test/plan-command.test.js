import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assemblePlan,
  enqueuePlanJob,
  formatPlanReply,
  parsePlanArgs,
  planStatusCommand,
  resolvePlanSymbol,
  runResearchStages,
} from '../lib/plan-command.js';

const ASSETS = [
  { label: 'BTCUSDT', coin: 'BTC' },
  { label: 'XAUUSD', coin: 'xyz:GOLD' },
  { label: 'MU', coin: 'xyz:MU' },
];

test('parsePlanArgs applies symbol-only defaults', () => {
  assert.deepEqual(parsePlanArgs(['MU']), {
    symbol: 'MU',
    direction: 'both',
    horizon: '1-4w',
  });
});

test('parsePlanArgs recognizes direction and horizon tokens', () => {
  assert.deepEqual(parsePlanArgs(['MU', 'Long', '2w']), {
    symbol: 'MU',
    direction: 'long',
    horizon: '2w',
  });
  assert.deepEqual(parsePlanArgs(['MU', '8w', 'SHORT']), {
    symbol: 'MU',
    direction: 'short',
    horizon: '8w',
  });
});

test('parsePlanArgs ignores unrecognized extra tokens', () => {
  assert.deepEqual(parsePlanArgs(['MU', 'please', 'both', '1-4w', 'extra']), {
    symbol: 'MU',
    direction: 'both',
    horizon: '1-4w',
  });
});

test('resolvePlanSymbol matches label, coin, and USDT-stripped base', () => {
  assert.deepEqual(resolvePlanSymbol('btc-usdt', ASSETS), {
    resolvedSymbol: 'BTCUSDT',
    alertable: true,
    asset: ASSETS[0],
  });
  assert.deepEqual(resolvePlanSymbol('btc', ASSETS), {
    resolvedSymbol: 'BTCUSDT',
    alertable: true,
    asset: ASSETS[0],
  });
  assert.deepEqual(resolvePlanSymbol('gold', ASSETS), {
    resolvedSymbol: 'XAUUSD',
    alertable: true,
    asset: ASSETS[1],
  });
  assert.deepEqual(resolvePlanSymbol('xyz:mu', ASSETS), {
    resolvedSymbol: 'MU',
    alertable: true,
    asset: ASSETS[2],
  });
});

test('resolvePlanSymbol marks non-tracked symbols as analysis-only', () => {
  assert.deepEqual(resolvePlanSymbol('TSLA', ASSETS), {
    resolvedSymbol: 'TSLA',
    alertable: false,
    asset: null,
  });
});

test('runResearchStages collects snapshot and search context before neutral AI stages', async () => {
  const prompts = [];
  const result = await runResearchStages({
    symbol: 'MU',
    resolvedSymbol: 'MU',
    alertable: true,
    direction: 'both',
    horizon: '1-4w',
    deps: {
      extractionCache: null,
      getHyperliquidSnapshot: async () => ({
        timestamp: '2026-07-02T00:00:00.000Z',
        interval: '4h',
        assets: [
          {
            symbol: 'MU',
            coin: 'xyz:MU',
            price: 100,
            regime: 'MIXED',
            indicators: { rsi14: 50, ema20: 101, ema50: 99 },
          },
        ],
      }),
      extractSearchQuery: async ({ message }) => {
        assert.match(message, /MU swing trading research/);
        return { q: 'Micron MU latest catalysts', gl: 'us', hl: 'en', freshness: 'd', needs_search: true };
      },
      getSearch: async ({ params, limit }) => {
        assert.equal(limit, 6);
        assert.equal(params.engine, 'google_news');
        return {
          ok: true,
          results: [{ title: 'MU result', source: 'News', snippet: 'Fresh context' }],
        };
      },
      aiChat: async ({ messages }) => {
        prompts.push(messages[0].content);
        return { ok: true, text: prompts.length === 1 ? 'verified facts' : 'neutral inference' };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.stageOrder, ['collect', 'fact-check', 'infer']);
  assert.equal(result.snapshot.price, 100);
  assert.equal(result.search.results.length, 1);
  assert.equal(result.facts, 'verified facts');
  assert.equal(result.inference, 'neutral inference');
  assert.match(prompts[0], /Do not emit entry, stop, target, position size, or buy\/sell\/long\/short recommendations/);
  assert.match(prompts[1], /Do not emit entry, stop, target, position size, or buy\/sell\/long\/short recommendations/);
});

test('runResearchStages continues when search returns no usable results', async () => {
  const result = await runResearchStages({
    symbol: 'TSLA',
    resolvedSymbol: 'TSLA',
    alertable: false,
    direction: 'both',
    horizon: '1-4w',
    deps: {
      extractionCache: null,
      extractSearchQuery: async () => ({ q: 'TSLA news', gl: 'us', hl: 'en', freshness: 'd', needs_search: true }),
      getSearch: async () => ({ ok: true, results: [] }),
      aiChat: async () => ({ ok: true, text: 'stage text' }),
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.notes.join('\n'), /Current web results could not be verified/);
  assert.equal(result.snapshot, null);
});

test('runResearchStages returns an AI-unavailable marker when a neutral AI stage fails', async () => {
  const result = await runResearchStages({
    symbol: 'MU',
    resolvedSymbol: 'MU',
    alertable: false,
    direction: 'both',
    horizon: '1-4w',
    deps: {
      extractionCache: null,
      extractSearchQuery: async () => ({ q: 'MU news', gl: 'us', hl: 'en', freshness: 'd', needs_search: true }),
      getSearch: async () => ({ ok: false, results: [], error: 'search unavailable' }),
      aiChat: async () => ({ ok: false, error: 'DeepSeek is not configured.', missing: ['DEEPSEEK_API_KEY'] }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'ai-unavailable');
  assert.equal(result.stage, 'fact-check');
  assert.deepEqual(result.missing, ['DEEPSEEK_API_KEY']);
});

test('assemblePlan returns long and short plans with supported monitorable conditions for both direction', async () => {
  let systemPrompt = '';
  const result = await assemblePlan({
    symbol: 'MU',
    resolvedSymbol: 'MU',
    inference: 'Neutral inference.',
    facts: 'Verified facts.',
    direction: 'both',
    horizon: '2w',
    snapshot: { price: 100, indicators: { recentHigh20: 110, recentLow20: 90, atr14: 4, ema20: 101, ema50: 99 } },
    deps: {
      aiJson: async ({ messages }) => {
        systemPrompt = messages[0].content;
        return {
          ok: true,
          json: {
            analysisSummary: 'Summary.',
            long: { entries: [101], stop: 95, targets: [110], rationale: 'Upside.' },
            short: { entries: [94], stop: 100, targets: [90], rationale: 'Downside.' },
            conditions: [
              { symbol: 'MU', conditionKind: 'above', lowerPrice: 101, actionText: 'Long trigger.' },
              { symbol: 'MU', conditionKind: 'rsi_below', threshold: 30, actionText: 'RSI trigger.' },
              { symbol: 'MU', conditionKind: 'unsupported', actionText: 'Drop me.' },
            ],
          },
        };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan.long);
  assert.ok(result.plan.short);
  assert.deepEqual(result.plan.conditions.map(condition => condition.conditionKind), ['above', 'rsi_below']);
  assert.match(systemPrompt, /Only this stage may emit concrete entry, stop, target/);
});

test('assemblePlan keeps only the requested side and side-matching conditions', async () => {
  const result = await assemblePlan({
    symbol: 'MU',
    resolvedSymbol: 'MU',
    inference: 'Neutral inference.',
    direction: 'long',
    horizon: '2w',
    snapshot: null,
    deps: {
      aiJson: async () => ({
        ok: true,
        json: {
          analysisSummary: 'Summary.',
          long: { entries: [101], stop: 95, targets: [110], rationale: 'Upside.' },
          short: { entries: [94], stop: 100, targets: [90], rationale: 'Downside.' },
          conditions: [
            { side: 'long', conditionKind: 'ema_cross_up', actionText: 'Long technical trigger.' },
            { side: 'short', conditionKind: 'below', upperPrice: 94, actionText: 'Short trigger.' },
          ],
        },
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan.long);
  assert.equal(result.plan.short, undefined);
  assert.deepEqual(result.plan.conditions.map(condition => condition.conditionKind), ['ema_cross_up']);
});

test('assemblePlan degrades malformed AI JSON to a prose plan with zero conditions', async () => {
  const result = await assemblePlan({
    symbol: 'MU',
    resolvedSymbol: 'MU',
    inference: 'Neutral inference survived.',
    direction: 'both',
    horizon: '2w',
    deps: {
      aiJson: async () => ({ ok: false, error: 'response did not contain a JSON object' }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.plan.conditions.length, 0);
  assert.match(result.plan.analysisSummary, /Neutral inference survived/);
});

test('assemblePlan passes a bounded timeout to final AI assembly', async () => {
  const previous = process.env.PLAN_ASSEMBLY_TIMEOUT_MS;
  process.env.PLAN_ASSEMBLY_TIMEOUT_MS = '1234';
  let timeoutMs;

  try {
    const result = await assemblePlan({
      symbol: 'BTCUSDT',
      resolvedSymbol: 'BTCUSDT',
      inference: 'BTC inference survived.',
      direction: 'both',
      horizon: '1-4w',
      deps: {
        aiJson: async (request) => {
          timeoutMs = request.timeoutMs;
          return { ok: false, error: 'DeepSeek request timed out after 1234ms.' };
        },
      },
    });

    assert.equal(timeoutMs, 1234);
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
    assert.match(result.plan.analysisSummary, /BTC inference survived/);
  } finally {
    if (previous === undefined) {
      delete process.env.PLAN_ASSEMBLY_TIMEOUT_MS;
    } else {
      process.env.PLAN_ASSEMBLY_TIMEOUT_MS = previous;
    }
  }
});

test('formatPlanReply separates analysis, execution, and saved alert status', () => {
  const reply = formatPlanReply({
    pipeline: {
      symbol: 'MU',
      resolvedSymbol: 'MU',
      alertable: true,
      plan: {
        analysisSummary: 'Neutral summary.',
        long: {
          entries: [{ type: 'limit', price: 101, rationale: 'Breakout trigger.', timeInForce: 'GTC' }],
          stop: 95,
          targets: [{ type: 'limit', price: 110, rationale: 'First target.' }],
          rationale: 'Breakout follow-through.',
        },
        conditions: [],
      },
    },
    savedAlerts: [{ symbol: 'MU' }, { symbol: 'MU' }],
    rejected: [{ reason: 'unsupported' }],
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /<b>SwingScope plan<\/b>\n<code>MU<\/code>/);
  assert.match(reply.text, /<b>Analysis<\/b>/);
  assert.match(reply.text, /Neutral summary\./);
  assert.match(reply.text, /<b>Execution<\/b>/);
  assert.match(reply.text, /<b>Entries<\/b>\n1\. <code>limit @ 101<\/code>/);
  assert.match(reply.text, /<i>Why:<\/i> Breakout trigger\./);
  assert.match(reply.text, /<i>Time In Force:<\/i> GTC/);
  assert.match(reply.text, /<b>Stop \/ invalidation<\/b>\n<code>95<\/code>/);
  assert.match(reply.text, /<b>Targets<\/b>\n1\. <code>limit @ 110<\/code>/);
  assert.match(reply.text, /<b>Rationale<\/b>\nBreakout follow-through\./);
  assert.match(reply.text, /Alerts saved: 2 for MU\. 1 generated condition rejected\./);
});

test('formatPlanReply includes skipped alert note for non-tracked symbols', () => {
  const reply = formatPlanReply({
    pipeline: {
      symbol: 'TSLA',
      resolvedSymbol: 'TSLA',
      alertable: false,
      plan: { analysisSummary: 'Search-only summary.', conditions: [] },
    },
  });

  assert.match(reply.text, /Alerts skipped/);
  assert.match(reply.text, /TSLA is not one of the 12 tracked symbols/);
  assert.match(reply.text, /BTCUSDT/);
});

test('formatPlanReply truncates oversized Telegram replies', () => {
  const reply = formatPlanReply({
    pipeline: {
      symbol: 'MU',
      resolvedSymbol: 'MU',
      alertable: true,
      plan: {
        analysisSummary: 'x'.repeat(5000),
        long: { entries: [101], stop: 95, targets: [110], rationale: 'Long.' },
        conditions: [],
      },
    },
  });

  assert.ok(reply.text.length <= 3900);
  assert.match(reply.text, /\[Reply shortened for Telegram\.\]/);
});

test('formatPlanReply keeps truncated code entities balanced', () => {
  const reply = formatPlanReply({
    pipeline: {
      symbol: 'MU',
      resolvedSymbol: 'MU',
      alertable: true,
      plan: {
        analysisSummary: 'Short summary.',
        long: {
          entries: [{ type: 'limit', price: '1'.repeat(5000) }],
          stop: 95,
          targets: [110],
        },
        conditions: [],
      },
    },
  });
  const openCodeCount = reply.text.match(/<code>/g)?.length ?? 0;
  const closeCodeCount = reply.text.match(/<\/code>/g)?.length ?? 0;

  assert.ok(reply.text.length <= 3900);
  assert.match(reply.text, /\[Reply shortened for Telegram\.\]/);
  assert.equal(openCodeCount, closeCodeCount);
});

test('enqueuePlanJob returns usage when no symbol is supplied', async () => {
  const reply = await enqueuePlanJob({ args: [], chatId: 123 });

  assert.match(reply.text, /<b>SwingScope plan usage<\/b>/);
  assert.match(reply.text, /\/plan &lt;symbol&gt; \[long\|short\|both\] \[horizon\]/);
  assert.match(reply.text, /BTCUSDT/);
});

test('enqueuePlanJob refuses to run without PostgreSQL persistence', async () => {
  let inserted = false;
  const reply = await enqueuePlanJob({
    args: ['MU', 'long', '2w'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: false, missing: ['POSTGRES_URL'] }),
      insertPlanJob: async () => {
        inserted = true;
      },
    },
  });

  assert.equal(inserted, false);
  assert.match(reply.text, /requires database persistence/);
  assert.match(reply.text, /POSTGRES_URL/);
});

test('enqueuePlanJob refuses a duplicate in-flight job for the same chat and symbol', async () => {
  let inserted = false;
  const reply = await enqueuePlanJob({
    args: ['btc'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      findOpenJob: async (chatId, symbol) => {
        assert.equal(chatId, 123);
        assert.equal(symbol, 'BTCUSDT');
        return { id: 9, symbol: 'BTCUSDT' };
      },
      insertPlanJob: async () => {
        inserted = true;
      },
    },
  });

  assert.equal(inserted, false);
  assert.match(reply.text, /BTCUSDT is already being analyzed/);
});

test('enqueuePlanJob inserts a pending collect-stage job and returns an immediate ack', async () => {
  let insertedPayload;
  const reply = await enqueuePlanJob({
    args: ['MU', 'Long', '2w'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      findOpenJob: async () => null,
      insertPlanJob: async (payload) => {
        insertedPayload = payload;
        return { id: 42, stage: 'collect', status: 'pending', ...payload };
      },
    },
  });

  assert.deepEqual(insertedPayload, {
    chatId: 123,
    symbol: 'MU',
    resolvedSymbol: 'MU',
    alertable: true,
    direction: 'long',
    horizon: '2w',
  });
  assert.match(reply.text, /Accepted/);
  assert.match(reply.text, /analyzing MU/);
  assert.match(reply.text, /in progress/);
  assert.match(reply.text, /Queued at collect \(step 1\/6\)/);
  assert.match(reply.text, /I'll send the plan here shortly/);
});

test('enqueuePlanJob queues non-tracked symbols as analysis-only jobs', async () => {
  let insertedPayload;
  const reply = await enqueuePlanJob({
    args: ['TSLA'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      findOpenJob: async () => null,
      insertPlanJob: async (payload) => {
        insertedPayload = payload;
        return { id: 43, stage: 'collect', status: 'pending', ...payload };
      },
    },
  });

  assert.equal(insertedPayload.resolvedSymbol, 'TSLA');
  assert.equal(insertedPayload.alertable, false);
  assert.match(reply.text, /Analysis only/);
});

test('planStatusCommand reports the latest symbol job progress', async () => {
  let query;
  const reply = await planStatusCommand({
    args: ['btc'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      listPlanJobs: async (chatId, options) => {
        query = { chatId, options };
        return [
          {
            id: 7,
            symbol: 'BTC',
            resolvedSymbol: 'BTCUSDT',
            alertable: true,
            direction: 'both',
            horizon: '1-4w',
            stage: 'fact_check',
            status: 'running',
            createdAt: '2026-07-02T00:00:00.000Z',
            updatedAt: '2026-07-02T00:01:00.000Z',
          },
        ];
      },
    },
  });

  assert.deepEqual(query, {
    chatId: 123,
    options: { symbol: 'BTCUSDT', limit: 1 },
  });
  assert.match(reply.text, /<b>SwingScope plan status<\/b>/);
  assert.match(reply.text, /BTCUSDT/);
  assert.match(reply.text, /In progress/);
  assert.match(reply.text, /Running: Fact check \(step 2\/6\)/);
});

test('planStatusCommand warns when collect has waited too long for the scheduler', async () => {
  const reply = await planStatusCommand({
    args: ['SPCX'],
    chatId: 123,
    deps: {
      now: new Date('2026-07-02T11:44:00.000Z'),
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      listPlanJobs: async () => [
        {
          id: 11,
          symbol: 'SPCX',
          resolvedSymbol: 'SPCX',
          alertable: true,
          direction: 'both',
          horizon: '1-4w',
          stage: 'collect',
          status: 'pending',
          createdAt: '2026-07-02T11:23:00.000Z',
          updatedAt: '2026-07-02T11:23:00.000Z',
        },
      ],
    },
  });

  assert.match(reply.text, /No external runner call has picked this up for 21 minutes/);
  assert.match(reply.text, /\/api\/plan-runner\/collect/);
});

test('planStatusCommand does not warn for a fresh collect job', async () => {
  const reply = await planStatusCommand({
    args: ['SPCX'],
    chatId: 123,
    deps: {
      now: new Date('2026-07-02T11:24:00.000Z'),
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      listPlanJobs: async () => [
        {
          id: 11,
          symbol: 'SPCX',
          resolvedSymbol: 'SPCX',
          alertable: true,
          direction: 'both',
          horizon: '1-4w',
          stage: 'collect',
          status: 'pending',
          createdAt: '2026-07-02T11:23:00.000Z',
          updatedAt: '2026-07-02T11:23:00.000Z',
        },
      ],
    },
  });

  assert.doesNotMatch(reply.text, /No external runner call/);
});

test('planStatusCommand lists recent chat jobs when no symbol is supplied', async () => {
  let query;
  const reply = await planStatusCommand({
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      listPlanJobs: async (chatId, options) => {
        query = { chatId, options };
        return [
          { id: 8, resolvedSymbol: 'MU', symbol: 'MU', direction: 'long', horizon: '2w', stage: 'levels', status: 'pending' },
          { id: 7, resolvedSymbol: 'TSLA', symbol: 'TSLA', direction: 'both', horizon: '1-4w', stage: 'done', status: 'done' },
        ];
      },
    },
  });

  assert.deepEqual(query, {
    chatId: 123,
    options: { symbol: undefined, limit: 5 },
  });
  assert.match(reply.text, /<b>SwingScope recent plan jobs<\/b>/);
  assert.match(reply.text, /MU \| Waiting: Levels \(step 4\/6\)/);
  assert.match(reply.text, /TSLA \| Done/);
});

test('planStatusCommand explains when no matching jobs exist', async () => {
  const reply = await planStatusCommand({
    args: ['MU'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      ensurePlanJobsSchema: async () => true,
      listPlanJobs: async () => [],
    },
  });

  assert.match(reply.text, /No plan jobs found for MU/);
  assert.match(reply.text, /Queue one with \/plan/);
});

test('planStatusCommand requires PostgreSQL persistence', async () => {
  const reply = await planStatusCommand({
    args: ['MU'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: false, missing: ['POSTGRES_URL'] }),
      listPlanJobs: async () => {
        throw new Error('should not query without persistence');
      },
    },
  });

  assert.match(reply.text, /requires database persistence/);
  assert.match(reply.text, /POSTGRES_URL/);
});

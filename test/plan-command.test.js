import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assemblePlan,
  formatPlanReply,
  parsePlanArgs,
  resolvePlanSymbol,
  runPlanCommand,
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

test('formatPlanReply separates analysis, execution, and saved alert status', () => {
  const reply = formatPlanReply({
    pipeline: {
      symbol: 'MU',
      resolvedSymbol: 'MU',
      alertable: true,
      plan: {
        analysisSummary: 'Neutral summary.',
        long: { entries: [101], stop: 95, targets: [110], rationale: 'Breakout follow-through.' },
        conditions: [],
      },
    },
    savedAlerts: [{ symbol: 'MU' }, { symbol: 'MU' }],
    rejected: [{ reason: 'unsupported' }],
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /<b>Analysis<\/b>/);
  assert.match(reply.text, /Neutral summary\./);
  assert.match(reply.text, /<b>Execution<\/b>/);
  assert.match(reply.text, /Entries: 101/);
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

test('runPlanCommand returns usage when no symbol is supplied', async () => {
  const reply = await runPlanCommand({ args: [], chatId: 123 });

  assert.match(reply.text, /<b>SwingScope plan usage<\/b>/);
  assert.match(reply.text, /\/plan &lt;symbol&gt; \[long\|short\|both\] \[horizon\]/);
  assert.match(reply.text, /BTCUSDT/);
});

test('runPlanCommand saves normalized alerts for tracked symbols', async () => {
  let savedPayload;
  const reply = await runPlanCommand({
    args: ['MU', 'long', '2w'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      runResearchStages: async () => ({
        ok: true,
        symbol: 'MU',
        resolvedSymbol: 'MU',
        alertable: true,
        direction: 'long',
        horizon: '2w',
        snapshot: { price: 100, indicators: {} },
        facts: 'facts',
        inference: 'inference',
        notes: [],
      }),
      assemblePlan: async () => ({
        ok: true,
        plan: {
          analysisSummary: 'Summary.',
          long: { entries: [101], stop: 95, targets: [110], rationale: 'Upside.' },
          conditions: [
            { kind: 'above', price: 101, actionText: 'Watch breakout.' },
            { kind: 'rsi_below', threshold: 30, actionText: 'Watch reset.' },
          ],
        },
      }),
      saveDecisionTreeAlerts: async (payload) => {
        savedPayload = payload;
        return payload.rules.map((rule, index) => ({ ...rule, id: index + 1, chatId: '123' }));
      },
    },
  });

  assert.equal(savedPayload.chatId, 123);
  assert.match(savedPayload.rawTree, /Long/);
  assert.deepEqual(savedPayload.rules.map(rule => rule.conditionKind), ['above', 'rsi_below']);
  assert.match(reply.text, /Alerts saved: 2 for MU/);
});

test('runPlanCommand skips normalize and save for non-tracked symbols', async () => {
  let saved = false;
  let normalized = false;
  const reply = await runPlanCommand({
    args: ['TSLA'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      runResearchStages: async () => ({
        ok: true,
        symbol: 'TSLA',
        resolvedSymbol: 'TSLA',
        alertable: false,
        direction: 'both',
        horizon: '1-4w',
        facts: 'facts',
        inference: 'inference',
        notes: [],
      }),
      assemblePlan: async () => ({
        ok: true,
        plan: { analysisSummary: 'Summary.', conditions: [{ kind: 'above', price: 101, actionText: 'Ignore.' }] },
      }),
      normalizePlanRulesToAlerts: () => {
        normalized = true;
        return { rules: [], rejected: [] };
      },
      saveDecisionTreeAlerts: async () => {
        saved = true;
        return [];
      },
    },
  });

  assert.equal(normalized, false);
  assert.equal(saved, false);
  assert.match(reply.text, /Alerts skipped/);
  assert.match(reply.text, /TSLA is not one of the 12 tracked symbols/);
});

test('runPlanCommand notes when PostgreSQL persistence is unavailable', async () => {
  let saved = false;
  const reply = await runPlanCommand({
    args: ['MU'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: false }),
      runResearchStages: async () => ({
        ok: true,
        symbol: 'MU',
        resolvedSymbol: 'MU',
        alertable: true,
        direction: 'both',
        horizon: '1-4w',
        facts: 'facts',
        inference: 'inference',
        notes: [],
      }),
      assemblePlan: async () => ({
        ok: true,
        plan: {
          analysisSummary: 'Summary.',
          conditions: [{ kind: 'above', price: 101, actionText: 'Watch breakout.' }],
        },
      }),
      saveDecisionTreeAlerts: async () => {
        saved = true;
        return [];
      },
    },
  });

  assert.equal(saved, false);
  assert.match(reply.text, /Alerts not saved: PostgreSQL persistence unavailable\./);
});

test('runPlanCommand notes when alert saving fails', async () => {
  const reply = await runPlanCommand({
    args: ['MU'],
    chatId: 123,
    deps: {
      getPostgresStatus: () => ({ configured: true }),
      runResearchStages: async () => ({
        ok: true,
        symbol: 'MU',
        resolvedSymbol: 'MU',
        alertable: true,
        direction: 'both',
        horizon: '1-4w',
        facts: 'facts',
        inference: 'inference',
        notes: [],
      }),
      assemblePlan: async () => ({
        ok: true,
        plan: {
          analysisSummary: 'Summary.',
          conditions: [{ kind: 'above', price: 101, actionText: 'Watch breakout.' }],
        },
      }),
      saveDecisionTreeAlerts: async () => {
        throw new Error('database down');
      },
    },
  });

  assert.match(reply.text, /Alerts not saved: Alert save failed: database down/);
});

test('runPlanCommand returns a graceful reply when a stage throws', async () => {
  const reply = await runPlanCommand({
    args: ['MU'],
    chatId: 123,
    deps: {
      runResearchStages: async () => {
        throw new Error('stage exploded');
      },
    },
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /unexpected error: stage exploded/);
});

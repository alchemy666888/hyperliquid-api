import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PlanStageError,
  advanceOneStage,
} from '../lib/plan-workflow.js';

function job(overrides = {}) {
  return {
    id: 42,
    chatId: '123',
    symbol: 'MU',
    resolvedSymbol: 'MU',
    alertable: true,
    direction: 'long',
    horizon: '2w',
    stage: 'collect',
    status: 'running',
    collectOutput: null,
    factcheckOutput: null,
    inferOutput: null,
    levelsOutput: null,
    planOutput: null,
    replySentAt: null,
    ...overrides,
  };
}

function captureCommit(commits) {
  return async (jobId, payload) => {
    commits.push({ jobId, payload });
    return { id: jobId, ...payload };
  };
}

test('advanceOneStage runs collect only once and commits collect output to fact_check', async () => {
  const commits = [];
  let searchCalled = false;
  let aiChatCalled = false;

  const result = await advanceOneStage(job(), {
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
      return { q: 'MU latest catalysts', gl: 'us', hl: 'en', freshness: 'd', needs_search: true };
    },
    getSearch: async ({ params, limit }) => {
      searchCalled = true;
      assert.equal(limit, 6);
      assert.equal(params.engine, 'google_news');
      return { ok: true, results: [{ title: 'MU result', source: 'News' }] };
    },
    aiChat: async () => {
      aiChatCalled = true;
      return { ok: true, text: 'should not run in collect' };
    },
    commitStage: captureCommit(commits),
  });

  assert.equal(result.stage, 'collect');
  assert.equal(result.nextStage, 'fact_check');
  assert.equal(searchCalled, true);
  assert.equal(aiChatCalled, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].payload.outputColumn, 'collect_output');
  assert.equal(commits[0].payload.nextStage, 'fact_check');
  assert.equal(commits[0].payload.output.snapshot.price, 100);
});

test('collect advances with a clear note when search returns no usable results', async () => {
  const commits = [];
  await advanceOneStage(job({ alertable: false, resolvedSymbol: 'TSLA', symbol: 'TSLA' }), {
    extractionCache: null,
    extractSearchQuery: async () => ({ q: 'TSLA news', gl: 'us', hl: 'en', freshness: 'd', needs_search: true }),
    getSearch: async () => ({ ok: true, results: [] }),
    commitStage: captureCommit(commits),
  });

  assert.match(commits[0].payload.output.notes.join('\n'), /Current web results could not be verified/);
  assert.equal(commits[0].payload.output.snapshot, null);
});

test('neutral AI stages include the no-recommendation instruction and advance one stage', async () => {
  const stages = [
    {
      stage: 'fact_check',
      outputColumn: 'factcheck_output',
      nextStage: 'infer',
      job: job({ stage: 'fact_check', collectOutput: { snapshot: null, search: { results: [] }, notes: [] } }),
    },
    {
      stage: 'infer',
      outputColumn: 'infer_output',
      nextStage: 'levels',
      job: job({
        stage: 'infer',
        collectOutput: { snapshot: null, search: { results: [] } },
        factcheckOutput: { facts: 'verified facts' },
      }),
    },
    {
      stage: 'levels',
      outputColumn: 'levels_output',
      nextStage: 'plan',
      job: job({
        stage: 'levels',
        collectOutput: { snapshot: { price: 100, indicators: {} } },
        factcheckOutput: { facts: 'verified facts' },
        inferOutput: { inference: 'neutral inference' },
      }),
    },
  ];

  for (const item of stages) {
    const commits = [];
    let prompt = '';
    const result = await advanceOneStage(item.job, {
      aiChat: async ({ messages, maxTokens }) => {
        prompt = messages[0].content;
        assert.ok(maxTokens <= 900);
        return { ok: true, text: `${item.stage} output` };
      },
      commitStage: captureCommit(commits),
    });

    assert.equal(result.stage, item.stage);
    assert.equal(result.nextStage, item.nextStage);
    assert.equal(commits[0].payload.outputColumn, item.outputColumn);
    assert.match(prompt, /Do not emit entry, stop, target, position size, or buy\/sell\/long\/short recommendations/);
  }
});

test('AI-unavailable neutral stage throws a typed PlanStageError', async () => {
  await assert.rejects(
    () => advanceOneStage(job({ stage: 'fact_check', collectOutput: { snapshot: null, search: { results: [] } } }), {
      aiChat: async () => ({ ok: false, error: 'DeepSeek is not configured.', missing: ['DEEPSEEK_API_KEY'] }),
      commitStage: async () => {
        throw new Error('should not commit failed AI stage');
      },
    }),
    error => {
      assert.equal(error instanceof PlanStageError, true);
      assert.equal(error.stage, 'fact_check');
      assert.deepEqual(error.missing, ['DEEPSEEK_API_KEY']);
      return true;
    },
  );
});

test('plan stage commits final plan JSON and degrades malformed non-config AI output', async () => {
  const commits = [];
  const result = await advanceOneStage(job({
    stage: 'plan',
    collectOutput: { snapshot: { price: 100, indicators: { recentHigh20: 110 } } },
    factcheckOutput: { facts: 'facts' },
    inferOutput: { inference: 'neutral inference' },
    levelsOutput: { levels: 'neutral levels' },
  }), {
    assemblePlan: async ({ levels }) => {
      assert.equal(levels, 'neutral levels');
      return {
        ok: false,
        error: 'response did not contain a JSON object',
        plan: { analysisSummary: 'neutral inference', conditions: [] },
      };
    },
    commitStage: captureCommit(commits),
  });

  assert.equal(result.stage, 'plan');
  assert.equal(result.nextStage, 'send');
  assert.equal(commits[0].payload.outputColumn, 'plan_output');
  assert.equal(commits[0].payload.output.conditions.length, 0);
  assert.match(commits[0].payload.output.assemblyError, /response did not contain/);
});

test('send stage saves alerts, pushes the plan, persists outbound, and marks done', async () => {
  const commits = [];
  const sent = [];
  const persisted = [];
  let savedPayload;

  const result = await advanceOneStage(job({
    stage: 'send',
    collectOutput: { snapshot: { price: 100 }, search: { results: [] }, notes: [] },
    factcheckOutput: { facts: 'facts' },
    inferOutput: { inference: 'neutral inference' },
    levelsOutput: { levels: 'levels' },
    planOutput: {
      analysisSummary: 'Summary.',
      long: { entries: [101], stop: 95, targets: [110], rationale: 'Upside.' },
      conditions: [{ conditionKind: 'above', price: 101, actionText: 'Watch breakout.' }],
    },
  }), {
    telegramBotToken: 'token',
    markReplySent: async (jobId) => ({ id: jobId, replySentAt: 'now' }),
    getPostgresStatus: () => ({ configured: true }),
    saveDecisionTreeAlerts: async (payload) => {
      savedPayload = payload;
      return payload.rules.map((rule, index) => ({ ...rule, id: index + 1 }));
    },
    sendTelegramMessage: async (token, chatId, text, options) => {
      sent.push({ token, chatId, text, options });
    },
    saveTelegramChatMessage: async (payload) => {
      persisted.push(payload);
    },
    commitStage: captureCommit(commits),
  });

  assert.equal(result.status, 'done');
  assert.equal(savedPayload.chatId, '123');
  assert.deepEqual(savedPayload.rules.map(rule => rule.conditionKind), ['above']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<b>Analysis<\/b>/);
  assert.match(sent[0].text, /Alerts saved: 1 for MU/);
  assert.equal(persisted[0].direction, 'outbound');
  assert.equal(commits[0].payload.nextStage, 'done');
  assert.equal(commits[0].payload.nextStatus, 'done');
});

test('send stage skips alert saving for non-tracked symbols and says why', async () => {
  const sent = [];
  let saved = false;

  await advanceOneStage(job({
    stage: 'send',
    symbol: 'TSLA',
    resolvedSymbol: 'TSLA',
    alertable: false,
    collectOutput: { snapshot: null, search: { results: [] }, notes: [] },
    factcheckOutput: { facts: 'facts' },
    inferOutput: { inference: 'neutral inference' },
    levelsOutput: { levels: 'levels' },
    planOutput: { analysisSummary: 'Summary.', conditions: [] },
  }), {
    telegramBotToken: 'token',
    markReplySent: async (jobId) => ({ id: jobId, replySentAt: 'now' }),
    saveDecisionTreeAlerts: async () => {
      saved = true;
    },
    sendTelegramMessage: async (_token, _chatId, text) => {
      sent.push(text);
    },
    saveTelegramChatMessage: async () => {},
    commitStage: async () => {},
  });

  assert.equal(saved, false);
  assert.match(sent[0], /Alerts skipped/);
  assert.match(sent[0], /TSLA is not one of the 12 tracked symbols/);
});

test('send stage with reply_sent_at set is a no-op but still advances to done', async () => {
  const commits = [];
  let sent = false;
  let marked = false;

  const result = await advanceOneStage(job({
    stage: 'send',
    replySentAt: '2026-07-02T00:00:00.000Z',
    planOutput: { analysisSummary: 'Summary.', conditions: [] },
  }), {
    markReplySent: async () => {
      marked = true;
    },
    sendTelegramMessage: async () => {
      sent = true;
    },
    commitStage: captureCommit(commits),
  });

  assert.equal(result.skipped, true);
  assert.equal(marked, false);
  assert.equal(sent, false);
  assert.equal(commits[0].payload.nextStage, 'done');
});

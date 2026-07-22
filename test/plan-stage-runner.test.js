import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRunnerStage,
  runPlanStageOnce,
} from '../lib/plan-stage-runner.js';

function runnerJob(overrides = {}) {
  return {
    id: 42,
    chatId: '123',
    symbol: 'MU',
    resolvedSymbol: 'MU',
    stage: 'collect',
    ...overrides,
  };
}

test('normalizeRunnerStage accepts stage path variants', () => {
  assert.equal(normalizeRunnerStage('fact-check'), 'fact_check');
  assert.equal(normalizeRunnerStage('FACT_CHECK'), 'fact_check');
  assert.equal(normalizeRunnerStage('collect'), 'collect');
  assert.equal(normalizeRunnerStage('done'), '');
  assert.equal(normalizeRunnerStage('unknown'), '');
});

test('runPlanStageOnce rejects unsupported stages before touching dependencies', async () => {
  const result = await runPlanStageOnce('done', {
    withPlanJobsClient: async () => {
      throw new Error('should not open db client');
    },
  });

  assert.equal(result.event, 'plan_stage_runner_invalid_stage');
  assert.equal(result.status, 'error');
  assert.ok(result.allowedStages.includes('collect'));
});

test('runPlanStageOnce claims and advances one job at the requested stage', async () => {
  const calls = [];
  const result = await runPlanStageOnce('levels', {
    withPlanJobsClient: async (fn) => fn('client'),
    reapStaleJobs: async (client) => {
      assert.equal(client, 'client');
      return { reaped: [], failed: [] };
    },
    claimOneJobAtStage: async (client, stage) => {
      calls.push({ client, stage });
      return runnerJob({ stage });
    },
    advanceOneStage: async (job, deps) => {
      assert.equal(job.stage, 'levels');
      assert.equal(deps.client, 'client');
      return { stage: 'levels', nextStage: 'plan' };
    },
  });

  assert.equal(result.event, 'plan_stage_runner_complete');
  assert.equal(result.stage, 'levels');
  assert.equal(result.jobId, 42);
  assert.deepEqual(calls, [{ client: 'client', stage: 'levels' }]);
});

test('runPlanStageOnce no-ops when no job exists for that stage', async () => {
  const result = await runPlanStageOnce('send', {
    withPlanJobsClient: async (fn) => fn('client'),
    reapStaleJobs: async () => ({ reaped: [], failed: [] }),
    claimOneJobAtStage: async () => null,
    advanceOneStage: async () => {
      throw new Error('should not advance without a job');
    },
  });

  assert.equal(result.event, 'plan_stage_runner_noop');
  assert.equal(result.stage, 'send');
});

test('runPlanStageOnce marks failed and pushes a message when stage processing throws', async () => {
  let failed;
  const sent = [];
  const result = await runPlanStageOnce('infer', {
    telegramBotToken: 'token',
    withPlanJobsClient: async (fn) => fn('client'),
    reapStaleJobs: async () => ({ reaped: [], failed: [] }),
    claimOneJobAtStage: async () => runnerJob({ stage: 'infer' }),
    advanceOneStage: async () => {
      const error = new Error('AI unavailable');
      error.stage = 'fact_check';
      throw error;
    },
    markFailed: async (client, jobId, reason) => {
      failed = { client, jobId, reason };
    },
    sendTelegramMessage: async (token, chatId, text) => {
      sent.push({ token, chatId, text });
    },
    saveTelegramChatMessage: async () => {},
  });

  assert.equal(result.event, 'plan_stage_runner_failed');
  assert.equal(result.stage, 'fact_check');
  assert.equal(result.runnerStage, 'infer');
  assert.deepEqual(failed, { client: 'client', jobId: 42, reason: 'AI unavailable' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /SwingScope plan failed/);
  assert.match(sent[0].text, /Stage/);
  assert.match(sent[0].text, /fact_check/);
});

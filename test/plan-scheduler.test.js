import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  readPlanSchedulerIntervalMs,
  runOnce,
} from '../scripts/plan-scheduler.js';

function schedulerJob(overrides = {}) {
  return {
    id: 42,
    chatId: '123',
    symbol: 'MU',
    resolvedSymbol: 'MU',
    stage: 'collect',
    ...overrides,
  };
}

test('readPlanSchedulerIntervalMs uses the configured fast interval override', () => {
  const previous = process.env.PLAN_SCHEDULER_INTERVAL_MS;
  process.env.PLAN_SCHEDULER_INTERVAL_MS = '30000';
  try {
    assert.equal(readPlanSchedulerIntervalMs(), 30000);
  } finally {
    if (previous === undefined) {
      delete process.env.PLAN_SCHEDULER_INTERVAL_MS;
    } else {
      process.env.PLAN_SCHEDULER_INTERVAL_MS = previous;
    }
  }
});

test('runOnce is a cheap no-op when no jobs are runnable', async () => {
  let advanced = false;
  const result = await runOnce({
    withPlanJobsClient: async (fn) => fn('client'),
    reapStaleJobs: async (client) => {
      assert.equal(client, 'client');
      return { reaped: [], failed: [] };
    },
    claimOneJob: async () => null,
    advanceOneStage: async () => {
      advanced = true;
    },
  });

  assert.equal(result.event, 'plan_scheduler_tick_noop');
  assert.equal(advanced, false);
});

test('runOnce advances exactly one claimed job stage', async () => {
  const calls = [];
  let clientCheckedOut = false;
  const result = await runOnce({
    withPlanJobsClient: async (fn) => {
      clientCheckedOut = true;
      try {
        return await fn('client');
      } finally {
        clientCheckedOut = false;
      }
    },
    reapStaleJobs: async () => ({ reaped: [], failed: [] }),
    claimOneJob: async () => schedulerJob({ stage: 'infer' }),
    advanceOneStage: async (job, deps) => {
      assert.equal(clientCheckedOut, false);
      calls.push({ job, client: deps.client });
      return { stage: job.stage, nextStage: 'levels' };
    },
  });

  assert.equal(result.event, 'plan_scheduler_tick_complete');
  assert.equal(result.jobId, 42);
  assert.equal(result.stage, 'infer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].client, undefined);
});

test('runOnce marks failed and pushes a graceful failure message when a stage throws', async () => {
  let failed;
  let clientCheckedOut = false;
  const sent = [];
  const persisted = [];
  const result = await runOnce({
    telegramBotToken: 'token',
    withPlanJobsClient: async (fn) => {
      clientCheckedOut = true;
      try {
        return await fn('client');
      } finally {
        clientCheckedOut = false;
      }
    },
    reapStaleJobs: async () => ({ reaped: [], failed: [] }),
    claimOneJob: async () => schedulerJob({ stage: 'levels' }),
    advanceOneStage: async () => {
      assert.equal(clientCheckedOut, false);
      const error = new Error('AI unavailable');
      error.stage = 'levels';
      throw error;
    },
    markFailed: async (client, jobId, reason) => {
      assert.equal(clientCheckedOut, true);
      failed = { client, jobId, reason };
      return schedulerJob({ status: 'failed', error: reason });
    },
    sendTelegramMessage: async (token, chatId, text, options) => {
      sent.push({ token, chatId, text, options });
    },
    saveTelegramChatMessage: async (payload) => {
      persisted.push(payload);
    },
  });

  assert.equal(result.event, 'plan_scheduler_tick_failed');
  assert.equal(result.stage, 'levels');
  assert.deepEqual(failed, { client: 'client', jobId: 42, reason: 'AI unavailable' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<b>SwingScope plan failed<\/b>/);
  assert.match(sent[0].text, /Stage/);
  assert.match(sent[0].text, /levels/);
  assert.match(sent[0].text, /AI unavailable/);
  assert.equal(persisted[0].direction, 'outbound');
});

test('runOnce pushes failure messages for jobs failed by the stale-lock reaper', async () => {
  const sent = [];
  const result = await runOnce({
    telegramBotToken: 'token',
    withPlanJobsClient: async (fn) => fn('client'),
    reapStaleJobs: async () => ({
      reaped: [],
      failed: [schedulerJob({ id: 99, error: 'Plan job exceeded retry budget after stale lock.' })],
    }),
    claimOneJob: async () => null,
    sendTelegramMessage: async (_token, _chatId, text) => {
      sent.push(text);
    },
    saveTelegramChatMessage: async () => {},
  });

  assert.equal(result.event, 'plan_scheduler_tick_noop');
  assert.equal(result.failed, 1);
  assert.match(sent[0], /exceeded retry budget/);
});

test('plan scheduler is isolated from the existing alert runner', async () => {
  const source = await readFile(new URL('../scripts/plan-scheduler.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /refreshMarketDataAndProcessAlerts/);
  assert.doesNotMatch(source, /alert-runner/);
});

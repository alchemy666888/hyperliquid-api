import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimOneJob,
  commitStage,
  markReplySent,
  reapStaleJobs,
  readPlanJobConfig,
} from '../lib/plan-jobs.js';

function planRow(overrides = {}) {
  return {
    id: 42,
    chat_id: '123',
    symbol: 'MU',
    resolved_symbol: 'MU',
    alertable: true,
    direction: 'long',
    horizon: '2w',
    stage: 'collect',
    status: 'running',
    locked_at: null,
    retry_count: 0,
    reply_sent_at: null,
    error: null,
    collect_output: null,
    factcheck_output: null,
    infer_output: null,
    levels_output: null,
    plan_output: null,
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

test('readPlanJobConfig applies env defaults and overrides', () => {
  assert.deepEqual(readPlanJobConfig({}), {
    staleMs: 120000,
    maxRetries: 2,
  });
  assert.deepEqual(readPlanJobConfig({ PLAN_STALE_MS: '90000', PLAN_MAX_RETRIES: '4' }), {
    staleMs: 90000,
    maxRetries: 4,
  });
});

test('claimOneJob uses an atomic SKIP LOCKED update and returns one row', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [planRow({ id: 7, status: 'running' })] };
    },
  };

  const job = await claimOneJob(client);

  assert.equal(job.id, 7);
  assert.equal(job.status, 'running');
  assert.match(queries[0].sql, /UPDATE plan_jobs/);
  assert.match(queries[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(queries[0].sql, /LIMIT 1/);
});

test('commitStage writes output, advances cursor, and clears lock in one transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).trim().startsWith('UPDATE')) {
        return {
          rows: [
            planRow({
              stage: 'fact_check',
              status: 'pending',
              locked_at: null,
              collect_output: { ok: true },
            }),
          ],
        };
      }
      return { rows: [] };
    },
  };

  const job = await commitStage(client, 42, {
    outputColumn: 'collect_output',
    output: { ok: true },
    nextStage: 'fact_check',
    nextStatus: 'pending',
  });

  assert.deepEqual(calls.map(call => call.sql.trim().split(/\s+/)[0]), ['BEGIN', 'UPDATE', 'COMMIT']);
  assert.match(calls[1].sql, /collect_output = \$1::jsonb/);
  assert.match(calls[1].sql, /locked_at = NULL/);
  assert.match(calls[1].sql, /retry_count = 0/);
  assert.deepEqual(calls[1].params, [JSON.stringify({ ok: true }), 'fact_check', 'pending', 42]);
  assert.equal(job.stage, 'fact_check');
});

test('commitStage rolls back when the stage update fails', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql).trim().split(/\s+/)[0]);
      if (String(sql).trim().startsWith('UPDATE')) throw new Error('write failed');
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => commitStage(client, 42, {
      outputColumn: 'collect_output',
      output: { ok: true },
      nextStage: 'fact_check',
    }),
    /write failed/,
  );
  assert.deepEqual(calls, ['BEGIN', 'UPDATE', 'ROLLBACK']);
});

test('reapStaleJobs retries stale jobs and fails rows over the retry cap', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return {
        rows: [
          planRow({ id: 1, status: 'pending', retry_count: 1 }),
          planRow({ id: 2, status: 'failed', retry_count: 3, error: 'Plan job exceeded retry budget after stale lock.' }),
        ],
      };
    },
  };

  const result = await reapStaleJobs(client, { staleMs: 60000, maxRetries: 2 });

  assert.deepEqual(queries[0].params, [60000, 2]);
  assert.match(queries[0].sql, /locked_at < NOW\(\) - \(\$1::int \* INTERVAL '1 millisecond'\)/);
  assert.deepEqual(result.reaped.map(job => job.id), [1]);
  assert.deepEqual(result.failed.map(job => job.id), [2]);
});

test('markReplySent only returns a row when reply_sent_at was previously null', async () => {
  const client = {
    calls: 0,
    async query(sql, params) {
      this.calls += 1;
      assert.match(String(sql), /reply_sent_at IS NULL/);
      assert.deepEqual(params, [42]);
      return this.calls === 1
        ? { rows: [planRow({ reply_sent_at: '2026-07-02T01:00:00.000Z' })] }
        : { rows: [] };
    },
  };

  const first = await markReplySent(client, 42);
  const second = await markReplySent(client, 42);

  assert.equal(first.id, 42);
  assert.equal(first.replySentAt, '2026-07-02T01:00:00.000Z');
  assert.equal(second, null);
});

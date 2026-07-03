import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/plan-runner/[stage].js';

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('plan runner API rejects unsupported methods', async () => {
  const res = mockResponse();
  await handler({ method: 'PUT', headers: {}, query: { stage: 'collect' } }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, POST');
});

test('plan runner API requires PLAN_RUNNER_SECRET or CRON_SECRET', async () => {
  const previousRunner = process.env.PLAN_RUNNER_SECRET;
  const previousCron = process.env.CRON_SECRET;
  delete process.env.PLAN_RUNNER_SECRET;
  delete process.env.CRON_SECRET;
  const res = mockResponse();
  try {
    await handler({ method: 'GET', headers: {}, query: { stage: 'collect' } }, res);
  } finally {
    restoreEnv('PLAN_RUNNER_SECRET', previousRunner);
    restoreEnv('CRON_SECRET', previousCron);
  }

  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /PLAN_RUNNER_SECRET/);
});

test('plan runner API rejects invalid bearer token', async () => {
  const previous = process.env.PLAN_RUNNER_SECRET;
  process.env.PLAN_RUNNER_SECRET = 'secret';
  const res = mockResponse();
  try {
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' }, query: { stage: 'collect' } }, res);
  } finally {
    restoreEnv('PLAN_RUNNER_SECRET', previous);
  }

  assert.equal(res.statusCode, 401);
});

test('plan runner API rejects unsupported stage path variables', async () => {
  const previous = process.env.PLAN_RUNNER_SECRET;
  process.env.PLAN_RUNNER_SECRET = 'secret';
  const res = mockResponse();
  try {
    await handler({ method: 'GET', headers: { authorization: 'Bearer secret' }, query: { stage: 'done' } }, res);
  } finally {
    restoreEnv('PLAN_RUNNER_SECRET', previous);
  }

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Unsupported plan stage/);
});

test('plan runner API runs the requested stage when authorized', async () => {
  const previousRunner = process.env.PLAN_RUNNER_SECRET;
  const previousPostgres = process.env.POSTGRES_URL;
  process.env.PLAN_RUNNER_SECRET = 'secret';
  delete process.env.POSTGRES_URL;
  const res = mockResponse();
  try {
    await handler({ method: 'GET', headers: { authorization: 'Bearer secret' }, query: { stage: 'collect' } }, res);
  } finally {
    restoreEnv('PLAN_RUNNER_SECRET', previousRunner);
    restoreEnv('POSTGRES_URL', previousPostgres);
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.result.event, 'plan_stage_runner_unavailable');
  assert.equal(res.body.result.stage, 'collect');
});

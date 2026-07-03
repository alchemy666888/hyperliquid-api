import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/plan-runner/[stage].js';

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

test('plan runner API rejects unsupported stage path variables', async () => {
  const res = mockResponse();
  await handler({ method: 'GET', headers: {}, query: { stage: 'done' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Unsupported plan stage/);
});

test('plan runner API runs the requested stage without authorization', async () => {
  const previousPostgres = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;
  const res = mockResponse();
  try {
    await handler({ method: 'GET', headers: {}, query: { stage: 'collect' } }, res);
  } finally {
    if (previousPostgres === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousPostgres;
    }
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.result.event, 'plan_stage_runner_unavailable');
  assert.equal(res.body.result.stage, 'collect');
});

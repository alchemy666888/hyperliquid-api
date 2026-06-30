import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDeepSeekChat, requestDeepSeekJson } from '../lib/deepseek-client.js';

test('requestDeepSeekJson safely rejects malformed model JSON content', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const result = await requestDeepSeekJson({
    messages: [{ role: 'user', content: 'return json' }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /JSON object/);
  delete process.env.DEEPSEEK_API_KEY;
});

test('requestDeepSeekChat returns plain model text without JSON response format', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let requestBody;

  const result = await requestDeepSeekChat({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '  Hi there.  ' } }], usage: { total_tokens: 7 } }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hi there.');
  assert.deepEqual(result.usage, { total_tokens: 7 });
  assert.equal(requestBody.response_format, undefined);
  delete process.env.DEEPSEEK_API_KEY;
});

test('requestDeepSeekChat reports empty text responses', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const result = await requestDeepSeekChat({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /text/);
  delete process.env.DEEPSEEK_API_KEY;
});

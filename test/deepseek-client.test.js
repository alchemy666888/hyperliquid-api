import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDeepSeekJson } from '../lib/deepseek-client.js';

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

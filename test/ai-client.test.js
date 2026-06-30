import assert from 'node:assert/strict';
import test from 'node:test';
import { getAiConfig, getAiStatus, requestAiChat, requestAiJson } from '../lib/ai-client.js';

function clearAiEnv() {
  delete process.env.AI_MODEL_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.CLAUDE_API_KEY;
  delete process.env.CLAUDE_BASE_URL;
  delete process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_ANTHROPIC_VERSION;
}

test('AI config defaults to DeepSeek for existing deployments', () => {
  clearAiEnv();
  process.env.DEEPSEEK_API_KEY = 'deepseek-key';

  const config = getAiConfig();

  assert.equal(config.provider, 'DEEPSEEK');
  assert.equal(config.configured, true);
  assert.deepEqual(config.missing, []);
  clearAiEnv();
});

test('AI config selects Claude with CLAUDE_API_KEY', () => {
  clearAiEnv();
  process.env.AI_MODEL_PROVIDER = 'CLAUDE';
  process.env.CLAUDE_API_KEY = 'claude-key';

  const config = getAiConfig();
  const status = getAiStatus();

  assert.equal(config.provider, 'CLAUDE');
  assert.equal(config.configured, true);
  assert.deepEqual(config.missing, []);
  assert.equal(status.provider, 'CLAUDE');
  assert.equal(status.claude.configured, true);
  assert.equal(status.deepseek.configured, false);
  clearAiEnv();
});

test('requestAiChat sends Claude Messages API shape without DeepSeek response_format', async () => {
  clearAiEnv();
  process.env.AI_MODEL_PROVIDER = 'CLAUDE';
  process.env.CLAUDE_API_KEY = 'claude-key';
  process.env.CLAUDE_BASE_URL = 'https://claude.example/';
  process.env.CLAUDE_MODEL = 'claude-test-model';
  let requestUrl;
  let requestHeaders;
  let requestBody;

  const result = await requestAiChat({
    messages: [
      { role: 'system', content: 'System instructions.' },
      { role: 'user', content: 'Hello Claude.' },
    ],
    temperature: 0.9,
    searchEnable: true,
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestHeaders = options.headers;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '  Hello back.  ' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello back.');
  assert.equal(result.provider, 'CLAUDE');
  assert.equal(requestUrl, 'https://claude.example/v1/messages');
  assert.equal(requestHeaders['x-api-key'], 'claude-key');
  assert.equal(requestHeaders['anthropic-version'], '2023-06-01');
  assert.equal(requestBody.model, 'claude-test-model');
  assert.equal(requestBody.system, 'System instructions.');
  assert.deepEqual(requestBody.messages, [{ role: 'user', content: 'Hello Claude.' }]);
  assert.equal(requestBody.response_format, undefined);
  assert.equal(requestBody.search_enable, undefined);
  assert.equal(requestBody.temperature, undefined);
  clearAiEnv();
});

test('requestAiJson parses Claude text JSON responses', async () => {
  clearAiEnv();
  process.env.AI_MODEL_PROVIDER = 'CLAUDE';
  process.env.CLAUDE_API_KEY = 'claude-key';

  const result = await requestAiJson({
    messages: [{ role: 'user', content: 'Return JSON.' }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }],
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.provider, 'CLAUDE');
  clearAiEnv();
});

test('requestAiChat rejects unsupported AI_MODEL_PROVIDER values', async () => {
  clearAiEnv();
  process.env.AI_MODEL_PROVIDER = 'OPENAI';

  const result = await requestAiChat({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => {
      throw new Error('should not request an invalid provider');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /CLAUDE or DEEPSEEK/);
  assert.deepEqual(result.missing, ['AI_MODEL_PROVIDER']);
  clearAiEnv();
});

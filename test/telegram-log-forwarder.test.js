import assert from 'node:assert/strict';
import test from 'node:test';
import { installTelegramLogForwarder } from '../lib/telegram-log-forwarder.js';

function createConsoleStub() {
  const calls = [];
  const stub = {};
  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    stub[level] = (...args) => calls.push({ level, args });
  }
  return { stub, calls };
}

test('installTelegramLogForwarder forwards every console level to TG_LOG_CHAT_ID', async () => {
  const requests = [];
  const { stub, calls } = createConsoleStub();

  const installed = installTelegramLogForwarder({
    env: {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TG_LOG_CHAT_ID: '-100123',
    },
    consoleObject: stub,
    fetchImpl: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      return { ok: true };
    },
  });

  assert.equal(installed, true);

  stub.debug('debug message');
  stub.log('log message');
  stub.info('info message');
  stub.warn('warn message');
  stub.error('error message', new Error('boom'));

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.map((call) => call.level), ['debug', 'log', 'info', 'warn', 'error']);
  assert.equal(requests.length, 5);
  assert.ok(requests.every((request) => request.url === 'https://api.telegram.org/botbot-token/sendMessage'));
  assert.ok(requests.every((request) => request.payload.chat_id === '-100123'));
  assert.match(requests[0].payload.text, /Vercel log DEBUG/);
  assert.match(requests[4].payload.text, /boom/);
});

test('installTelegramLogForwarder stays disabled without TG_LOG_CHAT_ID', () => {
  const { stub } = createConsoleStub();
  const installed = installTelegramLogForwarder({
    env: { TELEGRAM_BOT_TOKEN: 'bot-token' },
    consoleObject: stub,
    fetchImpl: async () => ({ ok: true }),
  });

  assert.equal(installed, false);
});

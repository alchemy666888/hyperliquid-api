import assert from 'node:assert/strict';
import test from 'node:test';
import { sendTelegramMessage } from '../lib/telegram-client.js';

test('sendTelegramMessage includes optional parse mode', async () => {
  const originalFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, '<b>Hello</b>', { parseMode: 'HTML' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payload.chat_id, 123);
  assert.equal(payload.text, '<b>Hello</b>');
  assert.equal(payload.parse_mode, 'HTML');
  assert.equal(payload.disable_web_page_preview, true);
});

test('sendTelegramMessage omits parse mode by default', async () => {
  const originalFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payload.parse_mode, undefined);
});

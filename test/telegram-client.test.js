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

test('sendTelegramMessage repairs unbalanced HTML entities before sending', async () => {
  const originalFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, 'Run <code>npm test', { parseMode: 'HTML' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payload.text, 'Run <code>npm test</code>');
  assert.equal(payload.parse_mode, 'HTML');
});

test('sendTelegramMessage escapes nested tags inside code entities', async () => {
  const originalFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, '<code>literal <b>tag</b></code>', { parseMode: 'HTML' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payload.text, '<code>literal &lt;b&gt;tag&lt;/b&gt;</code>');
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

test('sendTelegramMessage includes group thread and reply metadata', async () => {
  const originalFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', -123, 'Hello group', {
      messageThreadId: 456,
      replyToMessageId: 789,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payload.chat_id, -123);
  assert.equal(payload.message_thread_id, 456);
  assert.deepEqual(payload.reply_parameters, {
    message_id: 789,
    allow_sending_without_reply: true,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { sendTelegramMessage } from '../lib/telegram-client.js';
import { MAX_TELEGRAM_TEXT_LENGTH } from '../lib/telegram-format.js';

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

test('sendTelegramMessage preserves HTML reply whitespace', async () => {
  const originalFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, '  <b>Hello</b>  ', { parseMode: 'HTML' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payload.text, '  <b>Hello</b>  ');
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

test('sendTelegramMessage sends long plain-text replies in multiple chunks', async () => {
  const originalFetch = globalThis.fetch;
  const payloads = [];
  const longText = `Intro\n\n${'plain reply segment '.repeat(260)}Done.`;

  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, longText, {
      messageThreadId: 456,
      replyToMessageId: 789,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(payloads.length > 1);
  assert.equal(payloads.map(payload => payload.text).join(''), longText);
  assert.ok(payloads.every(payload => payload.text.length <= MAX_TELEGRAM_TEXT_LENGTH));
  assert.ok(payloads.every(payload => payload.message_thread_id === 456));
  assert.ok(payloads.every(payload => payload.reply_parameters?.message_id === 789));
  assert.ok(payloads.every(payload => !payload.text.includes('Reply shortened for Telegram')));
});

test('sendTelegramMessage sends long HTML replies in balanced chunks', async () => {
  const originalFetch = globalThis.fetch;
  const payloads = [];
  const longHtml = `<b>${'bold reply segment '.repeat(260)}</b>`;

  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
    };
  };

  try {
    await sendTelegramMessage('token', 123, longHtml, { parseMode: 'HTML' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(payloads.length > 1);
  assert.ok(payloads.every(payload => payload.parse_mode === 'HTML'));
  assert.ok(payloads.every(payload => payload.text.length <= MAX_TELEGRAM_TEXT_LENGTH));
  assert.ok(payloads.every(payload => {
    const opens = payload.text.match(/<b>/g)?.length ?? 0;
    const closes = payload.text.match(/<\/b>/g)?.length ?? 0;
    return opens === closes;
  }));
  assert.ok(payloads.every(payload => !payload.text.includes('Reply shortened for Telegram')));
});

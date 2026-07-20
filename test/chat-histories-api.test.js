import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeChatHistoryRequest,
  createChatHistoriesHandler,
  parsePositiveIntQuery,
} from '../api/chat-histories/[token].js';

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    ended: false,
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
    end() {
      this.ended = true;
      return this;
    },
  };
}

test('chat histories API rejects requests until an access token is configured', () => {
  const auth = authorizeChatHistoryRequest(
    { query: { token: 'provided' } },
    {},
  );

  assert.equal(auth.ok, false);
  assert.equal(auth.statusCode, 503);
  assert.match(auth.error, /CHAT_HISTORY_API_TOKEN/);
});

test('chat histories API accepts token from path variable with timing-safe comparison', () => {
  const auth = authorizeChatHistoryRequest(
    { query: { token: 'expected-token' } },
    { CHAT_HISTORY_API_TOKEN: 'expected-token' },
  );

  assert.deepEqual(auth, { ok: true });
});

test('parsePositiveIntQuery rejects malformed numeric query parameters', () => {
  assert.equal(parsePositiveIntQuery(undefined, {
    name: 'limit',
    defaultValue: 50,
    max: 200,
  }), 50);
  assert.equal(parsePositiveIntQuery('999', {
    name: 'limit',
    defaultValue: 50,
    max: 200,
  }), 200);
  assert.throws(
    () => parsePositiveIntQuery('12px', {
      name: 'limit',
      defaultValue: 50,
      max: 200,
    }),
    /limit must be a positive integer/,
  );
});

test('chat histories API returns related chat ids and latest histories', async () => {
  const calls = [];
  const handler = createChatHistoriesHandler({
    env: { CHAT_HISTORY_API_TOKEN: 'secret' },
    getStatus: () => ({ configured: true }),
    listHistories: async options => {
      calls.push(options);
      return [
        {
          chatId: '456',
          latestMessageAt: '2026-07-20T06:00:00.000Z',
          messageCount: 2,
          messages: [
            {
              id: '1',
              chatId: '456',
              direction: 'inbound',
              messageText: 'Hello',
              messageType: 'ai_chat',
              telegramMessageId: '11',
              createdAt: '2026-07-20T05:59:00.000Z',
            },
            {
              id: '2',
              chatId: '456',
              direction: 'outbound',
              messageText: 'Hi',
              messageType: 'ai_chat',
              telegramMessageId: null,
              createdAt: '2026-07-20T06:00:00.000Z',
            },
          ],
        },
      ];
    },
  });
  const res = mockResponse();

  await handler({
    method: 'GET',
    headers: {},
    query: { token: 'secret', limit: '5', historyLimit: '2' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls, [{ chatLimit: 5, historyLimit: 2 }]);
  assert.deepEqual(res.body.relatedChatIds, ['456']);
  assert.equal(res.body.chatHistories[0].messages.length, 2);
});

test('chat histories API reports missing PostgreSQL persistence', async () => {
  const handler = createChatHistoriesHandler({
    env: { CHAT_HISTORY_API_TOKEN: 'secret' },
    getStatus: () => ({ configured: false, missing: ['POSTGRES_HOST'] }),
    listHistories: async () => {
      throw new Error('should not query database');
    },
  });
  const res = mockResponse();

  await handler({
    method: 'GET',
    headers: {},
    query: { token: 'secret' },
  }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'error');
  assert.deepEqual(res.body.persistence.missing, ['POSTGRES_HOST']);
});

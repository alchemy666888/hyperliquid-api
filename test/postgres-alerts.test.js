import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertRuleIndicatorParams,
  buildTelegramChatHistories,
  normalizeAlertRow,
  parsePostgresConnectionString,
} from '../lib/postgres.js';

const BASE_ROW = {
  id: 12,
  chat_id: '123',
  symbol: 'MU',
  condition_text: 'MU above $100?',
  condition_kind: 'above',
  lower_price: '100',
  upper_price: null,
  action_text: 'Watch upside.',
  raw_tree: 'raw plan',
  active: true,
  last_matched: false,
  last_checked_at: null,
  last_checked_price: null,
  last_triggered_at: null,
  last_triggered_price: null,
  expires_at: '2026-07-03T00:00:00.000Z',
  created_at: '2026-07-02T00:00:00.000Z',
};

test('normalizes technical alert indicator columns into indicatorParams', () => {
  const row = normalizeAlertRow({
    ...BASE_ROW,
    condition_kind: 'rsi_below',
    lower_price: null,
    indicator_kind: 'rsi',
    indicator_threshold: '30',
    indicator_fast: null,
    indicator_slow: null,
  });

  assert.deepEqual(row.indicatorParams, {
    kind: 'rsi',
    threshold: 30,
    fast: null,
    slow: null,
  });
  assert.equal(row.conditionKind, 'rsi_below');
  assert.equal(row.lowerPrice, null);
  assert.equal(row.upperPrice, null);
});

test('normalizes price alert rows with null indicatorParams and unchanged price fields', () => {
  const row = normalizeAlertRow({
    ...BASE_ROW,
    indicator_kind: null,
    indicator_threshold: null,
    indicator_fast: null,
    indicator_slow: null,
  });

  assert.equal(row.indicatorParams, null);
  assert.equal(row.conditionKind, 'above');
  assert.equal(row.lowerPrice, 100);
  assert.equal(row.upperPrice, null);
  assert.equal(row.expiresAt, '2026-07-03T00:00:00.000Z');
});

test('builds nullable indicator insert values from alert rules', () => {
  assert.deepEqual(
    alertRuleIndicatorParams({
      indicatorParams: { kind: 'ema', threshold: null, fast: 20, slow: 50 },
    }),
    ['ema', null, 20, 50],
  );
  assert.deepEqual(alertRuleIndicatorParams({}), [null, null, null, null]);
});

test('parses POSTGRES_URL without using legacy url.parse', () => {
  const config = parsePostgresConnectionString(
    'postgres://alice:p%40ss@db.example.com:6543/trading?sslmode=require&application_name=alchemy',
  );

  assert.equal(config.host, 'db.example.com');
  assert.equal(config.port, 6543);
  assert.equal(config.user, 'alice');
  assert.equal(config.password, 'p@ss');
  assert.equal(config.database, 'trading');
  assert.equal(config.sslmode, 'require');
  assert.equal(config.application_name, 'alchemy');
});

test('rejects non-postgres connection string protocols', () => {
  assert.throws(
    () => parsePostgresConnectionString('https://db.example.com/trading'),
    /postgres:\/\/ or postgresql:\/\//,
  );
});

test('groups latest Telegram chat history rows by chat id', () => {
  const rows = [
    {
      id: '1',
      chat_id: '456',
      direction: 'inbound',
      message_text: 'First',
      message_type: 'ai_chat',
      telegram_message_id: '10',
      created_at: '2026-07-20T05:59:00.000Z',
      latest_message_at: '2026-07-20T06:00:00.000Z',
      message_count: 3,
    },
    {
      id: '2',
      chat_id: '456',
      direction: 'outbound',
      message_text: 'Second',
      message_type: 'ai_chat',
      telegram_message_id: null,
      created_at: '2026-07-20T06:00:00.000Z',
      latest_message_at: '2026-07-20T06:00:00.000Z',
      message_count: 3,
    },
    {
      id: '3',
      chat_id: '123',
      direction: 'inbound',
      message_text: '/help',
      message_type: 'command',
      telegram_message_id: '20',
      created_at: '2026-07-20T05:00:00.000Z',
      latest_message_at: '2026-07-20T05:00:00.000Z',
      message_count: 1,
    },
  ];

  assert.deepEqual(buildTelegramChatHistories(rows), [
    {
      chatId: '456',
      latestMessageAt: '2026-07-20T06:00:00.000Z',
      messageCount: 3,
      messages: [
        {
          id: '1',
          chatId: '456',
          direction: 'inbound',
          messageText: 'First',
          messageType: 'ai_chat',
          telegramMessageId: '10',
          createdAt: '2026-07-20T05:59:00.000Z',
        },
        {
          id: '2',
          chatId: '456',
          direction: 'outbound',
          messageText: 'Second',
          messageType: 'ai_chat',
          telegramMessageId: null,
          createdAt: '2026-07-20T06:00:00.000Z',
        },
      ],
    },
    {
      chatId: '123',
      latestMessageAt: '2026-07-20T05:00:00.000Z',
      messageCount: 1,
      messages: [
        {
          id: '3',
          chatId: '123',
          direction: 'inbound',
          messageText: '/help',
          messageType: 'command',
          telegramMessageId: '20',
          createdAt: '2026-07-20T05:00:00.000Z',
        },
      ],
    },
  ]);
});

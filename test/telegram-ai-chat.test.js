import assert from 'node:assert/strict';
import test from 'node:test';

const { buildReply, processTelegramText } = await import('../api/telegram.js');

test('buildReply routes plain text to stateless AI chat', async () => {
  const reply = await buildReply('What about BTC right now?', 123, {
    answerStatelessAiChat: async ({ message }) => {
      assert.equal(message, 'What about BTC right now?');
      return { text: 'BTC answer' };
    },
  });

  assert.equal(reply.text, 'BTC answer');
  assert.equal(reply.parseMode, undefined);
});

test('buildReply keeps unknown slash commands on the help path', async () => {
  const reply = await buildReply('/unknown please chat', 123, {
    answerStatelessAiChat: async () => {
      throw new Error('unknown slash commands should not call AI chat');
    },
  });

  assert.match(reply.text, /<b>Hyperliquid Market Bot<\/b>/);
  assert.match(reply.text, /\/prices/);
});

test('processTelegramText persists inbound and outbound chat messages through injected helper', async () => {
  const saved = [];
  const reply = await processTelegramText({
    text: 'Tell me about MU',
    chatId: 456,
    telegramMessageId: 789,
    deps: {
      saveTelegramChatMessage: async row => {
        saved.push(row);
        return { id: saved.length, ...row };
      },
      answerStatelessAiChat: async () => ({ text: 'MU answer' }),
    },
  });

  assert.equal(reply.text, 'MU answer');
  assert.equal(reply.parseMode, undefined);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], {
    chatId: 456,
    direction: 'inbound',
    messageText: 'Tell me about MU',
    messageType: 'ai_chat',
    telegramMessageId: 789,
  });
  assert.deepEqual(saved[1], {
    chatId: 456,
    direction: 'outbound',
    messageText: 'MU answer',
    messageType: 'ai_chat',
    telegramMessageId: undefined,
  });
});

test('processTelegramText persists slash command messages as command type', async () => {
  const saved = [];
  await processTelegramText({
    text: '/help',
    chatId: 456,
    telegramMessageId: 790,
    deps: {
      saveTelegramChatMessage: async row => {
        saved.push(row);
        return row;
      },
    },
  });

  assert.equal(saved.length, 2);
  assert.equal(saved[0].messageType, 'command');
  assert.equal(saved[1].messageType, 'command');
});

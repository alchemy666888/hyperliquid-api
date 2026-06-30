import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildReply,
  getProcessableTelegramText,
  processTelegramText,
} = await import('../api/telegram.js');

test('buildReply routes plain text to stateless AI chat', async () => {
  const reply = await buildReply('What about BTC right now?', 123, {
    answerStatelessAiChat: async ({ message }) => {
      assert.equal(message, 'What about BTC right now?');
      return { text: 'BTC answer' };
    },
  });

  assert.equal(reply.text, 'BTC answer');
});

test('buildReply routes daily-life text to stateless AI chat', async () => {
  const reply = await buildReply('What should I cook tonight?', 123, {
    answerStatelessAiChat: async ({ message }) => {
      assert.equal(message, 'What should I cook tonight?');
      return { text: 'Dinner answer' };
    },
  });

  assert.equal(reply.text, 'Dinner answer');
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

test('getProcessableTelegramText keeps private chat text unchanged', () => {
  const message = {
    chat: { id: 123, type: 'private' },
    text: 'What about BTC right now?',
  };

  assert.equal(getProcessableTelegramText(message, 'MarketBot'), 'What about BTC right now?');
});

test('getProcessableTelegramText ignores group text without bot mention', () => {
  const message = {
    chat: { id: -123, type: 'group' },
    text: 'What about BTC right now?',
  };

  assert.equal(getProcessableTelegramText(message, 'MarketBot'), '');
});

test('getProcessableTelegramText strips bot mention from group text', () => {
  const mention = '@MarketBot';
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: `${mention} What about BTC right now?`,
    entities: [{ type: 'mention', offset: 0, length: mention.length }],
  };

  assert.equal(getProcessableTelegramText(message, 'marketbot'), 'What about BTC right now?');
});

test('getProcessableTelegramText keeps bot-targeted group commands', () => {
  const command = '/help@MarketBot';
  const message = {
    chat: { id: -123, type: 'group' },
    text: command,
    entities: [{ type: 'bot_command', offset: 0, length: command.length }],
  };

  assert.equal(getProcessableTelegramText(message, 'MarketBot'), command);
});

test('getProcessableTelegramText keeps bare group commands routed to the bot', () => {
  const command = '/help';
  const message = {
    chat: { id: -123, type: 'group' },
    text: command,
    entities: [{ type: 'bot_command', offset: 0, length: command.length }],
  };

  assert.equal(getProcessableTelegramText(message), command);
});

test('getProcessableTelegramText keeps group replies to the bot', () => {
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: 'Can you explain BTC here?',
    reply_to_message: {
      from: { is_bot: true, username: 'MarketBot' },
    },
  };

  assert.equal(
    getProcessableTelegramText(message, '@MarketBot'),
    'Can you explain BTC here?'
  );
});

test('getProcessableTelegramText ignores group replies to other bots when username is known', () => {
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: 'Can you explain BTC here?',
    reply_to_message: {
      from: { is_bot: true, username: 'OtherBot' },
    },
  };

  assert.equal(getProcessableTelegramText(message, 'MarketBot'), '');
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

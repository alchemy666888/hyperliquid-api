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

test('buildReply routes /rsh to research chat', async () => {
  const reply = await buildReply('/rsh 分析一下 btc 有什麼做多或者做空的機會', 123, {
    answerResearchChat: async ({ message }) => {
      assert.equal(message, '分析一下 btc 有什麼做多或者做空的機會');
      return { text: 'Research answer' };
    },
  });

  assert.equal(reply.text, 'Research answer');
});

test('buildReply /rsh transforms the search query before analysis', async () => {
  let searchedParams;
  let aiRequest;
  const reply = await buildReply('/rsh 分析一下 btc 有什麼做多或者做空的機會', 123, {
    getHyperliquidSnapshot: async () => ({
      interval: '4h',
      timestamp: '2026-07-01T00:00:00.000Z',
      assets: [
        {
          symbol: 'BTCUSDT',
          price: 61000,
          regime: 'MIXED',
          indicators: {},
        },
      ],
    }),
    getSearch: async ({ params }) => {
      searchedParams = params;
      return {
        ok: true,
        source: 'searchapi-io',
        query: params.q,
        timestamp: '2026-07-01T00:00:00.000Z',
        resultCount: 1,
        results: [
          {
            rank: 1,
            title: 'Bitcoin news update',
            source: 'Example News',
            date: '1 hour ago',
            snippet: 'Fresh Bitcoin market context.',
            link: 'https://example.com/btc',
          },
        ],
      };
    },
    deepSeekChat: async request => {
      aiRequest = request;
      return { ok: true, text: 'BTC research answer' };
    },
  });

  assert.equal(searchedParams.q, 'Bitcoin');
  assert.notEqual(searchedParams.q, '分析一下 btc 有什麼做多或者做空的機會');
  assert.equal(searchedParams.engine, 'google_news');
  const userPayload = JSON.parse(aiRequest.messages[1].content);
  assert.equal(userPayload.currentRequest, '分析一下 btc 有什麼做多或者做空的機會');
  assert.equal(userPayload.freshArticles[0].title, 'Bitcoin news update');
  assert.match(reply.text, /BTC research answer/);
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

test('getProcessableTelegramText recognizes the trading alchemist bot mention by default', () => {
  const mention = '@trading_alchemist_bot';
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: `${mention} say something`,
    entities: [{ type: 'mention', offset: 0, length: mention.length }],
  };

  assert.equal(getProcessableTelegramText(message), 'say something');
});

test('getProcessableTelegramText uses configured group bot username before default fallback', () => {
  const mention = '@trading_alchemist_bot';
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: `${mention} say something`,
    entities: [{ type: 'mention', offset: 0, length: mention.length }],
  };

  assert.equal(getProcessableTelegramText(message, 'MarketBot'), '');
});

test('getProcessableTelegramText recognizes group mentions even without entity metadata', () => {
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: 'hey @trading_alchemist_bot say something',
  };

  assert.equal(getProcessableTelegramText(message), 'hey say something');
});

test('getProcessableTelegramText ignores group mentions for other bots', () => {
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: '@other_bot say something',
    entities: [{ type: 'mention', offset: 0, length: '@other_bot'.length }],
  };

  assert.equal(getProcessableTelegramText(message), '');
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

test('getProcessableTelegramText ignores bare group commands', () => {
  const command = '/help';
  const message = {
    chat: { id: -123, type: 'group' },
    text: command,
    entities: [{ type: 'bot_command', offset: 0, length: command.length }],
  };

  assert.equal(getProcessableTelegramText(message), '');
});

test('getProcessableTelegramText ignores group replies without a bot mention', () => {
  const message = {
    chat: { id: -123, type: 'supergroup' },
    text: 'Can you explain BTC here?',
    reply_to_message: {
      from: { is_bot: true, username: 'MarketBot' },
    },
  };

  assert.equal(
    getProcessableTelegramText(message, '@MarketBot'),
    ''
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { answerStatelessAiChat } from '../lib/conversational-ai.js';

const snapshot = {
  interval: '4h',
  timestamp: '2026-06-30T00:00:00.000Z',
  assets: [
    {
      symbol: 'BTCUSDT',
      price: 61000,
      regime: 'bull',
      indicators: {
        rsi14: 64,
        adx14: 22,
        ema20: 60000,
        ema50: 59000,
        macd: { histogram: 12, histogramDirection: 'increasing' },
      },
    },
  ],
};

test('answerStatelessAiChat sends only current request and market context to AI', async () => {
  let aiRequest;
  const reply = await answerStatelessAiChat({
    message: 'What is BTC doing now?',
    getSnapshot: async () => snapshot,
    deepSeekChat: async request => {
      aiRequest = request;
      return { ok: true, text: 'BTC is firm on the current snapshot.' };
    },
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /BTC is firm/);
  assert.match(reply.text, /BTCUSDT 61,000/);
  assert.match(reply.text, /Informational only/);

  const messages = aiRequest.messages;
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /stateless/);
  assert.match(messages[0].content, /daily-life topics/);
  assert.match(messages[0].content, /Use the market context only when the request is about markets/);
  assert.match(messages[0].content, /Telegram-compatible HTML, not Markdown/);
  assert.match(messages[0].content, /Do not refer to or infer previous conversation history/);

  const userPayload = JSON.parse(messages[1].content);
  assert.equal(userPayload.currentRequest, 'What is BTC doing now?');
  assert.equal(userPayload.marketRelatedRequest, true);
  assert.equal(userPayload.marketContext.assets[0].symbol, 'BTCUSDT');
  assert.equal(Object.hasOwn(userPayload, 'history'), false);
  assert.equal(Object.hasOwn(userPayload, 'previousMessages'), false);
});

test('answerStatelessAiChat supports daily-life chat without market footer', async () => {
  let aiRequest;
  const reply = await answerStatelessAiChat({
    message: 'What should I cook for dinner tonight?',
    getSnapshot: async () => snapshot,
    deepSeekChat: async request => {
      aiRequest = request;
      return { ok: true, text: 'Try a quick veggie stir-fry with rice.' };
    },
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /veggie stir-fry/);
  assert.doesNotMatch(reply.text, /Market context:/);
  assert.doesNotMatch(reply.text, /Informational only/);

  const messages = aiRequest.messages;
  assert.match(messages[0].content, /daily-life topics/);
  assert.match(messages[0].content, /Telegram-compatible HTML, not Markdown/);
  const userPayload = JSON.parse(messages[1].content);
  assert.equal(userPayload.currentRequest, 'What should I cook for dinner tonight?');
  assert.equal(userPayload.marketRelatedRequest, false);
  assert.equal(userPayload.marketContext.assets[0].symbol, 'BTCUSDT');
  assert.equal(Object.hasOwn(userPayload, 'history'), false);
});

test('answerStatelessAiChat renders safe Telegram HTML from AI replies', async () => {
  const reply = await answerStatelessAiChat({
    message: 'Give me a quick dinner idea',
    getSnapshot: async () => snapshot,
    deepSeekChat: async () => ({
      ok: true,
      text: '<b>Try this</b>: tofu and rice. <script>alert("x")</script>',
    }),
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /<b>Try this<\/b>/);
  assert.match(reply.text, /&lt;script&gt;alert\("x"\)&lt;\/script&gt;/);
  assert.doesNotMatch(reply.text, /<script>/);
});

test('answerStatelessAiChat converts common Markdown formatting to Telegram HTML', async () => {
  const reply = await answerStatelessAiChat({
    message: 'Give me a short morning routine',
    getSnapshot: async () => snapshot,
    deepSeekChat: async () => ({
      ok: true,
      text: '**Morning plan**: drink water, stretch, then write `top priority`.',
    }),
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /<b>Morning plan<\/b>/);
  assert.match(reply.text, /<code>top priority<\/code>/);
  assert.doesNotMatch(reply.text, /\*\*Morning plan\*\*/);
});

test('answerStatelessAiChat returns setup guidance when AI is unavailable', async () => {
  const reply = await answerStatelessAiChat({
    message: 'hello',
    getSnapshot: async () => snapshot,
    deepSeekChat: async () => ({ ok: false, error: 'DeepSeek is not configured.' }),
  });

  assert.match(reply.text, /<b>AI chat unavailable<\/b>/);
  assert.match(reply.text, /DEEPSEEK_API_KEY/);
});

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
  let messages;
  const reply = await answerStatelessAiChat({
    message: 'What is BTC doing now?',
    getSnapshot: async () => snapshot,
    deepSeekChat: async request => {
      messages = request.messages;
      return { ok: true, text: 'BTC is firm on the current snapshot.' };
    },
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /BTC is firm/);
  assert.doesNotMatch(reply.text, /BTCUSDT 61,000/);
  assert.doesNotMatch(reply.text, /Informational only/);

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /stateless/);
  assert.match(messages[0].content, /Do not refer to or infer previous conversation history/);
  assert.match(messages[0].content, /plain text without Markdown formatting/);

  const userPayload = JSON.parse(messages[1].content);
  assert.equal(userPayload.currentRequest, 'What is BTC doing now?');
  assert.equal(userPayload.marketContext.assets[0].symbol, 'BTCUSDT');
  assert.equal(Object.hasOwn(userPayload, 'history'), false);
  assert.equal(Object.hasOwn(userPayload, 'previousMessages'), false);
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

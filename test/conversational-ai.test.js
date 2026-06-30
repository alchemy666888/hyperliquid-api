import assert from 'node:assert/strict';
import test from 'node:test';
import { answerStatelessAiChat } from '../lib/conversational-ai.js';

test('answerStatelessAiChat sends only the current request to AI as plain text', async () => {
  let messages;
  const reply = await answerStatelessAiChat({
    message: 'What is BTC doing now?',
    getSnapshot: async () => {
      throw new Error('no-command AI chat should not fetch market context');
    },
    deepSeekChat: async request => {
      messages = request.messages;
      return { ok: true, text: 'BTC is firm on the current snapshot.' };
    },
  });

  assert.equal(reply.parseMode, undefined);
  assert.match(reply.text, /BTC is firm/);
  assert.doesNotMatch(reply.text, /BTCUSDT 61,000/);
  assert.doesNotMatch(reply.text, /Market context/);

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /stateless/);
  assert.match(messages[0].content, /plain text only/);
  assert.match(messages[0].content, /Do not refer to or infer previous conversation history/);

  assert.equal(messages[1].content, 'What is BTC doing now?');
  assert.doesNotMatch(messages[1].content, /marketContext/);
  assert.doesNotMatch(messages[1].content, /history/);
  assert.doesNotMatch(messages[1].content, /previousMessages/);
});

test('answerStatelessAiChat returns setup guidance when AI is unavailable', async () => {
  const reply = await answerStatelessAiChat({
    message: 'hello',
    deepSeekChat: async () => ({ ok: false, error: 'DeepSeek is not configured.' }),
  });

  assert.equal(reply.parseMode, undefined);
  assert.match(reply.text, /AI chat unavailable\./);
  assert.match(reply.text, /DEEPSEEK_API_KEY/);
});

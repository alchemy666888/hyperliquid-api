import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchApiParams,
  extractSearchQuery,
  isLikelySearchRequest,
} from '../lib/intelligence/search-query.js';

test('extractSearchQuery fast-path canonicalizes Chinese BTC trading requests', async () => {
  const extracted = await extractSearchQuery({
    message: '分析一下 btc 有什麼做多或者做空的機會',
    aiJson: async () => {
      throw new Error('BTC fast path should not call the extractor');
    },
  });

  assert.equal(extracted.q, 'Bitcoin');
  assert.equal(extracted.gl, 'us');
  assert.equal(extracted.hl, 'en');
  assert.equal(extracted.freshness, 'd');
  assert.equal(extracted.needs_search, true);

  assert.deepEqual(buildSearchApiParams(extracted, { env: {} }), {
    engine: 'google_news',
    q: 'Bitcoin',
    gl: 'us',
    hl: 'en',
    tbs: 'qdr:d,sbd:1',
  });
});

test('extractSearchQuery uses hourly freshness for latest/now ticker requests', async () => {
  const extracted = await extractSearchQuery({
    message: 'latest BTC now',
    aiJson: async () => {
      throw new Error('BTC fast path should not call the extractor');
    },
  });

  assert.equal(extracted.q, 'Bitcoin');
  assert.equal(extracted.freshness, 'h');
  assert.equal(buildSearchApiParams(extracted, { env: {} }).tbs, 'qdr:h,sbd:1');
});

test('extractSearchQuery uses Taiwan locale for Taiwan equities', async () => {
  const extracted = await extractSearchQuery({
    message: '分析一下 2330.TW 台股 最新消息',
    aiJson: async () => {
      throw new Error('Taiwan ticker fast path should not call the extractor');
    },
  });

  assert.equal(extracted.q, '"2330.TW"');
  assert.equal(extracted.gl, 'tw');
  assert.equal(extracted.hl, 'zh-TW');
});

test('extractSearchQuery wraps ambiguous short tickers', async () => {
  const extracted = await extractSearchQuery({
    message: 'SPCX news',
    aiJson: async () => {
      throw new Error('SPCX fast path should not call the extractor');
    },
  });

  assert.equal(extracted.q, '"$SPCX"');
  assert.equal(extracted.needs_search, true);
});

test('extractSearchQuery returns needs_search=false for chit-chat extractor output', async () => {
  const extracted = await extractSearchQuery({
    message: 'What should I cook tonight?',
    aiJson: async () => ({
      ok: true,
      json: {
        q: '',
        gl: 'us',
        hl: 'en',
        freshness: 'd',
        needs_search: false,
      },
    }),
  });

  assert.equal(extracted.needs_search, false);
  assert.equal(buildSearchApiParams(extracted, { env: {} }), null);
});

test('extractSearchQuery falls back to raw daily query when extractor JSON is malformed', async () => {
  const extracted = await extractSearchQuery({
    message: 'tell me about OpenAI',
    aiJson: async () => ({ ok: false, error: 'invalid JSON' }),
  });

  assert.equal(extracted.q, 'tell me about OpenAI');
  assert.equal(extracted.freshness, 'd');
  assert.equal(extracted.needs_search, true);
  assert.equal(buildSearchApiParams(extracted, { env: {} }).tbs, 'qdr:d,sbd:1');
});

test('isLikelySearchRequest gates casual chat but allows news and market requests', () => {
  assert.equal(isLikelySearchRequest('What should I cook tonight?'), false);
  assert.equal(isLikelySearchRequest('latest OpenAI news today'), true);
  assert.equal(isLikelySearchRequest('分析一下 btc 有什麼機會'), true);
});

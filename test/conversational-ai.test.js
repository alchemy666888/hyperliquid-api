import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerStatelessAiChat,
  isWebSearchRelatedRequest,
} from '../lib/conversational-ai.js';

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

const weatherSnapshot = {
  requestedLocation: 'Kuala Lumpur',
  location: {
    name: 'Kuala Lumpur',
    country: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
  },
  current: {
    time: '2026-07-01T08:00',
    weather_code: 2,
    temperature_2m: 31.4,
    apparent_temperature: 35.2,
    relative_humidity_2m: 72,
    wind_speed_10m: 8.6,
  },
  currentUnits: {
    temperature_2m: '°C',
    apparent_temperature: '°C',
    wind_speed_10m: 'km/h',
  },
  today: {
    weatherCode: 61,
    temperatureMin: 25.1,
    temperatureMax: 32.8,
    precipitationProbabilityMax: 60,
  },
  dailyUnits: {
    temperature_2m_max: '°C',
  },
};

test('answerStatelessAiChat sends only current request and market context to AI', async () => {
  let aiRequest;
  const reply = await answerStatelessAiChat({
    message: 'What is BTC doing now?',
    getSnapshot: async () => snapshot,
    getSearch: async () => {
      throw new Error('market data-only request should not search the web');
    },
    deepSeekChat: async request => {
      aiRequest = request;
      return { ok: true, text: 'BTC is firm on the current snapshot.' };
    },
  });

  assert.equal(reply.parseMode, 'HTML');
  assert.match(reply.text, /BTC is firm/);
  assert.match(reply.text, /BTCUSDT 61,000/);
  assert.match(reply.text, /Updated: 2026-06-30 08:00 HKT/);
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
  assert.equal(userPayload.webSearchRelatedRequest, false);
  assert.equal(userPayload.webSearchContext, null);
  assert.equal(Object.hasOwn(userPayload, 'history'), false);
  assert.equal(Object.hasOwn(userPayload, 'previousMessages'), false);
});

test('answerStatelessAiChat searches current news before asking AI to analyze it', async () => {
  let searchedQuery;
  let aiRequest;
  const reply = await answerStatelessAiChat({
    message: 'latest OpenAI news today',
    getSnapshot: async () => snapshot,
    getSearch: async ({ query }) => {
      searchedQuery = query;
      return {
        ok: true,
        source: 'google-custom-search',
        query,
        timestamp: '2026-07-01T00:00:00.000Z',
        resultCount: 1,
        results: [
          {
            rank: 1,
            title: 'OpenAI shares product update',
            link: 'https://example.com/openai-update',
            snippet: 'A concise search result snippet.',
          },
        ],
      };
    },
    deepSeekChat: async request => {
      aiRequest = request;
      return { ok: true, text: 'OpenAI has a new update based on the search result.' };
    },
  });

  assert.equal(searchedQuery, 'latest OpenAI news today');
  assert.match(reply.text, /OpenAI has a new update/);
  assert.match(aiRequest.messages[0].content, /webSearchContext/);

  const userPayload = JSON.parse(aiRequest.messages[1].content);
  assert.equal(userPayload.currentRequest, 'latest OpenAI news today');
  assert.equal(userPayload.marketRelatedRequest, false);
  assert.equal(userPayload.webSearchRelatedRequest, true);
  assert.equal(userPayload.webSearchContext.ok, true);
  assert.equal(userPayload.webSearchContext.results[0].title, 'OpenAI shares product update');
});

test('isWebSearchRelatedRequest keeps market data on Hyperliquid but searches market news', () => {
  assert.equal(
    isWebSearchRelatedRequest('What is BTC price now?', { marketRelatedRequest: true }),
    false
  );
  assert.equal(
    isWebSearchRelatedRequest('latest BTC ETF news', { marketRelatedRequest: true }),
    true
  );
  assert.equal(
    isWebSearchRelatedRequest('who is the current OpenAI CEO?', { marketRelatedRequest: false }),
    true
  );
});

test('answerStatelessAiChat answers bare Chinese weather query with default location', async () => {
  const previousDefault = process.env.DEFAULT_WEATHER_LOCATION;
  process.env.DEFAULT_WEATHER_LOCATION = 'Kuala Lumpur';
  let weatherLocation;
  let aiCalled = false;
  let snapshotCalled = false;

  try {
    const reply = await answerStatelessAiChat({
      message: '今天天气如何',
      getSnapshot: async () => {
        snapshotCalled = true;
        return snapshot;
      },
      getWeather: async ({ location }) => {
        weatherLocation = location;
        return weatherSnapshot;
      },
      deepSeekChat: async () => {
        aiCalled = true;
        return { ok: true, text: 'AI should not answer weather.' };
      },
    });

    assert.equal(reply.parseMode, 'HTML');
    assert.equal(weatherLocation, 'Kuala Lumpur');
    assert.equal(aiCalled, false);
    assert.equal(snapshotCalled, false);
    assert.match(reply.text, /<b>天气<\/b>/);
    assert.match(reply.text, /未指定城市，按默认地点 Kuala Lumpur, Malaysia 查询。/);
    assert.match(reply.text, /当前：局部多云/);
    assert.match(reply.text, /最高降雨概率 60%/);
    assert.match(reply.text, /更新时间：2026-07-01 08:00 HKT/);
  } finally {
    if (previousDefault == null) {
      delete process.env.DEFAULT_WEATHER_LOCATION;
    } else {
      process.env.DEFAULT_WEATHER_LOCATION = previousDefault;
    }
  }
});

test('answerStatelessAiChat extracts Chinese weather city before querying', async () => {
  let weatherLocation;

  const reply = await answerStatelessAiChat({
    message: '上海今天天气如何',
    getSnapshot: async () => {
      throw new Error('market snapshot should not be fetched for weather');
    },
    getWeather: async ({ location }) => {
      weatherLocation = location;
      return {
        ...weatherSnapshot,
        requestedLocation: location,
        location: { name: 'Shanghai', country: 'China' },
      };
    },
    deepSeekChat: async () => {
      throw new Error('AI should not answer weather');
    },
  });

  assert.equal(weatherLocation, '上海');
  assert.match(reply.text, /Shanghai, China 的天气：/);
  assert.doesNotMatch(reply.text, /未指定城市/);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSearchTool,
  getSearchStatus,
  parseSearchOutput,
  searchForContext,
} from '../lib/search.js';

test('getSearchStatus reports missing SearchApi.io variables safely', () => {
  const status = getSearchStatus({});

  assert.equal(status.provider, 'SEARCHAPI_IO');
  assert.equal(status.configured, false);
  assert.equal(status.apiKeyConfigured, false);
  assert.equal(status.engine, 'google');
  assert.deepEqual(status.missing, ['SEARCHAPI_API_KEY']);
});

test('parseSearchOutput normalizes SearchApi.io JSON', () => {
  const results = parseSearchOutput(JSON.stringify([
    {
      title: ' First result ',
      link: ' https://example.com/first ',
      snippet: ' Useful current context. ',
    },
    {
      title: 'Second result',
      link: 'https://example.com/second',
      snippet: 'Another snippet.',
    },
  ]), 1);

  assert.deepEqual(results, [
    {
      rank: 1,
      title: 'First result',
      link: 'https://example.com/first',
      snippet: 'Useful current context.',
    },
  ]);
});

test('createSearchTool calls SearchApi.io and returns compact organic results JSON', async () => {
  let requestedUrl;
  let requestOptions;
  const tool = createSearchTool({
    apiKey: 'searchapi-key',
    engine: 'google',
    resultLimit: 3,
  }, {
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return {
        ok: true,
        json: async () => ({
          organic_results: [
            {
              title: 'OpenAI announces update',
              link: 'https://example.com/openai-update',
              snippet: 'The result snippet.',
            },
          ],
        }),
      };
    },
  });

  const output = await tool.invoke('latest OpenAI news');
  const results = JSON.parse(output);

  assert.equal(requestedUrl.href, 'https://www.searchapi.io/api/v1/search?engine=google&q=latest+OpenAI+news');
  assert.equal(requestOptions.headers.Authorization, 'Bearer searchapi-key');
  assert.deepEqual(results, [
    {
      title: 'OpenAI announces update',
      link: 'https://example.com/openai-update',
      snippet: 'The result snippet.',
    },
  ]);
});

test('createSearchTool rejects missing config before calling SearchApi.io', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let fetchCalled = false;

  try {
    const tool = createSearchTool({
      apiKey: '',
      engine: 'google',
      resultLimit: 3,
    }, {
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('should not call SearchApi.io without credentials');
      },
    });

    await assert.rejects(
      () => tool.invoke('latest OpenAI news'),
      /Missing SEARCHAPI_API_KEY/
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(fetchCalled, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'SearchApi.io request skipped: missing configuration');
  assert.deepEqual(warnings[0][1].missing, ['SEARCHAPI_API_KEY']);
});

test('createSearchTool logs sanitized SearchApi.io error details', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const tool = createSearchTool({
      apiKey: 'searchapi-key',
      engine: 'google',
      resultLimit: 3,
    }, {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({
          error: {
            status: 'UNAUTHENTICATED',
            message: 'Invalid API key.',
            reason: 'invalid_api_key',
          },
        }),
      }),
    });

    await assert.rejects(
      () => tool.invoke('secret user query'),
      /HTTP 401\. UNAUTHENTICATED \| invalid_api_key \| Invalid API key/
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'SearchApi.io request failed');

  const details = warnings[0][1];
  assert.equal(details.status, 401);
  assert.equal(details.statusText, 'Unauthorized');
  assert.equal(details.apiKeyConfigured, true);
  assert.equal(details.requestHasAuthorizationHeader, true);
  assert.equal(details.engine, 'google');
  assert.equal(details.searchApiError.status, 'UNAUTHENTICATED');
  assert.equal(details.searchApiError.reason, 'invalid_api_key');
  assert.doesNotMatch(JSON.stringify(details), /searchapi-key/);
  assert.doesNotMatch(JSON.stringify(details), /secret user query/);
});

test('searchForContext invokes an injected SearchApi.io-compatible search tool', async () => {
  let searchedQuery;
  const context = await searchForContext({
    query: '  latest OpenAI news  ',
    env: {},
    now: new Date('2026-07-01T00:00:00.000Z'),
    searchTool: {
      invoke: async query => {
        searchedQuery = query;
        return JSON.stringify([
          {
            title: 'OpenAI announces update',
            link: 'https://example.com/openai-update',
            snippet: 'The result snippet.',
          },
        ]);
      },
    },
  });

  assert.equal(searchedQuery, 'latest OpenAI news');
  assert.equal(context.ok, true);
  assert.equal(context.source, 'searchapi-io');
  assert.equal(context.timestamp, '2026-07-01T00:00:00.000Z');
  assert.equal(context.resultCount, 1);
  assert.equal(context.results[0].title, 'OpenAI announces update');
});

test('searchForContext returns setup guidance when SearchApi.io is not configured', async () => {
  const context = await searchForContext({
    query: 'latest AI news',
    env: {},
    now: new Date('2026-07-01T00:00:00.000Z'),
  });

  assert.equal(context.ok, false);
  assert.match(context.error, /not configured/);
  assert.deepEqual(context.missing, ['SEARCHAPI_API_KEY']);
  assert.deepEqual(context.results, []);
});

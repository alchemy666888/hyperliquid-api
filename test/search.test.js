import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGoogleSearchTool,
  getGoogleSearchStatus,
  parseGoogleSearchOutput,
  searchGoogleForContext,
} from '../lib/search.js';

test('getGoogleSearchStatus reports missing Google Custom Search variables safely', () => {
  const status = getGoogleSearchStatus({});

  assert.equal(status.provider, 'GOOGLE_CUSTOM_SEARCH');
  assert.equal(status.configured, false);
  assert.equal(status.apiKeyConfigured, false);
  assert.equal(status.cseIdConfigured, false);
  assert.deepEqual(status.missing, ['GOOGLE_API_KEY', 'GOOGLE_CSE_ID']);
});

test('parseGoogleSearchOutput normalizes Google Custom Search JSON', () => {
  const results = parseGoogleSearchOutput(JSON.stringify([
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

test('createGoogleSearchTool calls Google Custom Search and returns compact JSON', async () => {
  let requestedUrl;
  const tool = createGoogleSearchTool({
    apiKey: 'google-key',
    googleCSEId: 'search-engine-id',
    resultLimit: 3,
  }, {
    fetchImpl: async url => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          items: [
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

  assert.equal(requestedUrl.href, 'https://www.googleapis.com/customsearch/v1?key=google-key&cx=search-engine-id&q=latest+OpenAI+news&num=3');
  assert.deepEqual(results, [
    {
      title: 'OpenAI announces update',
      link: 'https://example.com/openai-update',
      snippet: 'The result snippet.',
    },
  ]);
});

test('searchGoogleForContext invokes an injected Google search tool', async () => {
  let searchedQuery;
  const context = await searchGoogleForContext({
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
  assert.equal(context.source, 'google-custom-search');
  assert.equal(context.timestamp, '2026-07-01T00:00:00.000Z');
  assert.equal(context.resultCount, 1);
  assert.equal(context.results[0].title, 'OpenAI announces update');
});

test('searchGoogleForContext returns setup guidance when Google search is not configured', async () => {
  const context = await searchGoogleForContext({
    query: 'latest AI news',
    env: {},
    now: new Date('2026-07-01T00:00:00.000Z'),
  });

  assert.equal(context.ok, false);
  assert.match(context.error, /not configured/);
  assert.deepEqual(context.missing, ['GOOGLE_API_KEY', 'GOOGLE_CSE_ID']);
  assert.deepEqual(context.results, []);
});

const DEFAULT_SEARCH_RESULT_LIMIT = 8;
const MAX_SEARCH_RESULT_LIMIT = 10;
const MAX_QUERY_LENGTH = 400;
const MAX_TITLE_LENGTH = 180;
const MAX_SOURCE_LENGTH = 120;
const MAX_DATE_LENGTH = 120;
const MAX_SNIPPET_LENGTH = 500;
const MAX_LINK_LENGTH = 700;
const MAX_ERROR_MESSAGE_LENGTH = 800;
const DEFAULT_SEARCHAPI_ENGINE = 'google_news';
const SEARCHAPI_URL = 'https://www.searchapi.io/api/v1/search';
const DEFAULT_SEARCH_PROVIDER = 'SEARCHAPI_IO';
const WEBSEARCH_DEEPSEEK_PROVIDER = 'WEBSEARCH_DEEPSEEK';
const DEFAULT_WEBSEARCH_DEEPSEEK_TOOL = 'web_search';
const ALLOWED_SEARCHAPI_PARAM_KEYS = new Set([
  'engine',
  'q',
  'gl',
  'hl',
  'tbs',
  'tbm',
]);

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function clampResultLimit(value, fallback = DEFAULT_SEARCH_RESULT_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_SEARCH_RESULT_LIMIT);
}

function compactText(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeQuery(value) {
  return compactText(value, MAX_QUERY_LENGTH);
}

function redactText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    const token = String(secret ?? '');
    if (token) text = text.split(token).join('[redacted]');
  }
  return text;
}

function sanitizedSearchApiUrl(url) {
  const safeUrl = new URL(url);
  if (safeUrl.searchParams.has('api_key')) safeUrl.searchParams.set('api_key', '[redacted]');
  if (safeUrl.searchParams.has('q')) safeUrl.searchParams.set('q', '[redacted-query]');
  return safeUrl.href;
}

function validateSearchApiConfig(config) {
  const missing = [];
  if (!String(config?.apiKey ?? '').trim()) missing.push('SEARCHAPI_API_KEY');
  return missing;
}

function normalizeSearchProvider(value) {
  const provider = String(value || DEFAULT_SEARCH_PROVIDER).trim().toUpperCase().replace(/[ -]+/g, '_');
  if (provider === 'SEARCHAPI' || provider === 'SEARCHAPIIO') return DEFAULT_SEARCH_PROVIDER;
  if (provider === 'DEEPSEEK' || provider === 'DEEPSEEK_WEBSEARCH' || provider === 'WEBSEARCH_DEEPSEEK') {
    return WEBSEARCH_DEEPSEEK_PROVIDER;
  }
  return DEFAULT_SEARCH_PROVIDER;
}

function validateWebsearchDeepseekConfig(config) {
  const missing = [];
  if (!String(config?.mcpUrl ?? '').trim()) missing.push('WEBSEARCH_DEEPSEEK_MCP_URL');
  return missing;
}

function normalizeSearchApiErrorPayload(payload) {
  const error = payload?.error ?? payload?.errors ?? payload;
  if (!error) return null;

  if (typeof error === 'string') {
    return {
      message: compactText(error, MAX_ERROR_MESSAGE_LENGTH),
      errors: [],
    };
  }

  if (Array.isArray(error)) {
    return {
      errors: error.map(item => ({
        code: item?.code,
        status: compactText(item?.status, 120),
        reason: compactText(item?.reason, 160),
        message: compactText(item?.message ?? item?.title ?? item?.detail, MAX_ERROR_MESSAGE_LENGTH),
      })),
    };
  }

  if (typeof error !== 'object') return null;

  const nestedErrors = Array.isArray(error.errors)
    ? error.errors.map(item => ({
        code: item?.code,
        status: compactText(item?.status, 120),
        reason: compactText(item?.reason, 160),
        message: compactText(item?.message ?? item?.title ?? item?.detail, MAX_ERROR_MESSAGE_LENGTH),
      }))
    : [];

  return {
    code: error.code,
    status: compactText(error.status, 120),
    reason: compactText(error.reason, 160),
    message: compactText(error.message ?? error.title ?? error.detail, MAX_ERROR_MESSAGE_LENGTH),
    errors: nestedErrors,
  };
}

async function readSearchApiErrorDetails(response, secrets = []) {
  try {
    if (typeof response.text === 'function') {
      const body = redactText(await response.text(), secrets);
      if (!body) return {};

      try {
        const payload = JSON.parse(body);
        return { searchApiError: normalizeSearchApiErrorPayload(payload) };
      } catch {
        return { body: compactText(body, MAX_ERROR_MESSAGE_LENGTH) };
      }
    }

    if (typeof response.json === 'function') {
      const payload = await response.json();
      return { searchApiError: normalizeSearchApiErrorPayload(payload) };
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    return { parseError: compactText(redactText(message, secrets), MAX_ERROR_MESSAGE_LENGTH) };
  }

  return {};
}

function searchApiErrorSummary(details) {
  const searchApiError = details?.searchApiError;
  const nested = searchApiError?.errors ?? [];
  const reasons = nested.map(item => item.reason).filter(Boolean);
  const messages = nested.map(item => item.message).filter(Boolean);
  const pieces = [
    searchApiError?.status,
    searchApiError?.reason,
    searchApiError?.message,
    reasons.length ? `reasons: ${reasons.join(', ')}` : '',
    messages.length ? messages.join(' | ') : '',
    details?.body,
    details?.parseError ? `error body parse failed: ${details.parseError}` : '',
  ].filter(Boolean);

  return pieces.length ? ` ${pieces.join(' | ')}` : '';
}

export function getSearchConfig(env = process.env) {
  const provider = normalizeSearchProvider(readEnv(env, 'SEARCH_PROVIDER') || readEnv(env, 'SEARCHAI_PROVIDER'));
  const apiKey = readEnv(env, 'SEARCHAPI_API_KEY') || readEnv(env, 'SEARCH_API_KEY');
  const engine = readEnv(env, 'SEARCHAPI_ENGINE') || DEFAULT_SEARCHAPI_ENGINE;
  const resultLimit = clampResultLimit(
    readEnv(env, 'SEARCHAPI_RESULT_LIMIT') || readEnv(env, 'SEARCH_RESULT_LIMIT')
  );
  const missing = [];

  if (provider === WEBSEARCH_DEEPSEEK_PROVIDER) {
    const mcpUrl = readEnv(env, 'WEBSEARCH_DEEPSEEK_MCP_URL');
    const mcpTool = readEnv(env, 'WEBSEARCH_DEEPSEEK_TOOL') || DEFAULT_WEBSEARCH_DEEPSEEK_TOOL;
    const mcpHeaders = readEnv(env, 'WEBSEARCH_DEEPSEEK_MCP_HEADERS');
    const mcpMissing = validateWebsearchDeepseekConfig({ mcpUrl });
    return {
      provider,
      configured: mcpMissing.length === 0,
      missing: mcpMissing,
      mcpUrl,
      mcpTool,
      mcpHeaders,
      resultLimit,
    };
  }

  if (!apiKey) missing.push('SEARCHAPI_API_KEY');

  return {
    provider: DEFAULT_SEARCH_PROVIDER,
    configured: missing.length === 0,
    missing,
    apiKey,
    engine,
    resultLimit,
  };
}

export function getSearchStatus(env = process.env) {
  const config = getSearchConfig(env);
  return {
    provider: config.provider,
    configured: config.configured,
    missing: config.missing,
    apiKeyConfigured: Boolean(config.apiKey),
    mcpUrlConfigured: Boolean(config.mcpUrl),
    mcpTool: config.mcpTool,
    engine: config.engine,
    resultLimit: config.resultLimit,
  };
}

function normalizeSearchApiParams(input, config = {}) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const params = {};
    for (const key of ALLOWED_SEARCHAPI_PARAM_KEYS) {
      const value = input[key];
      if (value == null || value === '') continue;
      params[key] = compactText(value, key === 'q' ? MAX_QUERY_LENGTH : 120);
    }
    return {
      engine: params.engine || config.engine || DEFAULT_SEARCHAPI_ENGINE,
      ...params,
      q: normalizeQuery(params.q),
    };
  }

  return {
    engine: config.engine || DEFAULT_SEARCHAPI_ENGINE,
    q: normalizeQuery(input),
  };
}

function resultSource(item) {
  const source = item?.source;
  if (typeof source === 'string') return source;
  return source?.name ?? source?.title ?? item?.publisher ?? item?.publication ?? '';
}

function resultDate(item) {
  return item?.date ?? item?.published_date ?? item?.publishedAt ?? item?.time ?? item?.time_ago ?? '';
}

function resultSnippet(item) {
  return item?.snippet ?? item?.description ?? item?.summary ?? '';
}

function searchApiResultItems(payload) {
  const candidates = [
    payload?.news_results,
    payload?.organic_results,
    payload?.top_stories,
    payload?.stories,
  ];
  return candidates.find(Array.isArray) ?? [];
}

function mapSearchApiResults(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    title: item?.title,
    source: resultSource(item),
    date: resultDate(item),
    link: item?.link,
    snippet: resultSnippet(item),
  }));
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function postMcpJsonRpc(config, method, params, fetchImpl) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...parseJsonObject(config.mcpHeaders),
  };
  const response = await fetchImpl(config.mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${Math.random()}`, method, params }),
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    throw new Error(`websearch-deepseek MCP returned HTTP ${response.status}.${body ? ` ${compactText(body, MAX_ERROR_MESSAGE_LENGTH)}` : ''}`);
  }

  const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  const data = text.trim().startsWith('data:')
    ? text.trim().split(/\n+/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).find(line => line && line !== '[DONE]')
    : text;
  const payload = JSON.parse(data);
  if (payload.error) throw new Error(payload.error.message || 'websearch-deepseek MCP JSON-RPC error.');
  return payload.result;
}

function extractMcpToolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map(part => {
      if (typeof part?.text === 'string') return part.text;
      if (typeof part === 'string') return part;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || (typeof result === 'string' ? result : JSON.stringify(result));
}

export function createWebsearchDeepseekMcpTool(config = getSearchConfig(), { fetchImpl = fetch } = {}) {
  return {
    name: 'websearch-deepseek-mcp',
    description: 'Searches the web through the websearch-deepseek MCP server backed by DeepSeek native online search.',
    async invoke(input) {
      const missing = validateWebsearchDeepseekConfig(config);
      const params = normalizeSearchApiParams(input, config);
      if (missing.length) {
        throw new Error(`websearch-deepseek MCP is not configured. Missing ${missing.join(', ')}.`);
      }
      if (!params.q) throw new Error('websearch-deepseek MCP search query is required.');

      await postMcpJsonRpc(config, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hyperliquid-api', version: '1.0.0' },
      }, fetchImpl).catch(() => null);

      const result = await postMcpJsonRpc(config, 'tools/call', {
        name: config.mcpTool || DEFAULT_WEBSEARCH_DEEPSEEK_TOOL,
        arguments: { query: params.q, q: params.q, ...params },
      }, fetchImpl);
      return extractMcpToolText(result);
    },
  };
}

export function createSearchTool(config = getSearchConfig(), { fetchImpl = fetch } = {}) {
  return {
    name: 'searchapi-io',
    description: 'Searches SearchApi.io for current web information.',
    async invoke(input) {
      const missing = validateSearchApiConfig(config);
      const params = normalizeSearchApiParams(input, config);
      if (missing.length) {
        console.warn('SearchApi.io request skipped: missing configuration', {
          missing,
          apiKeyConfigured: Boolean(String(config?.apiKey ?? '').trim()),
          engine: params.engine,
          resultLimit: config?.resultLimit,
          queryLength: params.q.length,
        });
        throw new Error(`SearchApi.io search is not configured. Missing ${missing.join(', ')}.`);
      }

      if (!params.q) {
        throw new Error('SearchApi.io search query is required.');
      }

      const url = new URL(SEARCHAPI_URL);
      for (const [key, value] of Object.entries(params)) {
        if (value) url.searchParams.set(key, value);
      }

      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
      if (!response.ok) {
        const details = await readSearchApiErrorDetails(response, [config.apiKey]);
        console.warn('SearchApi.io request failed', {
          status: response.status,
          statusText: response.statusText ?? '',
          url: sanitizedSearchApiUrl(url),
          apiKeyConfigured: Boolean(config.apiKey),
          requestHasAuthorizationHeader: Boolean(config.apiKey),
          requestHasQueryParam: Boolean(url.searchParams.get('q')),
          engine: params.engine,
          resultLimit: config.resultLimit,
          queryLength: params.q.length,
          ...details,
        });
        throw new Error(`SearchApi.io search returned HTTP ${response.status}.${searchApiErrorSummary(details)}`);
      }

      const payload = await response.json();
      return JSON.stringify(mapSearchApiResults(searchApiResultItems(payload)));
    },
  };
}

async function invokeSearchTool(searchTool, query) {
  if (typeof searchTool === 'function') return searchTool(query);
  if (typeof searchTool?.invoke === 'function') return searchTool.invoke(query);
  if (typeof searchTool?.call === 'function') return searchTool.call(query);
  if (typeof searchTool?._call === 'function') return searchTool._call(query);
  throw new Error('Search tool must be a function or an object with invoke().');
}

function normalizeSearchResult(item, index) {
  if (!item || typeof item !== 'object') return null;

  const title = compactText(item.title, MAX_TITLE_LENGTH);
  const source = compactText(item.source, MAX_SOURCE_LENGTH);
  const date = compactText(item.date, MAX_DATE_LENGTH);
  const link = compactText(item.link, MAX_LINK_LENGTH);
  const snippet = compactText(item.snippet, MAX_SNIPPET_LENGTH);

  if (!title && !link && !snippet && !source && !date) return null;
  return {
    rank: index + 1,
    title,
    source,
    date,
    link,
    snippet,
  };
}

export function parseSearchOutput(output, limit = DEFAULT_SEARCH_RESULT_LIMIT) {
  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map(normalizeSearchResult)
    .filter(Boolean)
    .slice(0, clampResultLimit(limit));
}

export async function searchForContext({
  query,
  params,
  limit,
  env = process.env,
  searchTool,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const config = getSearchConfig(env);
  const searchInput = params ?? query;
  const normalizedParams = normalizeSearchApiParams(searchInput, config);
  const searchQuery = normalizedParams.q;
  const resultLimit = clampResultLimit(limit, config.resultLimit);
  const source = config.provider === WEBSEARCH_DEEPSEEK_PROVIDER ? 'websearch-deepseek-mcp' : 'searchapi-io';
  const base = {
    source,
    query: searchQuery,
    timestamp: now.toISOString(),
    ...(params ? { searchParams: normalizedParams } : {}),
  };

  if (!searchQuery) {
    return {
      ...base,
      ok: false,
      error: 'Search query is required.',
    };
  }

  if (!searchTool && !config.configured) {
    return {
      ...base,
      ok: false,
      error: config.provider === WEBSEARCH_DEEPSEEK_PROVIDER
        ? 'websearch-deepseek MCP is not configured.'
        : 'SearchApi.io search is not configured.',
      missing: config.missing,
      results: [],
    };
  }

  try {
    const tool = searchTool ?? (config.provider === WEBSEARCH_DEEPSEEK_PROVIDER
      ? createWebsearchDeepseekMcpTool(config, { fetchImpl })
      : createSearchTool(config, { fetchImpl }));
    const output = await invokeSearchTool(tool, params ? normalizedParams : searchQuery);
    const results = parseSearchOutput(output, resultLimit);
    return {
      ...base,
      ok: true,
      results,
      resultCount: results.length,
    };
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    return {
      ...base,
      ok: false,
      error: `${source} search failed: ${message}`,
      results: [],
    };
  }
}

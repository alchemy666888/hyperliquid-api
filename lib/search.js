const DEFAULT_SEARCH_RESULT_LIMIT = 5;
const MAX_SEARCH_RESULT_LIMIT = 10;
const MAX_QUERY_LENGTH = 400;
const MAX_TITLE_LENGTH = 180;
const MAX_SNIPPET_LENGTH = 500;
const MAX_LINK_LENGTH = 700;
const MAX_ERROR_MESSAGE_LENGTH = 800;
const GOOGLE_CUSTOM_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';

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

function redactValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= 8) return '[redacted]';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redactText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    const token = String(secret ?? '');
    if (token) text = text.split(token).join('[redacted]');
  }
  return text;
}

function sanitizedGoogleSearchUrl(url) {
  const safeUrl = new URL(url);
  if (safeUrl.searchParams.has('key')) safeUrl.searchParams.set('key', '[redacted]');
  if (safeUrl.searchParams.has('q')) safeUrl.searchParams.set('q', '[redacted-query]');
  return safeUrl.href;
}

function validateGoogleSearchConfig(config) {
  const missing = [];
  if (!String(config?.apiKey ?? '').trim()) missing.push('GOOGLE_API_KEY');
  if (!String(config?.googleCSEId ?? '').trim()) missing.push('GOOGLE_CSE_ID');
  return missing;
}

function normalizeGoogleErrorPayload(payload) {
  const error = payload?.error ?? payload;
  if (!error || typeof error !== 'object') return null;

  const errors = Array.isArray(error.errors)
    ? error.errors.map(item => ({
        domain: compactText(item?.domain, 120),
        reason: compactText(item?.reason, 160),
        message: compactText(item?.message, MAX_ERROR_MESSAGE_LENGTH),
        locationType: compactText(item?.locationType, 120),
        location: compactText(item?.location, 160),
      }))
    : [];

  return {
    code: error.code,
    status: compactText(error.status, 120),
    message: compactText(error.message, MAX_ERROR_MESSAGE_LENGTH),
    errors,
  };
}

async function readGoogleErrorDetails(response, secrets = []) {
  try {
    if (typeof response.text === 'function') {
      const body = redactText(await response.text(), secrets);
      if (!body) return {};

      try {
        const payload = JSON.parse(body);
        return { googleError: normalizeGoogleErrorPayload(payload) };
      } catch {
        return { body: compactText(body, MAX_ERROR_MESSAGE_LENGTH) };
      }
    }

    if (typeof response.json === 'function') {
      const payload = await response.json();
      return { googleError: normalizeGoogleErrorPayload(payload) };
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    return { parseError: compactText(redactText(message, secrets), MAX_ERROR_MESSAGE_LENGTH) };
  }

  return {};
}

function googleErrorSummary(details) {
  const googleError = details?.googleError;
  const reasons = googleError?.errors?.map(item => item.reason).filter(Boolean) ?? [];
  const pieces = [
    googleError?.status,
    googleError?.message,
    reasons.length ? `reasons: ${reasons.join(', ')}` : '',
    details?.body,
    details?.parseError ? `error body parse failed: ${details.parseError}` : '',
  ].filter(Boolean);

  return pieces.length ? ` ${pieces.join(' | ')}` : '';
}

export function getGoogleSearchConfig(env = process.env) {
  const apiKey = readEnv(env, 'GOOGLE_API_KEY') || readEnv(env, 'GOOGLE_CUSTOM_SEARCH_API_KEY');
  const googleCSEId = readEnv(env, 'GOOGLE_CSE_ID')
    || readEnv(env, 'GOOGLE_CUSTOM_SEARCH_ENGINE_ID')
    || readEnv(env, 'GOOGLE_CUSTOM_SEARCH_CX');
  const resultLimit = clampResultLimit(readEnv(env, 'GOOGLE_SEARCH_RESULT_LIMIT'));
  const missing = [];

  if (!apiKey) missing.push('GOOGLE_API_KEY');
  if (!googleCSEId) missing.push('GOOGLE_CSE_ID');

  return {
    provider: 'GOOGLE_CUSTOM_SEARCH',
    configured: missing.length === 0,
    missing,
    apiKey,
    googleCSEId,
    resultLimit,
  };
}

export function getGoogleSearchStatus(env = process.env) {
  const config = getGoogleSearchConfig(env);
  return {
    provider: config.provider,
    configured: config.configured,
    missing: config.missing,
    apiKeyConfigured: Boolean(config.apiKey),
    cseIdConfigured: Boolean(config.googleCSEId),
    resultLimit: config.resultLimit,
  };
}

function mapGoogleApiItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    title: item?.title,
    link: item?.link,
    snippet: item?.snippet,
  }));
}

export function createGoogleSearchTool(config = getGoogleSearchConfig(), { fetchImpl = fetch } = {}) {
  return {
    name: 'google-custom-search',
    description: 'Searches Google Custom Search for current web information.',
    async invoke(input) {
      const missing = validateGoogleSearchConfig(config);
      if (missing.length) {
        console.warn('Google Custom Search request skipped: missing configuration', {
          missing,
          apiKeyConfigured: Boolean(String(config?.apiKey ?? '').trim()),
          cseIdConfigured: Boolean(String(config?.googleCSEId ?? '').trim()),
          resultLimit: config?.resultLimit,
          queryLength: String(input ?? '').length,
        });
        throw new Error(`Google custom search is not configured. Missing ${missing.join(', ')}.`);
      }

      const url = new URL(GOOGLE_CUSTOM_SEARCH_URL);
      url.searchParams.set('key', config.apiKey);
      url.searchParams.set('cx', config.googleCSEId);
      url.searchParams.set('q', input);
      url.searchParams.set('num', String(config.resultLimit));

      const response = await fetchImpl(url);
      if (!response.ok) {
        const details = await readGoogleErrorDetails(response, [config.apiKey]);
        console.warn('Google Custom Search request failed', {
          status: response.status,
          statusText: response.statusText ?? '',
          url: sanitizedGoogleSearchUrl(url),
          apiKeyConfigured: Boolean(config.apiKey),
          requestHasApiKeyParam: Boolean(url.searchParams.get('key')),
          requestHasCSEIdParam: Boolean(url.searchParams.get('cx')),
          googleCSEId: redactValue(config.googleCSEId),
          resultLimit: config.resultLimit,
          queryLength: String(input ?? '').length,
          ...details,
        });
        throw new Error(`Google custom search returned HTTP ${response.status}.${googleErrorSummary(details)}`);
      }

      const payload = await response.json();
      return JSON.stringify(mapGoogleApiItems(payload?.items));
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
  const link = compactText(item.link, MAX_LINK_LENGTH);
  const snippet = compactText(item.snippet, MAX_SNIPPET_LENGTH);

  if (!title && !link && !snippet) return null;
  return {
    rank: index + 1,
    title,
    link,
    snippet,
  };
}

export function parseGoogleSearchOutput(output, limit = DEFAULT_SEARCH_RESULT_LIMIT) {
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

export async function searchGoogleForContext({
  query,
  limit,
  env = process.env,
  searchTool,
  now = new Date(),
} = {}) {
  const searchQuery = normalizeQuery(query);
  const config = getGoogleSearchConfig(env);
  const resultLimit = clampResultLimit(limit, config.resultLimit);
  const base = {
    source: 'google-custom-search',
    query: searchQuery,
    timestamp: now.toISOString(),
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
      error: 'Google search is not configured.',
      missing: config.missing,
      results: [],
    };
  }

  try {
    const tool = searchTool ?? createGoogleSearchTool(config);
    const output = await invokeSearchTool(tool, searchQuery);
    const results = parseGoogleSearchOutput(output, resultLimit);
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
      error: `Google search failed: ${message}`,
      results: [],
    };
  }
}

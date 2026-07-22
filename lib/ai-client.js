const DEFAULT_PROVIDER = 'DEEPSEEK';
const SUPPORTED_PROVIDERS = new Set(['CLAUDE', 'DEEPSEEK']);

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEEPSEEK_MODEL_ALIASES = new Map([
  ['deepseek-v4-pro-thinking-search', 'deepseek-v4-pro'],
  ['deepseek-v4-pro-thinking', 'deepseek-v4-pro'],
  ['deepseek-v4-pro-search', 'deepseek-v4-pro'],
  ['deepseek-v4-flash-thinking-search', 'deepseek-v4-flash'],
  ['deepseek-v4-flash-thinking', 'deepseek-v4-flash'],
  ['deepseek-v4-flash-search', 'deepseek-v4-flash'],
]);

const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_CLAUDE_EXTRACTOR_MODEL = 'claude-3-5-haiku-20241022';
const DEFAULT_CLAUDE_VERSION = '2023-06-01';

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizeDeepSeekModel(value) {
  const model = String(value || '').trim();
  const normalized = DEEPSEEK_MODEL_ALIASES.get(model.toLowerCase());
  return normalized || model || DEFAULT_DEEPSEEK_MODEL;
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toUpperCase();
  return SUPPORTED_PROVIDERS.has(provider) ? provider : '';
}

function providerLabel(provider) {
  return provider === 'CLAUDE' ? 'Claude' : 'DeepSeek';
}

function parseBooleanEnv(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseListEnv(value) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function shouldEnableDeepSeekSearch({ searchEnabled, task } = {}) {
  if (searchEnabled === true) return true;
  if (searchEnabled === false) return false;
  if (parseBooleanEnv(readEnv('DEEPSEEK_SEARCH_ENABLE'))) return true;

  const taskName = String(task ?? '').trim().toLowerCase();
  if (!taskName) return false;
  const enabledTasks = parseListEnv(readEnv('DEEPSEEK_SEARCH_ENABLE_TASKS'));
  return enabledTasks.includes(taskName);
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with a conservative fenced/object extraction below.
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      return null;
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

export function getDeepSeekConfig() {
  const apiKey = readEnv('DEEPSEEK_API_KEY');
  const baseUrl = trimTrailingSlash(readEnv('DEEPSEEK_BASE_URL') || DEFAULT_DEEPSEEK_BASE_URL);
  const rawModel = readEnv('DEEPSEEK_MODEL');
  const model = normalizeDeepSeekModel(rawModel);

  return {
    provider: 'DEEPSEEK',
    apiKey,
    baseUrl,
    model,
    rawModel: rawModel || model,
    modelAliased: Boolean(rawModel && rawModel !== model),
    configured: Boolean(apiKey),
    missing: apiKey ? [] : ['DEEPSEEK_API_KEY'],
  };
}

export function getClaudeConfig({ task } = {}) {
  const apiKey = readEnv('CLAUDE_API_KEY');
  const baseUrl = trimTrailingSlash(readEnv('CLAUDE_BASE_URL') || DEFAULT_CLAUDE_BASE_URL);
  const defaultModel = task === 'extractor' ? DEFAULT_CLAUDE_EXTRACTOR_MODEL : DEFAULT_CLAUDE_MODEL;
  const model = task === 'extractor'
    ? readEnv('CLAUDE_EXTRACTOR_MODEL') || defaultModel
    : readEnv('CLAUDE_MODEL') || defaultModel;
  const anthropicVersion = readEnv('CLAUDE_ANTHROPIC_VERSION') || DEFAULT_CLAUDE_VERSION;

  return {
    provider: 'CLAUDE',
    apiKey,
    baseUrl,
    model,
    anthropicVersion,
    configured: Boolean(apiKey),
    missing: apiKey ? [] : ['CLAUDE_API_KEY'],
  };
}

export function getAiConfig({ task } = {}) {
  const rawProvider = readEnv('AI_MODEL_PROVIDER');
  const provider = normalizeProvider(rawProvider);
  if (!provider) {
    return {
      provider: rawProvider.toUpperCase(),
      providerValid: false,
      configured: false,
      missing: ['AI_MODEL_PROVIDER'],
      error: 'AI_MODEL_PROVIDER must be CLAUDE or DEEPSEEK.',
    };
  }

  return {
    providerValid: true,
    providerConfigured: Boolean(rawProvider),
    ...(provider === 'CLAUDE' ? getClaudeConfig({ task }) : getDeepSeekConfig()),
  };
}

export function getAiStatus() {
  const config = getAiConfig();
  return {
    provider: config.provider,
    providerConfigured: Boolean(readEnv('AI_MODEL_PROVIDER')),
    providerValid: config.providerValid !== false,
    configured: Boolean(config.configured),
    missing: config.missing ?? [],
    deepseek: {
      configured: Boolean(readEnv('DEEPSEEK_API_KEY')),
      baseUrlConfigured: Boolean(readEnv('DEEPSEEK_BASE_URL')),
      modelConfigured: Boolean(readEnv('DEEPSEEK_MODEL')),
    },
    claude: {
      configured: Boolean(readEnv('CLAUDE_API_KEY')),
      baseUrlConfigured: Boolean(readEnv('CLAUDE_BASE_URL')),
      modelConfigured: Boolean(readEnv('CLAUDE_MODEL')),
      extractorModelConfigured: Boolean(readEnv('CLAUDE_EXTRACTOR_MODEL')),
      versionConfigured: Boolean(readEnv('CLAUDE_ANTHROPIC_VERSION')),
    },
  };
}

function toClaudeMessages(messages) {
  const system = [];
  const converted = [];

  for (const message of messages) {
    const role = String(message?.role ?? '').toLowerCase();
    const content = typeof message?.content === 'string'
      ? message.content
      : JSON.stringify(message?.content ?? '');

    if (role === 'system') {
      system.push(content);
    } else if (role === 'assistant') {
      converted.push({ role: 'assistant', content });
    } else {
      converted.push({ role: 'user', content });
    }
  }

  return {
    system: system.join('\n\n'),
    messages: converted,
  };
}

function extractDeepSeekText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

function extractClaudeText(payload) {
  const parts = Array.isArray(payload?.content) ? payload.content : [];
  return parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

async function requestDeepSeekCompletion({
  config,
  messages,
  temperature,
  maxTokens,
  responseFormat,
  fetchImpl,
  searchEnabled,
}) {
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(searchEnabled ? { search_enable: true } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, error: `DeepSeek returned HTTP ${response.status}.`, details: body.slice(0, 500) };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: `DeepSeek returned invalid JSON: ${error.message}` };
  }

  return {
    ok: true,
    payload,
    text: extractDeepSeekText(payload),
    usage: payload.usage,
    provider: config.provider,
  };
}

async function requestClaudeCompletion({
  config,
  messages,
  maxTokens,
  fetchImpl,
}) {
  const claudePrompt = toClaudeMessages(messages);
  const response = await fetchImpl(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': config.anthropicVersion,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: claudePrompt.messages,
      ...(claudePrompt.system ? { system: claudePrompt.system } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, error: `Claude returned HTTP ${response.status}.`, details: body.slice(0, 500) };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: `Claude returned invalid JSON: ${error.message}` };
  }

  return {
    ok: true,
    payload,
    text: extractClaudeText(payload),
    usage: payload.usage,
    provider: config.provider,
  };
}

async function requestAiCompletion({
  messages,
  temperature = 0,
  maxTokens = 1200,
  responseFormat,
  task,
  fetchImpl = fetch,
  searchEnabled,
} = {}) {
  const config = getAiConfig({ task });
  const label = providerLabel(config.provider);

  if (config.providerValid === false) {
    return { ok: false, error: config.error, missing: config.missing, provider: config.provider };
  }

  if (!config.configured) {
    return { ok: false, error: `${label} is not configured.`, missing: config.missing, provider: config.provider };
  }

  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, error: `${label} messages are required.`, provider: config.provider };
  }

  try {
    if (config.provider === 'CLAUDE') {
      return await requestClaudeCompletion({
        config,
        messages,
        maxTokens,
        fetchImpl,
      });
    }

    return await requestDeepSeekCompletion({
      config,
      messages,
      temperature,
      maxTokens,
      responseFormat,
      fetchImpl,
      searchEnabled: shouldEnableDeepSeekSearch({ searchEnabled, task }),
    });
  } catch (error) {
    return { ok: false, error: `${label} request failed: ${error.message}`, provider: config.provider };
  }
}

export async function requestAiJson({ messages, temperature = 0, maxTokens = 1200, task, fetchImpl = fetch, searchEnabled } = {}) {
  const result = await requestAiCompletion({
    messages,
    temperature,
    maxTokens,
    responseFormat: { type: 'json_object' },
    task,
    fetchImpl,
    searchEnabled,
  });
  if (!result.ok) return result;

  const json = extractJsonObject(result.text);
  if (!json || Array.isArray(json)) {
    return { ok: false, error: `${providerLabel(result.provider)} response did not contain a JSON object.`, provider: result.provider };
  }

  return { ok: true, json, usage: result.usage, provider: result.provider };
}

export async function requestAiChat({ messages, temperature = 0.3, maxTokens = 900, fetchImpl = fetch, searchEnabled } = {}) {
  const result = await requestAiCompletion({
    messages,
    temperature,
    maxTokens,
    fetchImpl,
    searchEnabled,
  });
  if (!result.ok) return result;

  if (!result.text) {
    return { ok: false, error: `${providerLabel(result.provider)} response did not contain text.`, provider: result.provider };
  }

  return { ok: true, text: result.text, usage: result.usage, provider: result.provider };
}

export const requestDeepSeekJson = requestAiJson;
export const requestDeepSeekChat = requestAiChat;

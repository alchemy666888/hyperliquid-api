const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
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
  const baseUrl = trimTrailingSlash(readEnv('DEEPSEEK_BASE_URL') || DEFAULT_BASE_URL);
  const model = readEnv('DEEPSEEK_MODEL') || DEFAULT_MODEL;

  return {
    apiKey,
    baseUrl,
    model,
    configured: Boolean(apiKey),
    missing: apiKey ? [] : ['DEEPSEEK_API_KEY'],
  };
}

async function requestDeepSeekCompletion({
  messages,
  temperature = 0,
  maxTokens = 1200,
  responseFormat,
  fetchImpl = fetch,
} = {}) {
  const config = getDeepSeekConfig();
  if (!config.configured) {
    return { ok: false, error: 'DeepSeek is not configured.', missing: config.missing };
  }

  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, error: 'DeepSeek messages are required.' };
  }

  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
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
      }),
    });
  } catch (error) {
    return { ok: false, error: `DeepSeek request failed: ${error.message}` };
  }

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

  return { ok: true, payload };
}

export async function requestDeepSeekJson({ messages, temperature = 0, maxTokens = 1200, fetchImpl = fetch } = {}) {
  const result = await requestDeepSeekCompletion({
    messages,
    temperature,
    maxTokens,
    responseFormat: { type: 'json_object' },
    fetchImpl,
  });
  if (!result.ok) return result;

  const { payload } = result;
  const content = payload?.choices?.[0]?.message?.content;
  const json = typeof content === 'string' ? extractJsonObject(content) : null;
  if (!json || Array.isArray(json)) {
    return { ok: false, error: 'DeepSeek response did not contain a JSON object.' };
  }

  return { ok: true, json, usage: payload.usage };
}

export async function requestDeepSeekChat({ messages, temperature = 0.3, maxTokens = 900, fetchImpl = fetch } = {}) {
  const result = await requestDeepSeekCompletion({
    messages,
    temperature,
    maxTokens,
    fetchImpl,
  });
  if (!result.ok) return result;

  const { payload } = result;
  const content = payload?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    return { ok: false, error: 'DeepSeek response did not contain text.' };
  }

  return { ok: true, text, usage: payload.usage };
}

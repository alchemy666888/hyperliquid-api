const TELEGRAM_API_BASE = 'https://api.telegram.org';
const INSTALL_STATE = Symbol.for('hyperliquid.telegramLogForwarderInstalled');
const LOG_LEVELS = ['debug', 'log', 'info', 'warn', 'error'];
const MAX_TELEGRAM_TEXT_LENGTH = 3900;

function readEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function serializeLogValue(value) {
  if (value instanceof Error) {
    return [value.stack, value.message].filter(Boolean).join('\n');
  }

  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function truncateTelegramText(text) {
  if (text.length <= MAX_TELEGRAM_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TELEGRAM_TEXT_LENGTH - 32).trimEnd()}\n[Log message truncated.]`;
}

function buildLogMessage(level, args) {
  const body = args.map(serializeLogValue).join(' ');
  return truncateTelegramText([
    `Vercel log ${level.toUpperCase()}`,
    new Date().toISOString(),
    body || '(empty log message)',
  ].join('\n'));
}

async function sendTelegramLog({ token, chatId, text, fetchImpl }) {
  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram log sendMessage HTTP ${response.status}`);
  }
}

export function installTelegramLogForwarder({
  env = process.env,
  fetchImpl = globalThis.fetch,
  consoleObject = console,
} = {}) {
  const token = readEnv(env, 'TELEGRAM_BOT_TOKEN');
  const chatId = readEnv(env, 'TG_LOG_CHAT_ID');

  if (!token || !chatId || typeof fetchImpl !== 'function') return false;
  if (consoleObject[INSTALL_STATE]) return false;

  const originals = Object.fromEntries(
    LOG_LEVELS.map((level) => [level, consoleObject[level]?.bind(consoleObject) ?? (() => {})])
  );
  for (const level of LOG_LEVELS) {
    consoleObject[level] = (...args) => {
      originals[level](...args);

      const text = buildLogMessage(level, args);
      Promise.resolve(sendTelegramLog({ token, chatId, text, fetchImpl })).catch(() => {});
    };
  }

  consoleObject[INSTALL_STATE] = true;
  return true;
}

installTelegramLogForwarder();

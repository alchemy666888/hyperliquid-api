import {
  sanitizeTelegramHtml,
  TELEGRAM_PARSE_MODE_HTML,
} from './telegram-format.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export async function sendTelegramMessage(
  token,
  chatId,
  text,
  { parseMode, messageThreadId, replyToMessageId } = {}
) {
  const htmlParseMode = String(parseMode ?? '').toUpperCase() === TELEGRAM_PARSE_MODE_HTML;
  const payload = {
    chat_id: chatId,
    text: htmlParseMode ? sanitizeTelegramHtml(text) : text,
    disable_web_page_preview: true,
  };

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  if (messageThreadId != null) {
    payload.message_thread_id = messageThreadId;
  }

  if (replyToMessageId != null) {
    payload.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage HTTP ${response.status}: ${body}`);
  }
}

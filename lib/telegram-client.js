import {
  sanitizeTelegramHtml,
  splitTelegramHtml,
  splitTelegramText,
  TELEGRAM_PARSE_MODE_HTML,
} from './telegram-format.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

async function sendTelegramPayload(token, payload) {
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

export async function sendTelegramMessage(
  token,
  chatId,
  text,
  { parseMode, messageThreadId, replyToMessageId } = {}
) {
  const htmlParseMode = String(parseMode ?? '').toUpperCase() === TELEGRAM_PARSE_MODE_HTML;
  const chunks = htmlParseMode
    ? splitTelegramHtml(text)
    : splitTelegramText(text);

  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: htmlParseMode ? sanitizeTelegramHtml(chunk) : chunk,
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

    await sendTelegramPayload(token, payload);
  }
}

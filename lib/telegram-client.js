const TELEGRAM_API_BASE = 'https://api.telegram.org';

export async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage HTTP ${response.status}: ${body}`);
  }
}

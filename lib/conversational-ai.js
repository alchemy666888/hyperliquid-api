import { requestDeepSeekChat } from './deepseek-client.js';

const MAX_TELEGRAM_TEXT_LENGTH = 3900;

function trimTelegramText(value) {
  const text = String(value ?? '').trim();
  if (text.length <= MAX_TELEGRAM_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TELEGRAM_TEXT_LENGTH - 40).trimEnd()}\n\n[Reply shortened for Telegram.]`;
}

export async function answerStatelessAiChat({
  message,
  deepSeekChat = requestDeepSeekChat,
} = {}) {
  const currentMessage = String(message ?? '').trim();
  if (!currentMessage) {
    return {
      text: 'Send a message and I will answer using the current request only.',
    };
  }

  const result = await deepSeekChat({
    messages: [
      {
        role: 'system',
        content: [
          'You are a stateless AI assistant inside a Telegram bot.',
          'Answer the user naturally without requiring slash commands.',
          'Use only the current user request in this prompt.',
          'Do not refer to or infer previous conversation history, even if history is stored elsewhere.',
          'Do not use Markdown or HTML formatting. Reply in plain text only.',
          'Be concise enough for Telegram. If discussing markets or trades, be clear that you do not have live market context for no-command chat and that it is informational, not financial advice.',
          'The bot can also handle slash commands: /prices, /asset SYMBOL, /treealert, /condition SYMBOL, /alerts, /clearalerts.',
        ].join(' '),
      },
      {
        role: 'user',
        content: currentMessage,
      },
    ],
  });

  if (!result.ok) {
    return {
      text: [
        'AI chat unavailable.',
        result.error ?? 'DeepSeek could not answer right now.',
        'Check DEEPSEEK_API_KEY configuration or try again later.',
      ].join('\n'),
    };
  }

  return { text: trimTelegramText(result.text) };
}

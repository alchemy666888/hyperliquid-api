import { APP_TIME_ZONE, APP_TIME_ZONE_LABEL } from './timezone.js';

export const TELEGRAM_PARSE_MODE_HTML = 'HTML';
export const MAX_TELEGRAM_TEXT_LENGTH = 3900;

const TELEGRAM_HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
]);
const TELEGRAM_CODE_HTML_TAGS = new Set(['code', 'pre']);
const TELEGRAM_HTML_ENTITY_PATTERN = /&(?!#\d{1,7};|#x[\da-f]{1,6};|(?:lt|gt|amp|quot);)/gi;

const TELEGRAM_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeTelegramHtmlText(value) {
  return String(value ?? '')
    .replace(TELEGRAM_HTML_ENTITY_PATTERN, '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function sanitizeTelegramHtml(value) {
  const input = String(value ?? '');
  const tagPattern = /<\/?([a-z][a-z0-9]*)(?:\s[^>]*)?>/gi;
  let sanitized = '';
  let cursor = 0;
  let match;
  const openTags = [];

  while ((match = tagPattern.exec(input)) !== null) {
    sanitized += escapeTelegramHtmlText(input.slice(cursor, match.index));

    const rawTag = match[0];
    const tag = match[1].toLowerCase();
    const closing = rawTag.startsWith('</');
    const openCodeTag = openTags.at(-1);

    if (TELEGRAM_CODE_HTML_TAGS.has(openCodeTag) && !closing) {
      sanitized += escapeTelegramHtmlText(rawTag);
    } else if (TELEGRAM_HTML_TAGS.has(tag)) {
      if (closing) {
        const openIndex = openTags.lastIndexOf(tag);
        if (openIndex !== -1) {
          for (let i = openTags.length - 1; i >= openIndex; i -= 1) {
            sanitized += `</${openTags.pop()}>`;
          }
        } else if (TELEGRAM_CODE_HTML_TAGS.has(openCodeTag)) {
          sanitized += escapeTelegramHtmlText(rawTag);
        }
      } else {
        sanitized += `<${tag}>`;
        openTags.push(tag);
      }
    } else {
      sanitized += escapeTelegramHtmlText(rawTag);
    }

    cursor = match.index + rawTag.length;
  }

  sanitized += escapeTelegramHtmlText(input.slice(cursor));
  while (openTags.length) {
    sanitized += `</${openTags.pop()}>`;
  }

  return sanitized;
}

export function trimTelegramText(value, maxLength = MAX_TELEGRAM_TEXT_LENGTH) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 40).trimEnd()}\n\n[Reply shortened for Telegram.]`;
}

export function trimTelegramHtml(value, maxLength = MAX_TELEGRAM_TEXT_LENGTH) {
  const sanitized = sanitizeTelegramHtml(value).trim();
  if (sanitized.length <= maxLength) return sanitized;

  const suffix = '\n\n[Reply shortened for Telegram.]';
  let sliceLength = maxLength - 40;
  while (sliceLength > 0) {
    const candidate = sanitizeTelegramHtml(`${sanitized.slice(0, sliceLength).trimEnd()}${suffix}`);
    if (candidate.length <= maxLength) return candidate;
    sliceLength -= Math.max(1, candidate.length - maxLength + 8);
  }

  return sanitizeTelegramHtml(suffix.trim());
}

export function htmlMessage(text) {
  return {
    text: sanitizeTelegramHtml(text),
    parseMode: TELEGRAM_PARSE_MODE_HTML,
  };
}

export function formatTelegramDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  const parts = Object.fromEntries(
    TELEGRAM_DATE_FORMATTER.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${APP_TIME_ZONE_LABEL}`;
}

export function formatTelegramLocalDate(value) {
  const text = String(value ?? '').trim();
  const localMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  const includesOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);

  if (localMatch && !includesOffset) {
    const [, year, month, day, hours = '00', minutes = '00'] = localMatch;
    return `${year}-${month}-${day} ${hours}:${minutes} ${APP_TIME_ZONE_LABEL}`;
  }

  return formatTelegramDate(value);
}

export function telegramTableMessage(title, rows) {
  const normalizedRows = rows.map(row => Array.isArray(row)
    ? { label: row[0], value: row[1] }
    : row);
  const lines = [`<b>${escapeTelegramHtml(title)}</b>`];

  for (const row of normalizedRows) {
    if (row?.separator) {
      if (lines.at(-1) !== '') lines.push('');
      continue;
    }

    lines.push('');
    lines.push(`<b>${escapeTelegramHtml(row?.label)}</b>`);
    lines.push(escapeTelegramHtml(row?.value));
  }

  return htmlMessage(lines.join('\n'));
}

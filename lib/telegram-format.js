import { APP_TIME_ZONE, APP_TIME_ZONE_LABEL } from './timezone.js';

export const TELEGRAM_PARSE_MODE_HTML = 'HTML';

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

export function htmlMessage(text) {
  return {
    text,
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

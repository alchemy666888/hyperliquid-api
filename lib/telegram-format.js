export const TELEGRAM_PARSE_MODE_HTML = 'HTML';

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
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
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

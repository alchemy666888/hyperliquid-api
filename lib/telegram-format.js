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

function normalizeTableText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function wrapTableText(value, width) {
  const text = normalizeTableText(value);
  if (!text) return [''];

  const lines = [];
  let remaining = text;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(' ', width);
    if (breakAt <= 0) breakAt = width;
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  lines.push(remaining);
  return lines;
}

function padTableText(value, width) {
  const text = String(value ?? '');
  return `${text}${' '.repeat(Math.max(0, width - text.length))}`;
}

export function telegramTableMessage(title, rows, {
  labelWidth = 14,
  valueWidth = 58,
} = {}) {
  const normalizedRows = rows.map(row => Array.isArray(row)
    ? { label: row[0], value: row[1] }
    : row);
  const actualLabelWidth = Math.min(
    Math.max(labelWidth, ...normalizedRows.map(row => normalizeTableText(row.label).length)),
    22,
  );
  const actualValueWidth = valueWidth;
  const totalInnerWidth = actualLabelWidth + actualValueWidth + 3;
  const fullBorder = `+${'-'.repeat(totalInnerWidth + 2)}+`;
  const rowBorder = `+${'-'.repeat(actualLabelWidth + 2)}+${'-'.repeat(actualValueWidth + 2)}+`;
  const lines = [fullBorder];

  for (const titleLine of wrapTableText(title, totalInnerWidth)) {
    lines.push(`| ${padTableText(titleLine, totalInnerWidth)} |`);
  }

  lines.push(rowBorder);

  for (const row of normalizedRows) {
    if (row?.separator) {
      lines.push(rowBorder);
      continue;
    }

    const labelLines = wrapTableText(row?.label, actualLabelWidth);
    const valueLines = wrapTableText(row?.value, actualValueWidth);
    const lineCount = Math.max(labelLines.length, valueLines.length);

    for (let index = 0; index < lineCount; index += 1) {
      lines.push([
        '| ',
        padTableText(labelLines[index] ?? '', actualLabelWidth),
        ' | ',
        padTableText(valueLines[index] ?? '', actualValueWidth),
        ' |',
      ].join(''));
    }
  }

  lines.push(rowBorder);
  return htmlMessage(`<pre>${escapeTelegramHtml(lines.join('\n'))}</pre>`);
}

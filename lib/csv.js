/**
 * Shared CSV serialiser for report exports.
 *
 * Produces a header row followed by one line per row, using CRLF line endings
 * (the convention already used by the payroll register) and RFC 4180 quoting:
 * a cell containing a comma, quote, CR or LF is wrapped in double quotes and
 * its inner quotes are doubled.
 *
 * Spreadsheet formula injection is also neutralised: any cell whose text starts
 * with one of the formula-triggering characters `=`, `+`, `-`, `@` (or a tab /
 * carriage return) is prefixed with a single apostrophe. That keeps a hostile
 * value such as `=HYPERLINK(...)` inert when the CSV is opened in Excel or
 * Sheets, while leaving ordinary text untouched.
 */

/** Normalise `columns` to `{key, header}` pairs. */
function normaliseColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.map((column) =>
    typeof column === 'string'
      ? { key: column, header: column }
      : { key: column?.key, header: column?.header ?? column?.key },
  );
}

/** Escape one cell, including the formula-injection guard. */
function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialise `rows` to a CSV string.
 *
 * @param {Array<object>} rows objects keyed by the column keys
 * @param {Array<string|{key:string,header?:string}>} columns column keys, or
 *   objects supplying a key and an optional display header
 * @returns {string} the CSV text, ending with a CRLF
 */
export function rowsToCsv(rows, columns) {
  const cols = normaliseColumns(columns);
  const lines = [cols.map((column) => cell(column.header)).join(',')];
  for (const row of rows ?? []) {
    lines.push(cols.map((column) => cell(row?.[column.key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

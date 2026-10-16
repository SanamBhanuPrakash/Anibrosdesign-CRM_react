/**
 * Minimal RFC 4180 CSV reader/writer (no dependency, bounded).
 *
 * Reader: BOM, CRLF/LF, quoted fields with embedded newlines and "" escapes, delimiter sniffed from the header
 * (comma, semicolon or tab — Excel in many locales saves with semicolons). Unterminated quotes are an error rather
 * than silently swallowing the rest of the file.
 *
 * Writer: every cell that a spreadsheet could interpret as a formula (= + - @ TAB CR) is prefixed with an apostrophe,
 * which prevents CSV/formula injection when an exported file is opened in Excel or Sheets.
 */
export class CsvError extends Error {}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export function parseCsv(input: string, opts: { maxRows?: number; maxColumns?: number } = {}): ParsedCsv {
  const maxRows = opts.maxRows ?? 50_000;
  const maxColumns = opts.maxColumns ?? 60;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLine = text.slice(0, Math.max(0, text.search(/\r|\n/)) || text.length);
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
    if (row.length > maxColumns) throw new CsvError(`Too many columns (limit ${maxColumns})`);
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) records.push(row); // skip blank lines
    row = [];
    if (records.length > maxRows + 1) throw new CsvError(`Too many rows (limit ${maxRows})`);
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === delimiter) endField();
    else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (c === '\n') endRow();
    else field += c;
    i++;
  }
  if (inQuotes) throw new CsvError('The file ends inside a quoted value — check for a missing closing quote');
  if (field !== '' || row.length) endRow();

  const header = (records.shift() ?? []).map((h) => h.trim());
  if (!header.length || header.every((h) => !h)) throw new CsvError('The file has no header row');
  return { header, rows: records };
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('; ') : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // genuine numbers (e.g. -5) cannot be formulas
  return /[",\r\n;]/.test(s) || s.startsWith(' ') || s.endsWith(' ') ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

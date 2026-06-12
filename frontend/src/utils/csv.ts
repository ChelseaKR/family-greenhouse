/**
 * Characters that make spreadsheet apps (Excel, Sheets, LibreOffice)
 * interpret a cell as a formula. Per the OWASP CSV-injection mitigation we
 * prefix such cells with a single quote so they render as literal text
 * instead of executing (e.g. `=HYPERLINK(...)` exfiltration payloads).
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * CSV escaping per RFC 4180: wrap in double quotes if the value contains
 * a comma, quote, newline, or leading/trailing whitespace; double up any
 * embedded quotes. We always quote string fields to keep the format
 * predictable for spreadsheet imports.
 *
 * Additionally, cells starting with =, +, -, @, tab, or CR are prefixed
 * with a single quote to neutralize CSV/formula injection (OWASP).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_TRIGGER.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const head = headers.map(csvCell).join(',');
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  return body ? `${head}\n${body}\n` : `${head}\n`;
}

/**
 * Minimal RFC-4180 CSV parser (the read-side counterpart of `toCsv`).
 * Handles quoted fields containing commas, doubled quotes (`""` → `"`), and
 * embedded newlines; accepts both LF and CRLF row separators. Unquoted CRs
 * are treated as part of the row separator. Returns a grid of raw string
 * cells — no type coercion, no header handling (see `parseCsvObjects`).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      // Bare CR outside quotes is only meaningful as part of CRLF; drop it.
      field += c;
    }
  }
  // Flush the trailing row when the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Header-based CSV parsing: the first non-empty row is the header, every
 * following row becomes a `{header: cell}` record. Headers are trimmed and
 * lowercased so callers can match them case-insensitively; extra columns are
 * preserved under their (lowercased) names and short rows simply omit the
 * missing keys. Fully blank rows are dropped.
 */
export function parseCsvObjects(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const grid = parseCsv(text).filter((r) => r.some((cell) => cell.trim() !== ''));
  if (grid.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = grid[0].map((h) => h.trim().toLowerCase());
  const rows = grid.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, i) => {
      if (header && i < cells.length) {
        record[header] = cells[i];
      }
    });
    return record;
  });
  return { headers, rows };
}

/**
 * Undo the OWASP formula-injection escape `csvCell` applies on export
 * (`'=SUM(...)` → `=SUM(...)`), so our own exports round-trip through
 * import without a stray leading apostrophe. Only strips the apostrophe
 * when it guards a formula trigger — a name that genuinely starts with an
 * apostrophe is left alone.
 */
export function unescapeFormulaGuard(value: string): string {
  return FORMULA_TRIGGER.test(value.slice(1)) && value.startsWith("'") ? value.slice(1) : value;
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

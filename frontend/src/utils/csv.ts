/**
 * CSV escaping per RFC 4180: wrap in double quotes if the value contains
 * a comma, quote, newline, or leading/trailing whitespace; double up any
 * embedded quotes. We always quote string fields to keep the format
 * predictable for spreadsheet imports.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const head = headers.map(csvCell).join(',');
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  return body ? `${head}\n${body}\n` : `${head}\n`;
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

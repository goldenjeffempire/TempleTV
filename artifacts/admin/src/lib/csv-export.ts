/**
 * Tiny CSV export helper. Builds a CSV string from rows + columns and triggers
 * a browser download. RFC-4180 compliant escaping (double-quote any field that
 * contains a comma, quote, CR, or LF).
 */

export interface CsvColumn<T> {
  header: string;
  /** Returns the cell value (anything coercible to string). null/undefined → empty cell. */
  value: (row: T) => string | number | boolean | null | undefined;
}

function escapeCell(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = String(raw);
  // CSV-injection guard: Excel / Sheets / Numbers will *evaluate* a cell whose
  // first character is `=`, `+`, `-`, `@`, tab, or CR as a formula. Prefixing
  // with a single quote neutralises the formula while remaining invisible
  // when the file is opened by a human. See OWASP "CSV Injection".
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows
    .map((row) => columns.map((c) => escapeCell(c.value(row))).join(","))
    .join("\r\n");
  return `${head}\r\n${body}`;
}

/**
 * Triggers a browser download of `csv` content as `<filename>.csv`.
 * Filename is sanitised; `.csv` is appended if missing. Uses a hidden <a>
 * element + Blob URL, then revokes the object URL on next tick.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === "undefined") return;
  const safe =
    filename.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "export";
  const name = safe.toLowerCase().endsWith(".csv") ? safe : `${safe}.csv`;
  // Prepend BOM so Excel reads UTF-8 correctly on Windows.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportRowsAsCsv<T>(
  filename: string,
  rows: T[],
  columns: CsvColumn<T>[],
): void {
  downloadCsv(filename, buildCsv(rows, columns));
}

/**
 * Tiny RFC-4180 CSV for the benchmark scripts (bench/score.mjs, gates.mjs): a quoted field may
 * hold commas, doubled quotes and line breaks; CRLF and LF both end a record; a leading UTF-8
 * BOM is dropped; blank lines are skipped. No streaming and no type coercion — gates.mjs types
 * the columns. Round-trips what scripts/lib/bench/session.mjs csvEscape() writes.
 */

/** Parses CSV text into rows of string cells. */
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let atCellStart = true;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
    atCellStart = true;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      atCellStart = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
      atCellStart = false;
    }
  }
  if (cell !== "" || row.length) endRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Parses CSV text into { header, records }: each record maps a header name to its cell ("" when short). */
export function parseRecords(text) {
  const [header = [], ...rest] = parseCsv(text);
  const cols = header.map((h) => h.trim());
  const records = rest.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
  return { header: cols, records };
}

/** One CSV cell: undefined/null → empty; booleans → 1/0; quoted when it holds a comma, quote or line break. */
export function csvQuote(value) {
  if (value === undefined || value === null) return "";
  const s = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header + rows (cell arrays, or objects read through the header) as CSV text ending in "\n". */
export function serializeCsv(header, rows = []) {
  const line = (cells) => cells.map(csvQuote).join(",");
  const body = rows.map((r) => line(Array.isArray(r) ? r : header.map((c) => r?.[c])));
  return [line(header), ...body].join("\n") + "\n";
}

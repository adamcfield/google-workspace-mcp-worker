// Runs sheets_audit_spreadsheet once on a generated tab and prints {ms, formulas, errorCount,
// warningCount, replyChars} as JSON. tests/sheets-analysis.test.ts starts it in a child node with a capped heap
// (--max-old-space-size), so a run that needs more memory than that dies instead of printing.
//   node --max-old-space-size=128 tests/helpers/audit-heap.mjs <bundled sheets-analysis.mjs> <fixture>
import { pathToFileURL } from "node:url";

const [bundle, fixture] = process.argv.slice(2);
const { sheetsAnalysisTools } = await import(pathToFileURL(bundle).href);
const audit = sheetsAnalysisTools.find((t) => t.name === "sheets_audit_spreadsheet");

const formula = (f) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: { numberValue: 0 }, formattedValue: "0" });
const col = (n) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
/** =SUM of 40 two-cell ranges along row r, from column `from` on: about 330 characters, a different text in every row. */
const sum40 = (r, from) => "=SUM(" + Array.from({ length: 40 }, (_, i) => `${col(from + 2 * i)}${r}:${col(from + 2 * i + 1)}${r}`).join(",") + ")";
/** 300 formulas of about 49,000 characters, each a sum of about 4,000 two-cell ranges no other formula reads. */
function dense(gap) {
  const rows = [];
  let k = 0;
  for (let c = 0; c < 300; c++) {
    const parts = [];
    for (let len = 1; ; k++) {
      const column = col(1000 + (k % 5000)), row = 1 + 2 * Math.floor(k / 5000);
      const t = `${column}${row}:${column}${row + 1}`;
      if ((len += t.length + 1) > 49_000) break;
      parts.push(t);
    }
    rows.push({ values: [formula("=" + parts.join("+"))] });
    if (gap) rows.push({ values: [] });
  }
  return rows;
}

/**
 * `cells` formulas of about 49,000 characters beside a 100 × 100 block of numbers, each a sum of
 * about 7,000 distinct two-cell ranges inside the block (=A1:A2+A3:B3+…) with more numbers after
 * each: every range stops short, so every formula is a finding with about 7,000 short ranges.
 */
function shortRanges(cells) {
  const number = (v) => ({ userEnteredValue: { numberValue: v }, effectiveValue: { numberValue: v }, formattedValue: String(v) });
  const candidates = [];
  for (let r = 1; r <= 98; r++)
    for (let c = 1; c <= 98; c++) candidates.push(`${col(c)}${r}:${col(c)}${r + 1}`, `${col(c)}${r}:${col(c + 1)}${r}`);
  const rows = [];
  for (let r = 1; r <= 2 * cells; r++) {
    const values = r <= 100 ? Array.from({ length: 100 }, (_, c) => number(r + c)) : [];
    if (r % 2) {
      const parts = [];
      for (let k = (r * 131) % candidates.length, len = 1; ; k = (k + 1) % candidates.length) {
        if ((len += candidates[k].length + 1) > 49_000) break;
        parts.push(candidates[k]);
      }
      while (values.length < 149) values.push({});
      values.push(formula("=" + parts.join("+")));
    }
    rows.push({ values });
  }
  return rows;
}

/** `cells` #REF! formulas of about 49,000 characters, each naming about 6,000 sheets that do not exist (=s0!A1+s1!A1+…). */
function missingSheets(cells) {
  const rows = [];
  let k = 0;
  for (let c = 0; c < cells; c++) {
    const parts = [];
    for (let len = 1; ; k++) {
      const t = `s${k}!A1`;
      if ((len += t.length + 1) > 49_000) break;
      parts.push(t);
    }
    const f = { userEnteredValue: { formulaValue: "=" + parts.join("+") }, effectiveValue: { errorValue: { type: "REF", message: `Unresolved sheet name '${parts[0].split("!")[0]}'.` } }, formattedValue: "#REF!" };
    rows.push({ values: [f] }, { values: [] });
  }
  return rows;
}

const FIXTURES = {
  // 20,000 formulas on every other row, each a 40-range SUM of its own row.
  sums: () => Array.from({ length: 40_000 }, (_, i) => ({ values: i % 2 ? [] : [formula(sum40(i + 1, 2))] })),
  // A relative fill-down of that SUM, 20,000 rows × 2 columns.
  fill: () => Array.from({ length: 20_000 }, (_, i) => ({ values: [formula(sum40(i + 1, 3)), formula(sum40(i + 1, 3))] })),
  // The 49,000-character sums, a blank row between them, and down one column with none.
  dense: () => dense(true),
  adjacent: () => dense(false),
  // 150 of those formulas, on every other row of one column.
  short: () => shortRanges(150),
  // 700 of the missing-sheet formulas, a blank row between them.
  missing: () => missingSheets(700),
};

const rowData = FIXTURES[fixture]();
const sheets = [{ properties: { sheetId: 0, title: "Big" }, data: [{ rowData }] }];
const meta = { sheets: [{ properties: { sheetId: 0, title: "Big" } }], namedRanges: [] };
const g = { get: async (_url, params) => (params?.includeGridData ? { sheets } : meta) };
const t0 = performance.now();
const r = await audit.handler({ spreadsheet_id: "sid", detail: "summary", max_findings: 200 }, { g, readOnly: false, grantedScopes: [] });
const ms = Math.round(performance.now() - t0);
console.log(JSON.stringify({ ms, formulas: r.formulas, errorCount: r.errorCount, warningCount: r.warningCount, replyChars: JSON.stringify(r).length }));

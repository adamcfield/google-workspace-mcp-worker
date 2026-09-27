import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { sheetsAnalysisTools, gridErrors, loadGrids } from "../src/tools/sheets-analysis.js";
import { strip } from "../src/tools/_shared.js";
import { colToLetters as colLetters } from "../src/tools/sheets-a1.js";

const byName = (n: string) => sheetsAnalysisTools.find((t) => t.name === n)!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [] });

const num = (n: number) => ({ userEnteredValue: { numberValue: n }, effectiveValue: { numberValue: n }, formattedValue: String(n) });
const str = (s: string) => ({ userEnteredValue: { stringValue: s }, effectiveValue: { stringValue: s }, formattedValue: s });
const formula = (f: string, v: number | string) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: typeof v === "number" ? { numberValue: v } : { stringValue: v }, formattedValue: String(v) });
const err = (f: string, type: string, message: string) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: { errorValue: { type, message } }, formattedValue: `#${type}` });
const empty = {};

/**
 * Data sheet:
 *      A        B            C
 * 1   Item     Amount       Double
 * 2   x        10           =B2*2
 * 3   y        20           =B3*2
 * 4   z        30           =B3*2      <- inconsistent (should be B4)
 * 5   w        40           =B5*2
 * 6            =SUM(B2:B4)             <- range stops before B5
 * 7            =1/0                    <- error
 * 8            =Missing!A1             <- missing sheet
 * 9            =B9+1                   <- circular
 * Summary sheet: A1 =SUM(Data!B2:B5), B1 =A1*Rate  (Rate = named range Data!B2)
 */
const gridResponse = {
  sheets: [
    {
      properties: { sheetId: 0, title: "Data" },
      data: [
        {
          rowData: [
            { values: [str("Item"), str("Amount"), str("Double")] },
            { values: [str("x"), num(10), formula("=B2*2", 20)] },
            { values: [str("y"), num(20), formula("=B3*2", 40)] },
            { values: [str("z"), num(30), formula("=B3*2", 40)] },
            { values: [str("w"), num(40), formula("=B5*2", 80)] },
            { values: [empty, formula("=SUM(B2:B4)", 60)] },
            { values: [empty, err("=1/0", "DIVIDE_BY_ZERO", "Function DIVIDE parameter 2 cannot be zero.")] },
            { values: [empty, err("=Missing!A1", "REF", "Unresolved sheet name 'Missing'.")] },
            { values: [empty, err("=B9+1", "REF", "Circular dependency detected. To resolve with iterative calculation, see File > Settings.")] },
          ],
        },
      ],
    },
    {
      properties: { sheetId: 1, title: "Summary" },
      data: [{ rowData: [{ values: [formula("=SUM(Data!B2:B5)", 100), formula("=A1*Rate", 1000)] }] }],
    },
  ],
};
const metaResponse = {
  sheets: [
    { properties: { sheetId: 0, title: "Data", gridProperties: { rowCount: 100, columnCount: 26 } } },
    { properties: { sheetId: 1, title: "Summary", gridProperties: { rowCount: 100, columnCount: 26 } } },
  ],
  namedRanges: [{ name: "Rate", range: { sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 } }],
};

function fakeClient(route: (url: string, params: any) => any) {
  const calls: { url: string; params: any }[] = [];
  return {
    calls,
    g: {
      get: async (url: string, params?: any) => {
        calls.push({ url, params });
        return route(url, params);
      },
    } as any,
  };
}
const gridOrMeta = (url: string, params: any) => (params?.includeGridData ? gridResponse : metaResponse);

describe("sheets_audit_spreadsheet", () => {
  it("finds errors, circular refs, missing sheets, inconsistent formulas and ranges stopping before data", async () => {
    const { g } = fakeClient(gridOrMeta);
    const r: any = await byName("sheets_audit_spreadsheet").handler({ spreadsheet_id: "sid", detail: "findings", max_findings: 200 }, ctx(g));
    expect(r.sheets).toEqual(["Data", "Summary"]);
    expect(r.summary).toEqual({ errorCells: 3, circularReferences: 1, missingSheetRefs: 1, inconsistentFormulas: 1, rangesStoppingBeforeData: 1 });
    expect(r.errors.items.map((e: any) => e.cell)).toEqual(["Data!B7", "Data!B8", "Data!B9"]);
    expect(r.errors.items[2]).toMatchObject({ circular: true, formula: "=B9+1" });
    expect(r.missingSheetRefs.items[0]).toEqual({ cell: "Data!B8", formula: "=Missing!A1", missingSheets: ["Missing"] });
    expect(r.inconsistentFormulas.items[0]).toEqual({ cell: "Data!C4", formula: "=B3*2", differsFrom: { column: "C2 =B2*2" } });
    expect(r.rangesStoppingBeforeData.items[0]).toEqual({ cell: "Data!B6", formula: "=SUM(B2:B4)", dataBeyondRange: { "Data!B2:B4": ["B5"] }, missedCells: 1 });
  });

  it("severity: ok means no errors, and errorCount/warningCount count cells (a #REF! naming a missing sheet is one error)", async () => {
    const { g } = fakeClient(gridOrMeta);
    const r: any = await byName("sheets_audit_spreadsheet").handler({ spreadsheet_id: "sid", detail: "summary", max_findings: 200 }, ctx(g));
    // Data!B8 is both an error cell (#REF!) and a missing-sheet reference: 3 error cells, not 4.
    expect([r.ok, r.errorCount, r.warningCount]).toEqual([false, 3, 2]);
    // `errors` is the LIST of error cells, as in release/1.6 and in the write tools' verification;
    // the counts are errorCount/warningCount and `summary`, never a number under `errors`.
    expect(r.errors.items[0]).toEqual({ cell: "Data!B7", formula: "=1/0", error: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." });
    expect(r.errors.items).toHaveLength(r.summary.errorCells);
    expect([r.errorCells, r.warnings]).toEqual([undefined, undefined]);
    // Warnings alone do not make a spreadsheet unhealthy.
    const w = await audit([tab("Sales", 0, [["Month", "Units"], ["Jan", 10], ["Feb", 20], ["Mar", 30], ["Total", "=SUM(B2:B3)"]])]);
    expect([w.ok, w.errorCount, w.warningCount]).toEqual([true, 0, 1]);
    expect(w.errors).toBeUndefined(); // strip() drops the empty list; errorCount says 0
  });

  it("errors are gridErrors of each tab, in tab order — the one list sheets_delete_sheet's post-check reports too", async () => {
    const { g } = fakeClient(gridOrMeta);
    const r: any = await byName("sheets_audit_spreadsheet").handler({ spreadsheet_id: "sid", detail: "findings", max_findings: 200 }, ctx(g));
    const grids = await loadGrids(g, "sid");
    expect(r.errors.items).toEqual(grids.flatMap((x) => gridErrors(x)));
    // Field for field what the audit's own loop listed before it called gridErrors (and release/1.6 lists).
    expect(r.errors.items).toEqual([
      { cell: "Data!B7", formula: "=1/0", error: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." },
      { cell: "Data!B8", formula: "=Missing!A1", error: "REF", message: "Unresolved sheet name 'Missing'." },
      { cell: "Data!B9", formula: "=B9+1", error: "REF", message: "Circular dependency detected. To resolve with iterative calculation, see File > Settings.", circular: true },
    ]);
    // A value cell showing an error (no formula) is listed too, without a formula.
    const plain = { ...err("=1/0", "N/A", "No value."), userEnteredValue: { stringValue: "#N/A" } };
    const one = await audit([{ properties: { sheetId: 0, title: "V" }, data: [{ rowData: [{ values: [plain] }] }] }]);
    expect(one.errors.items).toEqual([{ cell: "V!A1", error: "N/A", message: "No value." }]);
  });

  it("caps findings per category", async () => {
    const { g } = fakeClient(gridOrMeta);
    const r: any = await byName("sheets_audit_spreadsheet").handler({ spreadsheet_id: "sid", detail: "findings", max_findings: 1 }, ctx(g));
    expect(r.errors).toEqual({ items: [expect.objectContaining({ cell: "Data!B7" })], truncated: 2 });
  });

  it("defaults to the summary when detail is not passed", async () => {
    const r = await audit(WIDE, { detail: undefined });
    expect(r.inconsistentFormulas.items).toHaveLength(10);
    expect(r.note).toMatch(/detail=findings/);
  });
});

// ---- realistic model layouts (QA: "0 errors, alongside 43 'inconsistent formula' and 63 'range
// stops before data' warnings, almost all false alarms on total rows, headers and fixed-size
// ranges"). Every layout below produced false warnings before; each test names the cells.

type Spec = number | string | null | [string, number | string];
/** number → typed number; "=…" → formula showing 0; [formula, shown] → formula showing that; other string → text; null → blank. */
const cellOf = (x: Spec) => (x === null ? empty : typeof x === "number" ? num(x) : Array.isArray(x) ? formula(x[0], x[1]) : x.startsWith("=") ? formula(x, 0) : str(x));
const tab = (title: string, sheetId: number, rows: Spec[][]) => ({ properties: { sheetId, title }, data: [{ rowData: rows.map((r) => ({ values: r.map(cellOf) })) }] });
const metaFor = (sheets: any[]) => ({ sheets: sheets.map((s) => ({ properties: s.properties })), namedRanges: [] });

/** Run the audit over these tabs and return what a client reads: strip() + JSON, parsed back. */
async function audit(sheets: any[], args: Record<string, unknown> = {}, meta: any = metaFor(sheets)) {
  const { g } = fakeClient((_url, params) => (params?.includeGridData ? { sheets } : meta));
  const r = await byName("sheets_audit_spreadsheet").handler({ spreadsheet_id: "sid", detail: "summary", max_findings: 200, ...args }, ctx(g));
  return JSON.parse(JSON.stringify(strip(r))) as any;
}
const cells = (list: any) => (list?.items ?? []).map((f: any) => f.cell);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const M = "BCDEFGHIJKLM".split(""); // Jan..Dec
const quarters = (r: number): Spec[] => [`=SUM(B${r}:D${r})`, `=SUM(E${r}:G${r})`, `=SUM(H${r}:J${r})`, `=SUM(K${r}:M${r})`];

/**
 * A monthly budget: months B..M, a Total column N (=SUM of the row), quarterly subtotals P..S,
 * a Total-opex row (=SUM of the rows above) and revenue that grows month on month from a seed
 * pulled off an Inputs tab. Tab name in Hebrew, as in the QA session.
 */
const BUDGET = tab("תקציב 2026", 0, [
  ["Line item", ...MONTHS, "Total", null, "Q1", "Q2", "Q3", "Q4"],
  ["Revenue", ["=Inputs!B2", 1000], ...M.slice(1).map((c, i): Spec => [`=${M[i]}2*1.05`, 1050]), "=SUM(B2:M2)", null, ...quarters(2)],
  ["COGS", ...M.map((c): Spec => `=${c}2*0.4`), "=SUM(B3:M3)", null, ...quarters(3)],
  ["Salaries", ...M.map((): Spec => 500), "=SUM(B4:M4)", null, ...quarters(4)],
  ["Rent", ...M.map((): Spec => 200), "=SUM(B5:M5)", null, ...quarters(5)],
  ["Marketing", ...M.map((): Spec => 100), "=SUM(B6:M6)", null, ...quarters(6)],
  ["Total opex", ...M.map((c): Spec => `=SUM(${c}4:${c}6)`), "=SUM(B7:M7)", null, ...quarters(7)],
  ["Net", ...M.map((c): Spec => `=${c}2-${c}3-${c}7`), "=SUM(B8:M8)", null, ...quarters(8)],
]);
const INPUTS = tab("Inputs", 1, [["Revenue start"], [null, 1000]]);

/**
 * A line-item table: a computed header (D1 builds "Amount (USD)" from G1), Amount = Qty × Price
 * filled down with ONE broken cell (D7 reads B6, the row above), a running balance seeded by E2
 * =D2, a Total row, and an item count whose range ends right before the "Total" label.
 */
const itemRows: Spec[][] = [["Item", "Qty", "Price", ['="Amount ("&$G$1&")"', "Amount (USD)"], "Running", null, "USD"]];
for (let r = 2; r <= 9; r++) {
  const d: Spec = r === 7 ? ["=B6*C7", 60] : [`=B${r}*C${r}`, 20 * r];
  const e: Spec = r === 2 ? ["=D2", 40] : [`=E${r - 1}+D${r}`, 40 * r];
  itemRows.push([`item ${r - 1}`, r, 10, d, e, null, null, r === 2 ? ["=COUNTA(A2:A9)", 8] : null]);
}
itemRows.push(["Total", null, null, ["=SUM(D2:D9)", 700]]);
const ITEMS = tab("Items", 2, itemRows);

/**
 * Monthly actuals with a share-of-total column over the fixed range $B$2:$B$13, a 3-month moving
 * average (sliding windows), two forecast rows (formulas) right after the actuals, the actuals'
 * total, then a second block with its own text header and subtotal.
 */
const planRows: Spec[][] = [["Month", "Units", "Share", "3-mo avg"]];
for (let r = 2; r <= 13; r++) planRows.push([MONTHS[r - 2], 90 + 10 * r, `=B${r}/SUM($B$2:$B$13)`, r >= 4 ? `=AVERAGE(B${r - 2}:B${r})` : null]);
planRows.push(["Jan (forecast)", "=B13*1.05"], ["Feb (forecast)", "=B14*1.05"], ["Actual total", "=SUM(B2:B13)"], [], ["Costs", "Amount"], ["Rent", 50], ["Travel", 20], ["Costs total", "=SUM(B19:B20)"]);
const PLAN = tab("Plan", 3, planRows);

/** Two blocks in one column, each with a text header, summarised underneath. */
const BLOCKS = tab("Blocks", 4, [
  ["Revenue", "Amount"],
  ["Product A", 100],
  ["Product B", 200],
  ["Product C", 300],
  ["Costs", "Amount"],
  ["Rent", 50],
  ["Travel", 20],
  [],
  ["Revenue", "=SUM(B2:B4)"],
  ["Costs", "=SUM(B6:B7)"],
  ["Net", "=B9-B10"],
  ["Products", "=COUNTA(A2:A4)"],
]);

/** The real thing: a total whose fixed range stops one month short — B10 is a plain number the total leaves out. */
const salesRows: Spec[][] = [["Month", "Units"]];
for (let r = 2; r <= 10; r++) salesRows.push([MONTHS[r - 2], 10 * (r - 1)]);
salesRows.push(["Total", ["=SUM(B2:B9)", 360]]);
const SALES = tab("Sales", 5, salesRows);

/**
 * Two tables side by side, a blank column apart. A:B has ten months (Jan..Oct) and a Total in B12
 * that stops at Sep, leaving out B11; G2 counts the months with the same short range. D:E has nine
 * months and its own, correct Total in row 11, level with A:B's Oct.
 */
const sideRows: Spec[][] = [["Month", "Units", null, "Month", "Units", null, "Months"]];
for (let r = 2; r <= 10; r++) sideRows.push([MONTHS[r - 2], 10 * r, null, MONTHS[r - 2], 5 * r, null, r === 2 ? ["=COUNTA(A2:A10)", 9] : null]);
sideRows.push([MONTHS[9], 110, null, "Total", ["=SUM(E2:E10)", 270]]);
sideRows.push(["Total", ["=SUM(B2:B10)", 540]]);
const SIDE = tab("Side", 6, sideRows);

/** Cash: a year-to-date column C =SUM($B$2:Bn) beside twelve months, plus a cumulative row along row 16 (=SUM($B$15:C15) in C16). */
const cashRows: Spec[][] = [["Month", "Amount", "YTD"]];
for (let r = 2; r <= 13; r++) cashRows.push([MONTHS[r - 2], 100 * r, `=SUM($B$2:B${r})`]);
cashRows.push([], ["Amount", ...M.map((_, i): Spec => 10 * (i + 1))], ["Cumulative", ...M.map((c): Spec => `=SUM($B15:${c}15)`)]);
const CASH = tab("Cash", 7, cashRows);
/** A report tab listing Cash's year-to-date three rows lower, without anchors: =SUM(Cash!B2:B3) in B6, …, =SUM(Cash!B2:B13) in B16. */
const reportRows: Spec[][] = [["YTD report"], [], [], ["Month", "YTD"]];
for (let r = 5; r <= 16; r++) reportRows.push([MONTHS[r - 5], `=SUM(Cash!B2:B${r - 3})`]);
const REPORT = tab("Report", 8, reportRows);

/**
 * A line-item table whose Total row sums most columns but AVERAGEs the price, and a monthly budget
 * whose Year column sums every line but AVERAGEs the margin %.
 */
const totRows: Spec[][] = [["Item", "Qty", "Price", "Amount", "Discount"]];
for (let r = 2; r <= 9; r++) totRows.push([`item ${r - 1}`, r, 10 + r, `=B${r}*C${r}`, `=D${r}*0.1`]);
const totalsRow = (d = "=SUM(D2:D9)"): Spec[] => ["Total", "=SUM(B2:B9)", "=AVERAGE(C2:C9)", d, "=SUM(E2:E9)"];
const TOT = tab("Tot", 9, [...totRows, totalsRow()]);
const yearRows: Spec[][] = [["Line", ...MONTHS, "Year"]];
["Revenue", "Costs", "Margin %", "Heads", "Other"].forEach((label, i) => {
  const r = i + 2;
  yearRows.push([label, ...M.map((): Spec => 100 + r), label === "Margin %" ? `=AVERAGE(B${r}:M${r})` : `=SUM(B${r}:M${r})`]);
});
const YEAR = tab("Year", 10, yearRows);

describe("sheets_audit_spreadsheet: signal on a realistic model", () => {
  it("a clean model with one broken fill-down and one short total: 0 errors, exactly those 2 warnings", async () => {
    const r = await audit([BUDGET, INPUTS, ITEMS, PLAN, BLOCKS, SALES]);
    expect([r.ok, r.errorCount, r.warningCount]).toEqual([true, 0, 2]);
    expect(r.summary).toEqual({ errorCells: 0, circularReferences: 0, missingSheetRefs: 0, inconsistentFormulas: 1, rangesStoppingBeforeData: 1 });
    expect(r.inconsistentFormulas.items).toEqual([{ cell: "Items!D7", formula: "=B6*C7", differsFrom: { column: "D2 =B2*C2" } }]);
    expect(r.rangesStoppingBeforeData.items).toEqual([{ cell: "Sales!B11", formula: "=SUM(B2:B9)", dataBeyondRange: { "Sales!B2:B9": ["B10"] }, missedCells: 1 }]);
    expect(r.note).toBeUndefined();
  });

  it("totals rows and columns are not inconsistent formulas", async () => {
    const r = await audit([BUDGET, INPUTS, ITEMS, PLAN], { detail: "findings" });
    const flagged = cells(r.inconsistentFormulas);
    // The totals column at each row's right edge (=SUM(B2:M2) after =B2*1.05 …) …
    for (const c of ["N2", "N3", "N7", "N8"]) expect(flagged).not.toContain(`'תקציב 2026'!${c}`);
    // … and the Total row under a column of formulas.
    expect(flagged).not.toContain("Items!D10");
    expect(flagged).not.toContain("Plan!B16");
    // Taking the total out of the run still leaves the real break visible.
    expect(flagged).toEqual(["Items!D7"]);
  });

  it("a formula heading a column, or seeding a recurrence under a header, is not inconsistent", async () => {
    const r = await audit([BUDGET, INPUTS, ITEMS], { detail: "findings" });
    const flagged = cells(r.inconsistentFormulas);
    expect(flagged).not.toContain("Items!D1"); // ="Amount ("&$G$1&")" over =B2*C2 …
    expect(flagged).not.toContain("Items!E2"); // =D2 under "Running", then =E2+D3 …
    expect(flagged).not.toContain("'תקציב 2026'!B2"); // =Inputs!B2 after the "Revenue" label, then =B2*1.05 …
  });

  it("text headers after a block are not data a range stops before", async () => {
    const r = await audit([BLOCKS], { detail: "findings" });
    // =SUM(B2:B4) with B5 = "Amount" (the next block's header); =COUNTA(A2:A4) with A5 = "Costs".
    expect([r.warningCount, r.rangesStoppingBeforeData]).toEqual([0, undefined]);
  });

  it("a fixed-size range followed by its total or another formula does not stop before data", async () => {
    const r = await audit([PLAN, ITEMS], { detail: "findings" });
    // =B2/SUM($B$2:$B$13) … (B14 is a forecast formula), =SUM(B2:B13) in B16, =COUNTA(A2:A9) with the Total row after it.
    expect(r.rangesStoppingBeforeData).toBeUndefined();
  });

  it("partitions and sliding windows end where they do on purpose", async () => {
    const r = await audit([BUDGET, INPUTS, PLAN], { detail: "findings" });
    // Q1 =SUM(B4:D4) is followed by Q2 =SUM(E4:G4); =AVERAGE(B2:B4) by =AVERAGE(B3:B5).
    expect(r.rangesStoppingBeforeData).toBeUndefined();
    expect(r.warningCount).toBe(0);
  });

  it("still flags a broken fill-down in the middle of a run, and a total that stops one row short", async () => {
    const r = await audit([ITEMS, SALES], { detail: "findings" });
    expect(cells(r.inconsistentFormulas)).toEqual(["Items!D7"]);
    expect(cells(r.rangesStoppingBeforeData)).toEqual(["Sales!B11"]);
    // Same shape elsewhere: a share-of-total over $B$2:$B$9 while B10 is plain data.
    const share = await audit([tab("Sales", 0, [...salesRows.slice(0, 9), ["Sep", 90, "=B10/SUM($B$2:$B$9)"]])]);
    expect(share.rangesStoppingBeforeData.items).toEqual([{ cell: "Sales!C10", formula: "=B10/SUM($B$2:$B$9)", dataBeyondRange: { "Sales!B2:B9": ["B10"] }, missedCells: 1 }]);
  });

  it("a moving-average column over the same data does not excuse a total that stops short", async () => {
    // Review: the partition rule took its evidence from every range in the spreadsheet, so the
    // window C15 =AVERAGE(B13:B15), which starts right after B12, made Plan!B16 =SUM(B2:B12)
    // (B13 a plain number) look like the first block of a partition. release/1.6 flags it.
    const want = [{ cell: "Plan!B16", formula: "=SUM(B2:B12)", dataBeyondRange: { "Plan!B2:B12": ["B13"] }, missedCells: 1 }];
    const plan = (withAverage: boolean) => {
      const rows: Spec[][] = [["Month", "Units", "3-mo avg"]];
      for (let r = 2; r <= 13; r++) rows.push([MONTHS[r - 2], 90 + 10 * r, withAverage && r >= 4 ? `=AVERAGE(B${r - 2}:B${r})` : null]);
      rows.push(["Jan (forecast)", "=B13*1.05", withAverage ? "=AVERAGE(B12:B14)" : null], ["Feb (forecast)", "=B14*1.05", withAverage ? "=AVERAGE(B13:B15)" : null]);
      rows.push(["Actual total", "=SUM(B2:B12)"]);
      return tab("Plan", 3, rows);
    };
    for (const withAverage of [true, false]) {
      const r = await audit([plan(withAverage)], { detail: "findings" });
      expect([r.ok, r.errorCount, r.warningCount], `average column: ${withAverage}`).toEqual([true, 0, 1]);
      expect(r.rangesStoppingBeforeData.items, `average column: ${withAverage}`).toEqual(want);
    }
    // A total leaving out Q4 (B11:B13 plain) is flagged the same with the 3-month average beside
    // the data as without it: C13 =AVERAGE(B11:B13) starts right after B10, and is still no
    // evidence about B15, which is not its neighbour.
    const q4 = (withAverage: boolean) => {
      const rows: Spec[][] = [["Month", "Units", "3-mo avg"]];
      for (let r = 2; r <= 13; r++) rows.push([MONTHS[r - 2], 90 + 10 * r, withAverage && r >= 4 ? `=AVERAGE(B${r - 2}:B${r})` : null]);
      rows.push([], ["Total", "=SUM(B2:B10)"]);
      return tab("Plan", 3, rows);
    };
    for (const withAverage of [true, false]) {
      const r = await audit([q4(withAverage)], { detail: "findings" });
      expect([r.ok, r.errorCount, r.warningCount], `average column: ${withAverage}`).toEqual([true, 0, 1]);
      expect(r.rangesStoppingBeforeData.items, `average column: ${withAverage}`).toEqual([
        { cell: "Plan!B15", formula: "=SUM(B2:B10)", dataBeyondRange: { "Plan!B2:B10": ["B11", "B12", "B13"] }, missedCells: 3 },
      ]);
    }
    // The formula's OWN fill still counts: quarterly totals stacked in adjacent cells (E2 =SUM(B2:B4)
    // above E3 =SUM(B5:B7) …) and the windows of the average (C12 =AVERAGE(B10:B12) above C13) end
    // where they do on purpose.
    const rows: Spec[][] = [["Month", "Units", "3-mo avg", null, "Quarter"]];
    for (let r = 2; r <= 13; r++) rows.push([MONTHS[r - 2], 90 + 10 * r, r >= 4 ? `=AVERAGE(B${r - 2}:B${r})` : null, null, r <= 5 ? `=SUM(B${3 * r - 4}:B${3 * r - 2})` : null]);
    const own = await audit([tab("Plan", 3, rows)], { detail: "findings" });
    expect([own.warningCount, own.rangesStoppingBeforeData]).toEqual([0, undefined]);
  });

  it("another table's Total row beside the data does not hide the month a total leaves out", async () => {
    // Review: E11 (the side table's total) made row 11 a "totals row", which ended the walk from
    // B2:B10 before B11 and dropped Side!B12 — a true positive the base code reported.
    const r = await audit([SIDE], { detail: "findings" });
    expect(r.rangesStoppingBeforeData.items).toEqual([
      { cell: "Side!G2", formula: "=COUNTA(A2:A10)", dataBeyondRange: { "Side!A2:A10": ["A11"] }, missedCells: 1 },
      { cell: "Side!B12", formula: "=SUM(B2:B10)", dataBeyondRange: { "Side!B2:B10": ["B11"] }, missedCells: 1 },
    ]);
    // The label walk from A2:A10 still stops at its OWN table's Total row (A12 "Total", B12 the sum).
    expect(r.rangesStoppingBeforeData.items[0].dataBeyondRange["Side!A2:A10"]).not.toContain("A12");
    expect([r.warningCount, r.summary.inconsistentFormulas]).toEqual([2, 0]);
  });

  it("running totals are expanding windows, not ranges stopping before data — and cannot bury a short total", async () => {
    // Review: every =SUM($B$2:Bn) but the last was flagged, missing 10, 9, 8 … cells; ranked by
    // cells missed they filled the summary's top 10 and cut Sales!B11, the one real problem.
    const r = await audit([CASH, REPORT, SALES]);
    expect([r.ok, r.errorCount, r.warningCount]).toEqual([true, 0, 1]);
    expect(r.rangesStoppingBeforeData).toEqual({ items: [{ cell: "Sales!B11", formula: "=SUM(B2:B9)", dataBeyondRange: { "Sales!B2:B9": ["B10"] }, missedCells: 1 }] });
    expect(r.note).toBeUndefined();
    // A total one row short next to a correct total of the same column elsewhere is two ranges
    // from one start, not an expanding family: the short one stays flagged.
    const check = tab("Check", 9, [["Units total", ["=SUM(Sales!B2:B10)", 450]]]);
    expect(cells((await audit([SALES, check])).rangesStoppingBeforeData)).toEqual(["Sales!B11"]);
    // An anchored start alone is not a running total: =SUM($B$2:B9) in B11 does not end on its own row.
    const anchored = tab("Sales", 0, [...salesRows.slice(0, 10), ["Total", "=SUM($B$2:B9)"]]);
    expect(cells((await audit([anchored])).rangesStoppingBeforeData)).toEqual(["Sales!B11"]);
  });

  it("a year-to-date column over the same data does not hide a total one row short", async () => {
    // Review: the YTD column's ranges B2:B3 … B2:B10 formed a chain of ranges from one start, and
    // the chain rule counted ANY =SUM(B2:Bk) inside it as a step of a running total, so Sales!B11
    // =SUM(B2:B9) (B10 plain data) was dropped — with the YTD beside it, or on another tab.
    const want = [{ cell: "Sales!B11", formula: "=SUM(B2:B9)", dataBeyondRange: { "Sales!B2:B9": ["B10"] }, missedCells: 1 }];
    const ytd: Spec[][] = [["Month", "Units", "YTD"]];
    for (let r = 2; r <= 10; r++) ytd.push([MONTHS[r - 2], 10 * (r - 1), `=SUM($B$2:B${r})`]);
    ytd.push(["Total", ["=SUM(B2:B9)", 360]]);
    for (const detail of ["summary", "findings"]) {
      const r = await audit([tab("Sales", 5, ytd)], { detail });
      expect([r.ok, r.errorCount, r.warningCount], detail).toEqual([true, 0, 1]);
      expect(r.rangesStoppingBeforeData.items, detail).toEqual(want);
    }
    // The year-to-date on another tab, anchored and filled down (=SUM(Sales!$B$2:B2) in B2 …) …
    const dashRows: Spec[][] = [["Month", "YTD"]];
    for (let r = 2; r <= 10; r++) dashRows.push([MONTHS[r - 2], `=SUM(Sales!$B$2:B${r})`]);
    const dash = await audit([SALES, tab("Dash", 6, dashRows)], { detail: "findings" });
    expect([dash.warningCount, dash.rangesStoppingBeforeData.items]).toEqual([1, want]);
    // … or unanchored and offset, a report typed cell by cell (=SUM(Sales!B2:B3) in B6 …): the
    // report's own chain still exempts ITS cells, but not the Total on Sales.
    const repRows: Spec[][] = [["YTD report"], [], [], ["Month", "YTD"]];
    for (let r = 5; r <= 13; r++) repRows.push([MONTHS[r - 5], `=SUM(Sales!B2:B${r - 3})`]);
    const rep = await audit([SALES, tab("Report", 7, repRows)], { detail: "findings" });
    expect([rep.warningCount, rep.rangesStoppingBeforeData.items]).toEqual([1, want]);
  });

  it("a totals row or column that mixes SUM with AVERAGE is not inconsistent", async () => {
    // Review: Tot!C10 =AVERAGE(C2:C9) was flagged against B10 =SUM(B2:B9) along the Total row,
    // and Year!N4 =AVERAGE(B4:M4) against N2 =SUM(B2:M2) down the Year column.
    const r = await audit([TOT, YEAR], { detail: "findings" });
    expect([r.warningCount, r.inconsistentFormulas]).toEqual([0, undefined]);
  });

  it("still flags a cell of a totals row that totals less than its neighbours do", async () => {
    // D10 =SUM(D2:D8) stops a row short over a column of formulas (D9 is =B9*C9), which the
    // range check deliberately does not walk; the Total row's pattern still catches it.
    const r = await audit([tab("Tot", 9, [...totRows, totalsRow("=SUM(D2:D8)")])], { detail: "findings" });
    expect(r.inconsistentFormulas.items).toEqual([{ cell: "Tot!D10", formula: "=SUM(D2:D8)", differsFrom: { row: "B10 =SUM(B2:B9)" } }]);
    expect(r.warningCount).toBe(1);
  });

  it("still flags a plug, a multiplier or another function in a totals row or column", async () => {
    // Review: cells totalling their own row/column were compared by the block they total alone,
    // so everything else in the formula (+500, *1.1, MIN for MAX) went unseen.
    const byRow = (title: string, n: number, total: (r: number) => string): any => {
      const rows: Spec[][] = [["Line", ...MONTHS.slice(0, n), "Total"]];
      for (let r = 2; r <= 8; r++) rows.push([`line ${r - 1}`, ...Array.from({ length: n }, (_, i): Spec => 10 * r + i), total(r)]);
      return tab(title, 0, rows);
    };
    const last = (n: number) => M[n - 1];
    const cases: [any, string, string, string][] = [
      // A Total column N =SUM(Bn:Mn) with a hard-coded plug in the middle of it.
      [byRow("Plan", 12, (r) => (r === 5 ? "=SUM(B5:M5)+500" : `=SUM(B${r}:M${r})`)), "Plan!N5", "=SUM(B5:M5)+500", "N2 =SUM(B2:M2)"],
      // A per-row sum column E with a multiplier on one row.
      [byRow("Rs", 3, (r) => (r === 6 ? "=SUM(B6:D6)*1.1" : `=SUM(B${r}:${last(3)}${r})`)), "Rs!E6", "=SUM(B6:D6)*1.1", "E2 =SUM(B2:D2)"],
      // A Peak column F =MAX(Bn:En) with MIN on one row.
      [byRow("Peak", 4, (r) => (r === 5 ? "=MIN(B5:E5)" : `=MAX(B${r}:${last(4)}${r})`)), "Peak!F5", "=MIN(B5:E5)", "F2 =MAX(B2:E2)"],
    ];
    for (const [sheet, cell, formula, differs] of cases) {
      const r = await audit([sheet], { detail: "findings" });
      expect(r.inconsistentFormulas?.items, cell).toEqual([{ cell, formula, differsFrom: { column: differs } }]);
      expect([r.ok, r.warningCount], cell).toEqual([true, 1]);
    }
    // A Total row: a plug on one column's SUM, among plain SUMs and the price's AVERAGE.
    const row = await audit([tab("Tot", 9, [...totRows, totalsRow("=SUM(D2:D9)+100")])], { detail: "findings" });
    expect(row.inconsistentFormulas.items).toEqual([{ cell: "Tot!D10", formula: "=SUM(D2:D9)+100", differsFrom: { row: "B10 =SUM(B2:B9)" } }]);
    expect(row.warningCount).toBe(1);
  });

  it("a date header shown with dots (01.02.2026, 1.2.2026) is a label, like 'Feb 2026'", async () => {
    for (const shown of [(m: number) => `01.${String(m).padStart(2, "0")}.2026`, (m: number) => `1.${m}.2026`, (m: number) => `${MONTHS[m - 1]} 2026`]) {
      const rows: Spec[][] = [[null, ["=DATE(2026,1,1)", shown(1)], ["=EDATE(B1,1)", shown(2)], ["=EDATE(C1,1)", shown(3)], ["=EDATE(D1,1)", shown(4)]]];
      for (let r = 2; r <= 6; r++) rows.push([null, "=ROW()*2", "=ROW()*2", "=ROW()*2", "=ROW()*2"]);
      const r = await audit([tab("Dates", 0, rows)], { detail: "findings" });
      expect(r.warningCount, shown(2)).toBe(0);
    }
  });

  it("a total over a named range is a total", async () => {
    const rows: Spec[][] = [["Qty", "Price", "Amount"]];
    for (let r = 2; r <= 9; r++) rows.push([r, 10, `=A${r}*B${r}`]);
    rows.push([null, "Total", "=SUM(Amounts)"]);
    const t = tab("N", 0, rows);
    const meta = { ...metaFor([t]), namedRanges: [{ name: "Amounts", range: { sheetId: 0, startRowIndex: 1, endRowIndex: 9, startColumnIndex: 2, endColumnIndex: 3 } }] };
    const r = await audit([t], { detail: "findings" }, meta);
    expect([r.warningCount, r.inconsistentFormulas]).toEqual([0, undefined]);
    // … also along a Total row, next to totals written with A1 ranges.
    const row = tab("N", 0, [...rows.slice(0, -1), ["=SUM(A2:A9)", "=AVERAGE(B2:B9)", "=SUM(Amounts)"]]);
    expect((await audit([row], { detail: "findings" }, meta)).warningCount).toBe(0);
  });
});

describe("sheets_audit_spreadsheet: one finding per cell", () => {
  const DUP = tab("Dup", 0, [
    [10, 1, "=IF(SUM(A1:A3)=0,0,SUM(A1:A3))"],
    [20, 2, "=SUMPRODUCT(A1:A3,B1:B3)"],
    [30, 3],
    [40, 4],
  ]);

  it("a formula reading the same short range twice is one finding", async () => {
    const r = await audit([DUP], { detail: "findings" });
    const c1 = r.rangesStoppingBeforeData.items.filter((f: any) => f.cell === "Dup!C1");
    expect(c1).toEqual([{ cell: "Dup!C1", formula: "=IF(SUM(A1:A3)=0,0,SUM(A1:A3))", dataBeyondRange: { "Dup!A1:A3": ["A4"] }, missedCells: 1 }]);
  });

  it("a formula reading two short ranges is one finding listing both", async () => {
    const r = await audit([DUP], { detail: "findings" });
    const c2 = r.rangesStoppingBeforeData.items.filter((f: any) => f.cell === "Dup!C2");
    expect(c2).toEqual([{ cell: "Dup!C2", formula: "=SUMPRODUCT(A1:A3,B1:B3)", dataBeyondRange: { "Dup!A1:A3": ["A4"], "Dup!B1:B3": ["B4"] }, missedCells: 2 }]);
    expect(r.warningCount).toBe(2);
  });

  it("overlapping ranges load a cell twice, but report it once — and keep a fill-down run whole", async () => {
    const twice = (t: any, from: number) => ({ ...t, data: [...t.data, { startRow: from, rowData: t.data[0].rowData.slice(from) }] });
    const r = await audit([twice(DUP, 0), twice(ITEMS, 3)], { detail: "findings", ranges: ["Dup!A1:C4", "Dup!A1:C4", "Items!A1:H10", "Items!A4:H10"] });
    const all = [...cells(r.rangesStoppingBeforeData), ...cells(r.inconsistentFormulas)];
    expect(all.sort()).toEqual(["Dup!C1", "Dup!C2", "Items!D7"]);
    expect(r.rangesStoppingBeforeData.items.find((f: any) => f.cell === "Dup!C2").missedCells).toBe(2);
    // The counts are of cells too: the overlap is scanned once.
    const once = await audit([DUP, ITEMS], { detail: "findings" });
    expect([r.formulas, r.cellsScanned]).toEqual([once.formulas, once.cellsScanned]);
    expect(once.formulas).toBe(21); // Dup C1, C2; Items D1..D10, E2..E9, H2
  });

  it("holds one finding per cell per category even if a response lists a tab twice", async () => {
    const { g } = fakeClient((_url, params) => (params?.includeGridData ? { sheets: [...gridResponse.sheets, gridResponse.sheets[0]] } : metaResponse));
    const r: any = await byName("sheets_audit_spreadsheet").handler({ spreadsheet_id: "sid", detail: "findings", max_findings: 200 }, ctx(g));
    for (const k of ["errors", "missingSheetRefs", "inconsistentFormulas", "rangesStoppingBeforeData"]) {
      const listed = r[k].items.map((f: any) => f.cell);
      expect(new Set(listed).size, k).toBe(listed.length);
    }
    expect(r.summary).toEqual({ errorCells: 3, circularReferences: 1, missingSheetRefs: 1, inconsistentFormulas: 1, rangesStoppingBeforeData: 1 });
    expect([r.errorCount, r.warningCount]).toEqual([3, 2]);
  });

  it("a cell that breaks both its column and its row pattern is one finding with both reasons", async () => {
    const rows: Spec[][] = [[null, 1, 2, 3, 4]];
    for (let r = 2; r <= 5; r++) rows.push([10 * r, ...["B", "C", "D", "E"].map((c): Spec => (r === 3 && c === "C" ? "=$A4*C$1" : `=$A${r}*${c}$1`))]);
    const r = await audit([tab("Grid", 0, rows)], { detail: "findings" });
    expect(r.inconsistentFormulas.items).toEqual([{ cell: "Grid!C3", formula: "=$A4*C$1", differsFrom: { column: "C2 =$A2*C$1", row: "B3 =$A3*B$1" } }]);
    expect(r.warningCount).toBe(1);
  });
});

describe("sheets_audit_spreadsheet: output size", () => {
  it("clips formulas over 120 chars to 117 + an ellipsis and reports formulaLength", async () => {
    const long = "=" + M.map((c) => `'תחזית מכירות 2026'!${c}5`).join("+");
    expect(long.length).toBeGreaterThan(200);
    const sheet = { properties: { sheetId: 0, title: "Model" }, data: [{ rowData: [{ values: [err(long, "REF", "Unresolved sheet name 'תחזית מכירות 2026'."), err("=1/0", "DIVIDE_BY_ZERO", "Function DIVIDE parameter 2 cannot be zero.")] }] }] };
    const r = await audit([sheet]);
    const [clipped, short] = r.errors.items;
    expect(clipped.formula).toBe(`${long.slice(0, 117)}…`);
    expect(clipped.formulaLength).toBe(long.length);
    expect(short).toEqual({ cell: "Model!B1", formula: "=1/0", error: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." });
    // The same formula also names a missing sheet: clipped there too.
    expect(r.missingSheetRefs.items[0]).toMatchObject({ formula: `${long.slice(0, 117)}…`, formulaLength: long.length });
  });

  it("a formula of many short ranges lists the 10 fewest cells short, in formula order, and counts the rest", async () => {
    // Column j (A = 1) holds numbers in rows 1 to j + 2, so X1:X2 stops j cells before its data ends.
    const letters = Array.from({ length: 12 }, (_, i) => colLetters(i + 1));
    const rows: Spec[][] = Array.from({ length: 14 }, (_, r) => letters.map((_, j): Spec => (r + 1 <= j + 3 ? 100 * r + j : null)));
    const order = ["L", "A", "B", "K", "C", "D", "E", "F", "G", "H", "I", "J"];
    const f = "=SUM(" + order.map((c) => `${c}1:${c}2`).join(",") + ")";
    rows[0].push(null, f);
    const r = await audit([tab("Many", 0, rows)], { detail: "findings" });
    const [finding] = r.rangesStoppingBeforeData.items;
    expect(finding.cell).toBe("Many!N1");
    expect(Object.keys(finding.dataBeyondRange)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((c) => `Many!${c}1:${c}2`));
    expect(finding.dataBeyondRange["Many!A1:A2"]).toEqual(["A3"]);
    expect(finding.dataBeyondRange["Many!J1:J2"]).toHaveLength(10);
    // missedCells totals all 12 ranges (1 + 2 + … + 12), shortRanges counts them.
    expect([finding.missedCells, finding.shortRanges, r.warningCount]).toEqual([78, 12, 1]);
    // Ten or fewer short ranges: all listed, and no shortRanges.
    const ten = "=SUM(" + order.slice(0, 10).map((c) => `${c}1:${c}2`).join(",") + ")";
    rows[0][13] = ten;
    const [all] = (await audit([tab("Many", 0, rows)], { detail: "findings" })).rangesStoppingBeforeData.items;
    expect(Object.keys(all.dataBeyondRange)).toHaveLength(10);
    expect(all.shortRanges).toBeUndefined();
  });

  it("a formula naming many missing sheets names the first 10 and counts them all", async () => {
    const f = "=" + Array.from({ length: 12 }, (_, i) => `Gone${i}!A1`).join("+") + "+Gone0!B2";
    const sheet = { properties: { sheetId: 0, title: "Model" }, data: [{ rowData: [{ values: [err(f, "REF", "Unresolved sheet name 'Gone0'.")] }] }] };
    const [finding] = (await audit([sheet])).missingSheetRefs.items;
    expect(finding.missingSheets).toEqual(Array.from({ length: 10 }, (_, i) => `Gone${i}`));
    expect(finding.missingSheetCount).toBe(12);
    // Ten or fewer: all named, and no missingSheetCount.
    const few = { properties: { sheetId: 0, title: "Model" }, data: [{ rowData: [{ values: [err("=Gone0!A1+Gone1!A1", "REF", "Unresolved sheet name 'Gone0'.")] }] }] };
    expect((await audit([few])).missingSheetRefs.items[0]).toEqual({ cell: "Model!A1", formula: "=Gone0!A1+Gone1!A1", missingSheets: ["Gone0", "Gone1"] });
  });

  it("clips the neighbour's formula quoted in differsFrom", async () => {
    const pad = "+0".repeat(70);
    const rows: Spec[][] = [["x"]];
    for (let r = 2; r <= 6; r++) rows.push([r, r === 4 ? `=A3*2${pad}` : `=A${r}*2${pad}`]);
    const r = await audit([tab("Long", 0, rows)]);
    const [f] = r.inconsistentFormulas.items;
    expect(f.cell).toBe("Long!B4");
    expect(f.formulaLength).toBe(`=A3*2${pad}`.length);
    expect(f.differsFrom.column).toBe(`B2 ${`=A2*2${pad}`.slice(0, 117)}…`);
  });
});

/**
 * WIDE: 12 error cells; 15 columns (B..P) each a fill-down `=$A{r}*{k}` of a different length
 * (4..18 rows) with row 2 broken; and on Gaps, 12 columns (A..L) of 30 numbers each with a total
 * in row 31 that stops short — column A's =SUM(A1:A18) misses 12 rows, B's 11, …, L's =SUM(L1:L29)
 * only L30.
 */
const WIDE = (() => {
  const model: any[] = [];
  const cols = "BCDEFGHIJKLMNOP".split("");
  for (let r = 1; r <= 18; r++) {
    const row: any[] = [num(r)];
    cols.forEach((c, j) => {
      const k = j + 2; // the column's multiplier; column j+1 runs rows 1..(j+4)
      row.push(r <= j + 4 ? formula(r === 2 ? `=$A${r + 1}*${k}` : `=$A${r}*${k}`, r * k) : empty);
    });
    model.push({ values: row });
  }
  model.push({ values: Array.from({ length: 12 }, (_, i) => err(`=1/${i}-${i}`, "DIVIDE_BY_ZERO", "Function DIVIDE parameter 2 cannot be zero.")) });
  const gaps: Spec[][] = [];
  const letters = "ABCDEFGHIJKL".split("");
  for (let r = 1; r <= 30; r++) gaps.push(letters.map((_, j) => 100 * j + r));
  gaps.push(letters.map((c, j): Spec => `=SUM(${c}1:${c}${18 + j})`));
  return [{ properties: { sheetId: 0, title: "Model" }, data: [{ rowData: model }] }, tab("Gaps", 1, gaps)];
})();

describe("sheets_audit_spreadsheet: detail", () => {
  it("summary (default): counts, every error, the 10 likeliest-real warnings per kind and how many more", async () => {
    const r = await audit(WIDE);
    expect([r.ok, r.errorCount, r.warningCount]).toEqual([false, 12, 27]);
    expect(r.summary).toMatchObject({ errorCells: 12, inconsistentFormulas: 15, rangesStoppingBeforeData: 12 });
    expect(r.errors.items).toHaveLength(12); // errors are the real signal: never cut to 10
    expect(r.errors.truncated).toBeUndefined();
    expect(r.inconsistentFormulas.items).toHaveLength(10);
    expect(r.inconsistentFormulas.truncated).toBe(5);
    // Strongest first: the break in the longest run (column P, 18 rows) leads.
    expect(cells(r.inconsistentFormulas).slice(0, 3)).toEqual(["Model!P2", "Model!O2", "Model!N2"]);
    expect(r.rangesStoppingBeforeData.items).toHaveLength(10);
    expect(r.rangesStoppingBeforeData.truncated).toBe(2);
    // …and the range one row short leads: the classic slip. The ranges that leave out the most
    // (A31 misses 12 rows, B31 11) are the ones cut, not the one-row-short total.
    expect(r.rangesStoppingBeforeData.items.map((f: any) => [f.cell, f.missedCells]).slice(0, 3)).toEqual([["Gaps!L31", 1], ["Gaps!K31", 2], ["Gaps!J31", 3]]);
    expect(cells(r.rangesStoppingBeforeData)).not.toContain("Gaps!A31");
    expect(r.note).toBe("Showing the top 10 warnings per kind; detail=findings lists the rest (up to max_findings).");
  });

  it("findings: every finding in sheet order, capped only by max_findings", async () => {
    const r = await audit(WIDE, { detail: "findings" });
    expect(r.inconsistentFormulas.items).toHaveLength(15);
    expect(cells(r.inconsistentFormulas).slice(0, 2)).toEqual(["Model!B2", "Model!C2"]);
    expect(r.rangesStoppingBeforeData.items).toHaveLength(12);
    // Sheet order, and a long miss lists its first 10 cells with the full count.
    expect(r.rangesStoppingBeforeData.items[0]).toMatchObject({ cell: "Gaps!A31", missedCells: 12 });
    expect(r.rangesStoppingBeforeData.items[0].dataBeyondRange["Gaps!A1:A18"]).toHaveLength(10);
    expect(r.note).toBeUndefined();
    const capped = await audit(WIDE, { detail: "findings", max_findings: 4 });
    expect([capped.inconsistentFormulas.items.length, capped.inconsistentFormulas.truncated]).toEqual([4, 11]);
  });

  it("max_findings caps the errors in summary mode too, and the warnings when below 10", async () => {
    const r = await audit(WIDE, { max_findings: 5 });
    expect([r.errors.items.length, r.errors.truncated]).toEqual([5, 7]);
    expect([r.inconsistentFormulas.items.length, r.inconsistentFormulas.truncated]).toEqual([5, 10]);
    expect(r.note).toBe("Showing the top 5 warnings per kind; detail=findings lists the rest (up to max_findings).");
  });
});

describe("sheets_audit_spreadsheet: cost follows the cells present", () => {
  // Each case cost seconds, 38-366 MB of ArrayBuffers or 200+ MB of heap before its fix (quoted
  // per test); here each audits in under 0.5 s with at most +2 MB of ArrayBuffers (the totals
  // index), and release/1.6 in under 0.3 s. The bounds (2 s, +96 MB heap, +16 MB ArrayBuffers)
  // leave room for a loaded CI machine, and each case breaks at least one of them without its fix.
  // A Worker isolate has 128 MB, and typed-array backing stores count against it without showing
  // in heapUsed, so both are read right after the audit returns, from a full GC before it.
  const DAYS = 8000;
  const daily = (title: string, calc: (r: number) => Spec) => {
    const rows: Spec[][] = [["Day", "Units", "Calc"]];
    for (let r = 2; r <= DAYS + 1; r++) rows.push([`day ${r - 1}`, r % 17, calc(r)]);
    return tab(title, 0, rows);
  };
  /** Another data block on the tab, its top-left cell at (row, col): a side table, a stray note far from the data. */
  const withBlock = (sheet: any, row: number, col: number, rows: Spec[][]) => {
    sheet.data.push({ startRow: row - 1, startColumn: col - 1, rowData: rows.map((r) => ({ values: r.map(cellOf) })) });
    return sheet;
  };
  // A full GC before each measurement, so the growth read afterwards is the audit's own. vitest
  // does not run with --expose-gc; a flag set now makes `gc` available in a new context.
  const collect: () => void = (globalThis as { gc?: () => void }).gc ?? (setFlagsFromString("--expose-gc"), runInNewContext("gc"));
  const measure = async (sheet: any, args: Record<string, unknown> = {}) => {
    collect();
    const m0 = process.memoryUsage(), t0 = performance.now();
    const r = await audit([sheet], { detail: "findings", ...args });
    const ms = performance.now() - t0, m1 = process.memoryUsage();
    return { r, ms, heapMB: (m1.heapUsed - m0.heapUsed) / 2 ** 20, buffersMB: (m1.arrayBuffers - m0.arrayBuffers) / 2 ** 20 };
  };
  const cheap = (m: { ms: number; heapMB: number; buffersMB: number }, label: string, maxMs = 2000) => {
    expect(m.ms, `${label}: ${Math.round(m.ms)} ms`).toBeLessThan(maxMs);
    expect(m.heapMB, `${label}: heap +${Math.round(m.heapMB)} MB`).toBeLessThan(96);
    expect(m.buffersMB, `${label}: ArrayBuffers +${Math.round(m.buffersMB)} MB`).toBeLessThan(16);
  };
  const SLOW = 60_000; // a regression fails on the measured bound above, not on vitest's 5 s timeout

  it("a 7-day moving average and an unanchored running total: excused by their neighbours, not walked", async () => {
    // Before: the walk past a range's end ran BEFORE the neighbour checks and named every cell it
    // passed — 8,000 rows 25 s / +813 MB for the moving average.
    for (const [title, calc] of [
      ["MovingAvg", (r: number): Spec => (r >= 8 ? `=AVERAGE(B${r - 6}:B${r})` : null)],
      ["Running", (r: number): Spec => (r >= 3 ? `=SUM(B2:B${r})` : null)],
    ] as const) {
      const m = await measure(daily(title, calc));
      expect(m.r.formulas, title).toBeGreaterThan(DAYS - 10);
      expect([m.r.ok, m.r.warningCount], title).toEqual([true, 0]);
      cheap(m, title);
    }
  }, SLOW);

  it("subtotals placed apart are each walked, in one pass over the column, and name at most 10 cells", async () => {
    // A weekly subtotal every 7th row beside the daily data: no subtotal is its neighbour's, so
    // each range is walked to the end of the data and reported (as release/1.6 reports them). The
    // first misses 7,993 rows; the walks share one scan of column B instead of one each.
    const m = await measure(daily("Weeks", (r) => ((r - 1) % 7 === 0 ? `=SUM(B${r - 6}:B${r})` : null)), { max_findings: 2000 });
    expect(m.r.summary.rangesStoppingBeforeData).toBe(Math.floor(DAYS / 7));
    const [first] = m.r.rangesStoppingBeforeData.items;
    expect(first).toMatchObject({ cell: "Weeks!C8", missedCells: DAYS + 1 - 8 });
    expect(first.dataBeyondRange["Weeks!B2:B8"]).toEqual(["B9", "B10", "B11", "B12", "B13", "B14", "B15", "B16", "B17", "B18"]);
    cheap(m, "weekly subtotals");
  }, SLOW);

  it("a table beside the data with a total on every row does not make each walk go row by row", async () => {
    // A forecast column a blank column away, =AVERAGE(E(r-3):E(r-1)) on every row, puts a total of
    // its own column on every row. A total in another table does not end a walk, but it made every
    // row a stop, so each weekly range stepped through the rest of the data one row at a time:
    // 8,000 rows 2.8 s, 16,000 rows 12.6 s. Once a walk knows its table, the other table's totals
    // are plain data to the scan, and walks with the same table share it.
    const rows: Spec[][] = [["Day", "Units", "Week", null, "Forecast"]];
    for (let r = 2; r <= DAYS + 1; r++) rows.push([`day ${r - 1}`, r % 17, (r - 1) % 7 === 0 ? `=SUM(B${r - 6}:B${r})` : null, null, r <= 4 ? r : `=AVERAGE(E${r - 3}:E${r - 1})`]);
    const m = await measure(tab("Side", 0, rows), { max_findings: 2000 });
    expect(m.r.summary.rangesStoppingBeforeData).toBe(Math.floor(DAYS / 7));
    expect(m.r.rangesStoppingBeforeData.items[0]).toMatchObject({ cell: "Side!C8", missedCells: DAYS + 1 - 8 });
    cheap(m, "weekly subtotals beside a forecast column");
  }, SLOW);

  it("a tall log beside a wide block: nothing is sized by the tab's last row or column", async () => {
    // Before: every line holding a range got three Int32Arrays as long as the tab plus a stop memo,
    // even a total right under its range, which has nothing to walk. 20,000 rows beside a
    // 365-column block: 1.9 s and +111 MB of ArrayBuffers; 50,000 rows beside 50 columns: +38 MB.
    const summary = (cols: number, rows: number): Spec[][] => {
      const out: Spec[][] = [Array.from({ length: cols }, (_, i): Spec => `d${i + 1}`)];
      for (let r = 2; r <= rows + 1; r++) out.push(Array.from({ length: cols }, (_, i): Spec => (r * 7 + i) % 50));
      out.push(Array.from({ length: cols }, (_, i): Spec => `=SUM(${colLetters(i + 5)}2:${colLetters(i + 5)}${rows + 1})`));
      return out;
    };
    const txnRows: Spec[][] = [["Txn", "Amount", "Category"]];
    for (let r = 2; r <= 20_001; r++) txnRows.push([`txn ${r - 1}`, r % 97, r % 3 ? "ops" : "sales"]);
    const logRows: Spec[][] = [["Log"]];
    for (let r = 2; r <= 50_001; r++) logRows.push([`event ${r - 1}`]);
    for (const [label, sheet, formulas] of [
      ["20,000 rows + 365 columns", withBlock(tab("Txns", 0, txnRows), 1, 5, summary(365, 12)), 365],
      ["50,000 rows + 50 columns", withBlock(tab("Log", 0, logRows), 1, 5, summary(50, 19)), 50],
    ] as const) {
      const m = await measure(sheet);
      expect([m.r.formulas, m.r.ok, m.r.warningCount], label).toEqual([formulas, true, 0]);
      cheap(m, label);
    }
  }, SLOW);

  it("one stray cell far right of the data does not make each row cost the tab's width", async () => {
    // Before: 8,000 rows of =SUM(Ar:Br) with one note in column 3000: 3.9 s and +366 MB; 10,000
    // rows of months with a row total and a note in column ALL: 2.9 s and +153 MB; weekly subtotals
    // with a note in column 8000: 6.4 s (the header and totals checks read every column of each row).
    const pairs: Spec[][] = [["A", "B", "Sum"]];
    for (let r = 2; r <= 8001; r++) pairs.push([r % 11, r % 13, `=SUM(A${r}:B${r})`]);
    const months: Spec[][] = [["Item", ...MONTHS, "Total"]];
    for (let r = 2; r <= 10_001; r++) months.push([`item ${r - 1}`, ...M.map((_, i): Spec => (r + i) % 20), `=SUM(B${r}:M${r})`]);
    const weeks = daily("Weeks", (r) => ((r - 1) % 7 === 0 ? `=SUM(B${r - 6}:B${r})` : null));
    for (const [label, sheet, warnings] of [
      ["note in column 3000", withBlock(tab("Pairs", 0, pairs), 1, 3000, [["note"]]), 0],
      ["note in column ALL", withBlock(tab("Months", 0, months), 1, 1000, [["note"]]), 0],
      ["note in column 8000", withBlock(weeks, 1, 8000, [["note"]]), Math.floor(DAYS / 7)],
    ] as const) {
      const m = await measure(sheet, { max_findings: 2000 });
      expect([m.r.ok, m.r.warningCount], label).toEqual([true, warnings]);
      cheap(m, label);
    }
  }, SLOW);

  it("a range along a row finds its table once, not once per formula", async () => {
    // Item | Jan..Dec | Total | Avg, with Total pasted as values in most rows and =SUM(Br:Mr) kept
    // in every 50th (or only the last): each row's =AVERAGE(Br:Mr) reaches the plain Total, whose
    // column holds totals, so the walk asks which rows the table spans. Before, every formula
    // measured the whole table again: 8,000 rows took 11 s, and each doubling about 4x that.
    const pasted = (keep: (r: number) => boolean) => {
      const rows: Spec[][] = [["Item", ...MONTHS, "Total", "Avg"]];
      for (let r = 2; r <= DAYS + 1; r++) {
        const v = M.map((_, i) => (r * 3 + i) % 40);
        rows.push([`item ${r - 1}`, ...v, keep(r) ? [`=SUM(B${r}:M${r})`, v.reduce((a, b) => a + b, 0)] : v.reduce((a, b) => a + b, 0), `=AVERAGE(B${r}:M${r})`]);
      }
      return tab("Pasted", 0, rows);
    };
    for (const [label, keep] of [
      ["=SUM kept every 50th row", (r: number) => r % 50 === 0],
      ["=SUM kept in the last row only", (r: number) => r === DAYS + 1],
    ] as const) {
      const m = await measure(pasted(keep));
      expect([m.r.ok, m.r.warningCount], label).toEqual([true, 0]);
      cheap(m, label);
    }
  }, SLOW);

  it("a different table for every walk costs no memory per table", async () => {
    // A 30,000-row log in A:B; one "x" per column down a diagonal (row 100k, column 2+k: a
    // Gantt-style marker); a forecast column, a few blank columns right, with a total of its own
    // column on every row; and on every other row a total =SUM(B2:B(100k+50)). Each range's table
    // reaches a different marker, so each walk kept a stop memo of its own holding every row it
    // passed: 3.1 s and +204 MB of heap (25,000 rows and 200 markers: 2.1 s, +160 MB, and out of
    // memory in a 128 MB heap). Here about 0.45 s and +80 MB; release/1.6 0.25 s and +35 MB.
    const ROWS = 30_000, STEPS = 250, FORECAST = STEPS + 6, TOTALS = FORECAST + 2;
    const log: Spec[][] = [["Day", "Units"]];
    for (let r = 2; r <= ROWS + 1; r++) log.push([`day ${r - 1}`, r % 17]);
    const sheet = tab("Gantt", 0, log);
    for (let k = 1; k <= STEPS; k++) withBlock(sheet, 100 * k, 2 + k, [["x"]]);
    withBlock(sheet, 2, FORECAST, Array.from({ length: ROWS }, (_, i): Spec[] => [i < 3 ? i + 1 : `=AVERAGE(${colLetters(FORECAST)}${i - 1}:${colLetters(FORECAST)}${i + 1})`]));
    withBlock(sheet, 2, TOTALS, Array.from({ length: 2 * STEPS - 1 }, (_, i): Spec[] => [i % 2 ? null : `=SUM(B2:B${100 * (i / 2 + 1) + 50})`]));
    const m = await measure(sheet, { max_findings: 2000 });
    expect(m.r.cellsScanned).toBe(2 * (ROWS + 1) + STEPS + ROWS + STEPS);
    // Nothing in a total's own table ends its walk: the forecast is another table. Each is flagged, missing the rest of the log.
    expect(m.r.summary.rangesStoppingBeforeData).toBe(STEPS);
    const byCell = new Map<string, any>(m.r.rangesStoppingBeforeData.items.map((f: any) => [f.cell, f]));
    for (const k of [1, 2, 125, STEPS]) {
      const f = byCell.get(`Gantt!${colLetters(TOTALS)}${2 * k}`);
      expect(f, `k=${k}`).toMatchObject({ missedCells: ROWS + 1 - (100 * k + 50) });
      expect(f.dataBeyondRange[`Gantt!B2:B${100 * k + 50}`][0]).toBe(`B${100 * k + 51}`);
    }
    cheap(m, "staircase of tables");
  }, SLOW);

  it("a formula reading many ranges costs each range a lookup in its neighbours, not a scan of their ranges", async () => {
    // 3,000 rows × 4 scenario columns of the same 40-range SUM over a fixed 8-row block
    // (=SUM($A$2:$A$9,$B$2:$B$9,…)), so every formula has a formula on each side. Before, each range
    // was checked against the formulas next to it (deliberateEnd, expandingFamily) by walking every
    // range of each neighbour again, up to 16 times over the 4 neighbours and 2 steps away, building
    // a new list each time — 40 × 16 × 40 references per cell: 4.8 s and +119 MB here. Each
    // formula's line ranges are now indexed once, by line and start, and each check is a binary
    // search: 0.9 s and about +10 MB.
    const COLS = 40, ROWS = 3000, SCENARIOS = 4;
    const letters = Array.from({ length: COLS }, (_, i) => colLetters(i + 1));
    const sum = "=SUM(" + letters.map((c) => `$${c}$2:$${c}$9`).join(",") + ")";
    const rows: Spec[][] = [[...letters.map((c) => `h${c}`), null, ...Array.from({ length: SCENARIOS }, (_, j) => `Scenario ${j + 1}`)]];
    for (let r = 2; r <= ROWS + 1; r++) rows.push([...letters.map((_, i): Spec => (r <= 9 ? r * 10 + i : null)), null, ...Array.from({ length: SCENARIOS }, (): Spec => sum)]);
    const m = await measure(tab("Many", 0, rows));
    expect([m.r.formulas, m.r.ok, m.r.warningCount]).toEqual([ROWS * SCENARIOS, true, 0]);
    // 0.9-1.1 s alone and up to 1.4 s inside a parallel `npm test`, which is too close to the shared
    // 2 s: this case gets 3 s, still well under the 4.8 s it took before the lookup.
    cheap(m, "3,000 rows × 4 columns of 40-range SUMs", 3000);
  }, SLOW);

  it("a formula of thousands of ranges checks each against its neighbours by lookup", async () => {
    // 40 cells of a 49,000-character sum of 4,083 two-cell ranges (=A1:A2+A3:A4+…): before, 4,083
    // ranges × 16 walks of the neighbour's 4,083 ranges per cell — 12.9 s; now 0.3 s.
    const parts: string[] = [];
    for (let k = 0, len = 1; ; k++) {
      const t = `A${2 * k + 1}:A${2 * k + 2}`;
      if ((len += t.length + 1) > 49_000) break;
      parts.push(t);
    }
    const f = "=" + parts.join("+");
    const rows: Spec[][] = Array.from({ length: 40 }, (_, r): Spec[] => [r === 0 ? 1 : null, [f, 1]]);
    const m = await measure(tab("Ranges", 0, rows));
    expect([m.r.formulas, m.r.ok, m.r.warningCount]).toEqual([40, true, 0]);
    cheap(m, "40 formulas of 4,083 ranges");
  }, SLOW);

  it("whitespace in a formula or a displayed value costs time in proportion to its length", async () => {
    // Two regular expressions tried every split of a run of whitespace between parts that both
    // take it: =SUM(<n spaces>(B1)) cost the cube of n per cell of a fill-down (3 cells of 2,000
    // spaces: 3.3 s; 49,000 would take hours), and the test for a number the square of n on every
    // displayed value (20 text cells of "1", 49,000 spaces and "a": 50 s). release/1.6: 2 ms each.
    const pad = " ".repeat(49_000);
    const calls = await measure(tab("Call", 0, [[`=SUM(${pad}(B1))`], [`=SUM(${pad}(B2))`], [`=SUM(${pad}(B3))`], [`=SUM(A1:A2${pad})+1`]]));
    expect([calls.r.formulas, calls.r.ok]).toEqual([4, true]);
    cheap(calls, "49,000 spaces in a formula");
    const rows: Spec[][] = [["Label", "Amount", "Check"]];
    for (let r = 2; r <= 21; r++) rows.push([`1${pad}a`, r < 5 ? `1   23${r}` : null, r === 2 ? "=COUNTA(A2:A3)" : r === 3 ? "=SUM(B2:B3)" : null]);
    const values = await measure(tab("Pad", 0, rows));
    // Numbers shown with runs of spaces between digit groups still read as numbers; the padded labels read as labels.
    expect(values.r.rangesStoppingBeforeData.items).toEqual([
      { cell: "Pad!C2", formula: "=COUNTA(A2:A3)", dataBeyondRange: { "Pad!A2:A3": ["A4"] }, missedCells: 1 }, // rows 5-21 hold only labels: header rows
      { cell: "Pad!C3", formula: "=SUM(B2:B3)", dataBeyondRange: { "Pad!B2:B3": ["B4"] }, missedCells: 1 },
    ]);
    cheap(values, "49,000 spaces in displayed values");
  }, SLOW);

  it("a totals row compares =AVERAGE( C2:C9 ) written with spaces by the block it totals, like =SUM(B2:B9)", async () => {
    const rows: Spec[][] = [["Item", "Qty", "Price", "Amount"]];
    for (let r = 2; r <= 9; r++) rows.push([`item ${r}`, r, 10 + r, `=B${r}*C${r}`]);
    rows.push(["Total", "=SUM(B2:B9)", "=AVERAGE( C2:C9 )", "=SUM(D2:D9)"]);
    expect((await audit([tab("Tot", 0, rows)], { detail: "findings" })).warningCount).toBe(0);
    rows[9][2] = "=AVERAGE( C2:C9 )*2";
    expect(cells((await audit([tab("Tot", 0, rows)], { detail: "findings" })).inconsistentFormulas)).toEqual(["Tot!C10"]);
  });

  it("reference-dense formulas keep no per-reference state: 40 cells of 49,000-character =A1+A1+…", async () => {
    // 16,333 single-cell references per cell, 653,320 in all. Before, every formula cell's resolved
    // references (one object each) were kept for the whole audit: +142 MB of heap here, and node
    // needed a 150 MB heap to finish, over a Worker's 128 MB. The audit keeps only a formula's
    // bounded multi-cell ranges — the only references a total or a short range can be — once each,
    // as numbers, in a bounded memo released when its tab's checks finish: about +22 MB, and node
    // finishes it in a 17 MB heap.
    const dense = "=" + Array.from({ length: 16_333 }, () => "A1").join("+");
    expect(dense.length).toBe(48_999);
    const rows: Spec[][] = Array.from({ length: 40 }, (_, r): Spec[] => [r === 0 ? 1 : null, [dense, 16_333]]);
    const m = await measure(tab("Dense", 0, rows));
    expect([m.r.formulas, m.r.ok, m.r.warningCount]).toEqual([40, true, 0]);
    cheap(m, "40 dense formulas");
    expect(m.heapMB, `heap +${Math.round(m.heapMB)} MB`).toBeLessThan(48);
  }, SLOW);
});

describe("sheets_audit_spreadsheet: memory fits a Worker's heap", () => {
  // Each fixture is audited by a child node whose heap is capped at a Worker isolate's 128 MB
  // (tests/helpers/audit-heap.mjs, on a bundle of the audit); a run that needs more dies instead of
  // printing. The smallest heap each finishes in (--max-old-space-size, bisected twice as the least
  // in which two runs in a row finish): the audit before this change → an earlier version of it →
  // now. 20,000 isolated 40-range SUMs 34-36 → 294 → 44 MB; a relative fill-down of that SUM,
  // 20,000 rows × 2 columns, 74 → 398-412 → 78-80 MB; 300 isolated 49,000-character sums of about
  // 4,000 distinct ranges each 26 → 420 → 36 MB, and 300 adjacent ones 60 → 298-306 → 58-60 MB. The
  // earlier version kept every formula cell's resolved references, and one walk result per distinct
  // range, for the whole audit; each of the four ran out of memory at 128 MB. A single run's need
  // varies by several MB (before this change the fill-down finished at 62 MB once in three tries).
  const HEAP_MB = 128;
  let dir = "", bundle = "";
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "audit-heap-"));
    bundle = path.join(dir, "sheets-analysis.mjs");
    await build({ entryPoints: ["src/tools/sheets-analysis.ts"], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "silent" });
  }, 60_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const inHeap = (fixture: string) => {
    const run = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, "tests/helpers/audit-heap.mjs", bundle, fixture], { encoding: "utf8", timeout: 120_000 });
    expect(run.status, `${fixture}: exit ${run.status} ${run.signal ?? ""} ${run.stderr.slice(-400)}`).toBe(0);
    return JSON.parse(run.stdout.trim().split("\n").pop()!);
  };

  it("20,000 formulas of 40 ranges each, a different text on every row", () => {
    expect(inHeap("sums")).toMatchObject({ formulas: 20_000, errorCount: 0, warningCount: 0 });
  }, 150_000);

  it("a relative fill-down of a 40-range SUM, 20,000 rows × 2 columns", () => {
    expect(inHeap("fill")).toMatchObject({ formulas: 40_000, errorCount: 0, warningCount: 0 });
  }, 150_000);

  it("300 formulas of 49,000 characters, each summing about 4,000 ranges no other formula reads", () => {
    expect(inHeap("dense")).toMatchObject({ formulas: 300, errorCount: 0, warningCount: 0 });
    expect(inHeap("adjacent")).toMatchObject({ formulas: 300, errorCount: 0, warningCount: 0 });
  }, 150_000);

  it("150 formulas of 49,000 characters, each about 7,000 ranges stopping short: 10 listed per finding", () => {
    // Every range of every formula stops before more numbers. Each finding listed all of its
    // short ranges with up to 10 cells each, held for every cell before max_findings applied: this
    // ran out of memory in a 128 MB heap, and in a larger one the summary was 4,133,786
    // characters. A finding now lists 10 and counts the rest: 5,310 characters.
    const r = inHeap("short");
    expect(r).toMatchObject({ formulas: 150, errorCount: 0, warningCount: 150 });
    expect(r.replyChars).toBeLessThan(20_000);
  }, 150_000);

  it("700 formulas of 49,000 characters, each naming about 6,000 missing sheets: 10 named per finding", () => {
    // Each finding named every missing sheet of its formula, held for every cell before
    // max_findings applied: this ran out of memory in a 128 MB heap, and in a larger one the
    // summary (200 errors, 200 missing-sheet findings) was 8,982,690 characters. A finding now
    // names 10 and counts the rest: 109,590 characters.
    const r = inHeap("missing");
    expect(r).toMatchObject({ formulas: 700, errorCount: 700 });
    expect(r.replyChars).toBeLessThan(200_000);
  }, 150_000);
});

describe("sheets_trace_dependents", () => {
  it("walks direct and transitive readers, through ranges and named ranges", async () => {
    const { g } = fakeClient(gridOrMeta);
    const r: any = await byName("sheets_trace_dependents").handler({ spreadsheet_id: "sid", cell: "Data!B2", depth: 2, max_results: 200 }, ctx(g));
    expect(r.cell).toBe("Data!B2");
    const l1 = r.levels[0];
    expect(l1.level).toBe(1);
    expect(l1.dependents.map((d: any) => d.cell).sort()).toEqual(["Data!B6", "Data!C2", "Summary!A1", "Summary!B1"]);
    expect(l1.dependents.find((d: any) => d.cell === "Summary!B1").via).toEqual(["Rate"]);
    expect(l1.dependents.find((d: any) => d.cell === "Summary!A1").via).toEqual(["Data!B2:B5"]);
    expect(r.dependents).toBe(4);
  });

  it("rejects a cell without a tab and unknown tabs", async () => {
    const { g } = fakeClient(gridOrMeta);
    await expect(byName("sheets_trace_dependents").handler({ spreadsheet_id: "sid", cell: "B2", depth: 1, max_results: 10 }, ctx(g))).rejects.toThrow(/tab name/);
    await expect(byName("sheets_trace_dependents").handler({ spreadsheet_id: "sid", cell: "Nope!B2", depth: 1, max_results: 10 }, ctx(g))).rejects.toThrow(/No tab named 'Nope'/);
  });
});

describe("sheets_trace_precedents", () => {
  it("builds the tree level by level with values and formulas", async () => {
    const table: Record<string, { f: unknown[][]; v: unknown[][] }> = {
      "Summary!B1": { f: [["=A1*Rate"]], v: [["1000"]] },
      "Summary!A1": { f: [["=SUM(Data!B2:B5)"]], v: [["100"]] },
      "Data!B2": { f: [[10]], v: [["10"]] },
      "Data!B2:B5": { f: [[10], [20], [30], [40]], v: [["10"], ["20"], ["30"], ["40"]] },
    };
    const { g, calls } = fakeClient((url, params) => {
      if (!url.includes("values:batchGet")) return metaResponse;
      const isF = params.valueRenderOption === "FORMULA";
      return { valueRanges: params.ranges.map((r: string) => ({ range: r, values: isF ? table[r]?.f ?? [] : table[r]?.v ?? [] })) };
    });
    const r: any = await byName("sheets_trace_precedents").handler({ spreadsheet_id: "sid", cell: "Summary!B1", depth: 3, max_nodes: 80, expand_range_cells: 50 }, ctx(g));
    expect(r.cell).toBe("Summary!B1");
    expect(r.formula).toBe("=A1*Rate");
    expect(r.value).toBe("1000");
    expect(r.precedents.map((p: any) => p.cell)).toEqual(["Summary!A1", "Data!B2"]);
    const a1 = r.precedents[0];
    expect(a1.formula).toBe("=SUM(Data!B2:B5)");
    expect(a1.precedents[0]).toMatchObject({ cell: "Data!B2:B5", cells: 4, values: [["10"], ["20"], ["30"], ["40"]] });
    expect(r.precedents[1]).toMatchObject({ cell: "Data!B2", value: "10" });
    expect(r.precedents[1].formula).toBeUndefined();
    // meta + 2 calls per level (3 levels visited: root, A1+B2, B2:B5)
    expect(calls.filter((c) => c.url.includes("values:batchGet"))).toHaveLength(6);
    expect(r.nodes).toBe(4);
  });
});

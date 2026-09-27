import { describe, it, expect } from "vitest";
import { describeRequests, changeTotals, verifyCells, attachPreviews, nonEmptyReply, GRID_READ_MAX_CELLS, type SheetMeta } from "../src/tools/sheets-verify.js";
import { sheetsTools } from "../src/tools/sheets.js";

const meta: SheetMeta = {
  titles: new Map([[0, "Sheet1"], [7, "תקציב 2026"]]),
  ids: new Map([["Sheet1", 0], ["תקציב 2026", 7]]),
  grids: new Map([[0, { rowCount: 1000, columnCount: 26 }], [7, { rowCount: 100, columnCount: 10 }]]),
  namedRanges: [],
};

/** Fake GoogleClient: records calls, answers from a routing function. */
function fakeClient(route: (method: string, url: string, body: any, params: any) => any) {
  const calls: { method: string; url: string; body?: any; params?: any }[] = [];
  const make = (method: string) => async (url: string, a?: any, b?: any) => {
    const [body, params] = method === "get" ? [undefined, a] : [a, b];
    calls.push({ method, url, body, params });
    return route(method, url, body, params);
  };
  return { g: { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), delete: make("delete") } as any, calls };
}

describe("describeRequests", () => {
  it("explains dimension, format and value requests with A1 ranges and warnings", () => {
    const plan = describeRequests(
      [
        { insertDimension: { range: { sheetId: 7, dimension: "ROWS", startIndex: 4, endIndex: 6 }, inheritFromBefore: true } },
        { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
        { repeatCell: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredValue: { formulaValue: "=A2*2" } }, fields: "userEnteredValue" } },
        { deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 } } },
        { mergeCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }, mergeType: "MERGE_ALL" } },
        { addSheet: { properties: { title: "New" } } },
      ],
      meta,
    );
    expect(plan[0]).toMatchObject({ index: 0, type: "insertDimension", sheet: "תקציב 2026", count: 2 });
    expect(plan[0].effect).toMatch(/insert 2 rows at 5-6/);
    expect(plan[1]).toMatchObject({ type: "repeatCell", range: "Sheet1!A1:E1", cells: 5 });
    expect(plan[1].warning).toBeUndefined();
    expect(plan[2]).toMatchObject({ range: "Sheet1!C2:C3", cells: 2, warning: "overwrites values" });
    expect(plan[3]).toMatchObject({ type: "deleteDimension", warning: "destructive", count: 1 });
    expect(plan[3].effect).toMatch(/delete 1 columns \(B\)/);
    expect(plan[4].warning).toMatch(/top-left/);
    expect(plan[5].effect).toBe('add sheet "New"');
    expect(changeTotals(plan)).toEqual({ rowsInserted: 2, cellsFormatted: 5, cellsWritten: 2, columnsDeleted: 1, cellsMerged: 3, sheetsAdded: 1 });
  });

  it("counts findReplace from the reply and lists unknown types under other", () => {
    const plan = describeRequests([{ findReplace: { find: "a", replacement: "b", allSheets: true } }, { somethingNew: { x: 1 } }], meta);
    expect(changeTotals(plan, [{ findReplace: { valuesChanged: 3, formulasChanged: 1, occurrencesChanged: 4 } }, {}])).toEqual({ cellsReplaced: 4, other: ["somethingNew"] });
    expect(nonEmptyReply([{}, { a: 1 }], 0)).toBeUndefined();
    expect(nonEmptyReply([{}, { a: 1 }], 1)).toEqual({ a: 1 });
  });
});

describe("verifyCells", () => {
  it("lists error cells with Google's message and counts cells", async () => {
    const { g, calls } = fakeClient(() => ({
      sheets: [
        {
          properties: { title: "Sheet1" },
          data: [
            {
              startRow: 1,
              startColumn: 2,
              rowData: [
                { values: [{ formattedValue: "#REF!", effectiveValue: { errorValue: { type: "REF", message: "Unresolved sheet name 'NONEXISTENT'." } } }, { formattedValue: "3", effectiveValue: { numberValue: 3 } }] },
                { values: [{}, { formattedValue: "#DIV/0!", effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." } } }] },
              ],
            },
          ],
        },
      ],
    }));
    const v = await verifyCells(g, "sid", ["Sheet1!C2:D3"]);
    expect(calls[0].params.ranges).toEqual(["Sheet1!C2:D3"]);
    expect(v.cells).toBe(3);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([
      { cell: "Sheet1!C2", type: "REF", message: "Unresolved sheet name 'NONEXISTENT'." },
      { cell: "Sheet1!D3", type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." },
    ]);
    expect(await verifyCells(g, "sid", [])).toEqual({ cells: 0, errors: [], ok: true });
  });

  it("attachPreviews reads only warned, bounded ranges with FORMULA rendering", async () => {
    const { g, calls } = fakeClient(() => ({ valueRanges: [{ range: "Sheet1!C2:C3", values: [["=A2"], ["5"]] }] }));
    const plan = describeRequests(
      [
        { repeatCell: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredValue: { stringValue: "x" } }, fields: "userEnteredValue" } },
        { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } },
        { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 500 } } },
      ],
      meta,
    );
    await attachPreviews(g, "sid", plan, meta);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ ranges: ["Sheet1!C2:C3"], valueRenderOption: "FORMULA", prettyPrint: false });
    expect(plan[0].preview).toEqual({ range: "Sheet1!C2:C3", currentValues: [["=A2"], ["5"]] });
    expect(plan[1].preview).toBeUndefined();
  });

  it("attachPreviews reads at most GRID_READ_MAX_CELLS cells in all: the previews past it say so and are not read", async () => {
    const { g, calls } = fakeClient((_m, _url, _b, params) => ({ valueRanges: params.ranges.map((range: string) => ({ range, values: [["v"]] })) }));
    // 501 writes of 200 cells each (one column, 200 rows): 500 of them fill the 100,000-cell budget.
    const plan = describeRequests(
      Array.from({ length: 501 }, (_, i) => ({ repeatCell: { range: { sheetId: 0, startRowIndex: (i % 5) * 200, endRowIndex: (i % 5) * 200 + 200, startColumnIndex: i % 26, endColumnIndex: (i % 26) + 1 }, cell: { userEnteredValue: { stringValue: "x" } }, fields: "userEnteredValue" } })),
      meta,
    );
    await attachPreviews(g, "sid", plan, meta);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.ranges).toHaveLength(500);
    expect(plan[499].preview).toMatchObject({ currentValues: [["v"]] });
    expect(plan[500].preview).toEqual({ note: `preview skipped: this dry run's previews already cover the ${GRID_READ_MAX_CELLS}-cell read budget; read the range first if needed` });
  });
});

const byName = (n: string) => sheetsTools.find((t) => t.name === n)!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [] });

describe("sheets write tools verify their writes", () => {
  const errorGrid = { sheets: [{ properties: { title: "S" }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: [{ formattedValue: "#DIV/0!", effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." } } }] }] }] }] };

  it("sheets_write_range re-reads updatedRange and warns on error cells", async () => {
    const { g, calls } = fakeClient((m) => (m === "put" ? { updatedRange: "S!A1", updatedCells: 1 } : errorGrid));
    const r: any = await byName("sheets_write_range").handler({ spreadsheet_id: "sid", range: "S!A1", values: [["=1/0"]], value_input_option: "USER_ENTERED", include_values_in_response: false, verify: true }, ctx(g));
    expect(calls.map((c) => c.method)).toEqual(["put", "get"]);
    expect(calls[1].params.ranges).toEqual(["S!A1"]);
    expect(r.updatedCells).toBe(1);
    expect(r.verification).toEqual({ cells: 1, ok: false, errors: [{ cell: "S!A1", type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." }] });
    expect(r.warning).toMatch(/1 written cell\(s\) evaluate to an error: S!A1 DIVIDE_BY_ZERO/);
  });

  it("verify=false skips the re-read", async () => {
    const { g, calls } = fakeClient(() => ({ updatedRange: "S!A1", updatedCells: 1 }));
    const r: any = await byName("sheets_write_range").handler({ spreadsheet_id: "sid", range: "S!A1", values: [[1]], value_input_option: "USER_ENTERED", include_values_in_response: false, verify: false }, ctx(g));
    expect(calls).toHaveLength(1);
    expect(r.verification).toBeUndefined();
  });

  it("sheets_batch_write_ranges verifies every updatedRange in one read; append verifies updates.updatedRange", async () => {
    const okGrid = { sheets: [{ properties: { title: "S" }, data: [{ rowData: [{ values: [{ formattedValue: "2", effectiveValue: { numberValue: 2 } }] }] }] }] };
    const bw = fakeClient((m) => (m === "post" ? { totalUpdatedCells: 2, responses: [{ updatedRange: "S!A1", updatedCells: 1 }, { updatedRange: "S!B5", updatedCells: 1 }] } : okGrid));
    const r: any = await byName("sheets_batch_write_ranges").handler({ spreadsheet_id: "sid", data: [{ range: "S!A1", values: [[1]] }, { range: "S!B5", values: [[2]] }], value_input_option: "USER_ENTERED", verify: true }, ctx(bw.g));
    expect(bw.calls[1].params.ranges).toEqual(["S!A1", "S!B5"]);
    expect(r.verification.ok).toBe(true);
    expect(r.warning).toBeUndefined();

    const ap = fakeClient((m) => (m === "post" ? { tableRange: "S!A1:B3", updates: { updatedRange: "S!A4:B4", updatedCells: 2 } } : okGrid));
    const r2: any = await byName("sheets_append_rows").handler({ spreadsheet_id: "sid", range: "S", values: [[1, 2]], value_input_option: "USER_ENTERED", insert_data_option: "INSERT_ROWS", verify: true }, ctx(ap.g));
    expect(ap.calls[1].params.ranges).toEqual(["S!A4:B4"]);
    expect(r2.verification.ok).toBe(true);
  });
});

describe("sheets_batch_update_spreadsheet dry run and change summary", () => {
  const metaResp = { sheets: [{ properties: { sheetId: 0, title: "S", gridProperties: { rowCount: 100, columnCount: 26 } } }] };
  const requests = [
    { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 2, endIndex: 5 } } },
    { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    { updateCells: { start: { sheetId: 0, rowIndex: 9, columnIndex: 1 }, rows: [{ values: [{ userEnteredValue: { formulaValue: "=SUM(B2:B9)" } }] }], fields: "userEnteredValue" } },
  ];

  it("dry_run describes without posting and previews overwritten ranges", async () => {
    const { g, calls } = fakeClient((m, url) => (url.includes("values:batchGet") ? { valueRanges: [{ range: "S!B10", values: [["old"]] }] } : metaResp));
    const r: any = await byName("sheets_batch_update_spreadsheet").handler({ spreadsheet_id: "sid", requests, dry_run: true, verify: true, include_spreadsheet_in_response: false }, ctx(g));
    expect(calls.map((c) => c.method)).toEqual(["get", "get"]);
    expect(r.dryRun).toBe(true);
    expect(r.wrote).toBe(false);
    expect(r.totals).toEqual({ rowsInserted: 3, cellsFormatted: 4, cellsWritten: 1 });
    expect(r.requests[2]).toMatchObject({ type: "updateCells", range: "S!B10", warning: "overwrites values", preview: { range: "S!B10", currentValues: [["old"]] } });
    expect(r.warnings).toHaveLength(2);
  });

  it("a real run posts, summarizes totals/replies and verifies written cells", async () => {
    const okGrid = { sheets: [{ properties: { title: "S" }, data: [{ startRow: 9, startColumn: 1, rowData: [{ values: [{ formattedValue: "12", effectiveValue: { numberValue: 12 } }] }] }] }] };
    const { g, calls } = fakeClient((m, url) => (m === "post" ? { replies: [{}, {}, {}] } : url.includes("includeGridData") || calls.length > 2 ? okGrid : metaResp));
    const r: any = await byName("sheets_batch_update_spreadsheet").handler({ spreadsheet_id: "sid", requests, dry_run: false, verify: true, include_spreadsheet_in_response: false }, ctx(g));
    // get meta, post, verify the written block, then the post-check: the tabs after the batch and one grid read (insertDimension is structural).
    expect(calls.map((c) => c.method)).toEqual(["get", "post", "get", "get", "get"]);
    expect(calls[1].body.requests).toBe(requests);
    expect(calls[2].params.ranges).toEqual(["S!B10"]);
    expect(calls[4].params).toMatchObject({ includeGridData: true, ranges: undefined });
    expect(r.applied).toBe(3);
    expect(r.totals).toEqual({ rowsInserted: 3, cellsFormatted: 4, cellsWritten: 1 });
    expect(r.changes[0].effect).toMatch(/insert 3 rows at 3-5/);
    expect(r.changes[0].preview).toBeUndefined();
    expect(r.verification).toEqual({ cells: 1, errors: [], ok: true });
    expect(r.postCheck).toEqual({ sheets: ["S"], errorCount: 0, ok: true, errors: [] });
  });
});

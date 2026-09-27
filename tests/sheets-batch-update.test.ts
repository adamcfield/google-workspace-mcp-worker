/**
 * sheets_batch_update_spreadsheet after the JEV-build QA round: short replies, honest copyPaste
 * warnings, writeValues in the same ordered batch as structural changes, deletion previews that
 * show what is lost and what breaks, a post-structural-change error check, and opt-in snapshots.
 * Every test parses tool output as data (JSON), never as whitespace.
 */
import { describe, it, expect, vi } from "vitest";
import { ok, type AnyRec } from "../src/tools/_shared.js";
import { GoogleApiError } from "../src/google/client.js";
import { sheetsTools } from "../src/tools/sheets.js";
import {
  GRID_READ_MAX_CELLS,
  MAX_SHEET_TITLE,
  POST_CHECK_STATE_NOTE,
  blockOf,
  changeTotals,
  describeRequests,
  expandRequests,
  gridReadTabs,
  groupWarnings,
  laterMovers,
  lossySheetIds,
  movesBlock,
  planSnapshot,
  repliesByRequest,
  rereadCost,
  resolveWriteValues,
  snapshotRequests,
  titlesAfter,
  UNLOCATED,
  UNTRACKED,
  WRITE_VALUES_MAX_CELLS,
  WRITE_VALUES_MAX_UPDATES,
  writeValuesRequests,
  writtenBlock,
  type SheetMeta,
} from "../src/tools/sheets-verify.js";
import { connectInMemory } from "./helpers/mcp.js";
import { answerGridRead } from "./helpers/sheets-grid.js";
import { ALL_TOOLS } from "../src/tools/_groups.js";
import { buildManifest } from "../src/tools/_manifest.js";
import { gateTools, readMutationIntent, OWN_EVIDENCE_CUES } from "../src/routing/gate.js";
import { selectTools } from "../src/routing/select.js";
import { VERB_KINDS } from "../src/tools/naming.js";

const tool = sheetsTools.find((t) => t.name === "sheets_batch_update_spreadsheet")!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [] });
/** What the handler gets after zod applied the defaults. */
const args = (extra: AnyRec) => ({ spreadsheet_id: "sid", dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false, ...extra });
/** The wire text a caller reads, parsed back — never asserted on whitespace. */
const wire = (data: unknown) => ok(data).content[0].text;

const meta: SheetMeta = {
  titles: new Map([[0, "Data"], [1, "Summary"]]),
  ids: new Map([["Data", 0], ["Summary", 1]]),
  grids: new Map([[0, { rowCount: 100, columnCount: 26 }], [1, { rowCount: 100, columnCount: 26 }]]),
  namedRanges: [],
};
const metaResp = {
  sheets: [
    { properties: { sheetId: 0, title: "Data", gridProperties: { rowCount: 100, columnCount: 26 } } },
    { properties: { sheetId: 1, title: "Summary", gridProperties: { rowCount: 100, columnCount: 26 } } },
  ],
};

const num = (n: number) => ({ userEnteredValue: { numberValue: n }, effectiveValue: { numberValue: n }, formattedValue: String(n) });
const str = (s: string) => ({ userEnteredValue: { stringValue: s }, effectiveValue: { stringValue: s }, formattedValue: s });
const formula = (f: string, v: number) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: { numberValue: v }, formattedValue: String(v) });
const refError = (f: string) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: { errorValue: { type: "REF", message: "Reference does not exist." } }, formattedValue: "#REF!" });

/**
 * Data                              Summary
 *      A    B            C               A          B                  C          D
 * 1   Item Amount                   1   =Data!B2   =SUM(Data!B2:B5)   =Data!B5   =MAX(Data!B:B)
 * 2   x    10    =B2*2   <- deleted
 * 3   y    20            <- deleted
 * 4   z    30    =B3*2
 * 5   w    40
 * 6        =SUM(B2:B5)
 */
const gridsBefore = {
  sheets: [
    {
      properties: { sheetId: 0, title: "Data" },
      data: [
        {
          rowData: [
            { values: [str("Item"), str("Amount")] },
            { values: [str("x"), num(10), formula("=B2*2", 20)] },
            { values: [str("y"), num(20)] },
            { values: [str("z"), num(30), formula("=B3*2", 40)] },
            { values: [str("w"), num(40)] },
            { values: [{}, formula("=SUM(B2:B5)", 100)] },
          ],
        },
      ],
    },
    {
      properties: { sheetId: 1, title: "Summary" },
      data: [{ rowData: [{ values: [formula("=Data!B2", 10), formula("=SUM(Data!B2:B5)", 100), formula("=Data!B5", 40), formula("=MAX(Data!B:B)", 40)] }] }],
    },
  ],
};
/** After deleting Data rows 2-3: Summary!A1 lost its only input. */
const gridsAfterDelete = {
  sheets: [
    { properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [{ values: [str("Item"), str("Amount")] }, { values: [str("z"), num(30), refError("=#REF!*2")] }] }] },
    { properties: { sheetId: 1, title: "Summary" }, data: [{ rowData: [{ values: [refError("=#REF!"), formula("=SUM(Data!B2:B3)", 70)] }] }] },
  ],
};

const deleteRows23 = { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 3 } } };
const bold = (row: number) => ({ repeatCell: { range: { sheetId: 0, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 8 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } });

/** Fake GoogleClient: records calls and answers from a routing function (same shape as sheets-verify.test.ts). */
function fakeClient(route: (method: string, url: string, body: any, params: any, n: number) => any) {
  const calls: { method: string; url: string; body?: any; params?: any }[] = [];
  const make = (method: string) => async (url: string, a?: any, b?: any) => {
    const [body, params] = method === "get" ? [undefined, a] : [a, b];
    calls.push({ method, url, body, params });
    return route(method, url, body, params, calls.length);
  };
  return { g: { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), delete: make("delete") } as any, calls };
}
const isGridRead = (params: any) => params?.includeGridData === true;
/** A grid read answers as Google does: the ranges it names under Google's A1 rules, each cell under its field mask. */
const named = answerGridRead;
/** Tab metadata for a meta read, `rows` rows × 26 columns per tab. */
const tabsMeta = (tabs: [number, string, number][]) => ({ sheets: tabs.map(([sheetId, title, rowCount]) => ({ properties: { sheetId, title, gridProperties: { rowCount, columnCount: 26 } } })) });
/** Rows of 26 columns that together make up `cells` grid cells (rounded up). */
const rowsFor = (cells: number) => Math.ceil(cells / 26);
const isMetaRead = (m: string, url: string, params: any) => m === "get" && !isGridRead(params) && !url.includes("values:batchGet");

describe("(a) reply=summary: a short reply for a big batch", () => {
  const requests = Array.from({ length: 49 }, (_, i) => bold(i));
  const client = () => fakeClient((m, url, _b, params) => (m === "post" ? { replies: requests.map(() => ({})) } : isMetaRead(m, url, params) ? metaResp : {}));

  it("49 identical formatting requests produce a summary reply under 1,500 characters (the QA reply was 11.7K)", async () => {
    const { g, calls } = client();
    const summary: any = await tool.handler(args({ requests }), ctx(g));
    const text = wire(summary);
    expect(text.length, `${text.length} chars`).toBeLessThan(1_500);
    const parsed = JSON.parse(text);
    expect(parsed.applied).toBe(49);
    expect(parsed.totals).toEqual({ cellsFormatted: 49 * 8 });
    // Nothing to warn about and no reply from Google: no per-request restatement at all.
    expect(parsed.changes).toBeUndefined();
    expect(parsed.warnings).toBeUndefined();
    expect(calls.filter((c) => c.method === "post")).toHaveLength(1);

    // reply="full" is still today's shape: every request restated.
    const full: any = await tool.handler(args({ requests, reply: "full" }), ctx(client().g));
    const fullParsed = JSON.parse(wire(full));
    expect(fullParsed.changes).toHaveLength(49);
    expect(wire(full).length).toBeGreaterThan(5 * text.length);
  });

  it("the default on the wire is summary (zod default), measured on the real tools/call text", async () => {
    const { g } = client();
    const { client: mcp, close } = await connectInMemory({ ctx: { g } });
    try {
      const res: any = await mcp.callTool({ name: "sheets_batch_update_spreadsheet", arguments: { spreadsheet_id: "sid", requests } });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text.length).toBeLessThan(1_500);
      expect(JSON.parse(res.content[0].text)).toEqual({ applied: 49, totals: { cellsFormatted: 392 } });
    } finally {
      await close();
    }
  });

  it("warnings are listed once per distinct text, with request indexes, and changes do not repeat them", async () => {
    const writes = Array.from({ length: 25 }, (_, i) => ({ repeatCell: { range: { sheetId: 0, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredValue: { stringValue: "x" } }, fields: "userEnteredValue" } }));
    const okGrid = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [] }] }] };
    const { g } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: writes.map(() => ({})) } : isMetaRead(m, url, params) ? metaResp : okGrid));
    const r = JSON.parse(wire(await tool.handler(args({ requests: [bold(0), ...writes] }), ctx(g))));
    expect(r.warnings).toEqual([{ warning: "overwrites values", requests: Array.from({ length: 25 }, (_, i) => i + 1), types: ["repeatCell"] }]);
    expect(r.changes).toHaveLength(20);
    expect(r.changesOmitted).toBe(5);
    for (const c of r.changes) {
      expect(c.warning).toBeUndefined();
      expect(Object.keys(c)).toEqual(["index", "type", "range", "effect"]);
    }
  });

  it("a dry run keeps the full per-request plan but groups its warnings too", async () => {
    const dels = [0, 1, 2].map((i) => ({ deleteDimension: { range: { sheetId: 1, dimension: "ROWS", startIndex: 10 + i, endIndex: 11 + i } } }));
    const { g } = fakeClient((m, url, _b, params) => (isGridRead(params) ? gridsBefore : metaResp));
    const r = JSON.parse(wire(await tool.handler(args({ dry_run: true, requests: dels }), ctx(g))));
    expect(r.requests).toHaveLength(3);
    expect(r.requests.map((p: AnyRec) => p.warning)).toEqual(["destructive", "destructive", "destructive"]);
    expect(r.warnings).toEqual([{ warning: "destructive", requests: [0, 1, 2], types: ["deleteDimension"] }]);
    // Each later delete follows an earlier one on the same tab, so its preview is flagged as approximate.
    expect(r.requests[0].preview.caveat).toBeUndefined();
    expect(r.requests[2].preview.caveat).toMatch(/request #1 reshapes this tab first/);
  });

  it("groupWarnings merges identical texts across request types", () => {
    const plan = describeRequests([deleteRows23, { deleteRange: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, shiftDimension: "ROWS" } }, bold(0)], meta);
    expect(groupWarnings(plan)).toEqual([{ warning: "destructive", requests: [0, 1], types: ["deleteDimension", "deleteRange"] }]);
  });
});

describe("(b) copyPaste: a formatting-only paste is not an overwrite", () => {
  const src = { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 };
  const dst = { sheetId: 1, startRowIndex: 4, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 3 };
  const paste = (pasteType?: string) => ({ copyPaste: { source: src, destination: dst, ...(pasteType ? { pasteType } : {}) } });

  it("PASTE_FORMAT carries no 'destination overwritten' warning and counts cellsFormatted, not cellsWritten", () => {
    const [p] = describeRequests([paste("PASTE_FORMAT")], meta);
    expect(p.warning).toBeUndefined();
    expect(p.effect).toMatch(/replaces the destination's formatting and data validation; values unchanged/);
    expect(p).toMatchObject({ range: "Summary!A5:C6", cells: 6 });
    expect(changeTotals([p])).toEqual({ cellsFormatted: 6 });
    // Not lossy either, so it never asks for (or takes) a snapshot.
    expect(lossySheetIds([p], [paste("PASTE_FORMAT")], meta)).toEqual([]);
  });

  it("PASTE_CONDITIONAL_FORMATTING and PASTE_DATA_VALIDATION change no values either", () => {
    const plan = describeRequests([paste("PASTE_CONDITIONAL_FORMATTING"), paste("PASTE_DATA_VALIDATION")], meta);
    expect(plan.map((p) => p.warning)).toEqual([undefined, undefined]);
    expect(plan[0].effect).toMatch(/conditional formatting; values unchanged/);
    expect(plan[1].effect).toMatch(/data validation; values unchanged/);
    expect(changeTotals(plan)).toEqual({ cellsFormatted: 12 });
  });

  it("value pastes — PASTE_NORMAL (default), PASTE_VALUES, PASTE_FORMULA and PASTE_NO_BORDERS — still warn and count cellsWritten", () => {
    const plan = describeRequests([paste(), paste("PASTE_VALUES"), paste("PASTE_FORMULA"), paste("PASTE_NO_BORDERS")], meta);
    expect(plan.map((p) => p.warning)).toEqual(Array(4).fill("destination overwritten"));
    expect(changeTotals(plan)).toEqual({ cellsWritten: 24 });
  });

  it("the paste area follows Google: a smaller destination still receives the whole source", () => {
    const [p] = describeRequests([{ copyPaste: { source: src, destination: { sheetId: 1, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 }, pasteType: "PASTE_FORMAT" } }], meta);
    expect(p).toMatchObject({ range: "Summary!B10:D11", cells: 6 });
  });

  it("a TRANSPOSE paste lands on the source's shape turned sideways: 1×5 onto one cell is A1:A5, not A1:E1", () => {
    // Before: the un-transposed A1:E1 was reported (and previewed), while Google overwrites A1:A5.
    const row = { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 };
    const one = { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 };
    const [p] = describeRequests([{ copyPaste: { source: row, destination: one, pasteType: "PASTE_VALUES", pasteOrientation: "TRANSPOSE" } }], meta);
    expect(p).toMatchObject({ range: "Summary!A1:A5", cells: 5, warning: "destination overwritten" });
    expect(p.effect).toBe("copy Data!A1:E1 to Summary!A1:A5, transposed (PASTE_VALUES)");
    // NORMAL orientation (explicit or omitted) keeps the source's shape.
    const [q] = describeRequests([{ copyPaste: { source: row, destination: one, pasteType: "PASTE_VALUES", pasteOrientation: "NORMAL" } }], meta);
    expect(q.range).toBe("Summary!A1:E1");
    // A destination that is a whole multiple of the TRANSPOSED block is filled with repeats of it.
    const [r] = describeRequests([{ copyPaste: { source: src, destination: { sheetId: 1, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 4 }, pasteOrientation: "TRANSPOSE" } }], meta);
    expect(r).toMatchObject({ range: "Summary!A1:D6", cells: 24 });
  });

  it("a TRANSPOSE dry run previews the cells Google really overwrites", async () => {
    const row = { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 };
    const one = { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 };
    const { g, calls } = fakeClient((m, url, _b, params) => (url.includes("values:batchGet") ? { valueRanges: [{ range: "Summary!A1:A5", values: [["a"], ["b"]] }] } : isMetaRead(m, url, params) ? metaResp : {}));
    const r: any = await tool.handler(args({ dry_run: true, requests: [{ copyPaste: { source: row, destination: one, pasteType: "PASTE_VALUES", pasteOrientation: "TRANSPOSE" } }] }), ctx(g));
    expect(calls.find((c) => c.url.includes("values:batchGet"))?.params.ranges).toEqual(["Summary!A1:A5"]);
    expect(r.requests[0].preview).toEqual({ range: "Summary!A1:A5", currentValues: [["a"], ["b"]] });
  });

  it("a real run of PASTE_FORMAT reports no warning at all (the QA false alarm)", async () => {
    const { g } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isMetaRead(m, url, params) ? metaResp : {}));
    const r = JSON.parse(wire(await tool.handler(args({ requests: [paste("PASTE_FORMAT")] }), ctx(g))));
    expect(r).toEqual({ applied: 1, totals: { cellsFormatted: 6 } });
  });
});

describe("(c) writeValues: values and structure in one ordered, atomic call", () => {
  it("translates numbers, booleans, formulas, text and '' into one updateCells", () => {
    const t = resolveWriteValues({ range: "'Data'!B2:D3", values: [[1, true, "=A1*2"], ["text", "", 3.5]] }, 0, meta);
    expect(t).toMatchObject({ sheetId: 0, cells: 6, range: { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 4 } });
    expect(writeValuesRequests(t)).toEqual([
      {
        updateCells: {
          start: { sheetId: 0, rowIndex: 1, columnIndex: 1 },
          rows: [
            { values: [{ userEnteredValue: { numberValue: 1 } }, { userEnteredValue: { boolValue: true } }, { userEnteredValue: { formulaValue: "=A1*2" } }] },
            // '' is an empty CellData under fields=userEnteredValue: it clears the value, formatting kept.
            { values: [{ userEnteredValue: { stringValue: "text" } }, {}, { userEnteredValue: { numberValue: 3.5 } }] },
          ],
          fields: "userEnteredValue",
        },
      },
    ]);
  });

  it("null skips a cell: the block splits into one updateCells per run of values, in order", () => {
    const t = resolveWriteValues({ range: "Data!A1:C2", values: [[1, null, 3], [null, null, 4]] }, 0, meta);
    expect(t.cells).toBe(3);
    expect(writeValuesRequests(t).map((r) => [r.updateCells.start, r.updateCells.rows])).toEqual([
      [{ sheetId: 0, rowIndex: 0, columnIndex: 0 }, [{ values: [{ userEnteredValue: { numberValue: 1 } }] }]],
      [{ sheetId: 0, rowIndex: 0, columnIndex: 2 }, [{ values: [{ userEnteredValue: { numberValue: 3 } }] }]],
      [{ sheetId: 0, rowIndex: 1, columnIndex: 2 }, [{ values: [{ userEnteredValue: { numberValue: 4 } }] }]],
    ]);
  });

  it("only rows holding a null are split: a 1,000-row block with one null is two updateCells, not 1,000", () => {
    const values: (number | null)[][] = Array.from({ length: 1000 }, (_, i) => [i, i * 2]);
    values[0][1] = null;
    const reqs = writeValuesRequests(resolveWriteValues({ range: "Data!A1:B1000", values }, 0, meta));
    expect(reqs).toHaveLength(2);
    expect(reqs[0].updateCells.start).toEqual({ sheetId: 0, rowIndex: 0, columnIndex: 0 });
    expect(reqs[0].updateCells.rows).toEqual([{ values: [{ userEnteredValue: { numberValue: 0 } }] }]);
    expect(reqs[1].updateCells.start).toEqual({ sheetId: 0, rowIndex: 1, columnIndex: 0 });
    expect(reqs[1].updateCells.rows).toHaveLength(999);
    // Null-free runs on either side of a split row stay whole and keep their order.
    const mid = writeValuesRequests(resolveWriteValues({ range: "Data!A1:B4", values: [[1, 2], [3, 4], [null, 5], [6, 7]] }, 0, meta));
    expect(mid.map((r) => [r.updateCells.start.rowIndex, r.updateCells.start.columnIndex, r.updateCells.rows.length])).toEqual([[0, 0, 2], [2, 1, 1], [3, 0, 1]]);
  });

  it("rejects a range whose shape does not match the values, naming the block that would fit", () => {
    // The QA slip: a value meant for column D landing in C. A block one column short is an error, not a shifted write.
    expect(() => resolveWriteValues({ range: "'Data'!A1:C2", values: [[1, 2, 3, 4], [5, 6, 7, 8]] }, 3, meta)).toThrow(
      "writeValues (request #3): range 'Data'!A1:C2 is 2 row(s) x 3 column(s) but values is 2 x 4 — the block for this array is Data!A1:D2",
    );
    expect(() => resolveWriteValues({ range: "Data!D5", values: [["note", "extra"]] }, 0, meta)).toThrow(/is 1 row\(s\) x 1 column\(s\) but values is 1 x 2 — the block for this array is Data!D5:E5/);
  });

  it("rejects an unknown tab, a range without a tab, an unbounded range, bad cells and extra keys", () => {
    expect(() => resolveWriteValues({ range: "Nope!A1", values: [[1]] }, 0, meta)).toThrow("writeValues (request #0): no tab named 'Nope'. Tabs: Data, Summary");
    expect(() => resolveWriteValues({ range: "A1:B1", values: [[1, 2]] }, 0, meta)).toThrow(/names no tab/);
    expect(() => resolveWriteValues({ range: "Data!A:B", values: [[1, 2]] }, 0, meta)).toThrow(/bounded block/);
    expect(() => resolveWriteValues({ range: "Data!A1", values: [[{ x: 1 }]] }, 0, meta)).toThrow(/cells must be strings, finite numbers, booleans or null/);
    expect(() => resolveWriteValues({ range: "Data!A1", values: [[null]] }, 0, meta)).toThrow(/every cell is null/);
    expect(() => resolveWriteValues({ range: "Data!A1", values: [[1]], value_input_option: "RAW" }, 0, meta)).toThrow(/takes only sheetId, range and values/);
    expect(() => expandRequests([{ writeValues: { range: "Data!A1", values: [[1]] }, deleteDimension: {} }], meta)).toThrow(/exactly one request/);
  });

  it("writeValues then deleteDimension is ONE Google call with the translated updateCells first", async () => {
    const del = { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 5, endIndex: 6 } } };
    const requests = [{ writeValues: { range: "Data!A2:B2", values: [["q", 5]] } }, del];
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}, {}] } : isMetaRead(m, url, params) ? metaResp : gridsBefore));
    const r = JSON.parse(wire(await tool.handler(args({ requests }), ctx(g))));
    const posts = calls.filter((c) => c.method === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.requests).toHaveLength(2);
    expect(posts[0].body.requests[0]).toEqual({
      updateCells: { start: { sheetId: 0, rowIndex: 1, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: "q" } }, { userEnteredValue: { numberValue: 5 } }] }], fields: "userEnteredValue" },
    });
    expect(posts[0].body.requests[1]).toBe(del);
    expect(r.totals).toEqual({ cellsWritten: 2, rowsDeleted: 1 });
    expect(r.warnings).toEqual([
      { warning: "overwrites values", requests: [0], types: ["writeValues"] },
      { warning: "destructive", requests: [1], types: ["deleteDimension"] },
    ]);
    // Row 6 is below the written row 2: the delete does not move it, so it is re-read like any value write.
    // Before: every write followed by any structural request on its tab was skipped and called "moved".
    expect(calls.filter((c) => c.params?.ranges?.[0] === "Data!A2:B2").map((c) => c.params.ranges)).toEqual([["Data!A2:B2"]]);
    expect(r.note).toBeUndefined();
    expect(r.verification).toBeDefined();
    expect(r.postCheck.sheets).toEqual(["Data", "Summary"]);
  });

  it("the QA scenario: a delete far below the write still verifies it (post_check off)", async () => {
    const requests = [{ writeValues: { range: "Data!A2:B2", values: [["q", "=1/0"]] } }, { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 50, endIndex: 51 } } }];
    const verifyGrid = { sheets: [{ properties: { title: "Data" }, data: [{ startRow: 1, rowData: [{ values: [str("q"), { formattedValue: "#DIV/0!", effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." } } }] }] }] }] };
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}, {}] } : isMetaRead(m, url, params) ? metaResp : verifyGrid));
    const r = JSON.parse(wire(await tool.handler(args({ post_check: false, requests }), ctx(g))));
    expect(calls.map((c) => c.method)).toEqual(["get", "post", "get"]);
    expect(calls[2].params.ranges).toEqual(["Data!A2:B2"]);
    expect(r.verification).toEqual({ cells: 2, ok: false, errors: [{ cell: "Data!B2", type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." }] });
    expect(r.note).toBeUndefined();
  });

  it("a delete ABOVE the write moves it: not re-read at stale coordinates, and the note names the range and the request", async () => {
    const requests = [{ writeValues: { range: "Data!A5:B5", values: [["q", 5]] } }, deleteRows23];
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}, {}] } : isGridRead(params) ? gridsAfterDelete : metaResp));
    const r = JSON.parse(wire(await tool.handler(args({ requests }), ctx(g))));
    expect(calls.filter((c) => c.params?.ranges?.[0] === "Data!A5:B5")).toHaveLength(0);
    expect(r.verification).toBeUndefined();
    expect(r.note).toBe("1 written range(s) not re-read because a later request in this batch moves or deletes their cells: Data!A5:B5 (by #1 deleteDimension); postCheck re-read their tab(s)");
    expect(r.postCheck.sheets).toEqual(["Data", "Summary"]);
  });

  it("the note claims postCheck coverage only for tabs postCheck actually re-read", async () => {
    // Data is 1.3M grid cells: postCheck skips it, so it must not say it covered the moved write.
    const huge = tabsMeta([[0, "Data", 50_000], [1, "Summary", 100]]);
    const { g } = fakeClient((m, _url, _b, params) => (m === "post" ? { replies: [{}, {}] } : named(params, huge)));
    const r: any = await tool.handler(args({ requests: [{ writeValues: { range: "Data!A5:B5", values: [["q", 5]] } }, deleteRows23] }), ctx(g));
    expect(r.postCheck.skipped).toEqual(["Data"]);
    expect(r.postCheck.sheets).toEqual(["Summary"]);
    expect(r.note).toBe("1 written range(s) not re-read because a later request in this batch moves or deletes their cells: Data!A5:B5 (by #1 deleteDimension)");
  });

  it("a writeValues AFTER the structural change is verified like any value write", async () => {
    const requests = [deleteRows23, { writeValues: { range: "Data!A2:B2", values: [["q", "=1/0"]] } }];
    const verifyGrid = { sheets: [{ properties: { title: "Data" }, data: [{ startRow: 1, rowData: [{ values: [str("q"), { formattedValue: "#DIV/0!", effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." } } }] }] }] }] };
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}, {}] } : isMetaRead(m, url, params) ? metaResp : Array.isArray(params?.ranges) ? verifyGrid : gridsAfterDelete));
    const r = JSON.parse(wire(await tool.handler(args({ requests }), ctx(g))));
    const verify = calls.find((c) => Array.isArray(c.params?.ranges));
    expect(verify?.params.ranges).toEqual(["Data!A2:B2"]);
    expect(r.verification).toEqual({ cells: 2, ok: false, errors: [{ cell: "Data!B2", type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." }] });
    expect(r.warning).toMatch(/1 written cell\(s\) evaluate to an error: Data!B2 DIVIDE_BY_ZERO/);
  });

  it("a dry run describes writeValues as a value write and previews the cells it overwrites", async () => {
    const { g, calls } = fakeClient((m, url, _b, params) => (url.includes("values:batchGet") ? { valueRanges: [{ range: "Data!A2:B2", values: [["x", 10]] }] } : isMetaRead(m, url, params) ? metaResp : {}));
    const r: any = await tool.handler(args({ dry_run: true, requests: [{ writeValues: { range: "Data!A2:B2", values: [["q", 5]] } }] }), ctx(g));
    expect(calls.map((c) => c.method)).toEqual(["get", "get"]);
    expect(calls[1].params).toEqual({ ranges: ["Data!A2:B2"], valueRenderOption: "FORMULA", prettyPrint: false });
    expect(r.requests[0]).toMatchObject({ type: "writeValues", range: "Data!A2:B2", cells: 2, warning: "overwrites values", preview: { range: "Data!A2:B2", currentValues: [["x", 10]] } });
    expect(r.requests[0].effect).toMatch(/existing values overwritten/);
    expect(r.totals).toEqual({ cellsWritten: 2 });
  });

  it("a shape mismatch fails before anything is written", async () => {
    const { g, calls } = fakeClient(() => metaResp);
    await expect(tool.handler(args({ requests: [{ writeValues: { range: "Data!A1:B1", values: [[1, 2, 3]] } }] }), ctx(g))).rejects.toThrow(/the block for this array is Data!A1:C1/);
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("Google's replies are re-indexed to the caller's requests when writeValues expands", () => {
    const { origin } = expandRequests([{ writeValues: { range: "Data!A1:C1", values: [[1, null, 3]] } }, { findReplace: { find: "a", replacement: "b", allSheets: true } }], meta);
    expect(origin).toEqual([0, 0, 1]);
    expect(repliesByRequest([{}, {}, { findReplace: { valuesChanged: 2 } }], origin, 2)).toEqual([{}, { findReplace: { valuesChanged: 2 } }]);
  });
});

describe("(c) writeValues with sheetId: the tab once, not in every range", () => {
  // A long Hebrew tab title is exactly what a caller should not have to repeat (quoted) in every range.
  const budget = "תקציב 2026 — תחזית רבעונית";
  const heMeta: SheetMeta = {
    titles: new Map([[0, "Data"], [123, budget]]),
    ids: new Map([["Data", 0], [budget, 123]]),
    grids: new Map([[0, { rowCount: 100, columnCount: 26 }], [123, { rowCount: 100, columnCount: 26 }]]),
    namedRanges: [],
  };
  const heMetaResp = { sheets: [{ properties: { sheetId: 0, title: "Data", gridProperties: { rowCount: 100, columnCount: 26 } } }, { properties: { sheetId: 123, title: budget, gridProperties: { rowCount: 100, columnCount: 26 } } }] };

  it("sheetId + an unqualified range resolves exactly like the range with its tab", () => {
    const short = resolveWriteValues({ sheetId: 123, range: "B2:C3", values: [[1, "=A1"], ["x", ""]] }, 0, heMeta);
    const long = resolveWriteValues({ range: `'${budget}'!B2:C3`, values: [[1, "=A1"], ["x", ""]] }, 0, heMeta);
    expect(short).toEqual(long);
    expect(short).toMatchObject({ sheetId: 123, cells: 4, range: { sheetId: 123, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 3 } });
    expect(writeValuesRequests(short)[0].updateCells.start).toEqual({ sheetId: 123, rowIndex: 1, columnIndex: 1 });
    // A range that names the same tab as sheetId is fine too; the plan always shows the tab.
    expect(resolveWriteValues({ sheetId: 123, range: `'${budget}'!B2:C3`, values: [[1, 2], [3, 4]] }, 0, heMeta).sheetId).toBe(123);
    const [p] = describeRequests([{ writeValues: { sheetId: 123, range: "B2:C3", values: [[1, 2], [3, 4]] } }], heMeta);
    expect(p).toMatchObject({ sheet: budget, range: `'${budget}'!B2:C3`, cells: 4, warning: "overwrites values" });
  });

  it("rejects a tab that conflicts with sheetId, an unknown sheetId, a non-integer sheetId — and still an unqualified range without one", () => {
    expect(() => resolveWriteValues({ sheetId: 123, range: "Data!A1", values: [[1]] }, 2, heMeta)).toThrow(
      `writeValues (request #2): range "Data!A1" names tab 'Data' but sheetId 123 is '${budget}' — drop the tab from the range or make them agree`,
    );
    expect(() => resolveWriteValues({ sheetId: 0, range: `'${budget}'!A1`, values: [[1]] }, 0, heMeta)).toThrow(/names tab 'תקציב 2026 — תחזית רבעונית' but sheetId 0 is 'Data'/);
    expect(() => resolveWriteValues({ sheetId: 7, range: "A1", values: [[1]] }, 0, heMeta)).toThrow(`writeValues (request #0): no tab with sheetId 7. Tabs: Data (0), ${budget} (123)`);
    expect(() => resolveWriteValues({ sheetId: "123", range: "A1", values: [[1]] }, 0, heMeta)).toThrow(/sheetId must be a tab's integer sheetId/);
    expect(() => resolveWriteValues({ sheetId: 1.5, range: "A1", values: [[1]] }, 0, heMeta)).toThrow(/sheetId must be a tab's integer sheetId/);
    expect(() => resolveWriteValues({ range: "A1:B1", values: [[1, 2]] }, 0, heMeta)).toThrow(`writeValues (request #0): range "A1:B1" names no tab — write it as "'Tab'!A1:C2" or pass sheetId`);
    // The shape check names the block with the tab sheetId stands for.
    expect(() => resolveWriteValues({ sheetId: 123, range: "A1:B1", values: [[1, 2, 3]] }, 0, heMeta)).toThrow(`the block for this array is '${budget}'!A1:C1`);
  });

  it("one call writes values by sheetId and deletes rows: one Google call, verified under the quoted Hebrew title, backed up by sheetId", async () => {
    const { g, calls } = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.duplicateSheet) return { replies: body.requests.map((q: AnyRec) => (q.duplicateSheet ? { duplicateSheet: { properties: { sheetId: q.duplicateSheet.newSheetId, title: q.duplicateSheet.newSheetName } } } : {})) };
      if (m === "post") return { replies: body.requests.map(() => ({})) };
      // The verify re-read of the written block, then the post-check's grid read.
      if (isGridRead(params) && params.ranges?.[0]?.includes("A2:B2")) return { sheets: [{ properties: { title: budget }, data: [{ startRow: 1, rowData: [{ values: [str("q"), num(5)] }] }] }] };
      if (isGridRead(params)) return named(params, { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [] }, { properties: { sheetId: 123, title: budget }, data: [] }] });
      return heMetaResp;
    });
    const requests = [{ writeValues: { sheetId: 123, range: "A2:B2", values: [["q", 5]] } }, { deleteDimension: { range: { sheetId: 123, dimension: "ROWS", startIndex: 50, endIndex: 51 } } }];
    const r = JSON.parse(wire(await tool.handler(args({ snapshot: true, requests }), ctx(g))));
    const posts = calls.filter((c) => c.method === "post");
    expect(posts).toHaveLength(2);
    expect(posts[0].body.requests[0].duplicateSheet).toMatchObject({ sourceSheetId: 123 });
    expect(posts[1].body.requests[0]).toEqual({ updateCells: { start: { sheetId: 123, rowIndex: 1, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: "q" } }, { userEnteredValue: { numberValue: 5 } }] }], fields: "userEnteredValue" } });
    expect(calls.filter((c) => isGridRead(c.params) && c.params.ranges?.[0]?.includes("A2:B2")).map((c) => c.params.ranges)).toEqual([[`'${budget}'!A2:B2`]]);
    expect(r.verification).toEqual({ cells: 2, ok: true });
    expect(r.snapshot).toHaveLength(1);
    expect(r.snapshot[0].sheet).toBe(budget);
    expect(r.snapshot[0].backupTitle.length).toBeLessThanOrEqual(MAX_SHEET_TITLE);
    expect(r.warnings[0]).toEqual({ warning: "overwrites values", requests: [0], types: ["writeValues"] });
  });

  it("a block of 200,000 rows resolves (no argument-spread limit on its width)", () => {
    // Before: Math.max(...rows.map(length)) threw "Maximum call stack size exceeded" past about 120K rows.
    const values = Array.from({ length: 200_000 }, (_, i) => [i]);
    expect(resolveWriteValues({ sheetId: 0, range: "A1:A200000", values }, 0, heMeta).cells).toBe(200_000);
  });

  describe("writeValues is capped per batch: the body built for Google stays bounded", () => {
    // Every value becomes a CellData pair and every run an updateCells object, all alive while the body is
    // serialized. Uncapped, 1,000 x 500 values with alternating nulls became 250,000 updateCells and ran out of a
    // 128 MB heap; 120,000 x 5 dense values too. The caps refuse such a batch before anything is read or written.
    const bigMeta = { sheets: [{ properties: { sheetId: 0, title: "Data", gridProperties: { rowCount: 300_000, columnCount: 1_000 } } }] };
    const run = async (values: unknown[][], range: string, extra: AnyRec = {}) => {
      const { g, calls } = fakeClient((m, _url, body) => (m === "post" ? { replies: body.requests.map(() => ({})) } : bigMeta));
      const requests = [{ writeValues: { sheetId: 0, range, values } }, { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 299_000, endIndex: 299_001 } } }];
      try {
        const r = JSON.parse(wire(await tool.handler(args({ requests, verify: false, post_check: false, ...extra }), ctx(g))));
        return { r, calls };
      } catch (err) {
        return { err: err as Error, calls };
      }
    };
    const updateCellsSent = (calls: { method: string; body?: any }[]) => calls.filter((c) => c.method === "post").reduce((n, c) => n + c.body.requests.filter((q: AnyRec) => q.updateCells).length, 0);
    const alternating = (rows: number, cols: number) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ((r + c) % 2 ? null : r * cols + c)));
    const colA1 = (n: number) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

    it("1,000 x 500 values with alternating nulls (250,000 one-cell runs) is refused before anything is written", async () => {
      const { err, calls } = await run(alternating(1_000, 500), `A1:${colA1(500)}1000`);
      expect(err?.message).toBe(
        `writeValues: this batch writes 250000 values, over the ${WRITE_VALUES_MAX_CELLS} one batch may translate — write large blocks with sheets_write_range or sheets_batch_write_ranges (they send the values as given), and keep writeValues for the values that must be ordered with structural requests in this batch. Nothing was written`,
      );
      // Only the tab metadata was read: no grid read, no batch sent (it was 250,000 updateCells before the cap).
      expect(calls.map((c) => c.method)).toEqual(["get"]);
      expect(updateCellsSent(calls)).toBe(0);
    });

    it("200,000 x 1 and 120,000 x 5 dense values are refused too, and so is a dry run of them", async () => {
      const tall = Array.from({ length: 200_000 }, (_, i) => [i]);
      for (const extra of [{}, { dry_run: true }]) {
        const { err, calls } = await run(tall, "A1:A200000", extra);
        expect(err?.message).toMatch(/^writeValues: this batch writes 200000 values, over the 100000 one batch may translate — write large blocks with sheets_write_range/);
        expect(calls.filter((c) => c.method === "post")).toEqual([]);
      }
      const wide = Array.from({ length: 120_000 }, (_, r) => [r, r + 1, r + 2, r + 3, r + 4]);
      expect((await run(wide, "A1:E120000")).err?.message).toMatch(/this batch writes 600000 values/);
    });

    it("the caps count the whole batch: two writeValues of 60,000 values each are refused together", async () => {
      const block = Array.from({ length: 60_000 }, (_, i) => [i]);
      const { g, calls } = fakeClient((m, _url, body) => (m === "post" ? { replies: body.requests.map(() => ({})) } : bigMeta));
      const requests = [{ writeValues: { sheetId: 0, range: "A1:A60000", values: block } }, { writeValues: { sheetId: 0, range: "B1:B60000", values: block } }];
      await expect(tool.handler(args({ requests, verify: false }), ctx(g))).rejects.toThrow(/this batch writes 120000 values, over the 100000/);
      expect(calls.filter((c) => c.method === "post")).toEqual([]);
    });

    it("more than 10,000 updateCells is refused even under the value cap: nulls splitting rows, or as many writeValues", async () => {
      // 202 x 100 alternating: 10,100 values, each its own run.
      const { err, calls } = await run(alternating(202, 100), "A1:CV202");
      expect(err?.message).toMatch(
        new RegExp(`^writeValues: this batch's writeValues become 10100 separate updateCells \\(one per writeValues, more where nulls split a row\\), over the ${WRITE_VALUES_MAX_UPDATES} one batch may send — write large blocks with sheets_write_range or sheets_batch_write_ranges`),
      );
      expect(calls.filter((c) => c.method === "post")).toEqual([]);
      // 10,001 one-cell writeValues: the same cap, since each is an updateCells next to its own bookkeeping.
      const { g, calls: many } = fakeClient((m, _url, body) => (m === "post" ? { replies: body.requests.map(() => ({})) } : bigMeta));
      const requests = Array.from({ length: WRITE_VALUES_MAX_UPDATES + 1 }, (_, k) => ({ writeValues: { sheetId: 0, range: `A${k + 1}`, values: [[k]] } }));
      await expect(tool.handler(args({ requests, verify: false }), ctx(g))).rejects.toThrow(/become 10001 separate updateCells/);
      expect(many.filter((c) => c.method === "post")).toEqual([]);
    });

    it("exactly at both caps the batch is sent: 100,000 values in one updateCells, 10,000 one-cell runs, each body under 8 MB", async () => {
      const atCells = await run(Array.from({ length: 100_000 }, (_, i) => [i]), "A1:A100000");
      expect(atCells.err).toBeUndefined();
      expect(atCells.r.totals.cellsWritten).toBe(WRITE_VALUES_MAX_CELLS);
      expect(updateCellsSent(atCells.calls)).toBe(1);
      const atRuns = await run(alternating(200, 100), "A1:CV200");
      expect(atRuns.err).toBeUndefined();
      expect(updateCellsSent(atRuns.calls)).toBe(WRITE_VALUES_MAX_UPDATES);
      for (const { calls } of [atCells, atRuns]) {
        const post = calls.find((c) => c.method === "post")!;
        expect(JSON.stringify(post.body).length).toBeLessThan(8 * 1024 * 1024);
      }
    });

    it("a target's updates is exactly the number of updateCells it becomes", () => {
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      for (let k = 0; k < 200; k++) {
        const rows = 1 + Math.floor(rnd() * 6), cols = 1 + Math.floor(rnd() * 6);
        const values = Array.from({ length: rows }, () => Array.from({ length: cols }, () => (rnd() < 0.35 ? null : Math.floor(rnd() * 9))));
        values[0][0] = 1;
        const t = resolveWriteValues({ sheetId: 0, range: `A1:${colA1(cols)}${rows}`, values }, 0, heMeta);
        expect(writeValuesRequests(t)).toHaveLength(t.updates);
        expect(t.cells).toBe(values.flat().filter((v) => v !== null).length);
      }
    });
  });
});

describe("(c) verify: only a later request that really moves the written cells skips the re-read", () => {
  // Data!C5:D6 = rows 5-6, columns C-D (0-based rows 4-5, columns 2-3).
  const block = blockOf("Data!C5:D6", meta)!;
  const rows = (startIndex: number, endIndex = startIndex + 1, sheetId = 0) => ({ range: { sheetId, dimension: "ROWS", startIndex, endIndex } });
  const cols = (startIndex: number, endIndex = startIndex + 1) => ({ range: { sheetId: 0, dimension: "COLUMNS", startIndex, endIndex } });
  const box = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId: 0, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });

  it("blockOf reads the tab and the 1-based bounds; a whole-column range is open-ended; an unknown tab is undefined", () => {
    expect(block).toEqual({ sheetId: 0, r0: 5, r1: 6, c0: 3, c1: 4 });
    expect(blockOf("'Summary'!B:B", meta)).toEqual({ sheetId: 1, r0: 1, r1: Number.MAX_SAFE_INTEGER, c0: 2, c1: 2 });
    expect(blockOf("Nope!A1", meta)).toBeUndefined();
  });

  it("row/column inserts and deletes move the block only from an index at or before its last row/column", () => {
    for (const [req, moves] of [
      [{ deleteDimension: rows(1, 3) }, true], // above: shifts up
      [{ deleteDimension: rows(5) }, true], // its own last row: deleted
      [{ deleteDimension: rows(6) }, false], // row 7, just below
      [{ deleteDimension: rows(50) }, false], // far below (the QA scenario)
      [{ insertDimension: rows(5) }, true], // inserted before row 6: row 6 shifts
      [{ insertDimension: rows(6) }, false], // after the block
      [{ deleteDimension: rows(1, 3, 1) }, false], // another tab
      [{ deleteDimension: cols(0) }, true], // column A: shifts left
      [{ deleteDimension: cols(4) }, false], // column E, right of the block
      [{ insertDimension: cols(3) }, true], // before column D
      [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0 } } }, true], // unbounded end
    ] as [AnyRec, boolean][]) {
      expect(movesBlock(req, block), JSON.stringify(req)).toBe(moves);
    }
  });

  it("moveDimension moves it only when the block lies between the source and the destination", () => {
    const move = (startIndex: number, endIndex: number, destinationIndex: number) => ({ moveDimension: { source: { sheetId: 0, dimension: "ROWS", startIndex, endIndex }, destinationIndex } });
    expect(movesBlock(move(0, 1, 3), block)).toBe(false); // rows 1-3 change places, the block (5-6) does not
    expect(movesBlock(move(0, 1, 5), block)).toBe(true); // row 1 moved to before row 6: row 5 shifts up
    expect(movesBlock(move(10, 12, 2), block)).toBe(true); // rows 11-12 inserted above: shifts down
    expect(movesBlock(move(10, 12, 7), block)).toBe(false); // entirely below
  });

  it("the verify re-read is charged every cell of the block, an open end cut at the tab's grid", () => {
    const grid = { rowCount: 100, columnCount: 26 };
    // Data!C5:D6: 4 cells whatever the write holds (writeValues nulls included); read as written.
    expect(rereadCost(blockOf("Data!C5:D6", meta)!, grid)).toEqual({ cells: 4, a1: "C5:D6" });
    expect(rereadCost(blockOf("Data!C5", meta)!, grid)).toEqual({ cells: 1, a1: "C5" });
    // A whole column / row / tab-width block / tab: the closed block the grid holds, and that is what is read.
    expect(rereadCost(blockOf("Data!C:C", meta)!, grid)).toEqual({ cells: 100, a1: "C1:C100" });
    expect(rereadCost(blockOf("Data!3:4", meta)!, grid)).toEqual({ cells: 52, a1: "A3:Z4" });
    expect(rereadCost(blockOf("Data!B10:C", meta)!, grid)).toEqual({ cells: 182, a1: "B10:C100" });
    expect(rereadCost({ sheetId: 0, r0: 1, r1: Number.MAX_SAFE_INTEGER, c0: 1, c1: Number.MAX_SAFE_INTEGER }, grid)).toEqual({ cells: 2_600, a1: "A1:Z100" });
    // No grid size to cut an open end at: never under a budget.
    expect(rereadCost(blockOf("Data!C:C", meta)!, {}).cells).toBe(Infinity);
  });

  it("insertRange/deleteRange move it only across its columns (or rows) from at or before its end", () => {
    expect(movesBlock({ deleteRange: { range: box(0, 1, 2, 3), shiftDimension: "ROWS" } }, block)).toBe(true); // C1 deleted: column C shifts up
    expect(movesBlock({ deleteRange: { range: box(0, 1, 0, 2), shiftDimension: "ROWS" } }, block)).toBe(false); // A1:B1: other columns
    expect(movesBlock({ insertRange: { range: box(9, 10, 2, 3), shiftDimension: "ROWS" } }, block)).toBe(false); // below the block
    expect(movesBlock({ insertRange: { range: box(4, 5, 0, 1), shiftDimension: "COLUMNS" } }, block)).toBe(true); // A5 shifts row 5 right
    expect(movesBlock({ deleteRange: { range: box(0, 3, 0, 1), shiftDimension: "COLUMNS" } }, block)).toBe(false); // rows 1-3 only
  });

  it("cutPaste (source), sortRange, randomizeRange and deleteDuplicates move it when they intersect it; deleteSheet and a shrinking grid remove it", () => {
    expect(movesBlock({ cutPaste: { source: box(4, 5, 2, 3), destination: { sheetId: 1, rowIndex: 0, columnIndex: 0 } } }, block)).toBe(true);
    expect(movesBlock({ cutPaste: { source: box(0, 1, 0, 1), destination: { sheetId: 0, rowIndex: 4, columnIndex: 2 } } }, block)).toBe(false);
    expect(movesBlock({ sortRange: { range: box(0, 20, 0, 5), sortSpecs: [] } }, block)).toBe(true);
    expect(movesBlock({ sortRange: { range: box(0, 20, 5, 8), sortSpecs: [] } }, block)).toBe(false);
    expect(movesBlock({ randomizeRange: { range: box(5, 6, 3, 4) } }, block)).toBe(true);
    expect(movesBlock({ deleteDuplicates: { range: box(10, 20, 0, 5) } }, block)).toBe(false);
    expect(movesBlock({ deleteSheet: { sheetId: 0 } }, block)).toBe(true);
    expect(movesBlock({ deleteSheet: { sheetId: 1 } }, block)).toBe(false);
    expect(movesBlock({ updateSheetProperties: { properties: { sheetId: 0, gridProperties: { rowCount: 5 } }, fields: "gridProperties.rowCount" } }, block)).toBe(true);
    expect(movesBlock({ updateSheetProperties: { properties: { sheetId: 0, gridProperties: { rowCount: 6 } }, fields: "gridProperties.rowCount" } }, block)).toBe(false);
    // Formatting, value writes and appends leave it where it is.
    expect(movesBlock(bold(4), block)).toBe(false);
    expect(movesBlock({ appendDimension: { sheetId: 0, dimension: "ROWS", length: 10 } }, block)).toBe(false);
  });

  it("laterMovers returns the first later request that moves it, looking only at later movers on its tab", () => {
    const reqs = [{ writeValues: { range: "Data!C5:D6", values: [[1, 2], [3, 4]] } }, { deleteDimension: rows(50) }, bold(0), { insertDimension: rows(0) }];
    expect(laterMovers(reqs)(0, block)).toBe(3);
    expect(laterMovers(reqs.slice(0, 3))(0, block)).toBeUndefined();
    // A mover before the write, or on another tab, is never a later mover of it.
    const around = [{ insertDimension: rows(0) }, { writeValues: { range: "Data!C5:D6", values: [[1, 2], [3, 4]] } }, { deleteDimension: rows(0, 1, 1) }, { deleteSheet: { sheetId: 1 } }];
    expect(laterMovers(around)(1, block)).toBeUndefined();
    // Every test counts against one budget for the batch; once it is spent, the answer is "untracked", not a guess.
    const three = [{ writeValues: { range: "Data!C5:D6", values: [[1, 2], [3, 4]] } }, { deleteDimension: rows(50) }, { deleteDimension: rows(60) }, { insertDimension: rows(0) }];
    const moverOf = laterMovers(three, 4);
    expect(moverOf(0, block)).toBe(3); // three tests
    expect(moverOf(0, block)).toBe(UNTRACKED); // one left: not enough to reach #3
  });

  it("titlesAfter applies renames, deletions and added tabs in order", () => {
    const reqs = [
      { updateSheetProperties: { properties: { sheetId: 0, title: "Renamed" }, fields: "title" } },
      { updateSheetProperties: { properties: { sheetId: 1, title: "Ignored" }, fields: "index" } },
      { addSheet: { properties: { title: "New" } } },
      { deleteSheet: { sheetId: 1 } },
    ];
    const t = titlesAfter(reqs, meta, [{}, {}, { addSheet: { properties: { sheetId: 77, title: "New" } } }, {}]);
    expect([...t]).toEqual([[0, "Renamed"], [77, "New"]]);
  });

  it("a write on a tab the same batch renames is re-read under the new title", async () => {
    // Before: the re-read asked for 'Data!A2:B2' after the tab became 'Renamed', and Google rejected it.
    const rename = { updateSheetProperties: { properties: { sheetId: 0, title: "Renamed" }, fields: "title" } };
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}, {}] } : isMetaRead(m, url, params) ? metaResp : { sheets: [{ properties: { title: "Renamed" }, data: [{ startRow: 1, rowData: [{ values: [str("q"), num(5)] }] }] }] }));
    const r: any = await tool.handler(args({ requests: [{ writeValues: { range: "Data!A2:B2", values: [["q", 5]] } }, rename] }), ctx(g));
    expect(calls.filter((c) => Array.isArray(c.params?.ranges)).map((c) => c.params.ranges)).toEqual([["Renamed!A2:B2"]]);
    expect(r.verification).toEqual({ cells: 2, errors: [], ok: true });
  });

  it("with snapshot=true the post-check reads the tabs by their titles after the batch", async () => {
    // Before: it asked for ['Data', 'Summary'] after the batch renamed Data, so the whole post-check failed.
    const rename = { updateSheetProperties: { properties: { sheetId: 0, title: "Renamed" }, fields: "title" } };
    const renamedGrids = { sheets: [{ ...gridsAfterDelete.sheets[0], properties: { sheetId: 0, title: "Renamed" } }, gridsAfterDelete.sheets[1]] };
    let applied = false;
    let backup: AnyRec = {};
    const { g, calls } = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.duplicateSheet) {
        backup = body.requests[0].duplicateSheet;
        return { replies: body.requests.map((q: AnyRec) => (q.duplicateSheet ? { duplicateSheet: { properties: { sheetId: q.duplicateSheet.newSheetId, title: q.duplicateSheet.newSheetName } } } : {})) };
      }
      if (m === "post") return (applied = true), { replies: body.requests.map(() => ({})) };
      if (isGridRead(params)) {
        if (params.ranges?.includes("'Data'")) throw new GoogleApiError(400, "GET", url, "Unable to parse range: 'Data'");
        return named(params, renamedGrids);
      }
      // After the batch the tab list shows the rename and the hidden backup.
      return applied ? tabsMeta([[0, "Renamed", 100], [1, "Summary", 100], [backup.newSheetId, backup.newSheetName, 100]]) : metaResp;
    });
    const r: any = await tool.handler(args({ snapshot: true, requests: [deleteRows23, rename] }), ctx(g));
    // Named (a snapshot exists), by the titles after the batch, and without the backup.
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Renamed'", "'Summary'"]]);
    expect(r.postCheck).toMatchObject({ sheets: ["Renamed", "Summary"], errorCount: 2 });
    expect(r.postCheck.errors[0].cell).toBe("Renamed!C2");
  });

  it("with snapshot=true the post-check also reads a tab the batch added, as the unnamed read would", async () => {
    const add = { addSheet: { properties: { title: "New" } } };
    let applied = false;
    let backup: AnyRec = {};
    const { g, calls } = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.duplicateSheet) {
        backup = body.requests[0].duplicateSheet;
        return { replies: body.requests.map((q: AnyRec) => (q.duplicateSheet ? { duplicateSheet: { properties: { sheetId: q.duplicateSheet.newSheetId, title: q.duplicateSheet.newSheetName } } } : {})) };
      }
      if (m === "post") return (applied = true), { replies: [{}, { addSheet: { properties: { sheetId: 42, title: "New" } } }] };
      if (isGridRead(params)) return named(params, gridsAfterDelete);
      return applied ? tabsMeta([[0, "Data", 100], [1, "Summary", 100], [backup.newSheetId, backup.newSheetName, 100], [42, "New", 1000]]) : metaResp;
    });
    await tool.handler(args({ snapshot: true, requests: [deleteRows23, add] }), ctx(g));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Data'", "'Summary'", "'New'"]]);
  });
});

describe("(c) verify covers every value write: whole tabs, open ends and value pastes are re-read, the rest named", () => {
  // Review finding: a whole-tab value write (a range that is only {sheetId}) and the value pastes — copyPaste
  // PASTE_NORMAL/VALUES/FORMULA/NO_BORDERS, the cutPaste destination, autoFill — were neither re-read nor named in
  // the note, although the reply counted them as written: 500 cells of #DIV/0! came back as a clean reply.
  // Data is 100 rows x 5 columns here; after the write, row 100 holds an error in every column.
  const narrow = {
    sheets: [
      { properties: { sheetId: 0, title: "Data", gridProperties: { rowCount: 100, columnCount: 5 } } },
      { properties: { sheetId: 1, title: "Summary", gridProperties: { rowCount: 100, columnCount: 26 } } },
    ],
  };
  const typed = { userEnteredValue: { formulaValue: "=IF(ROW()=100,1/0,1)" } };
  const div0 = { ...typed, effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." } } };
  const one = { ...typed, effectiveValue: { numberValue: 1 } };
  const written = {
    sheets: [
      { properties: { sheetId: 0, title: "Data" }, data: [{ rowData: Array.from({ length: 100 }, (_, r) => ({ values: Array.from({ length: 5 }, () => (r === 99 ? div0 : one)) })) }] },
      { properties: { sheetId: 1, title: "Summary" }, data: [] },
    ],
  };
  const errorsIn = (row: number, cols: string) => [...cols].map((c) => ({ cell: `Data!${c}${row}`, type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." }));
  /** One real run (post_check off unless asked): the parsed reply and the `ranges` of every grid read. */
  const run = async (requests: AnyRec[], extra: AnyRec = {}, tabs: AnyRec = narrow) => {
    const { g, calls } = fakeClient((m, _url, body, params) =>
      m === "post" ? { replies: body.requests.map((q: AnyRec) => (q.addSheet ? { addSheet: { properties: q.addSheet.properties } } : {})) } : isGridRead(params) ? named(params, written) : tabs,
    );
    const r = JSON.parse(wire(await tool.handler(args({ post_check: false, requests, ...extra }), ctx(g))));
    return { r, reads: calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges) };
  };
  const fill = (range: AnyRec) => ({ repeatCell: { range, cell: typed, fields: "userEnteredValue" } });

  it("a whole-tab value write is re-read as the closed block the tab's grid holds, like a whole-column one", async () => {
    const tab = await run([fill({ sheetId: 0 })]);
    expect(tab.r.totals).toEqual({ cellsWritten: 500 });
    expect(tab.reads).toEqual([["Data!A1:E100"]]);
    expect(tab.r.verification).toEqual({ cells: 500, ok: false, errors: errorsIn(100, "ABCDE") });
    expect(tab.r.warning).toMatch(/^5 written cell\(s\) evaluate to an error: Data!A100 DIVIDE_BY_ZERO/);
    expect(tab.r.note).toBeUndefined();
    // The control the finding compared it with: the same write over column A alone.
    const col = await run([fill({ sheetId: 0, startColumnIndex: 0, endColumnIndex: 1 })]);
    expect(col.reads).toEqual([["Data!A1:A100"]]);
    expect(col.r.verification).toEqual({ cells: 100, ok: false, errors: errorsIn(100, "A") });
  });

  it("a whole-tab write over the cell budget is charged the whole grid and named in the note, not read", async () => {
    const big = tabsMeta([[0, "Data", 5_000], [1, "Summary", 100]]); // 130,000 grid cells
    const { r, reads } = await run([fill({ sheetId: 0 })], {}, big);
    expect(reads).toEqual([]);
    expect(r.verification).toBeUndefined();
    expect(r.note).toBe(`1 written range(s) not re-read: over the ${GRID_READ_MAX_CELLS}-cell re-read budget (Data!A1:Z5000)`);
  });

  it("a range with some bounds left out is re-read to the grid's edge on each open side; one without sheetId is on the first tab", async () => {
    const rows5on = await run([fill({ sheetId: 0, startRowIndex: 4 })]);
    expect(rows5on.reads).toEqual([["Data!A5:E100"]]);
    expect(rows5on.r.verification).toEqual({ cells: 480, ok: false, errors: errorsIn(100, "ABCDE") });
    expect((await run([fill({ sheetId: 0, startRowIndex: 90, endRowIndex: 100, startColumnIndex: 2 })])).reads).toEqual([["Data!C91:E100"]]);
    const noSheetId = await run([{ updateCells: { range: { startRowIndex: 99, endRowIndex: 100, startColumnIndex: 1, endColumnIndex: 2 }, rows: [{ values: [typed] }], fields: "userEnteredValue" } }]);
    expect(noSheetId.reads).toEqual([["Data!B100"]]);
    expect(noSheetId.r.verification).toEqual({ cells: 1, ok: false, errors: errorsIn(100, "B") });
  });

  it("value pastes are re-read where Google pastes them; format-only pastes are not", async () => {
    const a1 = { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 };
    const a100 = { sheetId: 0, startRowIndex: 99, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: 1 };
    const copy = (pasteType: string, destination: AnyRec = a100) => ({ copyPaste: { source: a1, destination, pasteType } });
    for (const pasteType of ["PASTE_NORMAL", "PASTE_VALUES", "PASTE_FORMULA", "PASTE_NO_BORDERS"]) {
      const { r, reads } = await run([copy(pasteType)]);
      expect([pasteType, r.totals, reads, r.verification, r.note]).toEqual([pasteType, { cellsWritten: 1 }, [["Data!A100"]], { cells: 1, ok: false, errors: errorsIn(100, "A") }, undefined]);
    }
    // A1 repeated over A91:E100, a whole multiple of it: the whole area is re-read.
    const area = await run([copy("PASTE_NORMAL", { sheetId: 0, startRowIndex: 90, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: 5 })]);
    expect(area.reads).toEqual([["Data!A91:E100"]]);
    expect(area.r.verification).toEqual({ cells: 50, ok: false, errors: errorsIn(100, "ABCDE") });
    for (const pasteType of ["PASTE_FORMAT", "PASTE_DATA_VALIDATION", "PASTE_CONDITIONAL_FORMATTING"]) {
      const { r, reads } = await run([copy(pasteType)]);
      expect([pasteType, reads, r.verification, r.note]).toEqual([pasteType, [], undefined, undefined]);
    }
  });

  it("a cutPaste that pastes values is re-read at its destination, over the block its source covers", async () => {
    const cut = (pasteType?: string) => ({ cutPaste: { source: { sheetId: 1, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 }, destination: { sheetId: 0, rowIndex: 98, columnIndex: 3 }, ...(pasteType ? { pasteType } : {}) } });
    const { r, reads } = await run([cut()]);
    expect(reads).toEqual([["Data!D99:E100"]]);
    expect(r.verification).toEqual({ cells: 4, ok: false, errors: errorsIn(100, "DE") });
    // PASTE_FORMAT moves only the formatting: no value lands there to check.
    expect((await run([cut("PASTE_FORMAT")])).reads).toEqual([]);
  });

  it("autoFill is re-read over its range, or over the rows or columns fillLength adds to its source", async () => {
    const inRange = await run([{ autoFill: { range: { sheetId: 0, startRowIndex: 89, endRowIndex: 100, startColumnIndex: 1, endColumnIndex: 2 } } }]);
    expect(inRange.reads).toEqual([["Data!B90:B100"]]);
    expect(inRange.r.verification).toEqual({ cells: 11, ok: false, errors: errorsIn(100, "B") });
    const source = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId: 0, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
    const down = await run([{ autoFill: { sourceAndDestination: { source: source(0, 2, 0, 2), dimension: "ROWS", fillLength: 98 } } }]);
    expect(down.reads).toEqual([["Data!A3:B100"]]);
    expect(down.r.verification).toEqual({ cells: 196, ok: false, errors: errorsIn(100, "AB") });
    const left = await run([{ autoFill: { sourceAndDestination: { source: source(99, 100, 4, 5), dimension: "COLUMNS", fillLength: -2 } } }]);
    expect(left.reads).toEqual([["Data!C100:D100"]]);
  });

  it("writtenBlock: formatting, format-only pastes and structure write no value; findReplace and textToColumns are unlocated", () => {
    const at = (req: AnyRec) => writtenBlock(req, describeRequests([req], meta)[0], meta);
    const g = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId: 0, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
    for (const req of [
      bold(0),
      { updateCells: { range: g(0, 1, 0, 1), rows: [{ values: [{ userEnteredFormat: {} }] }], fields: "userEnteredFormat" } },
      { updateBorders: { range: g(0, 1, 0, 1), top: { style: "SOLID" } } },
      { mergeCells: { range: g(0, 2, 0, 2), mergeType: "MERGE_ALL" } },
      { copyPaste: { source: g(0, 1, 0, 1), destination: g(5, 6, 0, 1), pasteType: "PASTE_FORMAT" } },
      { cutPaste: { source: g(0, 1, 0, 1), destination: { sheetId: 0, rowIndex: 5, columnIndex: 0 }, pasteType: "PASTE_CONDITIONAL_FORMATTING" } },
      { pasteData: { coordinate: { sheetId: 0 }, data: "a,b", delimiter: ",", type: "PASTE_FORMAT" } },
      deleteRows23,
      { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } },
      { sortRange: { range: g(0, 10, 0, 2), sortSpecs: [] } },
    ]) {
      expect(at(req), JSON.stringify(req)).toBeUndefined();
    }
    expect(at({ findReplace: { find: "a", replacement: "b", allSheets: true } })).toBe(UNLOCATED);
    expect(at({ textToColumns: { source: g(0, 5, 0, 1) } })).toBe(UNLOCATED);
    expect(at({ pasteData: { coordinate: { sheetId: 1 }, data: "<table></table>", html: true } })).toBe(UNLOCATED);
    expect(at({ autoFill: { sourceAndDestination: { source: { sheetId: 0, startColumnIndex: 0, endColumnIndex: 1 }, dimension: "ROWS", fillLength: 5 } } })).toBe(UNLOCATED);
    // Blocks are 1-based and inclusive; an open end stays open for rereadCost to cut at the grid.
    const open = Number.MAX_SAFE_INTEGER;
    expect(at({ repeatCell: { range: { sheetId: 1 }, cell: {}, fields: "*" } })).toEqual({ sheetId: 1, r0: 1, r1: open, c0: 1, c1: open });
    expect(at({ writeValues: { range: "Summary!B2:C3", values: [[1, null], [null, 4]] } })).toEqual({ sheetId: 1, r0: 2, r1: 3, c0: 2, c1: 3 });
    expect(at({ pasteData: { coordinate: { sheetId: 1, rowIndex: 4, columnIndex: 1 }, data: "1\t2\t3\n4\n", delimiter: "\t" } })).toEqual({ sheetId: 1, r0: 5, r1: 6, c0: 2, c1: 4 });
    // TRANSPOSE: a 1 x 3 source lands as 3 x 1.
    expect(at({ copyPaste: { source: g(0, 1, 0, 3), destination: g(9, 10, 5, 6), pasteOrientation: "TRANSPOSE" } })).toEqual({ sheetId: 0, r0: 10, r1: 12, c0: 6, c1: 6 });
  });

  it("value writes whose cells are not known before they run are named in the note, and so is a write on a tab the batch adds", async () => {
    const unknown = [
      { findReplace: { find: "x", replacement: "=1/0", includeFormulas: true, sheetId: 0 } },
      { textToColumns: { source: { sheetId: 0, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 1 }, delimiterType: "COMMA" } },
      { pasteData: { coordinate: { sheetId: 0, rowIndex: 0, columnIndex: 0 }, data: "<table><tr><td>=1/0</td></tr></table>", html: true } },
    ];
    const added = [{ addSheet: { properties: { sheetId: 7, title: "New" } } }, { updateCells: { start: { sheetId: 7, rowIndex: 0, columnIndex: 0 }, rows: [{ values: [typed] }], fields: "userEnteredValue" } }];
    const { r, reads } = await run([...unknown, ...added]);
    expect(reads).toEqual([]);
    expect(r.verification).toBeUndefined();
    expect(r.note).toBe(
      "3 value write(s) not re-read: the cells they change are not known before they run (#0 findReplace, #1 textToColumns, #2 pasteData); 1 written range(s) not re-read: on a tab this batch adds (New!A1)",
    );
    // With a structural change on the tab the post-check re-reads it whole, and the note says so.
    const withPostCheck = await run([unknown[0], { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 50, endIndex: 51 } } }], { post_check: true });
    expect(withPostCheck.r.postCheck.sheets).toEqual(["Data", "Summary"]);
    expect(withPostCheck.r.note).toBe("1 value write(s) not re-read: the cells they change are not known before they run (#0 findReplace); postCheck re-read their tab(s)");
  });
});

describe("(c) verify cuts an open end at the grid as it is after the batch", () => {
  // Review finding: an open-ended write was sized at the tab's grid from BEFORE the batch. An earlier request in
  // the same batch that grows the grid (insertDimension, appendDimension) left the rows it added unread and
  // unnamed, and a block that started past the old grid cost 0 cells and was dropped without a word.
  const typed = { userEnteredValue: { formulaValue: "=1/0" } };
  const div0 = { ...typed, effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." } } };
  const errorAt = (cell: string) => ({ cell: `Data!${cell}`, type: "DIVIDE_BY_ZERO", message: "Function DIVIDE parameter 2 cannot be zero." });
  /**
   * One real run: Data has 1,000 rows until the batch is posted and `rowsAfter` once it is (an Error: the
   * metadata read after the batch fails); after the batch Data holds `=1/0` at each [row, column] of `errors`.
   */
  const run = async (requests: AnyRec[], rowsAfter: number | Error, errors: [number, number][], extra: AnyRec = {}) => {
    let posted = false;
    const cells = {
      sheets: [
        { properties: { sheetId: 0, title: "Data" }, data: errors.map(([r, c]) => ({ startRow: r - 1, startColumn: c - 1, rowData: [{ values: [div0] }] })) },
        { properties: { sheetId: 1, title: "Summary" }, data: [] },
      ],
    };
    const { g, calls } = fakeClient((m, _url, body, params) => {
      if (m === "post") {
        posted = true;
        return { replies: body.requests.map(() => ({})) };
      }
      if (isGridRead(params)) return named(params, cells);
      if (!posted) return tabsMeta([[0, "Data", 1_000], [1, "Summary", 100]]);
      if (rowsAfter instanceof Error) throw rowsAfter;
      return tabsMeta([[0, "Data", rowsAfter], [1, "Summary", 100]]);
    });
    const r = JSON.parse(wire(await tool.handler(args({ post_check: false, requests, ...extra }), ctx(g))));
    const posts = calls.filter((c) => c.method === "post").length;
    const metaReadsAfter = calls.filter((c, i) => i > calls.findIndex((x) => x.method === "post") && c.method === "get" && !isGridRead(c.params)).length;
    return { r, posts, metaReadsAfter, reads: calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges) };
  };
  const insertRows = (n: number) => ({ insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: n } } });
  const appendRows = (n: number) => ({ appendDimension: { sheetId: 0, dimension: "ROWS", length: n } });
  const deleteRows = (from: number, to: number) => ({ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: from, endIndex: to } } });
  const fill = (range: AnyRec) => ({ repeatCell: { range, cell: typed, fields: "userEnteredValue" } });
  const columnC = fill({ sheetId: 0, startColumnIndex: 2, endColumnIndex: 3 });

  it("rows an earlier insertDimension adds are re-read with a whole-column write", async () => {
    const { r, reads, metaReadsAfter } = await run([insertRows(500), columnC], 1_500, [[1_500, 3]]);
    expect(reads).toEqual([["Data!C1:C1500"]]);
    expect(metaReadsAfter).toBe(1);
    expect(r.verification).toEqual({ cells: 1, ok: false, errors: [errorAt("C1500")] });
    expect(r.note).toBeUndefined();
  });

  it("a write into rows an earlier appendDimension adds is re-read there, not dropped at 0 cells", async () => {
    const { r, reads } = await run([appendRows(1_000), fill({ sheetId: 0, startRowIndex: 1_500 })], 2_000, [[1_501, 1], [2_000, 26]]);
    // 500 rows x 26 columns: the rows the write covers on the grid after the batch.
    expect(reads).toEqual([["Data!A1501:Z2000"]]);
    expect(r.verification).toEqual({ cells: 2, ok: false, errors: [errorAt("A1501"), errorAt("Z2000")] });
    expect(r.note).toBeUndefined();
  });

  it("a value paste of a whole column is sized on the grid after the batch too", async () => {
    // Column A of Data, 1,500 rows once the insert has run, pasted from F1 down: F1:F1500.
    const paste = { copyPaste: { source: { sheetId: 0, startColumnIndex: 0, endColumnIndex: 1 }, destination: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 }, pasteType: "PASTE_NORMAL" } };
    const { r, reads } = await run([insertRows(500), paste], 1_500, [[1_500, 6]]);
    expect(reads).toEqual([["Data!F1:F1500"]]);
    expect(r.verification).toEqual({ cells: 1, ok: false, errors: [errorAt("F1500")] });
    // The same paste with no earlier growth reads what it did before: F1:F1000.
    expect((await run([paste], 1_000, [])).reads).toEqual([["Data!F1:F1000"]]);
  });

  it("rows an earlier deleteDimension removes are not read past the grid's new end", async () => {
    const { reads } = await run([deleteRows(500, 1_000), columnC], 500, []);
    expect(reads).toEqual([["Data!C1:C500"]]);
  });

  it("a closed block needs no second metadata read; the post-check shares the one an open end makes", async () => {
    const closed = await run([insertRows(500), fill({ sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1 })], 1_500, []);
    expect([closed.reads, closed.metaReadsAfter]).toEqual([[["Data!A1:A2"]], 0]);
    const both = await run([insertRows(500), columnC], 1_500, [[1_500, 3]], { post_check: true });
    expect(both.metaReadsAfter).toBe(1);
    // The post-check covers every tab, so it names none (undefined ranges = the whole spreadsheet).
    expect(both.reads).toEqual([["Data!C1:C1500"], undefined]);
    expect(both.r.postCheck).toMatchObject({ sheets: ["Data", "Summary"], errorCount: 1 });
  });

  it("a write that covers no cell of the grid after the batch is named in the note, never dropped", async () => {
    const { r, reads, posts } = await run([fill({ sheetId: 0, startRowIndex: 1_500 })], 1_000, []);
    expect(posts).toBe(1);
    expect(reads).toEqual([]);
    expect(r.verification).toBeUndefined();
    expect(r.note).toBe("1 value write(s) not re-read: they cover no cell of their tab's grid after the batch (#0 repeatCell from Data!A1501)");
  });

  it("when the grid after the batch cannot be read, an open-ended write is named with the reason; the batch stays applied", async () => {
    const { r, reads, posts } = await run([appendRows(1_000), columnC], new GoogleApiError(503, "GET", "https://sheets.example.com/v4/spreadsheets/sid", "The service is currently unavailable."), []);
    expect(posts).toBe(1);
    expect(r.applied).toBe(2);
    expect(reads).toEqual([]);
    expect(r.note).toMatch(/^1 value write\(s\) not re-read: their tab's grid after the batch could not be read \(.*unavailable.*\) \(#1 repeatCell\)$/);
  });
});

describe("(d) deletion preview: what is lost and which formulas break", () => {
  const route = (m: string, url: string, _b: any, params: any) => (isGridRead(params) ? named(params, gridsBefore) : isMetaRead(m, url, params) ? metaResp : {});

  it("deleteDimension lists the deleted contents and the formulas outside the rows that read them", async () => {
    const { g, calls } = fakeClient(route);
    const r: any = await tool.handler(args({ dry_run: true, requests: [deleteRows23] }), ctx(g));
    expect(calls.filter((c) => c.method === "post")).toHaveLength(0);
    // The same loader as the audit/trace tools, twice, each asking only for what it uses: the deleted rows with
    // what a preview shows of a cell, then every tab's formulas and errors (no ranges: every tab fits).
    const [shown, scan] = calls.filter((c) => isGridRead(c.params));
    expect([shown.params.ranges, scan.params.ranges]).toEqual([["'Data'!A2:Z3"], undefined]);
    expect(shown.params.fields).toContain("values(userEnteredValue/formulaValue,formattedValue)");
    expect(scan.params.fields).toContain("values(userEnteredValue/formulaValue,effectiveValue/errorValue)");
    const parsed = JSON.parse(wire(r));
    // The preview quotes the spreadsheet's cells and formulas: the provenance notice comes first.
    expect(Object.keys(parsed)[0]).toBe("provenance");
    expect(parsed.provenance.fields).toEqual(["requests[].preview.currentValues", "requests[].preview.dependents[].formula"]);
    const preview = parsed.requests[0].preview;
    expect(preview).toEqual({
      range: "Data!A2:C3",
      cellsWithData: 5,
      currentValues: [["x", "10", "=B2*2"], ["y", "20"]],
      dependentFormulas: 5,
      refErrors: 2,
      dependents: [
        { cell: "Data!C4", formula: "=B3*2", becomes: "#REF!" },
        { cell: "Summary!A1", formula: "=Data!B2", becomes: "#REF!" },
        { cell: "Data!B6", formula: "=SUM(B2:B5)", becomes: "loses the deleted cells" },
        { cell: "Summary!B1", formula: "=SUM(Data!B2:B5)", becomes: "loses the deleted cells" },
        { cell: "Summary!D1", formula: "=MAX(Data!B:B)", becomes: "loses the deleted cells" },
      ],
    });
    // Data!C2 (=B2*2) is inside the deleted rows — it goes with them and is not a dependent;
    // Summary!C1 (=Data!B5) reads a row that only moves up.
  });

  it("deleteSheet: every formula elsewhere that reads the tab becomes #REF!", async () => {
    const { g } = fakeClient(route);
    const r: any = await tool.handler(args({ dry_run: true, requests: [{ deleteSheet: { sheetId: 0 } }] }), ctx(g));
    const p = r.requests[0].preview;
    expect(p.range).toBe("Data!A1:C6");
    expect(p.cellsWithData).toBe(13);
    expect(p.dependentFormulas).toBe(4);
    expect(p.refErrors).toBe(4);
    expect(p.dependents.map((d: AnyRec) => d.cell)).toEqual(["Summary!A1", "Summary!B1", "Summary!C1", "Summary!D1"]);
  });

  it("deleteRange previews its block; a deletion after another structural change on the tab carries a caveat", async () => {
    const { g } = fakeClient(route);
    const insert = { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };
    const delRange = { deleteRange: { range: { sheetId: 0, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 }, shiftDimension: "ROWS" } };
    const r: any = await tool.handler(args({ dry_run: true, requests: [insert, delRange] }), ctx(g));
    const p = r.requests[1].preview;
    // B5 is read by Data!B6, Summary!B1 and Summary!D1 through ranges, and by Summary!C1 alone.
    expect(p).toMatchObject({ range: "Data!B5", cellsWithData: 1, currentValues: [["40"]], dependentFormulas: 4, refErrors: 1 });
    expect(p.dependents[0]).toEqual({ cell: "Summary!C1", formula: "=Data!B5", becomes: "#REF!" });
    expect(p.caveat).toMatch(/request #0 reshapes this tab first/);
  });

  it("caps the lost contents at 50 rows and says how many rows are omitted", async () => {
    const tall = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ rowData: Array.from({ length: 80 }, (_, i) => ({ values: [num(i)] })) }] }, { properties: { sheetId: 1, title: "Summary" }, data: [] }] };
    const { g } = fakeClient((m, url, _b, params) => (isGridRead(params) ? tall : metaResp));
    const r: any = await tool.handler(args({ dry_run: true, requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 80 } } }] }), ctx(g));
    const p = r.requests[0].preview;
    expect(p.currentValues).toHaveLength(50);
    expect(p).toMatchObject({ range: "Data!A1:A50", cellsWithData: 80, rowsOmitted: 30, dependentFormulas: 0, refErrors: 0 });
  });

  it("the lost-contents window starts at the first populated cell, not at the top of the span", async () => {
    // Before: rows 2-70 deleted, data only in rows 61-70 → 'Data!A2:A51' and fifty empty rows, rowsOmitted 19.
    const low = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ startRow: 60, rowData: Array.from({ length: 10 }, (_, i) => ({ values: [num(61 + i)] })) }] }, { properties: { sheetId: 1, title: "Summary" }, data: [] }] };
    const { g } = fakeClient((m, url, _b, params) => (isGridRead(params) ? low : metaResp));
    const r: any = await tool.handler(args({ dry_run: true, requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 70 } } }] }), ctx(g));
    const p = JSON.parse(wire(r)).requests[0].preview;
    expect(p).toEqual({ range: "Data!A61:A70", cellsWithData: 10, currentValues: Array.from({ length: 10 }, (_, i) => [String(61 + i)]), dependentFormulas: 0, refErrors: 0 });

    // Same for a column: deleting D, whose data starts at row 60, shows D60 onward, and counts omitted rows from there.
    const colD = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ startRow: 59, startColumn: 3, rowData: Array.from({ length: 60 }, (_, i) => ({ values: [str(`d${60 + i}`)] })) }] }, { properties: { sheetId: 1, title: "Summary" }, data: [] }] };
    const c = fakeClient((m, url, _b, params) => (isGridRead(params) ? colD : metaResp));
    const rc: any = await tool.handler(args({ dry_run: true, requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 3, endIndex: 4 } } }] }), ctx(c.g));
    const pc = rc.requests[0].preview;
    expect(pc).toMatchObject({ range: "Data!D60:D109", cellsWithData: 60, rowsOmitted: 10 });
    expect(pc.currentValues[0]).toEqual(["d60"]);
    expect(pc.currentValues).toHaveLength(50);
  });

  it("a failed grid read still returns the plan, with the preview marked unavailable", async () => {
    // Before: the dry run itself threw ('Google did not answer within 30s') and the caller got no plan at all.
    const { g } = fakeClient((m, url, _b, params) => {
      if (isGridRead(params)) throw new GoogleApiError(0, "GET", url, "Google did not answer within 30s", "timeout");
      return metaResp;
    });
    const r: any = await tool.handler(args({ dry_run: true, requests: [deleteRows23] }), ctx(g));
    expect(r.dryRun).toBe(true);
    expect(r.requests[0]).toMatchObject({ type: "deleteDimension", sheet: "Data", count: 2, warning: "destructive" });
    expect(r.requests[0].preview).toEqual({ note: "preview unavailable: the grid read failed (Google did not answer within 30s)" });
  });

  it("a large spreadsheet reads the deleted tab first, then what fits, and names the tabs it did not check", async () => {
    // Data and Summary are 60% of the cap each: together over it, Data (the deleted tab) alone under it.
    const big = tabsMeta([[0, "Data", rowsFor(GRID_READ_MAX_CELLS * 0.6)], [1, "Summary", rowsFor(GRID_READ_MAX_CELLS * 0.6)]]);
    const { g, calls } = fakeClient((m, url, _b, params) => (isGridRead(params) ? named(params, gridsBefore) : big));
    const r: any = await tool.handler(args({ dry_run: true, requests: [deleteRows23] }), ctx(g));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Data'!A2:Z3"], ["'Data'"]]);
    const p = r.requests[0].preview;
    expect(p).toMatchObject({ range: "Data!A2:C3", cellsWithData: 5, dependentFormulas: 2, refErrors: 1 });
    expect(p.note).toBe("large spreadsheet: formulas on Summary were not checked (over the 100000-cell read budget) — any there that read these cells are not listed (sheets_trace_dependents)");
  });

  it("a tab too large on its own is never read in full: its deletion preview says so, and the other tabs are still checked", async () => {
    const huge = tabsMeta([[0, "Data", 50_000], [1, "Summary", 100]]);
    const { g, calls } = fakeClient((m, url, _b, params) => (isGridRead(params) ? named(params, gridsBefore) : huge));
    const r: any = await tool.handler(args({ dry_run: true, requests: [deleteRows23, { deleteDimension: { range: { sheetId: 1, dimension: "ROWS", startIndex: 5, endIndex: 6 } } }] }), ctx(g));
    // Before: over the cap only the deleted tabs were considered, so Summary's own deletion went unpreviewed too.
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Summary'!A6:Z6"], ["'Summary'"]]);
    expect(r.requests[0].preview).toEqual({ note: "preview unavailable: Data has 1300000 grid cells and does not fit the 100000-cell read budget — read the rows with sheets_read_range and check sheets_trace_dependents first" });
    expect(r.requests[1].preview).toMatchObject({ cellsWithData: 0, dependentFormulas: 0, note: expect.stringMatching(/^large spreadsheet: formulas on Data were not checked/) });
  });

  it("a destructive dry run points at snapshot=true", async () => {
    const { g } = fakeClient(route);
    const r: any = await tool.handler(args({ dry_run: true, requests: [deleteRows23] }), ctx(g));
    expect(r.hint).toBe("snapshot=true would first copy Data to hidden backup tab(s)");
    const withSnap: any = await tool.handler(args({ dry_run: true, snapshot: true, requests: [deleteRows23] }), ctx(fakeClient(route).g));
    expect(withSnap.hint).toBeUndefined();
    expect(withSnap.snapshot).toEqual([{ sheet: "Data", backupTitle: expect.stringMatching(/^Data \(backup \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/) }]);
  });
});

describe("(e) post-check after structural changes", () => {
  it("reports the #REF! a row deletion left behind, from one re-read of every tab", async () => {
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? gridsAfterDelete : metaResp));
    const r = JSON.parse(wire(await tool.handler(args({ requests: [deleteRows23] }), ctx(g))));
    // The tab list and grid sizes as they are after the batch, then one grid read of every tab.
    expect(calls.map((c) => c.method)).toEqual(["get", "post", "get", "get"]);
    expect(isMetaRead(calls[2].method, calls[2].url, calls[2].params)).toBe(true);
    expect(calls[3].params).toMatchObject({ includeGridData: true, ranges: undefined });
    expect(r.postCheck).toEqual({
      sheets: ["Data", "Summary"],
      errorCount: 2,
      ok: false,
      errors: [
        { cell: "Data!C2", error: "REF", formula: "=#REF!*2", message: "Reference does not exist." },
        { cell: "Summary!A1", error: "REF", formula: "=#REF!", message: "Reference does not exist." },
      ],
      note: POST_CHECK_STATE_NOTE,
    });
    // The errors quote the spreadsheet's formulas, so the provenance notice precedes them on the wire.
    expect(Object.keys(r)[0]).toBe("provenance");
    expect(r.provenance).toMatchObject({ source: "sheets:spreadsheet:sid", fields: ["postCheck.errors[].formula"], trust: "third-party" });
  });

  it("a state check, not a diff: an old error on a harmlessly shifted tab is reported, and the reply says it may predate the batch", async () => {
    const oldNA = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [{ values: [{ userEnteredValue: { formulaValue: "=VLOOKUP(\"z\",A:B,2,0)" }, effectiveValue: { errorValue: { type: "N_A", message: "Did not find value 'z'." } }, formattedValue: "#N/A" }] }] }] }] };
    const { g } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? oldNA : metaResp));
    const r = JSON.parse(wire(await tool.handler(args({ requests: [{ insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 90, endIndex: 91 } } }] }), ctx(g))));
    expect(r.postCheck).toMatchObject({ errorCount: 1, ok: false, note: "lists every error these tabs show now, including any from before this change" });
    // A clean post-check carries no such note.
    const clean = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [] }] } : metaResp));
    const c = JSON.parse(wire(await tool.handler(args({ requests: [{ insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 90, endIndex: 91 } } }] }), ctx(clean.g))));
    expect(c.postCheck).toEqual({ sheets: ["Data"], errorCount: 0, ok: true });
    expect(c.provenance).toBeUndefined();
  });

  it("post_check=false skips it; a batch with no structural request never runs it", async () => {
    const off = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isMetaRead(m, url, params) ? metaResp : gridsAfterDelete));
    const r1: any = await tool.handler(args({ post_check: false, requests: [deleteRows23] }), ctx(off.g));
    expect(off.calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(r1.applied).toBe(1);
    expect(r1.postCheck).toBeUndefined();
    const fmt = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isMetaRead(m, url, params) ? metaResp : gridsAfterDelete));
    const r2: any = await tool.handler(args({ requests: [bold(0)] }), ctx(fmt.g));
    expect(fmt.calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(r2.postCheck).toBeUndefined();
  });

  it("a failed re-read after the batch applied is reported, not thrown (a throw would invite a retry)", async () => {
    const { g } = fakeClient((m, url, _b, params) => {
      if (m === "post") return { replies: [{}] };
      if (isGridRead(params)) throw new Error("upstream hiccup");
      return metaResp;
    });
    const r: any = await tool.handler(args({ requests: [deleteRows23] }), ctx(g));
    expect(r.applied).toBe(1);
    expect(r.postCheck).toEqual({ error: "post-check re-read failed (upstream hiccup); the batch itself was applied" });
  });

  it("a large spreadsheet re-reads the touched tab first, then what fits, and names the tabs it skipped", async () => {
    // Data and Summary are 60% of the cap each: together over it, Data (the touched tab) alone under it.
    const big = tabsMeta([[0, "Data", rowsFor(GRID_READ_MAX_CELLS * 0.6)], [1, "Summary", rowsFor(GRID_READ_MAX_CELLS * 0.6)]]);
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? named(params, gridsAfterDelete) : big));
    const r: any = await tool.handler(args({ requests: [deleteRows23] }), ctx(g));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Data'"]]);
    expect(r.postCheck).toMatchObject({ sheets: ["Data"], skipped: ["Summary"], errorCount: 1 });
    expect(r.postCheck.note).toBe(`${POST_CHECK_STATE_NOTE}; 1 tab(s) under skipped not checked: over the 100000-cell read budget — run sheets_audit_spreadsheet with ranges`);
  });

  it("gridReadTabs: every tab under the cap; above it the wanted tabs first, then the others, each while it fits", () => {
    const m = (sizes: number[]): SheetMeta => ({
      titles: new Map(sizes.map((_, i) => [i, `T${i}`])),
      ids: new Map(sizes.map((_, i) => [`T${i}`, i])),
      grids: new Map(sizes.map((rows, i) => [i, { rowCount: rows, columnCount: 10 }])),
      namedRanges: [],
    });
    expect(GRID_READ_MAX_CELLS).toBe(100_000);
    // 3 × 30K cells: under the cap, every tab except the excluded one.
    expect(gridReadTabs(m([3_000, 3_000, 3_000]), [0], new Set([2]))).toEqual({ all: true, titles: ["T0", "T1"], skipped: [] });
    // 60K + 60K + 1K rows × 10: over the cap. Wanted T1 first (60K), then T0 (60K) no longer fits, T2 (10K) does.
    expect(gridReadTabs(m([6_000, 6_000, 1_000]), [1])).toEqual({ all: false, titles: ["T1", "T2"], skipped: ["T0"] });
    // A deleted tab is never read, even when wanted; the lists are in tab order whatever the priority.
    expect(gridReadTabs(m([6_000, 6_000, 1_000]), [2, 0], new Set([2]))).toEqual({ all: false, titles: ["T0"], skipped: ["T1"] });
    // A tab over the whole cap is skipped, never read in part; unknown ids are ignored.
    expect(gridReadTabs(m([20_000, 100]), [0, 99])).toEqual({ all: false, titles: ["T1"], skipped: ["T0"] });
  });

  it("some touched tabs re-read, one skipped: the post-check names the skipped one", async () => {
    const mixed = tabsMeta([[0, "Data", rowsFor(GRID_READ_MAX_CELLS * 0.6)], [1, "Summary", 50_000]]);
    const cut = { cutPaste: { source: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, destination: { sheetId: 1, rowIndex: 0, columnIndex: 0 } } };
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? named(params, gridsAfterDelete) : mixed));
    const r: any = await tool.handler(args({ verify: false, requests: [cut] }), ctx(g));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Data'"]]);
    expect(r.postCheck).toMatchObject({ sheets: ["Data"], skipped: ["Summary"], errorCount: 1 });
    expect(r.postCheck.note).toBe("lists every error these tabs show now, including any from before this change; 1 tab(s) under skipped not checked: over the 100000-cell read budget — run sheets_audit_spreadsheet with ranges");
  });

  it("a touched tab too large on its own is skipped, not read in full; the rest are still re-read", async () => {
    // Before: over the cap, every touched tab was read with includeGridData whatever its own size (here 1.3M cells).
    const huge = tabsMeta([[0, "Data", 50_000], [1, "Summary", 100]]);
    const { g, calls } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? named(params, gridsAfterDelete) : huge));
    const r: any = await tool.handler(args({ requests: [deleteRows23] }), ctx(g));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Summary'"]]);
    expect(r.applied).toBe(1);
    expect(r.postCheck).toMatchObject({ sheets: ["Summary"], errorCount: 1, skipped: ["Data"] });
    // Nothing read at all: no count and no ok — never ok: true for tabs nobody looked at.
    const alone = tabsMeta([[0, "Data", 50_000]]);
    const only = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? named(params, gridsAfterDelete) : alone));
    const r2 = JSON.parse(wire(await tool.handler(args({ requests: [deleteRows23] }), ctx(only.g))));
    expect(only.calls.filter((c) => isGridRead(c.params))).toHaveLength(0);
    expect(r2.postCheck).toEqual({ skipped: ["Data"], note: "1 tab(s) under skipped not checked: over the 100000-cell read budget — run sheets_audit_spreadsheet with ranges" });
  });
});

describe("(f) snapshot: hidden backup tabs before a destructive change", () => {
  const route = (m: string, url: string, body: any, params: any) => {
    if (m === "post" && body.requests[0]?.duplicateSheet) {
      return { replies: body.requests.map((q: AnyRec) => (q.duplicateSheet ? { duplicateSheet: { properties: { sheetId: q.duplicateSheet.newSheetId, title: q.duplicateSheet.newSheetName } } } : {})) };
    }
    if (m === "post") return { replies: body.requests.map(() => ({})) };
    return isGridRead(params) ? gridsAfterDelete : metaResp;
  };

  it("snapshot=true duplicates the touched tab as a hidden sheet in a separate call BEFORE the destructive batch", async () => {
    const { g, calls } = fakeClient(route);
    const r = JSON.parse(wire(await tool.handler(args({ snapshot: true, requests: [deleteRows23] }), ctx(g))));
    const posts = calls.filter((c) => c.method === "post");
    expect(posts).toHaveLength(2);
    const [dup, hide] = posts[0].body.requests;
    expect(dup.duplicateSheet).toMatchObject({ sourceSheetId: 0, insertSheetIndex: 2 });
    expect(dup.duplicateSheet.newSheetName).toMatch(/^Data \(backup \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/);
    expect([0, 1]).not.toContain(dup.duplicateSheet.newSheetId);
    expect(hide).toEqual({ updateSheetProperties: { properties: { sheetId: dup.duplicateSheet.newSheetId, hidden: true }, fields: "hidden" } });
    expect(posts[1].body.requests).toEqual([deleteRows23]);
    expect(r.snapshot).toEqual([{ sheet: "Data", backupSheetId: dup.duplicateSheet.newSheetId, backupTitle: dup.duplicateSheet.newSheetName }]);
  });

  it("the default takes no snapshot — one POST, no tab added", async () => {
    const { g, calls } = fakeClient(route);
    const r: any = await tool.handler(args({ requests: [deleteRows23] }), ctx(g));
    expect(calls.filter((c) => c.method === "post")).toHaveLength(1);
    expect(r.snapshot).toBeUndefined();
    // Called directly without the zod default, snapshot stays off too.
    const bare = fakeClient(route);
    const { snapshot: _omit, ...noSnapshotArg } = args({ requests: [deleteRows23] });
    await tool.handler(noSnapshotArg, ctx(bare.g));
    expect(bare.calls.filter((c) => c.method === "post")).toHaveLength(1);
  });

  it("formatting-only batches take no snapshot even when asked", async () => {
    const { g, calls } = fakeClient(route);
    await tool.handler(args({ snapshot: true, requests: [bold(0)] }), ctx(g));
    expect(calls.filter((c) => c.method === "post")).toHaveLength(1);
  });

  it("the post-check ignores the backup tab it just created", async () => {
    let backupId = -1;
    let applied = false;
    const { g } = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.duplicateSheet) backupId = body.requests[0].duplicateSheet.newSheetId;
      else if (m === "post") applied = true;
      if (isGridRead(params)) return named(params, { sheets: [...gridsAfterDelete.sheets, { properties: { sheetId: backupId, title: "Data (backup)" }, data: [{ rowData: [{ values: [refError("=#REF!")] }] }] }] });
      // After the batch the tab list holds the backup too.
      if (m === "get" && applied) return tabsMeta([[0, "Data", 100], [1, "Summary", 100], [backupId, "Data (backup)", 100]]);
      return route(m, url, body, params);
    });
    const reads: any[] = [];
    const r: any = await tool.handler(args({ snapshot: true, requests: [deleteRows23] }), ctx({ ...g, get: async (url: string, params: any) => (reads.push(params), g.get(url, params)) }));
    expect(r.postCheck.sheets).toEqual(["Data", "Summary"]);
    // The backup is not even read: the post-check names the original tabs, so a snapshot cannot double the read.
    expect(reads.filter(isGridRead).map((p) => p.ranges)).toEqual([["'Data'", "'Summary'"]]);
  });

  it("a batch Google rejects (4xx) removes the backups again and rethrows", async () => {
    const { g, calls } = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.deleteDimension) throw new GoogleApiError(400, "POST", url, "Invalid requests[0].deleteDimension");
      return route(m, url, body, params);
    });
    await expect(tool.handler(args({ snapshot: true, requests: [deleteRows23] }), ctx(g))).rejects.toThrow(/Invalid requests/);
    const posts = calls.filter((c) => c.method === "post");
    expect(posts).toHaveLength(3);
    expect(posts[2].body.requests).toEqual([{ deleteSheet: { sheetId: posts[0].body.requests[0].duplicateSheet.newSheetId } }]);
  });

  it("a pasteData over existing cells is backed up, described as a value write and verified", async () => {
    // Before: pasteData had no description, so snapshot=true sent only the paste — no backup, no hint.
    const paste = { pasteData: { coordinate: { sheetId: 0, rowIndex: 0, columnIndex: 0 }, data: "a,b\nc,d", delimiter: "," } };
    const [p] = describeRequests([paste], meta);
    expect(p).toMatchObject({ type: "pasteData", sheet: "Data", range: "Data!A1:B2", cells: 4, warning: "overwrites values" });
    expect(lossySheetIds([p], [paste], meta)).toEqual([0]);
    expect(changeTotals([p])).toEqual({ cellsWritten: 4 });

    const verifyGrid = { sheets: [{ properties: { title: "Data" }, data: [{ rowData: [{ values: [str("a"), str("b")] }, { values: [str("c"), str("d")] }] }] }] };
    const { g, calls } = fakeClient((m, url, body, params) => (m === "get" && Array.isArray(params?.ranges) ? verifyGrid : route(m, url, body, params)));
    const r = JSON.parse(wire(await tool.handler(args({ snapshot: true, requests: [paste] }), ctx(g))));
    const posts = calls.filter((c) => c.method === "post");
    expect(posts).toHaveLength(2);
    expect(posts[0].body.requests[0].duplicateSheet).toMatchObject({ sourceSheetId: 0 });
    expect(posts[1].body.requests).toEqual([paste]);
    expect(r.snapshot).toHaveLength(1);
    expect(calls.find((c) => Array.isArray(c.params?.ranges))?.params.ranges).toEqual(["Data!A1:B2"]);
    expect(r.verification).toEqual({ cells: 4, ok: true });

    // Tab-separated, a trailing newline, and an HTML paste (shape unknown: the anchor cell stands in).
    expect(describeRequests([{ pasteData: { coordinate: { sheetId: 1, rowIndex: 4, columnIndex: 1 }, data: "1\t2\t3\n4\n", delimiter: "\t" } }], meta)[0]).toMatchObject({ range: "Summary!B5:D6", cells: 6 });
    expect(describeRequests([{ pasteData: { coordinate: { sheetId: 1, rowIndex: 0, columnIndex: 0 }, data: "<table><tr><td>x</td></tr></table>", html: true } }], meta)[0]).toMatchObject({ range: "Summary!A1", warning: "overwrites values" });
    // A format-only pasteData changes no values, like the copyPaste equivalent.
    expect(describeRequests([{ pasteData: { coordinate: { sheetId: 0 }, data: "<b>x</b>", html: true, type: "PASTE_FORMAT" } }], meta)[0].warning).toBeUndefined();
  });

  it("a repeatCell with fields '*' clears values even when it only sets a format: backed up and warned", async () => {
    const wipe = { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 5 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "*" } };
    const [p] = describeRequests([wipe], meta);
    expect(p).toMatchObject({ range: "Data!1:5", cells: 130, warning: "overwrites values" });
    expect(p.effect).toBe("apply format to 130 cells (Data!1:5; fields: *) — fields '*' also clears their values");
    expect(lossySheetIds([p], [wipe], meta)).toEqual([0]);
    const { g, calls } = fakeClient(route);
    const r: any = await tool.handler(args({ snapshot: true, verify: false, requests: [wipe] }), ctx(g));
    expect(calls.filter((c) => c.method === "post").map((c) => Object.keys(c.body.requests[0])[0])).toEqual(["duplicateSheet", "repeatCell"]);
    expect(r.snapshot).toHaveLength(1);
    // A narrower mask that names only formats still is not a value write.
    expect(describeRequests([bold(0)], meta)[0].warning).toBeUndefined();
  });

  it("a failed batch after a snapshot names the backup tabs the caller now has", async () => {
    // Before: the timeout was rethrown unchanged, and the hidden backup tab went unmentioned.
    const timeout = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.deleteDimension) throw new GoogleApiError(0, "POST", url, "Google did not answer within 30s", "timeout");
      return route(m, url, body, params);
    });
    const err: any = await tool.handler(args({ snapshot: true, requests: [deleteRows23] }), ctx(timeout.g)).catch((e) => e);
    const dup = timeout.calls.find((c) => c.method === "post")!.body.requests[0].duplicateSheet;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(0);
    expect(err.message).toBe(`Google did not answer within 30s — snapshot kept (outcome unknown): hidden backup tab '${dup.newSheetName}' (sheetId ${dup.newSheetId}); delete it with sheets_delete_sheet when no longer needed`);

    // A 4xx whose cleanup also fails says the backups remain.
    const stuck = fakeClient((m, url, body, params) => {
      if (m === "post" && body.requests[0]?.deleteDimension) throw new GoogleApiError(400, "POST", url, "Invalid requests[0].deleteDimension");
      if (m === "post" && body.requests[0]?.deleteSheet) throw new Error("cleanup refused");
      return route(m, url, body, params);
    });
    const err2: any = await tool.handler(args({ snapshot: true, requests: [deleteRows23] }), ctx(stuck.g)).catch((e) => e);
    expect(err2.status).toBe(400);
    expect(err2.message).toMatch(/^Invalid requests\[0\]\.deleteDimension — nothing was applied, but removing the snapshot failed: hidden backup tab 'Data \(backup .*\)' \(sheetId \d+\); delete it with sheets_delete_sheet$/);
  });

  it("backup titles are unique and stay within Google's 100-character tab title limit", () => {
    const now = new Date("2026-09-22T14:05:59Z");
    const long = "תקציב ".repeat(25).trim(); // 149 characters
    const m: SheetMeta = { titles: new Map([[0, "Data"], [5, long], [9, "Data (backup 2026-09-22 14:05 UTC)"]]), ids: new Map([["Data", 0], [long, 5], ["Data (backup 2026-09-22 14:05 UTC)", 9]]), grids: new Map(), namedRanges: [] };
    const ids = [9, 9, 42, 43];
    const plan = planSnapshot([0, 5], m, now, () => ids.shift()!);
    expect(plan[0]).toEqual({ sheet: "Data", sheetId: 0, backupSheetId: 42, backupTitle: "Data (backup 2026-09-22 14:05 UTC #2)" });
    expect(plan[1].backupSheetId).toBe(43);
    expect(plan[1].backupTitle.length).toBeLessThanOrEqual(MAX_SHEET_TITLE);
    expect(plan[1].backupTitle).toMatch(/^תקציב .* \(backup 2026-09-22 14:05 UTC\)$/);
    expect(snapshotRequests(plan, m).map((q) => Object.keys(q)[0])).toEqual(["duplicateSheet", "updateSheetProperties", "duplicateSheet", "updateSheetProperties"]);
  });

  it("lossy tabs: deletions, cutPaste (both ends) and value writes — not formatting, inserts or sorts", () => {
    const cut = { cutPaste: { source: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, destination: { sheetId: 1, rowIndex: 0, columnIndex: 0 } } };
    const reqs = [bold(0), { insertDimension: { range: { sheetId: 1, dimension: "ROWS", startIndex: 0, endIndex: 1 } } }, { sortRange: { range: { sheetId: 1 }, sortSpecs: [] } }];
    expect(lossySheetIds(describeRequests(reqs, meta), reqs, meta)).toEqual([]);
    expect(lossySheetIds(describeRequests([cut], meta), [cut], meta)).toEqual([0, 1]);
    // A value copyPaste overwrites only its destination; the source tab is merely read.
    const copy = { copyPaste: { source: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, destination: { sheetId: 1, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 } } };
    expect(lossySheetIds(describeRequests([copy], meta), [copy], meta)).toEqual([1]);
    const wv = [{ writeValues: { range: "Summary!A1", values: [[1]] } }];
    expect(lossySheetIds(describeRequests(wv, meta), wv, meta)).toEqual([1]);
  });
});

describe("tool selection reaches the tool that deletes rows", () => {
  const manifest = buildManifest(ALL_TOOLS, new Set(ALL_TOOLS.map((t) => t.name)));

  it("row/column structure requests gate to sheets_batch_update_spreadsheet, not only to deleting the whole tab", () => {
    // Before: "delete rows 5 to 7" gated to sheets_delete_sheet (the entire tab) and never to the one
    // tool that deletes rows — the tool whose dry run now shows what the deletion breaks.
    for (const request of [
      "delete rows 5 to 7 in the budget spreadsheet",
      "remove columns C and D from the budget sheet",
      "insert two rows above row 5 in the sheet",
      "delete the empty rows from Sheet1!A1:D40",
      "תמחק את שורות 5 עד 7 בגיליון",
    ]) {
      expect(gateTools(request, manifest).tools, request).toContain("sheets_batch_update_spreadsheet");
    }
  });

  it("the new cues add no write to a request that only looks", () => {
    for (const request of ["what rows are in the sheet", "how many columns does the budget sheet have"]) {
      expect(gateTools(request, manifest).tools, request).toEqual([]);
    }
  });

  // Review finding: the cues were MUTATION_CUES.batch_update, and `batch_update` is mutating_idempotent. A
  // recoverable verb opens its whole kind to the ranked gate, so "insert two rows above row 5 in the sheet" —
  // a request that only adds — put every mutating_idempotent tool in the pool (trash, untrash, move, complete,
  // modify, update, batch_write) and the capped gate pinned unrelated writes, a trash tool among them. Now the
  // cues are evidence for this one tool (OWN_EVIDENCE_CUES, read like a fill): it is admitted on top, and the
  // rest of the gate is what the request got without the cues. `release` is the gate of the release/1.6 base
  // (commit 70d9d04) for the same request, measured there. `aimless` is what the mutation gate's per-tool
  // target rule (the Docs editing change) takes out of it: an irreversible tool whose own service, resource
  // or pasted object the request does not name. "delete rows 5 to 7 in the budget spreadsheet" names Sheets
  // and a file ("spreadsheet"), so sheets_delete_sheet and drive_delete_file stay; nothing in it is a
  // document range, a draft or an event. That rule only removes, so the rest of each list is unchanged.
  const BU = "sheets_batch_update_spreadsheet";
  const kindOf = (name: string) => VERB_KINDS[manifest.find((e) => e.name === name)!.verb as keyof typeof VERB_KINDS];
  it.each([
    ["insert two rows above row 5 in the sheet", ["sheets_append_rows", "sheets_add_sheet", "sheets_create_spreadsheet", "docs_insert_table", "docs_insert_text"], []],
    ["delete rows 5 to 7 in the budget spreadsheet", ["sheets_delete_sheet", "drive_delete_file", "docs_delete_range", "gmail_delete_draft", "calendar_delete_event"], ["docs_delete_range", "gmail_delete_draft", "calendar_delete_event"]],
    ["move column C before B", [BU, "sheets_batch_write_ranges", "drive_move_file", "calendar_move_event", "tasks_move_task"], []],
    ["תמחק את שורות 5 עד 7 בגיליון", ["sheets_delete_sheet", "drive_delete_file", "docs_delete_range"], ["drive_delete_file", "docs_delete_range"]], // delete rows 5 to 7 in the sheet
    ["תכניס שתי שורות מעל שורה 5 בגיליון", ["sheets_append_rows", "sheets_add_sheet", "docs_insert_table", "docs_insert_text", "slides_insert_text"], []], // insert two rows above row 5
    ["remove columns C and D from the budget sheet", ["sheets_delete_sheet"], []],
  ] as [string, string[], string[]][])("%j reaches the tool that changes rows and pulls in nothing else", async (request, release, aimless) => {
    const gate = gateTools(request, manifest).tools;
    expect(gate[0]).toBe(BU);
    expect(gate.slice(1)).toEqual(release.filter((n) => n !== BU && !aimless.includes(n)));
    // An insert request gets no Docs formatting or comment tool, or any other write it did not get before.
    expect(gate.filter((n) => n !== BU && !release.includes(n))).toEqual([]);
    expect(gate.filter((n) => /_(trash|untrash)_/.test(n))).toEqual([]);
    // Every other idempotent write comes from a verb the request says itself ("move"), as it did before the cues.
    const others = gate.filter((n) => n !== BU && kindOf(n) === "mutating_idempotent");
    expect(others.every((n) => release.includes(n))).toBe(true);
    if (!/^move /.test(request)) expect(others).toEqual([]);
    const selected = (await selectTools(request, manifest)).tools;
    expect(selected).toContain(BU);
    expect(selected.filter((n) => /_(trash|untrash)_/.test(n))).toEqual([]);
  });

  // Review finding: the list above pinned only its own strings, and the positional words of the Docs
  // spacing tool's route block and lexicon entry ("spacing above", "spacing below", "רווח מעל",
  // "רווח מתחת", "above or below", "ריווח שורות") are indexed word by word, so "above", "below",
  // "מעל" and "שורות" put docs_update_paragraph_style inside the gate's cap on row requests that
  // name Sheets — in place of docs_insert_text or tasks_move_task. The spacing tool keeps its nouns
  // ("spacing", "line spacing", "ריווח", "room under the table"). `release` is again the gate of the
  // release/1.6 base (70d9d04) for the same request, measured there; each request gets exactly that
  // list back, with this tool on top only where a row cue reads as a batch update. Re-measured on
  // release/1.6 at 78e42304 (after sheets_write_range gained the words users type): only "move the
  // rows below row 5 up in the sheet" changed there, sheets_write_range in place of
  // sheets_batch_write_ranges, and this step's gate equals that one on every request below.
  it.each([
    ["insert two rows above row 5 in the sheet and fill in the right names", ["sheets_write_range", "sheets_append_rows", "sheets_add_sheet", "docs_insert_table", "docs_insert_text"]],
    ["הוסף שתי שורות מעל שורה 5 בגיליון עם השם המלא למטה", ["sheets_write_range", "sheets_append_rows", "sheets_add_sheet", "docs_append_text", "docs_insert_table"]], // add two rows above row 5 in the sheet with the full name below
    ["move the rows below row 5 up in the sheet", [BU, "sheets_write_range", "drive_move_file", "calendar_move_event", "tasks_move_task"]],
    ["תשנה את השורות", ["sheets_replace_text", "sheets_write_range", BU]], // change the rows
    ["תשנה שורות", ["sheets_replace_text", "sheets_write_range", BU]], // change rows
    ["insert a row below the header in the sheet", ["sheets_add_sheet", "sheets_append_rows", "sheets_create_spreadsheet", "docs_insert_table", "docs_insert_text"]],
  ] as [string, string[]][])("%j: a word of position is no Docs spacing request — the gate of release/1.6, no write outside it", (request, release) => {
    const gate = gateTools(request, manifest).tools;
    expect(gate).not.toContain("docs_update_paragraph_style");
    expect(gate.filter((n) => !release.includes(n) && n !== BU)).toEqual([]);
    expect(gate.filter((n) => n !== BU)).toEqual(release.filter((n) => n !== BU));
  });

  it("vague requests keep the gate of release/1.6: the same writes, less the unaimed irreversible ones, plus this tool only on a row or column cue", () => {
    // Third column: the irreversible tools the per-tool target rule takes out (see `aimless` above). "the rows"
    // and "columns" are Sheets words, so the tab delete stays; no file, document, draft or event is named.
    for (const [request, release, aimless, needsTarget] of [
      ["delete rows 5 to 7", ["sheets_delete_sheet", "drive_delete_file", "docs_delete_range", "gmail_delete_draft", "calendar_delete_event"], ["drive_delete_file", "docs_delete_range", "gmail_delete_draft", "calendar_delete_event"], false],
      ["delete the rows", ["sheets_delete_sheet", "drive_delete_file", "docs_delete_range", "gmail_delete_draft", "calendar_delete_event"], ["drive_delete_file", "docs_delete_range", "gmail_delete_draft", "calendar_delete_event"], false],
      ["remove the columns", ["sheets_delete_sheet", "drive_delete_file", "calendar_delete_event"], ["drive_delete_file", "calendar_delete_event"], false],
      ["מחק עמודות", ["sheets_delete_sheet", "drive_delete_file"], ["drive_delete_file"], false], // delete columns
      ["insert rows", ["sheets_append_rows", "sheets_add_sheet", "docs_insert_table", "docs_insert_text", "slides_insert_text"], [], false],
      ["move the rows", [BU, "sheets_batch_write_ranges", "drive_move_file", "calendar_move_event", "tasks_move_task"], [], false],
      ["delete it", [], [], true],
      ["remove it", [], [], true],
      ["move it", ["tasks_move_task", "calendar_move_event", "drive_move_file", "gmail_modify_message_labels"], [], false],
    ] as [string, string[], string[], boolean][]) {
      const gate = gateTools(request, manifest);
      const cued = /rows|columns|עמודות/.test(request);
      const now = release.filter((n) => !aimless.includes(n));
      expect(gate.tools, request).toEqual(cued ? [BU, ...now.filter((n) => n !== BU)] : now);
      expect(gate.needsTarget, request).toBe(needsTarget);
      const destructive = (names: string[]) => names.filter((n) => manifest.find((e) => e.name === n)!.destructive);
      expect(destructive(gate.tools), request).toEqual(destructive(now));
      expect(aimless.every((n) => manifest.find((e) => e.name === n)!.destructive), request).toBe(true);
    }
  });

  it("the cues are evidence, not a verb: batch_update's own words still rank, and nothing else of its kind rides in", () => {
    expect(OWN_EVIDENCE_CUES[BU]?.verb).toBe("batch_update");
    expect(readMutationIntent("insert two rows above row 5 in the sheet").verbs).toEqual(["insert", "batch_update"]);
    // "format" is batch_update's lexicon word: ranked with the verb's family, as on release/1.6.
    expect(gateTools("format the header row in the budget sheet", manifest).tools).toContain(BU);
    // A phrase, not a bag of words: "insert" and "rows" apart are no row insert.
    expect(gateTools("insert the totals into the doc and summarise the rows", manifest).tools).not.toContain(BU);
  });
});

describe("the reply is always data", () => {
  it("summary output parses as JSON with only the documented keys", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { g } = fakeClient((m, url, _b, params) => (m === "post" ? { replies: [{}, {}] } : isGridRead(params) ? gridsAfterDelete : metaResp));
      const r = JSON.parse(wire(await tool.handler(args({ requests: [bold(0), deleteRows23] }), ctx(g))));
      // provenance first: postCheck.errors quotes formulas from the spreadsheet.
      expect(Object.keys(r)).toEqual(["provenance", "applied", "totals", "warnings", "changes", "postCheck"]);
      expect(r.changes).toEqual([{ index: 1, type: "deleteDimension", sheet: "Data", effect: "delete 2 rows (2-3) — their contents are lost, formulas pointing at them become #REF!" }]);
    } finally {
      log.mockRestore();
    }
  });
});

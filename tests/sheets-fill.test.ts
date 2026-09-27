/**
 * sheets_fill_range — write one formula into the top-left cell of a range and fill it across the
 * rest, the fill handle's job, in ONE batchUpdate (updateCells, then copyPaste PASTE_NORMAL).
 *
 * QA finding this answers: writes were the heaviest calls of a session, ~8.6K characters each
 * (~21.6K once the Hebrew was escaped into JSON), because the same formula was written twelve
 * times across the months and every copy repeated the long Hebrew tab name. The tests below pin
 * that the formula now travels once, that the tab name need not travel at all, and that every
 * refusal (open-ended range, unknown tab, conflicting tab, oversize range) happens before any write.
 */
import { describe, it, expect } from "vitest";
import { planFill, typedValue, capFillVerification, MAX_FILL_CELLS, FILL_VERIFY_CELLS, FILL_ERRORS_LISTED } from "../src/tools/sheets-fill.js";
import { colToLetters, parseA1 } from "../src/tools/sheets-a1.js";
import type { SheetMeta } from "../src/tools/sheets-verify.js";
import { sheetsTools } from "../src/tools/sheets.js";
import { ALL_TOOLS, toolsFor } from "../src/tools/_groups.js";
import { buildManifest } from "../src/tools/_manifest.js";
import { gateTools, readMutationIntent, GATE_PARAMS, OWN_EVIDENCE_VERBS } from "../src/routing/gate.js";
import { selectTools } from "../src/routing/select.js";
import { route } from "../src/tools/_router.js";
import { matchHardSignals } from "../src/tools/_lexicon.js";
import { connectInMemory } from "./helpers/mcp.js";
import benchCases from "./../bench/jev/cases.json" with { type: "json" };

/** A long Hebrew tab name with spaces and a dash — the shape that made the QA writes heavy. */
const HEB = "תחזית תזרים מזומנים 2026 — גרסה סופית";

const SHEETS = [
  { sheetId: 0, title: "Sheet1", rowCount: 1000, columnCount: 26 },
  { sheetId: 7, title: HEB, rowCount: 60_000, columnCount: 30 },
  { sheetId: 9, title: "Q1 Plan", rowCount: 100, columnCount: 26 },
  { sheetId: 11, title: "Big", rowCount: 60_000, columnCount: 30 },
  { sheetId: 12, title: "Bob's plan", rowCount: 100, columnCount: 26 },
  { sheetId: 13, title: "Wide", rowCount: 100, columnCount: 1000 },
];
const metaResponse = (sheets = SHEETS) => ({ sheets: sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title, gridProperties: { rowCount: s.rowCount, columnCount: s.columnCount } } })) });
const metaOf = (sheets = SHEETS): SheetMeta => ({
  titles: new Map(sheets.map((s) => [s.sheetId, s.title])),
  ids: new Map(sheets.map((s) => [s.title, s.sheetId])),
  grids: new Map(sheets.map((s) => [s.sheetId, { rowCount: s.rowCount, columnCount: s.columnCount }])),
  namedRanges: [],
});
const META = metaOf();

/** Fake GoogleClient: records every call and answers by shape (metadata / values writes / batchUpdate / verification read). */
function fakeClient(opts: { sheets?: typeof SHEETS; grid?: (ranges: string[]) => unknown } = {}) {
  const calls: { method: string; url: string; body?: any; params?: any }[] = [];
  const answer = (method: string, url: string, params: any, body: any) => {
    if (method === "put") return { spreadsheetId: "sid", updatedRange: body.range, updatedCells: 1 };
    if (method === "post" && url.endsWith("/values:batchUpdate")) return { totalUpdatedCells: body.data.length, responses: body.data.map((d: any) => ({ updatedRange: d.range, updatedCells: 1 })) };
    if (method === "post" && url.endsWith(":batchUpdate")) return { spreadsheetId: "sid", replies: [{}, {}] };
    if (method === "get" && params?.includeGridData) return opts.grid ? opts.grid(params.ranges) : { sheets: [] };
    if (method === "get") return metaResponse(opts.sheets);
    throw new Error(`unexpected ${method} ${url}`);
  };
  const make = (method: string) => async (url: string, a?: any, b?: any) => {
    const [body, params] = method === "get" ? [undefined, a] : [a, b];
    calls.push({ method, url, body, params });
    return answer(method, url, params, body);
  };
  return { g: { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), delete: make("delete") } as any, calls };
}

const fill = sheetsTools.find((t) => t.name === "sheets_fill_range")!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [] });
const run = (g: any, args: Record<string, unknown>) => fill.handler({ spreadsheet_id: "sid", verify: true, ...args }, ctx(g)) as Promise<any>;
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** JSON as a client sends it with non-ASCII escaped (\uXXXX) — the "21.6K once escaped" measure. */
const escapedJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

describe("sheets_fill_range: one batchUpdate, updateCells then copyPaste", () => {
  it("writes the formula once into the top-left cell and fills the range with PASTE_NORMAL", async () => {
    const { g, calls } = fakeClient();
    const formula = "=SUM(C$3:C$9)*$B$1";
    const r = await run(g, { range: "'Q1 Plan'!C2:N2", value: formula });
    expect(calls.map((c) => c.method)).toEqual(["get", "post", "get"]);
    const post = calls[1];
    expect(post.url).toMatch(/\/spreadsheets\/sid:batchUpdate$/);
    const requests: any[] = post.body.requests;
    // Order matters: the top-left cell must hold the formula before it is copied.
    expect(requests.map((q) => Object.keys(q)[0])).toEqual(["updateCells", "copyPaste"]);
    expect(requests[0].updateCells).toEqual({ start: { sheetId: 9, rowIndex: 1, columnIndex: 2 }, rows: [{ values: [{ userEnteredValue: { formulaValue: formula } }] }], fields: "userEnteredValue" });
    expect(requests[1].copyPaste).toEqual({
      source: { sheetId: 9, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 3 },
      destination: { sheetId: 9, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 14 },
      pasteType: "PASTE_NORMAL",
      pasteOrientation: "NORMAL",
    });
    // The formula is only in the top-left updateCells; Google produces the other eleven copies.
    const body = JSON.stringify(post.body);
    expect(occurrences(body, formula)).toBe(1);
    expect(JSON.stringify(requests[1])).not.toContain(formula);
    // repeatCell would write the identical formula text into every cell — references unadjusted.
    expect(body).not.toContain("repeatCell");
    expect(calls[2].params.ranges).toEqual(["'Q1 Plan'!C2:N2"]);
    expect(r).toMatchObject({ spreadsheetId: "sid", range: "'Q1 Plan'!C2:N2", cells: 12, topLeft: { cell: "C2", value: formula } });
    expect(r.verification).toEqual({ cells: 0, errorCount: 0, errors: [], ok: true });
    expect(r.verifiedRanges).toBeUndefined();
  });

  it("fills down a column exactly as it fills across a row", async () => {
    const { g, calls } = fakeClient();
    const r = await run(g, { range: "Sheet1!D2:D40", value: "=B2*C2" });
    expect(calls[1].body.requests[1].copyPaste.destination).toEqual({ sheetId: 0, startRowIndex: 1, endRowIndex: 40, startColumnIndex: 3, endColumnIndex: 4 });
    expect(r).toMatchObject({ range: "Sheet1!D2:D40", cells: 39, topLeft: { cell: "D2" } });
  });

  it("a one-cell range is just the write — no copyPaste of a cell onto itself", async () => {
    const { g, calls } = fakeClient();
    const r = await run(g, { range: "Sheet1!B2", value: "=A2" });
    expect(calls[1].body.requests.map((q: any) => Object.keys(q)[0])).toEqual(["updateCells"]);
    expect(r).toMatchObject({ range: "Sheet1!B2", cells: 1 });
  });

  it("normalises corners given bottom-right first", () => {
    const plan = planFill("Sheet1!N2:C2", undefined, "=1", META);
    expect(plan.range).toBe("Sheet1!C2:N2");
    expect(plan.topLeft).toBe("C2");
    expect(plan.cells).toBe(12);
  });
});

describe("which tab: sheet_id, quoting, the single-tab default", () => {
  it("sheet_id qualifies an unqualified range, so the long tab name is never sent", async () => {
    const { g, calls } = fakeClient();
    const args = { range: "C2:N2", sheet_id: 7, value: "=C$10-C$20" };
    const r = await run(g, args);
    expect(JSON.stringify(args)).not.toContain(HEB);
    expect(JSON.stringify(calls[1].body)).not.toContain(HEB); // requests address the tab by sheetId only
    expect(calls[1].body.requests[0].updateCells.start.sheetId).toBe(7);
    expect(calls[1].body.requests[1].copyPaste.destination.sheetId).toBe(7);
    // The reply names the tab once, quoted, so the caller can see where the fill landed.
    expect(r.range).toBe(`'${HEB}'!C2:N2`);
    expect(calls[2].params.ranges).toEqual([`'${HEB}'!C2:N2`]);
  });

  it("resolves quoted tab names with spaces, Hebrew and a doubled apostrophe", () => {
    expect(planFill(`'${HEB}'!B5:M5`, undefined, "=1", META)).toMatchObject({ sheetId: 7, range: `'${HEB}'!B5:M5`, cells: 12 });
    expect(planFill("'Q1 Plan'!A1:A3", undefined, "=1", META)).toMatchObject({ sheetId: 9, range: "'Q1 Plan'!A1:A3" });
    expect(planFill("'Bob''s plan'!A1:A3", undefined, "=1", META)).toMatchObject({ sheetId: 12, range: "'Bob''s plan'!A1:A3" });
    expect(planFill("Sheet1!A1:A3", undefined, "=1", META)).toMatchObject({ sheetId: 0, range: "Sheet1!A1:A3" });
    // A1 tab names are not case-sensitive in Sheets.
    expect(planFill("sheet1!A1:A3", undefined, "=1", META).sheetId).toBe(0);
    expect(planFill("$C$2:$D$3", 9, "=1", META)).toMatchObject({ sheetId: 9, range: "'Q1 Plan'!C2:D3" });
  });

  it("accepts a tab named in the range AND a sheet_id only when they agree", () => {
    expect(planFill("'Q1 Plan'!A1:A3", 9, "=1", META).sheetId).toBe(9);
    expect(() => planFill("'Q1 Plan'!A1:A3", 7, "=1", META)).toThrow(/names tab 'Q1 Plan' \(sheet_id 9\) but sheet_id is 7/);
    expect(() => planFill("'Q1 Plan'!A1:A3", 404, "=1", META)).toThrow(/sheet_id is 404 \(no such tab\)/);
  });

  it("refuses an unknown tab, by name or by id, and lists the tabs that exist", () => {
    expect(() => planFill("'Nope'!A1:A2", undefined, "=1", META)).toThrow(/No tab named 'Nope'\. Tabs \(sheet_id\): Sheet1 \(0\)/);
    expect(() => planFill("A1:A2", 99, "=1", META)).toThrow(/No tab with sheet_id 99\./);
  });

  it("uses the only tab of a one-tab spreadsheet, and refuses to guess among several", async () => {
    const one = metaOf([SHEETS[0]]);
    expect(planFill("A1:A3", undefined, "=1", one)).toMatchObject({ sheetId: 0, range: "Sheet1!A1:A3" });
    expect(() => planFill("A1:A3", undefined, "=1", META)).toThrow(/names no tab and the spreadsheet has 6: pass sheet_id or qualify the range/);
    // Refused before anything is written.
    const { g, calls } = fakeClient();
    await expect(run(g, { range: "A1:A3", value: "=1" })).rejects.toThrow(/names no tab/);
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });
});

/**
 * QA priority 2, "short aliases for sheet names": the value writes take the fill's sheet_id, so a
 * long Hebrew tab name is not repeated in every range. One implementation (`qualifyRange` shares
 * the fill's tab resolution), so the same id means the same tab and fails with the same text.
 */
describe("sheet_id on sheets_write_range and sheets_batch_write_ranges", () => {
  const write = sheetsTools.find((t) => t.name === "sheets_write_range")!;
  const batch = sheetsTools.find((t) => t.name === "sheets_batch_write_ranges")!;
  const VALUES = [["=C$10-C$20"]];
  const runWrite = (g: any, args: Record<string, unknown>) =>
    write.handler({ spreadsheet_id: "sid", values: VALUES, value_input_option: "USER_ENTERED", include_values_in_response: false, verify: false, ...args }, ctx(g)) as Promise<any>;
  const runBatch = (g: any, data: Record<string, unknown>[]) => batch.handler({ spreadsheet_id: "sid", data, value_input_option: "USER_ENTERED", verify: false }, ctx(g)) as Promise<any>;
  /** The range as Google receives it in the values.update path, decoded. */
  const pathRange = (url: string) => decodeURIComponent(url.slice(url.indexOf("/values/") + "/values/".length));
  /** The error sheets_fill_range gives for the same range and sheet_id. */
  const fillError = (range: string, sheetId: number) => {
    try {
      planFill(range, sheetId, "=1", META);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error(`planFill accepted ${range} on ${sheetId}`);
  };
  const failure = (p: Promise<unknown>) => p.then(() => "resolved", (err: Error) => err.message);

  it.each([
    [7, "C2:N2", `'${HEB}'!C2:N2`],
    [9, "A:A", "'Q1 Plan'!A:A"],
    [12, "B2", "'Bob''s plan'!B2"],
    [0, "$B$2:$C$3", "Sheet1!$B$2:$C$3"],
  ])("sheet_id %i qualifies %j as %j, quoted the way A1 needs", async (sheetId, range, sent) => {
    const { g, calls } = fakeClient();
    const r = await runWrite(g, { range, sheet_id: sheetId });
    expect(calls.map((c) => c.method)).toEqual(["get", "put"]);
    expect(calls[1].body.range).toBe(sent);
    expect(pathRange(calls[1].url)).toBe(sent);
    // Quoted correctly: the A1 Google receives names exactly the tab sheet_id points at.
    expect(parseA1(sent).sheet).toBe(SHEETS.find((t) => t.sheetId === sheetId)!.title);
    expect(r.updatedRange).toBe(sent);
  });

  it("the Hebrew tab name travels in the request to Google, never in the caller's arguments", async () => {
    const { g, calls } = fakeClient();
    const args = { range: "C2:N2", sheet_id: 7 };
    await runWrite(g, args);
    expect(JSON.stringify(args)).not.toContain(HEB);
    expect(calls[1].body.range).toBe(`'${HEB}'!C2:N2`);
  });

  it("accepts a range that names its tab when it agrees with sheet_id, and sends it as given", async () => {
    const { g, calls } = fakeClient();
    await runWrite(g, { range: "'Q1 Plan'!B2", sheet_id: 9 });
    expect(calls[1].body.range).toBe("'Q1 Plan'!B2");
  });

  it("refuses a tab name that conflicts with sheet_id, with the fill's error, before writing", async () => {
    const { g, calls } = fakeClient();
    const message = await failure(runWrite(g, { range: "Sheet1!B2", sheet_id: 7 }));
    expect(message).toBe(fillError("Sheet1!B2", 7));
    expect(message).toMatch(/range names tab 'Sheet1' \(sheet_id 0\) but sheet_id is 7/);
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("refuses an unknown sheet_id, with the fill's error, before writing", async () => {
    const { g, calls } = fakeClient();
    const message = await failure(runWrite(g, { range: "B2", sheet_id: 99 }));
    expect(message).toBe(fillError("B2", 99));
    expect(message).toMatch(/^No tab with sheet_id 99\. Tabs \(sheet_id\): Sheet1 \(0\)/);
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("without sheet_id nothing changes: no metadata read, the range sent exactly as given", async () => {
    for (const range of ["B2", "'Q1 Plan'!B2", "Totals"]) {
      const { g, calls } = fakeClient();
      await runWrite(g, { range });
      expect(calls.map((c) => c.method), range).toEqual(["put"]);
      expect(calls[0].body.range, range).toBe(range);
      expect(pathRange(calls[0].url), range).toBe(range);
    }
    const { g, calls } = fakeClient();
    await runBatch(g, [{ range: "B2", values: VALUES }, { range: "Sheet1!C3", values: VALUES }]);
    expect(calls.map((c) => c.method)).toEqual(["post"]);
    expect(calls[0].body).toEqual({ valueInputOption: "USER_ENTERED", data: [{ range: "B2", majorDimension: "ROWS", values: VALUES }, { range: "Sheet1!C3", majorDimension: "ROWS", values: VALUES }] });
  });

  it("batch: sheet_id per entry, one metadata read, entries without it untouched", async () => {
    const { g, calls } = fakeClient();
    const r = await runBatch(g, [
      { range: "C2:N2", sheet_id: 7, values: VALUES },
      { range: "B5", sheet_id: 12, values: VALUES },
      { range: "Sheet1!A1", values: VALUES },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(calls[1].body.data.map((d: any) => d.range)).toEqual([`'${HEB}'!C2:N2`, "'Bob''s plan'!B5", "Sheet1!A1"]);
    expect(r.responses.map((x: any) => x.range)).toEqual([`'${HEB}'!C2:N2`, "'Bob''s plan'!B5", "Sheet1!A1"]);
  });

  it("batch: a bad entry is named and nothing is written", async () => {
    for (const [data, index, range, sheetId] of [
      [[{ range: "B2", sheet_id: 0 }, { range: "Sheet1!B2", sheet_id: 7 }], 1, "Sheet1!B2", 7],
      [[{ range: "B2", sheet_id: 99 }, { range: "C3" }], 0, "B2", 99],
    ] as const) {
      const { g, calls } = fakeClient();
      const message = await failure(runBatch(g, data.map((d) => ({ ...d, values: VALUES }))));
      expect(message).toBe(`data[${index}]: ${fillError(range, sheetId)}`);
      expect(calls.map((c) => c.method)).toEqual(["get"]);
    }
  });

  it("on the wire: optional in both schemas, and a write through the client returns JSON", async () => {
    const { g, calls } = fakeClient();
    const { client, close } = await connectInMemory({ ctx: { g } });
    try {
      const tools = (await client.listTools()).tools;
      const w: any = tools.find((t) => t.name === "sheets_write_range")!.inputSchema;
      const b: any = tools.find((t) => t.name === "sheets_batch_write_ranges")!.inputSchema;
      expect(w.properties.sheet_id.type).toBe("integer");
      expect(w.required).not.toContain("sheet_id");
      expect(b.properties.data.items.properties.sheet_id.type).toBe("integer");
      expect(b.properties.data.items.required).not.toContain("sheet_id");
      const res: any = await client.callTool({ name: "sheets_write_range", arguments: { spreadsheet_id: "sid", range: "C2", sheet_id: 7, values: [[1]], verify: false } });
      expect(res.isError, res.content?.[0]?.text).toBeFalsy();
      expect(JSON.parse(res.content[0].text)).toMatchObject({ updatedRange: `'${HEB}'!C2` });
      const refused: any = await client.callTool({ name: "sheets_batch_write_ranges", arguments: { spreadsheet_id: "sid", data: [{ range: "C2", sheet_id: 404, values: [[1]] }], verify: false } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/data\[0\]: No tab with sheet_id 404/);
      expect(calls.filter((c) => c.method !== "get").map((c) => c.method)).toEqual(["put"]);
    } finally {
      await close();
    }
  });
});

describe("refusals happen before any write", () => {
  it("caps a fill at 50,000 cells", async () => {
    expect(MAX_FILL_CELLS).toBe(50_000);
    expect(() => planFill("Big!A1:Z2000", undefined, "=1", META)).toThrow(/covers 52,000 cells; one fill is limited to 50,000/);
    expect(planFill("Big!A1:A50000", undefined, "=1", META).cells).toBe(50_000);
    const { g, calls } = fakeClient();
    await expect(run(g, { range: "Big!A1:Z2000", value: "=1" })).rejects.toThrow(/50,000/);
    expect(calls.some((c) => c.method === "post")).toBe(false);
  });

  it("refuses open-ended ranges, bare tab names and named ranges", () => {
    for (const range of ["C:C", "C2:C", "3:3", "Sheet1", "'Q1 Plan'", "MonthlyTotals", "C2:N2:Z9", "'Q1 Plan'!C2:N2:Z9"]) {
      expect(() => planFill(range, 9, "=1", META), range).toThrow(/both corners/);
    }
    // parseA1 accepts row 0; Google would reject the negative grid index with a bare 400.
    for (const range of ["A0:A5", "Sheet1!A0:A5", "A5:A0", "A0"]) {
      expect(() => planFill(range, 0, "=1", META), range).toThrow(/rows start at 1/);
    }
  });

  it("refuses a range past the tab's grid instead of letting Google reject it", () => {
    expect(() => planFill("Sheet1!A999:A1001", undefined, "=1", META)).toThrow(/ends at row 1001 but 'Sheet1' has 1000 rows/);
    expect(() => planFill("Sheet1!Z1:AA1", undefined, "=1", META)).toThrow(/ends at column 27 but 'Sheet1' has 26 columns/);
  });

  it("rejects an empty value at the schema: filling nothing is a clear, which has its own tool", () => {
    expect(fill.input.value.safeParse("").success).toBe(false);
    expect(fill.input.value.safeParse("=A1").success).toBe(true);
  });
});

describe("the top-left value is typed by content, as if typed into the cell", () => {
  it("formula, number, boolean, forced text and text", () => {
    expect(typedValue("=SUM(A1:A3)")).toEqual({ formulaValue: "=SUM(A1:A3)" });
    expect(typedValue("42")).toEqual({ numberValue: 42 });
    expect(typedValue(" -3.5e2 ")).toEqual({ numberValue: -350 });
    expect(typedValue(".5")).toEqual({ numberValue: 0.5 });
    expect(typedValue("TRUE")).toEqual({ boolValue: true });
    expect(typedValue("false")).toEqual({ boolValue: false });
    expect(typedValue("'007")).toEqual({ stringValue: "007" });
    expect(typedValue("'=not a formula")).toEqual({ stringValue: "=not a formula" });
    expect(typedValue("ממתין")).toEqual({ stringValue: "ממתין" });
    expect(typedValue("12%")).toEqual({ stringValue: "12%" });
    expect(typedValue("1e999")).toEqual({ stringValue: "1e999" });
  });

  // Review finding: the number pattern (`\d+\.?\d*`) backtracked quadratically on a long digit
  // run that is not a number, and `value` had no length cap: 80,000 digits and an "x" cost ~3 s
  // of CPU, 160,000 ~13 s. Linear now, and the schema caps `value` at a cell's 50,000 characters.
  it("types a long non-number in linear time, and caps value at a cell's 50,000 characters", () => {
    const value = "1".repeat(160_000) + "x";
    const started = performance.now();
    expect(typedValue(value)).toEqual({ stringValue: value });
    expect(typedValue("1".repeat(160_000))).toEqual({ stringValue: "1".repeat(160_000) }); // past a double: text
    expect(performance.now() - started).toBeLessThan(250);
    expect(typedValue("1.")).toEqual({ numberValue: 1 });
    expect(typedValue("-2.50e3")).toEqual({ numberValue: -2500 });
    expect(typedValue("1..2")).toEqual({ stringValue: "1..2" });
    expect(fill.input.value.safeParse("x".repeat(50_000)).success).toBe(true);
    expect(fill.input.value.safeParse("x".repeat(50_001)).success).toBe(false);
  });

  it("puts the typed value in the updateCells request", async () => {
    const { g, calls } = fakeClient();
    await run(g, { range: "Sheet1!B2:B5", value: "0" });
    expect(calls[1].body.requests[0].updateCells.rows[0].values[0].userEnteredValue).toEqual({ numberValue: 0 });
  });
});

describe("verification", () => {
  const errorAtEnd = () => ({
    sheets: [
      {
        properties: { title: "Q1 Plan" },
        data: [
          {
            startRow: 1,
            startColumn: 2,
            rowData: [{ values: [...Array.from({ length: 11 }, () => ({ formattedValue: "5", effectiveValue: { numberValue: 5 } })), { formattedValue: "#REF!", effectiveValue: { errorValue: { type: "REF", message: "Reference does not exist." } } }] }],
          },
        ],
      },
    ],
  });

  it("re-reads the filled range and reports error cells with a warning", async () => {
    const { g } = fakeClient({ grid: errorAtEnd });
    const r = await run(g, { range: "'Q1 Plan'!C2:N2", value: "=C3/C4" });
    expect(r.verification).toEqual({ cells: 12, ok: false, errorCount: 1, errors: [{ cell: "'Q1 Plan'!N2", type: "REF", message: "Reference does not exist." }] });
    expect(r.warning).toMatch(/^1 written cell\(s\) evaluate to an error: 'Q1 Plan'!N2 REF/);
  });

  it("verify=false skips the re-read", async () => {
    const { g, calls } = fakeClient({ grid: errorAtEnd });
    const r = await run(g, { range: "'Q1 Plan'!C2:N2", value: "=C3/C4", verify: false });
    expect(calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(r.verification).toBeUndefined();
    expect(r.warning).toBeUndefined();
  });

  /** Every re-read cell is an error — what one mistyped tab name in a filled formula produces. */
  const allErrors = (ranges: string[]) => {
    const byTab = new Map<string, unknown[]>();
    for (const range of ranges) {
      const a = parseA1(range);
      const rows = a.endRow! - a.startRow! + 1, cols = a.endCol! - a.startCol! + 1;
      const cell = () => ({ formattedValue: "#REF!", effectiveValue: { errorValue: { type: "REF", message: "Unresolved sheet name 'Missing'." } } });
      const block = { startRow: a.startRow! - 1, startColumn: a.startCol! - 1, rowData: Array.from({ length: rows }, () => ({ values: Array.from({ length: cols }, cell) })) };
      byTab.set(a.sheet!, [...(byTab.get(a.sheet!) ?? []), block]);
    }
    return { sheets: [...byTab].map(([title, data]) => ({ properties: { title }, data })) };
  };

  // Review finding: the reply listed every error cell verifyCells found — up to 5,000 — so one
  // misspelled tab name in a 2,000-row fill came back as ~230K characters, and a 5,000-row one
  // passed MAX_OUTPUT_CHARS, was cut off mid-list and no longer parsed as JSON.
  it.each([
    ["C2:C2001", 2_000, 2_000],
    ["C2:C5001", 5_000, 5_000],
    ["C2:C50001", 50_000, FILL_VERIFY_CELLS],
  ])("a fill whose every cell errors (%s) replies with a count and the first few cells, as valid JSON", async (range, cells, verified) => {
    const { g } = fakeClient({ grid: allErrors });
    const { client, close } = await connectInMemory({ ctx: { g } });
    try {
      const res: any = await client.callTool({ name: "sheets_fill_range", arguments: { spreadsheet_id: "sid", range, sheet_id: 7, value: "=VLOOKUP(A2,Missing!A:B,2,0)" } });
      expect(res.isError).toBeFalsy();
      const text: string = res.content[0].text;
      const body = JSON.parse(text);
      expect(text.length).toBeLessThan(3_000);
      expect(body).toMatchObject({ range: `'${HEB}'!${range}`, cells });
      expect(body.verification).toMatchObject({ ok: false, cells: verified, errorCount: verified, errorsTruncated: true });
      expect(body.verification.errors).toHaveLength(FILL_ERRORS_LISTED);
      expect(body.verification.errors[0]).toEqual({ cell: `'${HEB}'!C2`, type: "REF", message: "Unresolved sheet name 'Missing'." });
      // The warning still counts every error it saw, and lists five.
      expect(body.warning).toMatch(new RegExp(`^${verified} written cell\\(s\\) evaluate to an error: `));
      expect(occurrences(body.warning, "REF")).toBe(5);
    } finally {
      await close();
    }
  });

  it("lists every error cell when there are few, with the count beside the list", () => {
    const errors = Array.from({ length: 3 }, (_, i) => ({ cell: `Sheet1!A${i + 1}`, type: "DIVIDE_BY_ZERO" }));
    expect(capFillVerification({ cells: 9, errors, ok: false })).toEqual({ cells: 9, ok: false, errorCount: 3, errors });
    expect(capFillVerification({ cells: 9, errors: [], ok: true })).toEqual({ cells: 9, ok: true, errorCount: 0, errors: [] });
    const many = Array.from({ length: 11 }, (_, i) => ({ cell: `Sheet1!A${i + 1}` }));
    expect(capFillVerification({ cells: 11, errors: many, ok: false })).toEqual({ cells: 11, ok: false, errorCount: 11, errors: many.slice(0, FILL_ERRORS_LISTED), errorsTruncated: true });
  });

  it(`above ${FILL_VERIFY_CELLS.toLocaleString("en-US")} cells re-reads a head and a tail band, and says so`, async () => {
    const { g, calls } = fakeClient();
    const tall = await run(g, { range: "Big!A1:A50000", value: "=ROW()" });
    expect(calls[2].params.ranges).toEqual(["Big!A1:A2500", "Big!A47501:A50000"]);
    expect(tall.verifiedRanges).toEqual(["Big!A1:A2500", "Big!A47501:A50000"]);
    // A block: bands of whole rows, each within the band budget.
    expect(planFill("Big!A1:AD1600", undefined, "=1", META).verifyRanges).toEqual(["Big!A1:AD83", "Big!A1518:AD1600"]);
    // Wider than tall: bands of whole columns.
    const wide = planFill("Wide!A1:ALL10", undefined, "=1", META);
    expect(wide.cells).toBe(10_000);
    expect(wide.verifyRanges).toEqual([`Wide!A1:${colToLetters(250)}10`, `Wide!${colToLetters(1000 - 249)}1:ALL10`]);
    expect(wide.sampled).toBe(true);
  });
});

describe("the QA failure: one formula across twelve months", () => {
  it("sends the formula once instead of twelve times — over 90% less once Hebrew is JSON-escaped", async () => {
    const tabRef = `'${HEB}'`;
    const columns = Array.from({ length: 12 }, (_, i) => colToLetters(3 + i)); // C … N
    // What QA had to send: every month's copy written out, each repeating the tab name.
    const perCell = { spreadsheet_id: "sid", data: [{ range: `${tabRef}!C2:N2`, values: [columns.map((c) => `=${tabRef}!${c}$10-${tabRef}!${c}$20`)] }] };
    // What a caller sends now: the first month's formula, once, and a numeric tab id.
    const filled = { spreadsheet_id: "sid", range: "C2:N2", sheet_id: 7, value: `=${tabRef}!C$10-${tabRef}!C$20` };
    expect(occurrences(JSON.stringify(perCell), HEB)).toBe(25);
    expect(occurrences(JSON.stringify(filled), HEB)).toBe(2);
    expect(escapedJson(filled).length / escapedJson(perCell).length).toBeLessThan(0.1);

    // And the tool really does fill the whole row from that one copy.
    const { g, calls } = fakeClient();
    const r = await run(g, filled);
    expect(occurrences(JSON.stringify(calls[1].body), HEB)).toBe(2); // only inside the one formula
    expect(r).toMatchObject({ range: `'${HEB}'!C2:N2`, cells: 12 });
  });
});

describe("on the wire", () => {
  it("is listed as an idempotent, overwriting write and returns compact JSON", async () => {
    const { g } = fakeClient();
    const { client, close } = await connectInMemory({ ctx: { g } });
    try {
      const listed = (await client.listTools()).tools.find((t) => t.name === "sheets_fill_range");
      expect(listed?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
      expect(listed?.inputSchema.required).toEqual(["spreadsheet_id", "range", "value"]);
      const res: any = await client.callTool({ name: "sheets_fill_range", arguments: { spreadsheet_id: "sid", range: "C2:N2", sheet_id: 9, value: "=C3*2" } });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body).toMatchObject({ spreadsheetId: "sid", range: "'Q1 Plan'!C2:N2", cells: 12, topLeft: { cell: "C2", value: "=C3*2" }, verification: { ok: true } });
      const refused: any = await client.callTool({ name: "sheets_fill_range", arguments: { spreadsheet_id: "sid", range: "'Q1 Plan'!C2:N2", sheet_id: 7, value: "=1" } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/names tab 'Q1 Plan'/);
    } finally {
      await close();
    }
  });

  it("does not exist on a read-only deployment", async () => {
    const { client, close } = await connectInMemory({ ctx: { readOnly: true } });
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("sheets_fill_range");
      const r: any = await client.callTool({ name: "sheets_fill_range", arguments: { spreadsheet_id: "s", range: "Sheet1!A1:A2", value: "=1" } }).catch((e) => e);
      expect(String(r.message ?? r.content?.[0]?.text)).toMatch(/not found|unknown tool|Tool sheets_fill_range/i);
    } finally {
      await close();
    }
  });
});

describe("routing: a request to fill reaches the fill tool", () => {
  const manifest = buildManifest(ALL_TOOLS, new Set(ALL_TOOLS.map((t) => t.name)));
  const REQUESTS = [
    "fill the formula down column C",
    "copy this formula across to December",
    "fill C2:C40 with =B2*1.17",
    "תמלא את הנוסחה למטה בעמודה C",
    "תעתיק את הנוסחה לכל החודשים עד דצמבר",
    "תגרור את הנוסחה עד סוף העמודה",
  ];

  it.each(REQUESTS)("the mutation gate offers sheets_fill_range for %j", async (request) => {
    expect(gateTools(request, manifest).tools).toContain("sheets_fill_range");
    expect((await selectTools(request, manifest)).tools).toContain("sheets_fill_range");
  });

  it("reads 'copy the formula' as a fill, not only as a copy", () => {
    // Before the gate cue, the only verb read here was `copy`, whose kind never admits the fill tool.
    expect(readMutationIntent("copy this formula across to December").verbs).toEqual(expect.arrayContaining(["copy", "fill"]));
    expect(readMutationIntent("תעתיק את הנוסחה לכל החודשים").verbs).toEqual(expect.arrayContaining(["fill"]));
  });

  it("stays out of requests that change nothing or copy something else", async () => {
    for (const request of ["what formula is in C2", "which formula feeds the total in D7", "מה הנוסחה בתא C2"]) {
      expect(readMutationIntent(request).mutating, request).toBe(false);
      expect((await selectTools(request, manifest)).tools, request).not.toContain("sheets_fill_range");
    }
    expect(gateTools("copy the template tab and rename the copy to October", manifest).tools).not.toContain("sheets_fill_range");
  });

  // Review finding: "drag down", "drag across" and "autofill" are fill words that name no product.
  // So a request to move a meeting, a task, an email or a slide read as a fill, and the gate
  // pinned a Sheets cell overwrite (destructiveHint) to it — for most of these as its only write,
  // where the gate without the fill tool pins nothing. (The "fill in / fill out" requests on a form
  // or a contact the same finding listed read no fill at all now: see NOT_A_FILL.)
  const ELSEWHERE = [
    "drag the 2pm meeting down to 4pm on my calendar",
    "drag the event down to Friday",
    "drag the meeting down an hour",
    "drag the task down the list",
    "drag the email down to the promotions label",
    "autofill the form with my details",
    "autofill the contact details",
    "drag the slide down to the end of the deck",
    // Pinned below on deployments without Sheets; with Sheets on, they pinned the fill tool too.
    "autofill the message",
    "drag down the email",
    "מילוי אוטומטי למייל", // autofill for the email
    "autofill my calendar",
  ];

  // Review finding: the fill cues matched their words anywhere and in any order, and Hebrew clitics
  // are folded away first. So "fill right" matched "fill in the right names", "fill down" matched
  // "scroll down … and fill in", and "מלא למטה" matched המלא ("the full") beside any למטה
  // ("below"). Where the request names Sheets or no product, the gate then pinned the fill tool
  // first — on structural, delete and send requests that ask for no fill. These read no fill at
  // all now: the cue's words follow the verb in order and close by, "fill in / fill out" is not
  // the fill verb, "right now" is not a direction, and the Hebrew definite article marks the
  // adjective, never the verb.
  const NOT_A_FILL = [
    "insert two rows above row 5 in the sheet and fill in the right names",
    "add a column on the right of the sheet and fill in the prices",
    "scroll down and fill in the missing prices in the sheet",
    "write it down and fill in the sheet",
    "delete it and fill in the right values",
    "fill in the right values in the sheet",
    "fill it in and scroll down to the totals in the sheet",
    "fill the sheet right now",
    "fill the budget sheet right away",
    "fill the rows right after the header",
    "scroll down and drag the photo into the album",
    "fill in the right address on the contact",
    "fill out the right form for the event",
    "מחק את הדוח המלא שמופיע למטה", // delete the full report shown below
    "תשלח את הדוח המלא שמופיע למטה", // send the full report shown below
    "הוסף שתי שורות מעל שורה 5 בגיליון עם השם המלא למטה", // add two rows above row 5 in the sheet with the full name below
    "תשלח את הדוח הקצר והמלא שמופיע למטה", // send the short and the full report shown below
    // Without the article, מלא after its noun is the adjective too ("a full report"): the verb
    // opens its clause.
    "תשלח לי דוח מלא על השורות למטה", // send me a full report on the rows below
    "תשלח דוח מלא עם הנוסחה", // send a full report with the formula
    "תכתוב שם מלא בתא למטה", // write a full name in the cell below
    "הגיליון מלא למטה", // the sheet is full below
    // A term's words are read in the verb's own clause only: a comma, a conjunction, or a Hebrew
    // "and" joined to the next verb ends it. And "the right" + a noun is the adjective.
    "fill the names in column C and scroll down",
    "fill the sheet with the survey results, then scroll down",
    "fill the budget with numbers and push the meeting down an hour",
    "fill the names in the right column",
    "fill the sheet with values from the right tab",
    "מלא את הטבלה ותגלול למטה", // fill the table and scroll down
    // A file, tab or folder between the verb and "formula" is what is copied.
    "copy the budget spreadsheet including the formula cells",
    "copy the whole spreadsheet with its formula columns",
    "copy the spreadsheet with the formula rows to the archive folder",
    "copy the doc with the formula table rows",
  ];

  // Review finding: route keywords "every month" / "whole column" (and Hebrew "לכל החודשים" /
  // "לכל העמודה") indexed the bare words "month" and "column" on the fill tool, so the gate pinned
  // a cell overwrite to Gmail, Calendar and Tasks requests that merely mention a month — bench
  // case J69 among them — and, capped at five, pushed their own writes out.
  const UNRELATED = [
    ...ELSEWHERE,
    ...NOT_A_FILL,
    "archive all the newsletters from last month", // bench/jev J69
    "mark all emails from last month as read",
    "rename every event this month",
    "set the due date of all my tasks to end of month",
    "update the team meeting next month to 3pm",
    "update the budget for every month",
    "append a row with today's totals to the tracker", // bench/jev J58
    // Review finding: in Hebrew מלא is also "full" (הדוח המלא, the full report). As a fill word it
    // pinned the cell overwrite to these Gmail, Chat, Tasks and Calendar requests and, in the
    // capped gate, pushed out their own writes (see the chat_send_message test below).
    "תשלח לדנה את הדוח המלא ותשתף איתה את התיקייה", // send Dana the full report and share the folder with her
    "תעדכן את המשימה עם הכתובת המלאה ותסמן אותה כהושלמה", // update the task with the full address and mark it done
    "תוסיף את השם המלא של הלקוח לאירוע ביומן", // add the client's full name to the calendar event
    "תשלח במייל לדנה את הדוח המלא", // email Dana the full report
  ];

  it.each(UNRELATED)("stays out of %j, which asks for no fill", async (request) => {
    expect(gateTools(request, manifest).tools).not.toContain("sheets_fill_range");
    expect((await selectTools(request, manifest)).tools).not.toContain("sheets_fill_range");
  });

  // The words still read as a fill; what they no longer do is pin the fill tool where the request
  // names another product and not Sheets. Gate and selection are then exactly those of the same
  // deployment without the fill tool, next action included.
  it.each([[{}], [{ ENABLED_TOOL_GROUPS: "gmail,calendar,drive,docs,sheets" }]])("a fill read aimed at another product changes nothing, on %j", async (env) => {
    const tools = toolsFor(env);
    const scoped = buildManifest(tools, new Set(tools.map((t) => t.name)));
    const others = tools.filter((t) => t.name !== "sheets_fill_range");
    const withoutFill = buildManifest(others, new Set(others.map((t) => t.name)));
    for (const request of ELSEWHERE) {
      const intent = readMutationIntent(request);
      expect(intent.verbs, request).toContain("fill");
      expect(intent.services, request).not.toContain("sheets");
      const gate = gateTools(request, scoped);
      expect(gate.tools, request).not.toContain("sheets_fill_range");
      expect(gate, request).toEqual(gateTools(request, withoutFill));
      const selection = await selectTools(request, scoped);
      const base = await selectTools(request, withoutFill);
      expect(selection.tools, request).toEqual(base.tools);
      expect(selection.nextAction, request).toBe(base.nextAction);
    }
  });

  it("asks which object is meant for a slide drag on a deployment without Slides, as it did before the fill tool", async () => {
    const tools = toolsFor({ ENABLED_TOOL_GROUPS: "gmail,calendar,drive,docs,sheets" });
    const scoped = buildManifest(tools, new Set(tools.map((t) => t.name)));
    const selection = await selectTools("drag the slide down to the end of the deck", scoped);
    expect(selection.tools).toEqual([]);
    expect(selection.nextAction).toBe("ask_user");
  });

  // The other side of the same rule: a typed formula or A1 range is the sheet's own words, so a
  // fill typed beside another product still reaches the fill tool, and so does one that names no
  // product at all.
  it.each([
    "fill C2:C40 with =B2*1.17 and email it to Dana",
    "autofill C2:C40 from C2 and email the result to dana@example.com",
    "copy =B2*2 down to row 40 and add an event for Monday",
    "autofill C2:C40 from C2 and send it to Dana",
    "drag it down to the last row and send it to Dana",
  ])("still offers the fill tool for %j", async (request) => {
    expect(gateTools(request, manifest).tools, request).toContain("sheets_fill_range");
    expect((await selectTools(request, manifest)).tools, request).toContain("sheets_fill_range");
  });

  // The words of a fill that name no product, used in a request that asks for none, read no fill
  // at all now: gate and selection are those of the same deployment without the fill tool.
  it.each([[{}], [{ ENABLED_TOOL_GROUPS: "gmail,calendar,drive,docs,sheets" }]])("a request that asks for no fill reads none, on %j", async (env) => {
    const tools = toolsFor(env);
    const scoped = buildManifest(tools, new Set(tools.map((t) => t.name)));
    const others = tools.filter((t) => t.name !== "sheets_fill_range");
    const withoutFill = buildManifest(others, new Set(others.map((t) => t.name)));
    for (const request of NOT_A_FILL) {
      expect(readMutationIntent(request).verbs, request).not.toContain("fill");
      const gate = gateTools(request, scoped);
      expect(gate.tools, request).not.toContain("sheets_fill_range");
      expect(gate, request).toEqual(gateTools(request, withoutFill));
      const selection = await selectTools(request, scoped);
      const base = await selectTools(request, withoutFill);
      expect(selection.tools, request).toEqual(base.tools);
      expect(selection.nextAction, request).toBe(base.nextAction);
    }
  });

  // The other side of that rule: a fill cue still reads where it is one — the verb first, the
  // direction or the formula close behind it — including beside a "fill in" of its own.
  it.each([
    "fill in the names, then fill the formula down column C",
    "fill it down to row 40",
    "fill the rate down for each row",
    "fill the formula right to December",
    "fill right from C2 to N2",
    "ותמלא את הנוסחה למטה עד סוף העמודה", // and fill the formula down to the end of the column
    "מלא למטה עד שורה 40", // fill down to row 40
    "בבקשה מלא למטה עד שורה 40", // please fill down to row 40
    "בגיליון התקציב, מלא למטה את הנוסחה", // in the budget sheet, fill the formula down
    "פתח את הגיליון ומלא למטה", // open the sheet and fill down
    "עכשיו מלא נוסחה בעמודה D", // now fill a formula in column D
    // Review finding: a cap of three words between the verb and the direction, and a strict
    // word order, dropped these plain fills (the source branch put the fill tool first on each).
    // The words of a term now follow the verb anywhere in its clause, in any order.
    "fill the value in C2 down to row 40",
    "fill the dates in column A down to row 100",
    "fill the SUM in B14 across to M14",
    "fill the percentage in D2 down the whole column",
    "in the budget sheet, fill the VAT rate from B2 down",
    "please fill the monthly totals from January across to December",
    "fill the total in the last column down to the bottom of the sheet",
    "מלא את הערך מתא C2 למטה עד שורה 40", // fill the value from cell C2 down to row 40
    "copy down the formula",
    "copy across the formula to December",
    "fill the formula to the right",
    "fill it to the right until December",
    "clear A1:A5 and מלא את הנוסחה למטה", // … and fill the formula down
  ])("still reads a fill in %j", async (request) => {
    expect(readMutationIntent(request).verbs, request).toContain("fill");
    expect(gateTools(request, manifest).tools[0], request).toBe("sheets_fill_range");
    expect((await selectTools(request, manifest)).tools, request).toContain("sheets_fill_range");
  });

  // Review finding: every service word diverted the fill evidence, the Meta service's too
  // ("account", "tool", "server", "workspace", חשבון) — and nothing is ever filled there. So a plain
  // Sheets fill that mentions an account lost the fill tool, and "autofill the account numbers
  // down" pinned no write at all.
  const SHEETS_ONLY_FILLS = [
    "autofill the account numbers down",
    "drag the total down for every account",
    "autofill the account ids across",
    "fill the balance down for every account",
    "fill down the server costs",
    "fill the tool costs down",
    "מלא למטה לכל חשבון", // fill down for every account
  ];
  it.each([[{}], [{ ENABLED_TOOL_GROUPS: "gmail,calendar,drive,docs,sheets" }], [{ ENABLED_TOOL_GROUPS: "sheets_power_user" }]])("a Meta word does not divert a Sheets fill, on %j", async (env) => {
    const tools = toolsFor(env);
    const scoped = buildManifest(tools, new Set(tools.map((t) => t.name)));
    for (const request of SHEETS_ONLY_FILLS) {
      expect(readMutationIntent(request).services, request).toContain("google");
      expect(gateTools(request, scoped).tools[0], request).toBe("sheets_fill_range");
      expect((await selectTools(request, scoped)).tools, request).toContain("sheets_fill_range");
    }
  });

  // The trade-off that remains, pinned so it is a decision and not an accident: any OTHER product's
  // word diverts the fill evidence, even in a request that only means Sheets, and even when that
  // product is not enabled on the deployment ("due" is Tasks, "schedule" Calendar, "person" and
  // "contact" Contacts, "label" Gmail, "file" Drive, "email"). Gate and selection are then exactly
  // those of the same deployment without the fill tool.
  it.each([[{}], [{ ENABLED_TOOL_GROUPS: "gmail,calendar,drive,docs,sheets" }], [{ ENABLED_TOOL_GROUPS: "sheets_power_user" }]])("another product's word still diverts a fill, on %j", async (env) => {
    const tools = toolsFor(env);
    const scoped = buildManifest(tools, new Set(tools.map((t) => t.name)));
    const others = tools.filter((t) => t.name !== "sheets_fill_range");
    const withoutFill = buildManifest(others, new Set(others.map((t) => t.name)));
    for (const request of ["autofill the due dates", "drag down the schedule", "fill the rate down for each person", "fill the discount down for every contact", "fill the label down", "fill down the file names", "fill it down and email it to Dana"]) {
      expect(readMutationIntent(request).verbs, request).toContain("fill");
      expect(gateTools(request, scoped), request).toEqual(gateTools(request, withoutFill));
      const selection = await selectTools(request, scoped);
      const base = await selectTools(request, withoutFill);
      expect(selection.tools, request).toEqual(base.tools);
      expect(selection.nextAction, request).toBe(base.nextAction);
    }
  });

  it("keeps the writes those requests need in the capped gate", () => {
    expect(gateTools("update the team meeting next month to 3pm", manifest).tools).toEqual(expect.arrayContaining(["calendar_update_event", "photos_update_media_item"]));
    expect(gateTools("update the budget for every month", manifest).tools).toEqual(expect.arrayContaining(["sheets_write_range", "calendar_update_event"]));
  });

  it("does not take one of the gate's ranking slots from a row append", () => {
    // "down a column or across a row" in useWhen ranked the fill tool into the top ten for J58,
    // which is filtered to the append pool AFTER ranking, so it displaced a candidate there.
    const ranked = route("append a row with today's totals to the tracker", manifest, { limit: GATE_PARAMS.rankDepth }).candidates.map((c) => c.name);
    expect(ranked).not.toContain("sheets_fill_range");
  });

  // Review finding: the bare verb put the fill tool ahead of sheets_write_range on ordinary
  // "fill in / fill out the sheet" requests. The gate keeps two writes per named service, so
  // the fill tool took sheets_write_range's slot, and the selection lost the only tool that
  // writes DIFFERENT values into cells. These requests name no formula, direction or drag.
  const FILL_IN = [
    "fill out the onboarding sheet and add an event for Monday",
    "fill out the onboarding sheet, share it with dana@example.com and add an event for Monday",
    "fill in the budget sheet",
    "fill the sheet with the survey results",
    "תמלא את הגיליון ותוסיף לשונית חדשה לאוקטובר", // fill in the sheet and add a tab for October
    "תמלא את הגיליון", // fill in the sheet
    "למלא את גיליון ההרשמה", // to fill in the sign-up sheet
  ];

  // Review finding: a pasted share link ends in `?usp=sharing`, and its `=s` read as a typed
  // formula, so every one of these became a fill as soon as the sheet's link was in it.
  const SHEET_LINK = "https://docs.google.com/spreadsheets/d/1AbCdEf/edit?usp=sharing";
  const FILL_IN_LINKED = [...FILL_IN.map((r) => `${r} ${SHEET_LINK}`), `fill in the budget sheet ${SHEET_LINK.replace("?usp=sharing", "#gid=0&range=A1:D10")}`];

  it.each([...FILL_IN, ...FILL_IN_LINKED])("keeps sheets_write_range, not the fill tool, for %j", async (request) => {
    const gate = gateTools(request, manifest).tools;
    const selected = (await selectTools(request, manifest)).tools;
    expect(gate).toContain("sheets_write_range");
    expect(selected).toContain("sheets_write_range");
    expect(gate).not.toContain("sheets_fill_range");
    expect(selected).not.toContain("sheets_fill_range");
  });

  it("keeps chat_send_message in the gate for 'send Dana the full report and share the folder'", async () => {
    const request = "תשלח לדנה את הדוח המלא ותשתף איתה את התיקייה";
    expect(gateTools(request, manifest).tools).toContain("chat_send_message");
    expect((await selectTools(request, manifest)).tools).toContain("chat_send_message");
  });

  it("does not read a fill into copying a whole spreadsheet with its formulas", () => {
    // The cue matches its words in any order and at any distance, so "copy" + "formulas" alone
    // turned this into a fill and admitted two spurious writes into a gate capped at five.
    const request = "copy the budget spreadsheet with its formulas and share it with dana@example.com";
    expect(readMutationIntent(request).verbs).not.toContain("fill");
    const gate = gateTools(request, manifest).tools;
    expect(gate).not.toContain("sheets_fill_range");
    expect(gate).not.toContain("sheets_batch_update_spreadsheet");
    expect(gate).toEqual(expect.arrayContaining(["drive_share_file", "drive_copy_file"]));
    // "whole", "other" and "all" are not destinations on their own: these copy a file.
    for (const other of ["copy the budget spreadsheet with all its formulas", "copy the whole spreadsheet with its formulas", "copy all the formulas to the other spreadsheet"]) {
      expect(readMutationIntent(other).verbs, other).not.toContain("fill");
      expect(gateTools(other, manifest).tools, other).not.toContain("sheets_fill_range");
    }
    // An A1 range without a formula is a copy of cells, not a fill.
    expect(readMutationIntent("copy Sheet1!A1:D10 to the archive spreadsheet").verbs).not.toContain("fill");
    // Hebrew keeps number apart: the plural נוסחאות is not the singular נוסחה the cue holds.
    expect(readMutationIntent("תעתיק את הגיליון עם כל הנוסחאות ותשתף אותו עם דנה").verbs).not.toContain("fill"); // copy the sheet with all the formulas and share it with Dana
  });

  it("does not read a fill into dragging a file into a folder", () => {
    // תגרור = drag. Bare, it is a Drive move, not a fill: only "drag the formula" is a fill.
    const request = "תגרור את הקובץ לתיקיית הכספים"; // drag the file into the finance folder
    expect(readMutationIntent(request).mutating).toBe(false);
    expect(gateTools(request, manifest).tools).toEqual([]);
  });

  it("still reaches the fill tool when the request carries fill evidence", async () => {
    for (const request of [
      "drag the formula down to the last row",
      "autofill C2:C40 from C2",
      "extend the formula to the end of the column",
      "fill down the total formula to row 40",
      "fill the same formula across C2:N2",
      "copy the formula down to row 40",
      "copy the formula to the rest of the column",
      "copy the formula to all the months",
      "copy =B2*2 down to row 40",
      // Escalated review finding: a destination in place of a direction. These read only `copy`
      // before, and the gate pinned sheets_copy_sheet and drive_copy_file, which duplicate a whole
      // tab or file. A typed A1 range reads as "cell"; the Hebrew equivalent already reached it.
      "copy the formula in C2 to D2:N2",
      "copy the formula in C2 to 'תקציב 2026'!D2:N2",
      "copy the formula to the whole column",
      "copy the formula to the other cells",
      "copy the formula to all rows",
      // Review finding: with the spreadsheet or tab named beside the destination the fill tool
      // ranked below the router's top ten, and the gate pinned only the tab and file copies.
      "copy the formula to the whole column on the תקציב tab",
      "copy the formula to all rows of the budget spreadsheet",
      "copy the formula to the other cells in the forecast spreadsheet",
      "copy the formula to every row on the Q1 Plan tab",
      "copy the formula to the rest of column B on the Q1 Plan tab",
      `copy the formula in C2 to D2:N2 in ${SHEET_LINK}`,
      "תמלא את הנוסחה לרוחב עד דצמבר", // fill the formula across to December
      "מילוי אוטומטי של הנוסחה בעמודה D", // autofill the formula in column D
    ]) {
      expect(gateTools(request, manifest).tools, request).toContain("sheets_fill_range");
      expect((await selectTools(request, manifest)).tools, request).toContain("sheets_fill_range");
    }
  });

  it("admits the fill tool on fill evidence only, never through the write family", () => {
    // `fill` is `mutating_idempotent` like `write` and `update`, and a recoverable verb admits its
    // whole family. Not this one: without a fill of its own, "fill the sheet with the survey
    // results" reads `write` and the fill tool, which ranks on its own name, must not ride in.
    expect(OWN_EVIDENCE_VERBS.has("fill")).toBe(true);
    for (const request of ["fill the sheet with the survey results", "update the budget for every month", "set C2:C40 to 5"]) {
      const intent = readMutationIntent(request);
      expect(intent.verbs, request).not.toContain("fill");
      expect(intent.mutating, request).toBe(true);
      expect(gateTools(request, manifest).tools, request).not.toContain("sheets_fill_range");
    }
  });

  // Review finding: `fill` is `mutating_idempotent`, and a read of it put that whole family
  // (sheets_batch_update_spreadsheet, gmail_untrash_message, the replace tools, the destructive
  // gmail_trash_message) in the pool of a gate capped at five. On a file copy that mentions its
  // formula cells, rows or columns, and on a fill paired with a second change, those pushed out
  // the tool that does what the user asked: drive_copy_file, sheets_clear_range, a send tool.
  // A fill admits the fill tools and nothing else.
  it.each([
    ["copy the budget spreadsheet including the formula cells and email it to dana@example.com", ["drive_copy_file", "gmail_send_message"]],
    ["copy the budget spreadsheet with its formulas and row totals and email dana@example.com the link", ["drive_copy_file", "drive_share_file"]],
    ["copy the budget spreadsheet with its formulas and column widths, share it with dana@example.com and email her the link", ["drive_copy_file", "drive_share_file", "gmail_send_message"]],
    ["copy the doc with the formula table rows and share it with the team", ["drive_copy_file", "drive_share_file"]],
    ["copy the formula to the whole column and clear A1:A5", ["sheets_fill_range", "sheets_clear_range"]],
    ["clear A1:A5 and copy the formula to the whole column", ["sheets_fill_range", "sheets_clear_range"]],
    ["copy the formula row and send it to Dana", ["sheets_fill_range", "chat_send_message"]],
    ["copy the formula to the other cells and reply to Dana's email", ["sheets_fill_range", "chat_send_message"]],
    ["copy formula column C to D and send the report to dana@example.com", ["sheets_fill_range", "chat_send_message", "gmail_send_message"]],
  ])("a fill read does not widen the write family: %j keeps %j", async (request, kept) => {
    const gate = gateTools(request, manifest).tools;
    const selected = (await selectTools(request, manifest)).tools;
    expect(gate).toEqual(expect.arrayContaining(kept));
    expect(selected).toEqual(expect.arrayContaining(kept));
    // Nothing the request did not ask for rides in on the fill: no other idempotent write, and no
    // irreversible tool the request's own verbs would not reach.
    for (const spurious of ["sheets_batch_update_spreadsheet", "gmail_untrash_message", "gmail_trash_message", "gmail_update_draft", "sheets_replace_text", "docs_replace_text", "docs_batch_update_document"]) {
      expect(gate, spurious).not.toContain(spurious);
    }
  });

  it("reads a typed formula as the word 'formula', for verbs only", () => {
    // "fill C2:C40 with =B2*1.17" names no direction and never says "formula": it writes one.
    expect(readMutationIntent("fill C2:C40 with =B2*1.17").verbs).toContain("fill");
    expect(readMutationIntent("fill C2:C40 with =SUM(B2:B9)").verbs).toContain("fill");
    expect(readMutationIntent("fill C2:C40 with the totals").verbs).not.toContain("fill");
    // A comparison is not a formula, and a formula with no verb asks for no change.
    expect(readMutationIntent("fill in the rows where x >= B2").verbs).not.toContain("fill");
    expect(readMutationIntent("what does =SUM(B2:B9) return").mutating).toBe(false);
  });

  it("reads neither a formula nor a range out of a link, and `name=value` is not a formula", () => {
    // `?usp=sharing` holds "=s", and a Sheets link can carry `range=A1:D10`: neither is typed by
    // the user. The link still makes the request targeted — it names the spreadsheet.
    for (const link of [SHEET_LINK, "docs.google.com/spreadsheets/d/1AbCdEf/edit?usp=drive_link", "https://docs.google.com/spreadsheets/d/1AbCdEf/edit#gid=0&range=A1:D10"]) {
      for (const request of [`fill in the budget sheet ${link}`, `copy the cells from ${link} down to the summary tab`, `copy the formulas in ${link} into the archive spreadsheet`]) {
        const intent = readMutationIntent(request);
        expect(intent.verbs, request).not.toContain("fill");
        expect(intent.targeted, request).toBe(true);
      }
    }
    expect(readMutationIntent("fill the form with name=Dana").verbs).not.toContain("fill");
    // A formula typed in the request still counts, link or no link.
    expect(readMutationIntent(`fill C2:C40 with =B2*1.17 in ${SHEET_LINK}`).verbs).toContain("fill");
    expect(readMutationIntent("fill C2:C40 with '=SUM(B2:B9)'").verbs).toContain("fill");
    expect(readMutationIntent(`copy the formula in ${SHEET_LINK} to D2:N2`).verbs).toContain("fill");
  });

  // Review finding: admission hung on the router's rank. A destination is fill evidence but not
  // one of the tool's ranking words, so naming the spreadsheet or tab beside it ("… on the תקציב
  // tab") dropped the tool below the router's top ten and out of the gate. The Hebrew form
  // reached it; the English one did not. Every phrasing, in every context, must reach it.
  it("admits the fill tool on evidence, however it ranks", async () => {
    const phrasings = ["copy the formula in C2 to D2:N2", "copy the formula to the whole column", "copy the formula to the other cells", "copy the formula to all rows", "copy the formula to every row", "copy the formula to the rest of column B", "copy the formula down to row 40", "copy this formula across to December"];
    const contexts = ["", " of the budget spreadsheet", " on the תקציב tab", " in the forecast sheet", " on the Q1 Plan tab", " in the budget"];
    const unranked: string[] = [];
    for (const phrasing of phrasings) {
      for (const context of contexts) {
        const request = phrasing + context;
        const gate = gateTools(request, manifest).tools;
        expect(gate[0], request).toBe("sheets_fill_range");
        expect((await selectTools(request, manifest)).tools, request).toContain("sheets_fill_range");
        const ranked = route(request, manifest, { limit: GATE_PARAMS.rankDepth }).candidates.map((c) => c.name);
        if (!ranked.includes("sheets_fill_range")) unranked.push(request);
      }
    }
    // The point of the test: some of these are not in the router's top ten at all.
    expect(unranked).toContain("copy the formula to the whole column on the תקציב tab");
  });

  // The fill tool is added to the gate, never traded for another write: the gate for a request
  // that reads a fill is the gate without the fill tool, plus the fill tool. It is not ranked
  // either, so it cannot hold one of the router's ten places another write needed — on "copy the
  // cells from <link> down to the summary tab" it ranked second and pushed sheets_write_range out.
  it("never costs another write its place in the gate", () => {
    const others = ALL_TOOLS.filter((t) => t.name !== "sheets_fill_range");
    const withoutFill = buildManifest(others, new Set(others.map((t) => t.name)));
    const fills = ["copy the formula to the whole column", "copy the formula in C2 to D2:N2", "fill the formula down column C", "drag the formula down to the last row"];
    const seconds = ["clear A1:A5", "trash the old draft email", "share the spreadsheet with dana@example.com", "rename the spreadsheet to Budget 2027", "send it to Dana", "add a tab for October"];
    const requests = [
      ...fills.flatMap((f) => seconds.flatMap((s) => [`${f} and ${s}`, `${s} and ${f}`])),
      "copy the doc with the formula table rows and rename it to Budget 2027",
      "copy the budget spreadsheet including the formula cells and email it to dana@example.com",
      `copy the cells from ${SHEET_LINK} down to the summary tab`,
      `fill the formula down column C in ${SHEET_LINK}`,
      ...FILL_IN_LINKED,
    ];
    for (const request of requests) {
      const gate = gateTools(request, manifest).tools;
      expect(gate.filter((n) => n !== "sheets_fill_range"), request).toEqual(gateTools(request, withoutFill).tools);
      expect(gate.length, request).toBeLessThanOrEqual(GATE_PARAMS.maxTools + OWN_EVIDENCE_VERBS.size);
    }
    // The two the review named, by name.
    expect(gateTools("copy the formula to the whole column and trash the old draft email", manifest).tools).toEqual(expect.arrayContaining(["sheets_fill_range", "gmail_trash_message"]));
    expect(gateTools(`copy the cells from ${SHEET_LINK} down to the summary tab`, manifest).tools).toContain("sheets_write_range");
  });

  // Review finding: when `fill` was the only verb read and the deployment had no fill tool, the
  // gate fell back to "every write", as it does for a verb no enabled tool spells, and pinned
  // unrelated tools, destructive ones included. On the release base these pinned nothing.
  it.each([
    [{ ENABLED_TOOL_GROUPS: "gmail" }],
    [{ ENABLED_TOOL_GROUPS: "calendar" }],
    [{ ENABLED_TOOL_GROUPS: "company_admin", DISABLED_TOOL_GROUPS: "sheets" }],
  ])("a fill no enabled tool can do pins nothing, on %j", async (env) => {
    const tools = toolsFor(env);
    const scoped = buildManifest(tools, new Set(tools.map((t) => t.name)));
    expect(scoped.map((e) => e.name)).not.toContain("sheets_fill_range");
    const writes = new Set(scoped.filter((e) => e.write).map((e) => e.name));
    for (const request of ["autofill the message", "drag down the email", "מילוי אוטומטי למייל", "autofill the draft", "גרור נוסחה למייל", "autofill my calendar", "extend the formula to the whole column"]) {
      const gate = gateTools(request, scoped);
      expect(gate.intent.verbs, request).toEqual(["fill"]);
      expect(gate.tools, request).toEqual([]);
      expect(gate.needsTarget, request).toBe(false);
      const selection = await selectTools(request, scoped);
      expect(selection.tools.filter((n) => writes.has(n)), request).toEqual([]);
      expect(selection.nextAction, request).toBe("select");
    }
  });

  // Review finding: the fill read added two passes over the WHOLE request — a link cut (LINK_RE,
  // quadratic on a run of dotted words) and a second hard-signal scan — though what they feed is
  // capped at the router's 500 characters. On 80 KB of "a." the gate went from ~3 s (the one
  // uncapped signal scan the gate already made) to ~12 s. Now they read the capped text only, so
  // a long request costs the gate what it cost before this step: that one scan, plus little.
  it("reads the fill evidence out of the capped text only, so a wall of text costs no extra pass", () => {
    const request = "fill down " + "a.".repeat(20_000);
    matchHardSignals(request); // warm up
    let started = performance.now();
    matchHardSignals(request);
    const baseline = performance.now() - started;
    started = performance.now();
    const gate = gateTools(request, manifest);
    const elapsed = performance.now() - started;
    expect(gate.intent.verbs).toContain("fill");
    expect(elapsed).toBeLessThan(baseline * 1.5 + 250);
  }, 60_000);

  it("is pinned by the gate for no committed bench/jev case: none of the 72 asks for a fill", () => {
    const pinned = benchCases.cases.filter((c) => gateTools(c.request, manifest).tools.includes("sheets_fill_range")).map((c) => c.id);
    expect(pinned).toEqual([]);
  });

  it("on the JEV QA path, google_select_tools pins it for a fill and not for J69", async () => {
    const { client, close } = await connectInMemory({ env: { JEV_ENABLED: "true" } });
    try {
      const ask = async (request: string) => {
        const res: any = await client.callTool({ name: "google_select_tools", arguments: { request } });
        expect(res.isError, res.content?.[0]?.text).toBeFalsy();
        return JSON.parse(res.content[0].text);
      };
      expect((await ask("archive all the newsletters from last month")).gate.pinned).not.toContain("sheets_fill_range");
      expect((await ask("fill the formula down column C")).gate.pinned).toContain("sheets_fill_range");
      const fillOut = await ask("fill out the onboarding sheet and add an event for Monday");
      expect(fillOut.gate.pinned).toContain("sheets_write_range");
      expect(fillOut.gate.pinned).not.toContain("sheets_fill_range");
      expect(fillOut.tools).toContain("sheets_write_range");
      const full = await ask("תשלח לדנה את הדוח המלא ותשתף איתה את התיקייה");
      expect(full.gate.pinned).toContain("chat_send_message");
      expect(full.gate.pinned).not.toContain("sheets_fill_range");
    } finally {
      await close();
    }
  });
});

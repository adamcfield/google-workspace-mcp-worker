/**
 * shape=cells on the Sheets read tools (QA on the JEV build: "Reads return arrays with no cell
 * addresses, and empty trailing cells are dropped. I wrote a note into column C instead of D").
 *
 * Every assertion parses the tool output as JSON (never whitespace), and the default grid output
 * is pinned byte for byte against what these tools returned before `shape` existed.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../src/tools/index.js";
import { MAX_OUTPUT_CHARS, ok, provenance, strip } from "../src/tools/_shared.js";
import { connectInMemory, listToolsInMemory } from "./helpers/mcp.js";
import { toApiTool, SURFACES } from "../scripts/lib/measure-core.mjs";

const byName = (n: string) => ALL_TOOLS.find((t) => t.name === n)!;
const ctx = (g: unknown) => ({ g, email: "u@example.com", requestedScopes: undefined }) as any;
/** What a client receives, parsed: the handler result through the same ok() → strip() the wire uses. */
const reply = (result: unknown) => JSON.parse(ok(result).content[0].text as string);
const READ = { spreadsheet_id: "s1", include_formulas: false, value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", major_dimension: "ROWS" } as const;

/** A values.get fake that echoes `range` and records every call's params. */
function valuesClient(range: string | undefined, values: unknown[][] | undefined, opts: { formulas?: unknown[][]; majorDimension?: string } = {}) {
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    get: async (url: string, params: Record<string, unknown> = {}) => {
      calls.push({ url, params });
      const body = params.valueRenderOption === "FORMULA" && opts.formulas ? opts.formulas : values;
      return { range, majorDimension: opts.majorDimension ?? "ROWS", ...(body ? { values: body } : {}) };
    },
  };
}

describe("the QA failure: a note meant for column D", () => {
  // Header row says the note column is D. Row 3 has only two values, so Google returns ["Aug", "80"]
  // for a range four columns wide. Counting positions, the first free cell after the data is C3 —
  // which is where the note went. Addresses leave nothing to count.
  const values = [
    ["Month", "Budget", "Actual", "Note"],
    ["Jul", "100", "90", "ok"],
    ["Aug", "80"],
  ];

  it("grid output is ragged — the hazard, unchanged", async () => {
    const g = valuesClient("'Sheet 1'!A1:D3", values);
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "'Sheet 1'!A1:D3" }, ctx(g)));
    expect(r.values[2]).toEqual(["Aug", "80"]);
    expect(r.values[2].length).toBeLessThan(4);
  });

  it("shape=cells names every cell, reports the full width and leaves D3 visibly empty", async () => {
    const g = valuesClient("'Sheet 1'!A1:D3", values);
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "'Sheet 1'!A1:D3", shape: "cells" }, ctx(g)));
    expect(r).toMatchObject({ range: "'Sheet 1'!A1:D3", rowCount: 3, columnCount: 4, cellCount: 10 });
    expect(r.cells.D1).toEqual({ value: "Note" });
    expect(r.cells.B3).toEqual({ value: "80" });
    expect(r.cells.C3).toBeUndefined();
    expect(r.cells.D3).toBeUndefined();
    // Where does row 3's note go? The positional guess and the addressed answer disagree.
    const positionalGuess = `${String.fromCharCode(65 + values[2].length)}3`;
    const noteColumn = Object.keys(r.cells).find((a) => r.cells[a].value === "Note")!.replace(/\d+$/, "");
    expect(positionalGuess).toBe("C3");
    expect(`${noteColumn}3`).toBe("D3");
  });

  it("an off-origin read (the range starts at C5) does not put column C at A", async () => {
    const g = valuesClient("'Sheet 1'!C5:F9", [["Jul", "", "90"], [], ["Aug", "80"]]);
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "'Sheet 1'!C5:F9", shape: "cells" }, ctx(g)));
    expect(r.cells).toEqual({ C5: { value: "Jul" }, E5: { value: "90" }, C7: { value: "Aug" }, D7: { value: "80" } });
    expect(r).toMatchObject({ rowCount: 5, columnCount: 4, cellCount: 4 });
  });
});

describe("sheets_read_range shape=cells", () => {
  it("keeps the provenance envelope first and names the addressed fields", async () => {
    const g = valuesClient("Sheet1!A1:B1", [["a", "b"]]);
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "Sheet1!A1:B1", shape: "cells" }, ctx(g)));
    expect(Object.keys(r)[0]).toBe("provenance");
    expect(r.provenance).toMatchObject({ source: "sheets:spreadsheet:s1", fields: ["cells.*.value"], trust: "third-party" });
    expect(Object.keys(r)).toEqual(["provenance", "range", "rowCount", "columnCount", "cellCount", "cells"]);
  });

  it("major_dimension=COLUMNS: transposes to the right addresses", async () => {
    const g = valuesClient("Data!B2:D4", [["b2", "b3", "b4"], [], ["d2", "", "d4"]], { majorDimension: "COLUMNS" });
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "Data!B2:D4", major_dimension: "COLUMNS", shape: "cells" }, ctx(g)));
    expect(g.calls[0].params.majorDimension).toBe("COLUMNS");
    expect(r.cells).toEqual({ B2: { value: "b2" }, B3: { value: "b3" }, B4: { value: "b4" }, D2: { value: "d2" }, D4: { value: "d4" } });
    expect(r).toMatchObject({ rowCount: 3, columnCount: 3, cellCount: 5 });
  });

  it("a quoted Hebrew tab name with a space and an apostrophe", async () => {
    const range = "'דו''ח תקציב 2026'!B2:C3";
    const g = valuesClient(range, [["הכנסות", "1,200"], ["", "800"]]);
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range, shape: "cells" }, ctx(g)));
    expect(r.range).toBe(range);
    expect(r.cells).toEqual({ B2: { value: "הכנסות" }, C2: { value: "1,200" }, C3: { value: "800" } });
  });

  it("a named range is addressed from the A1 range Google resolved it to", async () => {
    const g = valuesClient("Rates!E10:F11", [["USD", "3.7"], ["EUR", "4.0"]]);
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "FxRates", shape: "cells" }, ctx(g)));
    expect(Object.keys(r.cells)).toEqual(["E10", "F10", "E11", "F11"]);
  });

  it("whole columns and a single cell", async () => {
    const cols = reply(await byName("sheets_read_range").handler({ ...READ, range: "Sheet1!C:D", shape: "cells" }, ctx(valuesClient("Sheet1!C1:D1000", [["h"], [], ["", "x"]]))));
    expect(cols.cells).toEqual({ C1: { value: "h" }, D3: { value: "x" } });
    expect(cols).toMatchObject({ rowCount: 1000, columnCount: 2 });
    const one = reply(await byName("sheets_read_range").handler({ ...READ, range: "Sheet1!AA7", shape: "cells" }, ctx(valuesClient("Sheet1!AA7", [[42]]))));
    expect(one).toMatchObject({ rowCount: 1, columnCount: 1, cellCount: 1, cells: { AA7: { value: 42 } } });
  });

  it("include_formulas: formula only where the cell has one, and a formula showing blank is kept", async () => {
    const g = valuesClient("S!B2:D2", [["3", "6"]], { formulas: [[3, "=B2*2", '=IF(B2>5,"big","")']] });
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "S!B2:D2", include_formulas: true, shape: "cells" }, ctx(g)));
    expect(g.calls.map((c) => c.params.valueRenderOption)).toEqual(["FORMATTED_VALUE", "FORMULA"]);
    expect(r.provenance.fields).toEqual(["cells.*.value", "cells.*.formula"]);
    expect(r.cells).toEqual({ B2: { value: "3" }, C2: { value: "6", formula: "=B2*2" }, D2: { formula: '=IF(B2>5,"big","")' } });
    expect(r.cellCount).toBe(3);
  });

  it("an all-empty range still says cellCount 0 (strip() drops the empty cells object)", async () => {
    const r = reply(await byName("sheets_read_range").handler({ ...READ, range: "'Sheet 1'!A1:B2", shape: "cells" }, ctx(valuesClient("'Sheet 1'!A1:B2", undefined))));
    expect(r.cellCount).toBe(0);
    expect(r.cells).toBeUndefined();
    expect(r).toMatchObject({ rowCount: 2, columnCount: 2 });
  });

  it("refuses to guess an origin when Google echoes no coordinates", async () => {
    await expect(byName("sheets_read_range").handler({ ...READ, range: "FxRates", shape: "cells" }, ctx(valuesClient(undefined, [["x"]])))).rejects.toThrow(/no cell coordinates/);
  });
});

describe("sheets_batch_read_ranges shape=cells", () => {
  it("one entry per range, each addressed from its own echoed range", async () => {
    const g = {
      get: async () => ({
        spreadsheetId: "s1",
        valueRanges: [
          { range: "'תקציב 2026'!C5:E6", majorDimension: "ROWS", values: [["a", "", "c"], ["d"]] },
          { range: "Data!A1:B2", majorDimension: "ROWS" },
          { range: "Data!AZ3:BA3", majorDimension: "ROWS", values: [["x", "y"]] },
        ],
      }),
    };
    const r = reply(await byName("sheets_batch_read_ranges").handler({ spreadsheet_id: "s1", ranges: ["'תקציב 2026'!C5:E6", "Data!A1:B2", "Data!AZ3:BA3"], value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", shape: "cells" }, ctx(g)));
    expect(Object.keys(r)[0]).toBe("provenance");
    expect(r.provenance.fields).toEqual(["valueRanges[].cells.*.value"]);
    expect(r.valueRanges).toEqual([
      { range: "'תקציב 2026'!C5:E6", rowCount: 2, columnCount: 3, cellCount: 3, cells: { C5: { value: "a" }, E5: { value: "c" }, C6: { value: "d" } } },
      { range: "Data!A1:B2", rowCount: 2, columnCount: 2, cellCount: 0 },
      { range: "Data!AZ3:BA3", rowCount: 1, columnCount: 2, cellCount: 2, cells: { AZ3: { value: "x" }, BA3: { value: "y" } } },
    ]);
  });
});

/** spreadsheets.get with includeGridData for 'Sheet 1'!B7:E9 (0-based origin row 6, column 1). */
const gridData = () => ({
  sheets: [
    {
      properties: { sheetId: 3, title: "Sheet 1" },
      data: [{ startRow: 6, startColumn: 1, rowData: [{ values: [{ formattedValue: "Jul" }, {}, { formattedValue: "90", userEnteredValue: { formulaValue: "=B7-10" }, effectiveValue: { numberValue: 90 } }] }, {}, { values: [{ formattedValue: "Aug", note: "n" }] }] }],
    },
  ],
});

describe("sheets_read_cells shape=cells", () => {
  const args = { spreadsheet_id: "s1", range: "'Sheet 1'!B7:E9", fields: ["value", "formula", "note", "link"] };

  it("keys each non-empty cell by its address from the GridData origin", async () => {
    const r = reply(await byName("sheets_read_cells").handler({ ...args, shape: "cells" }, ctx({ get: async () => gridData() })));
    expect(Object.keys(r)[0]).toBe("provenance");
    expect(r.provenance.fields).toEqual(["cells.*.v", "cells.*.f", "cells.*.note", "cells.*.link"]);
    expect(Object.keys(r)).toEqual(["provenance", "sheet", "cellCount", "cells"]);
    expect(r.sheet).toEqual({ sheetId: 3, title: "Sheet 1" });
    expect(r.cellCount).toBe(3);
    expect(r.cells).toEqual({ B7: { v: "Jul" }, D7: { v: "90", n: 90, f: "=B7-10" }, B9: { v: "Aug", note: "n" } });
  });

  it("the QA failure through read_cells: row 9 has one entry in a four-column range, and nothing needs counting", async () => {
    // Grid: startColumn 2 and rows[2] = [{v:"Aug"}] — the note column has to be worked out as
    // startColumn + index, the counting that put a note in C instead of D. Keyed, D9 is simply absent.
    const grid = reply(await byName("sheets_read_cells").handler(args, ctx({ get: async () => gridData() })));
    expect(grid.rows[2]).toHaveLength(1);
    const r = reply(await byName("sheets_read_cells").handler({ ...args, shape: "cells" }, ctx({ get: async () => gridData() })));
    expect(Object.keys(r.cells).filter((a) => a.endsWith("9"))).toEqual(["B9"]);
    expect(r.cells.D9).toBeUndefined();
    expect(r.cells.D7.f).toBe("=B7-10");
  });

  it("Google omits a zero origin: a range at A1 on a Hebrew tab, and a multi-letter column", async () => {
    const at = (startColumn?: number) => ({
      sheets: [{ properties: { sheetId: 0, title: "דו\"ח" }, data: [{ ...(startColumn === undefined ? {} : { startColumn }), rowData: [{ values: [{ formattedValue: "א" }, { formattedValue: "ב" }] }] }] }],
    });
    const a1 = reply(await byName("sheets_read_cells").handler({ ...args, range: "'דו\"ח'!A1:B1", shape: "cells" }, ctx({ get: async () => at() })));
    expect(a1.cells).toEqual({ A1: { v: "א" }, B1: { v: "ב" } });
    const az = reply(await byName("sheets_read_cells").handler({ ...args, range: "'דו\"ח'!AZ1:BA1", shape: "cells" }, ctx({ get: async () => at(51) })));
    expect(Object.keys(az.cells)).toEqual(["AZ1", "BA1"]);
  });

  it("an all-empty range still says cellCount 0", async () => {
    const empty = { sheets: [{ properties: { sheetId: 3, title: "Sheet 1" }, data: [{ startRow: 6, startColumn: 1 }] }] };
    const r = reply(await byName("sheets_read_cells").handler({ ...args, shape: "cells" }, ctx({ get: async () => empty })));
    expect(r.cellCount).toBe(0);
    expect(r.cells).toBeUndefined();
  });
});

describe("the default is still the grid, byte for byte", () => {
  // Pinned from these tools' output before `shape` existed (JSON of the stripped result, which is
  // what ok() serialises — so this holds whether replies are pretty-printed or compact).
  const src = "sheets:spreadsheet:s1";
  const vals = { range: "'Sheet 1'!B7:E9", majorDimension: "ROWS", values: [["Jul", "100", "90"], [], ["Aug", "", "80", "late"]] };
  const g1 = { get: async (_u: string, p: Record<string, unknown>) => (p.valueRenderOption === "FORMULA" ? { ...vals, values: [["Jul", 100, "=B7-10"], [], ["Aug", "", 80, "late"]] } : vals) };
  const before = {
    read: JSON.stringify({ ...provenance(src, ["values"]), range: "'Sheet 1'!B7:E9", majorDimension: "ROWS", rows: 3, values: [["Jul", "100", "90"], [], ["Aug", "", "80", "late"]] }),
    readF: JSON.stringify({ ...provenance(src, ["values", "formulas"]), range: "'Sheet 1'!B7:E9", majorDimension: "ROWS", rows: 3, values: [["Jul", "100", "90"], [], ["Aug", "", "80", "late"]], formulas: [["Jul", "100", "=B7-10"], [], ["Aug", "", "80", "late"]] }),
    batch: JSON.stringify({ ...provenance(src, ["valueRanges[].values"]), valueRanges: [{ range: "Data!A1:B2", values: [["a"], ["", "b"]] }, { range: "'גיליון 1'!C3:C4" }] }),
    cells: JSON.stringify({ ...provenance(src, ["rows[][].v", "rows[][].f", "rows[][].note", "rows[][].link"]), sheet: { sheetId: 3, title: "Sheet 1" }, startRow: 7, startColumn: 2, rows: [[{ v: "Jul" }, null, { v: "90", n: 90, f: "=B7-10" }], [], [{ v: "Aug", note: "n" }]] }),
  };
  const out = (x: unknown) => JSON.stringify(strip(x));
  const base = { spreadsheet_id: "s1", range: "'Sheet 1'!B7:E9", value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", major_dimension: "ROWS" };
  const g2 = { get: async () => ({ spreadsheetId: "s1", valueRanges: [{ range: "Data!A1:B2", majorDimension: "ROWS", values: [["a"], ["", "b"]] }, { range: "'גיליון 1'!C3:C4", majorDimension: "ROWS" }] }) };
  const batchArgs = { spreadsheet_id: "s1", ranges: ["Data!A1:B2", "'גיליון 1'!C3:C4"], value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING" };
  const g3 = { get: async () => gridData() };
  const cellsArgs = { spreadsheet_id: "s1", range: "'Sheet 1'!B7:E9", fields: ["value", "formula", "note", "link"] };

  it.each([undefined, "grid"])("shape=%s", async (shape) => {
    const s = shape === undefined ? {} : { shape };
    expect(out(await byName("sheets_read_range").handler({ ...base, include_formulas: false, ...s }, ctx(g1)))).toBe(before.read);
    expect(out(await byName("sheets_read_range").handler({ ...base, include_formulas: true, ...s }, ctx(g1)))).toBe(before.readF);
    expect(out(await byName("sheets_batch_read_ranges").handler({ ...batchArgs, ...s }, ctx(g2)))).toBe(before.batch);
    expect(out(await byName("sheets_read_cells").handler({ ...cellsArgs, ...s }, ctx(g3)))).toBe(before.cells);
  });

  it("the schema defaults shape to grid on all three tools", () => {
    for (const name of ["sheets_read_range", "sheets_batch_read_ranges", "sheets_read_cells"]) {
      const parsed = z.object(byName(name).input).parse({ spreadsheet_id: "s1", range: "A1", ranges: ["A1"] }) as { shape?: string };
      expect(parsed.shape, name).toBe("grid");
      expect(() => z.object(byName(name).input).parse({ spreadsheet_id: "s1", range: "A1", ranges: ["A1"], shape: "map" }), name).toThrow();
    }
  });

  it("over the wire, a call without shape returns the grid and shape=cells the addresses", async () => {
    const { client, close } = await connectInMemory({ ctx: { g: g1 as any } });
    try {
      const grid: any = await client.callTool({ name: "sheets_read_range", arguments: { spreadsheet_id: "s1", range: "'Sheet 1'!B7:E9" } });
      expect(JSON.stringify(JSON.parse(grid.content[0].text))).toBe(before.read);
      const cells: any = await client.callTool({ name: "sheets_read_range", arguments: { spreadsheet_id: "s1", range: "'Sheet 1'!B7:E9", shape: "cells" } });
      const r = JSON.parse(cells.content[0].text);
      expect(r.cells).toEqual({ B7: { value: "Jul" }, C7: { value: "100" }, D7: { value: "90" }, B9: { value: "Aug" }, D9: { value: "80" }, E9: { value: "late" } });
      expect(r).toMatchObject({ rowCount: 3, columnCount: 4, cellCount: 6 });
    } finally {
      await close();
    }
  });
});

describe("a whole-tab read with shape=cells stays within one reply", () => {
  // Found by an independent verifier: shape=cells built one small object per non-empty cell of the
  // whole range (~119 bytes retained each), strip() copied them all again and JSON.stringify ran
  // over the lot, only for ok() to keep the first MAX_OUTPUT_CHARS (~17k cells). A 17,500 × 20 tab
  // (350k cells) ran a 128 MB isolate out of memory where the grid shape did not. Now only what
  // fits one reply is built, the rest is counted, and the reply says it was cut and where.
  const SMALLEST_ENTRY = '"A1":{"value":0},'.length;
  /** Rows of `r<i>c<j>` strings, one per cell. */
  const grid = (rows: number, cols: number, row0 = 0) => Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => `r${row0 + i}c${j}`));
  /** The wire text is whole JSON (ok() never had to cut it) and within the limit. */
  const wire = (result: unknown) => {
    const text = ok(result).content[0].text as string;
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(text).not.toMatch(/…\[truncated: /);
    return JSON.parse(text);
  };

  it("sheets_read_range: 400,000 cells build at most one reply's worth, and cellCount still says 400,000", async () => {
    const g = valuesClient("Data!A1:T20000", grid(20_000, 20));
    const raw = (await byName("sheets_read_range").handler({ ...READ, range: "Data", shape: "cells" }, ctx(g))) as { cells: Record<string, unknown> };
    const built = Object.keys(raw.cells).length;
    expect(built).toBeLessThanOrEqual(Math.floor(MAX_OUTPUT_CHARS / SMALLEST_ENTRY));
    const r = wire(raw);
    expect(r).toMatchObject({ range: "Data!A1:T20000", rowCount: 20_000, columnCount: 20, cellCount: 400_000, truncated: true, returnedCells: built });
    expect(Object.keys(r)).toEqual(["provenance", "range", "rowCount", "columnCount", "cellCount", "truncated", "returnedCells", "note", "cells"]);
    expect(r.note).toMatch(/narrower range/);
    // A prefix in read order: whole rows up to the cut, then the start of one row.
    const keys = Object.keys(r.cells);
    expect(keys.slice(0, 21)).toEqual([..."ABCDEFGHIJKLMNOPQRST"].map((c) => `${c}1`).concat("A2"));
    const last = keys[keys.length - 1];
    const lastRow = Number(last.replace(/^[A-Z]+/, ""));
    expect(r.cells[last].value).toBe(`r${lastRow - 1}c${last.charCodeAt(0) - 65}`);
    expect(keys.length).toBe((lastRow - 1) * 20 + (last.charCodeAt(0) - 64));
  });

  it("sheets_read_range include_formulas: the same bound with formulas alongside", async () => {
    const values = grid(10_000, 10);
    const formulas = values.map((row, i) => row.map((v, j) => (j === 9 ? `=SUM(A${i + 1}:I${i + 1})` : v)));
    const g = valuesClient("Data!A1:J10000", values, { formulas });
    const r = wire(await byName("sheets_read_range").handler({ ...READ, range: "Data!A1:J10000", include_formulas: true, shape: "cells" }, ctx(g)));
    expect(r).toMatchObject({ cellCount: 100_000, truncated: true });
    expect(Object.keys(r.cells)).toHaveLength(r.returnedCells);
    expect(r.cells.J1).toEqual({ value: "r0c9", formula: "=SUM(A1:I1)" });
  });

  it("sheets_batch_read_ranges: the ranges share one reply's worth, in the order asked", async () => {
    const g = {
      get: async () => ({
        valueRanges: [
          { range: "A!A1:J6000", majorDimension: "ROWS", values: grid(6_000, 10) },
          { range: "B!A1:J6000", majorDimension: "ROWS", values: grid(6_000, 10) },
          { range: "C!A1:B2", majorDimension: "ROWS" },
          { range: "D!A1:J6000", majorDimension: "ROWS", values: grid(6_000, 10) },
        ],
      }),
    };
    const raw = (await byName("sheets_batch_read_ranges").handler({ spreadsheet_id: "s1", ranges: ["A", "B", "C", "D"], value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", shape: "cells" }, ctx(g))) as { valueRanges: Array<{ cells: Record<string, unknown> }> };
    const built = raw.valueRanges.reduce((n, v) => n + Object.keys(v.cells).length, 0);
    expect(built).toBeLessThanOrEqual(Math.floor(MAX_OUTPUT_CHARS / SMALLEST_ENTRY));
    const r = wire(raw);
    expect(Object.keys(r)).toEqual(["provenance", "note", "valueRanges"]);
    expect(r.valueRanges.map((v: { range: string }) => v.range)).toEqual(["A!A1:J6000", "B!A1:J6000", "C!A1:B2", "D!A1:J6000"]);
    expect(r.valueRanges.map((v: { cellCount: number }) => v.cellCount)).toEqual([60_000, 60_000, 0, 60_000]);
    // The first range fills the reply; the others are counted but carry no cells, and the empty one is not "cut".
    expect(r.valueRanges[0]).toMatchObject({ truncated: true, returnedCells: Object.keys(r.valueRanges[0].cells).length });
    expect(r.valueRanges[1]).toEqual({ range: "B!A1:J6000", rowCount: 6_000, columnCount: 10, cellCount: 60_000, truncated: true, returnedCells: 0 });
    expect(r.valueRanges[2]).toEqual({ range: "C!A1:B2", rowCount: 2, columnCount: 2, cellCount: 0 });
    expect(r.valueRanges[3]).toMatchObject({ truncated: true, returnedCells: 0 });
  });

  // Found by independent verifiers: each range's entry ({"range", counts, truncated,
  // returnedCells: 0}) was charged only when that range was reached, after the ranges before it
  // had spent the budget. With as few as 8 ranges after the cut the entries overran the
  // envelope allowance, ok() cut the reply mid-string and the later ranges' counts were lost.
  // Every range's entry is now reserved before any cells are built.
  const batch = async (valueRanges: Array<{ range: string; values?: unknown[][] }>) => {
    const g = { get: async () => ({ valueRanges: valueRanges.map((v) => ({ majorDimension: "ROWS", ...v })) }) };
    const args = { spreadsheet_id: "s1", ranges: valueRanges.map((v) => v.range), value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", shape: "cells" };
    return wire(await byName("sheets_batch_read_ranges").handler(args, ctx(g)));
  };

  it("sheets_batch_read_ranges: a first range that fills the reply, then 24 more, is still whole JSON with every range counted", async () => {
    const later = grid(60, 10);
    const ranges = [{ range: "A!A1:J20000", values: grid(20_000, 10) }, ...Array.from({ length: 24 }, (_, k) => ({ range: `'Quarterly report ${k + 1}'!A1:J6000`, values: later }))];
    const r = await batch(ranges);
    expect(r.valueRanges.map((v: { range: string }) => v.range)).toEqual(ranges.map((v) => v.range));
    expect(r.valueRanges.map((v: { cellCount: number }) => v.cellCount)).toEqual([200_000, ...Array(24).fill(600)]);
    expect(r.valueRanges[0]).toMatchObject({ truncated: true, returnedCells: Object.keys(r.valueRanges[0].cells).length });
    for (const v of r.valueRanges.slice(1)) expect(v).toEqual({ range: v.range, rowCount: 6_000, columnCount: 10, cellCount: 600, truncated: true, returnedCells: 0 });
  });

  it("sheets_batch_read_ranges: 100 ranges (the schema maximum) on long quoted Hebrew tab names are still whole JSON", async () => {
    // Tab names near Google's 100-character limit, with a doubled apostrophe; each range 10,000 cells.
    const tab = (k: number) => `'דו''ח רבעוני מפורט של הכנסות והוצאות לפי מחלקות, פרויקטים ואנשי קשר — גרסה ${String(k).padStart(3, "0")}'`;
    const values = grid(1_000, 10);
    const ranges = Array.from({ length: 100 }, (_, k) => ({ range: `${tab(k)}!A1:J1000`, values }));
    expect(z.object(byName("sheets_batch_read_ranges").input).parse({ spreadsheet_id: "s1", ranges: ranges.map((v) => v.range) }).ranges).toHaveLength(100);
    const r = await batch(ranges);
    expect(r.note).toMatch(/fewer or narrower ranges/);
    expect(r.valueRanges).toHaveLength(100);
    expect(r.valueRanges.map((v: { range: string }) => v.range)).toEqual(ranges.map((v) => v.range));
    expect(r.valueRanges.every((v: { cellCount: number }) => v.cellCount === 10_000)).toBe(true);
    const returned = r.valueRanges.map((v: { returnedCells?: number; cells?: object }) => v.returnedCells ?? Object.keys(v.cells ?? {}).length);
    expect(returned.reduce((n: number, c: number) => n + c, 0)).toBeGreaterThan(0);
    expect(r.valueRanges.at(-1)).toMatchObject({ truncated: true, returnedCells: 0 });
  });

  it("sheets_read_cells: 100,000 grid cells build at most one reply's worth", async () => {
    const rowData = Array.from({ length: 10_000 }, (_, i) => ({ values: Array.from({ length: 10 }, (_, j) => ({ formattedValue: `r${i}c${j}`, ...(j === 9 ? { userEnteredValue: { formulaValue: `=A${i + 1}` } } : {}) })) }));
    const g = { get: async () => ({ sheets: [{ properties: { sheetId: 3, title: "Data" }, data: [{ rowData }] }] }) };
    const raw = (await byName("sheets_read_cells").handler({ spreadsheet_id: "s1", range: "Data!A1:J10000", fields: ["value", "formula"], shape: "cells" }, ctx(g))) as { cells: Record<string, unknown> };
    expect(Object.keys(raw.cells).length).toBeLessThanOrEqual(Math.floor(MAX_OUTPUT_CHARS / '"A1":{"v":0},'.length));
    const r = wire(raw);
    expect(Object.keys(r)).toEqual(["provenance", "sheet", "cellCount", "truncated", "returnedCells", "note", "cells"]);
    expect(r).toMatchObject({ cellCount: 100_000, truncated: true, returnedCells: Object.keys(r.cells).length });
    expect(r.cells.J1).toEqual({ v: "r0c9", f: "=A1" });
  });

  it("a read that fits is not marked: no truncated, returnedCells or note", async () => {
    const r = wire(await byName("sheets_read_range").handler({ ...READ, range: "Data!A1:T100", shape: "cells" }, ctx(valuesClient("Data!A1:T100", grid(100, 20)))));
    expect(r.cellCount).toBe(2_000);
    expect(Object.keys(r.cells)).toHaveLength(2_000);
    expect(r).not.toHaveProperty("truncated");
    expect(r).not.toHaveProperty("returnedCells");
    expect(r).not.toHaveProperty("note");
  });
});

describe("what shape costs the group:sheets budget", () => {
  // Model-facing bytes (scripts/measure-tools.mjs) of the three read tools on the group:sheets
  // surface, before `shape` existed and with it: +508 in total (sheets_read_range, which is also on
  // the compact surface, sheets_batch_read_ranges and sheets_read_cells). No other change touches
  // these three tools, so SPENT is this change's alone. It is pinned: an edit to these tools has to
  // be re-measured here. Whether the whole group fits its ceiling is tests/budget.test.ts's job,
  // measured on the real tree rather than projected from other changes' numbers.
  const BASE = { sheets_read_range: 1_206, sheets_batch_read_ranges: 598, sheets_read_cells: 1_214 };
  const SPENT = 508;

  it(`spends ${SPENT} model-facing bytes on the read tools`, async () => {
    const tools = await listToolsInMemory(SURFACES["group:sheets"]);
    const bytes = (name: string) => Buffer.byteLength(JSON.stringify(toApiTool(tools.find((t: { name: string }) => t.name === name)!)), "utf8");
    const spent = Object.entries(BASE).reduce((n, [name, before]) => n + bytes(name) - before, 0);
    expect(spent, `+${spent} bytes`).toBe(SPENT);
  });
});

import { describe, it, expect } from "vitest";
import { colToLetters, lettersToCol, parseA1, gridRangeToA1, gridRangeCells, extractRefs, toR1C1, rangeContains, colorHex, compactFormat, quoteSheet, gridOrigin, cellsByAddress, entryChars } from "../src/tools/sheets-a1.js";
import { MAX_OUTPUT_CHARS, strip } from "../src/tools/_shared.js";

describe("A1 helpers", () => {
  it("column letters round-trip", () => {
    for (const [n, l] of [[1, "A"], [26, "Z"], [27, "AA"], [52, "AZ"], [53, "BA"], [702, "ZZ"], [703, "AAA"]] as const) {
      expect(colToLetters(n)).toBe(l);
      expect(lettersToCol(l)).toBe(n);
    }
  });
  it("parses ranges, sheets and whole rows/columns", () => {
    expect(parseA1("'תקציב 2026'!B2:D10")).toEqual({ sheet: "תקציב 2026", startCol: 2, startRow: 2, endCol: 4, endRow: 10 });
    expect(parseA1("Sheet1!A:A")).toEqual({ sheet: "Sheet1", startCol: 1, endCol: 1 });
    expect(parseA1("3:5")).toEqual({ sheet: undefined, startRow: 3, endRow: 5 });
    expect(parseA1("$C$7")).toEqual({ sheet: undefined, startCol: 3, startRow: 7, endCol: 3, endRow: 7 });
    expect(parseA1("Sheet1")).toEqual({ sheet: "Sheet1" });
    expect(parseA1("'It''s here'")).toEqual({ sheet: "It's here" });
    expect(quoteSheet("It's here")).toBe("'It''s here'");
  });
  it("converts GridRanges", () => {
    const titles = new Map([[0, "Sheet1"], [7, "Data 2"]]);
    expect(gridRangeToA1({ sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }, titles)).toBe("Sheet1!A1:C1");
    expect(gridRangeToA1({ sheetId: 7, startRowIndex: 4, endRowIndex: 5 }, titles)).toBe("'Data 2'!5:5");
    expect(gridRangeToA1({ sheetId: 7 }, titles)).toBe("'Data 2'");
    expect(gridRangeCells({ startRowIndex: 2, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 4 })).toBe(12);
    expect(gridRangeCells({ startRowIndex: 2, endRowIndex: 5 }, { rowCount: 100, columnCount: 26 })).toBe(78);
  });
});

describe("formula references", () => {
  it("extracts plain, sheet-qualified, absolute and Hebrew-sheet refs and skips functions/strings", () => {
    const refs = extractRefs("=SUM('הכנסות 2026'!B2:B9)+Data!$C$4*LOG10(D5)+\"A1 in text\"+E1:E");
    expect(refs.map((r) => r.text)).toEqual(["'הכנסות 2026'!B2:B9", "Data!$C$4", "D5", "E1:E"]);
    expect(refs[0].sheet).toBe("הכנסות 2026");
    expect(refs[0].range).toEqual({ sheet: undefined, startCol: 2, startRow: 2, endCol: 2, endRow: 9 });
    expect(refs[3].range).toEqual({ sheet: undefined, startCol: 5, startRow: 1, endCol: 5, endRow: undefined });
    expect(extractRefs("plain text")).toEqual([]);
  });
  it("finds named ranges when told their names", () => {
    const refs = extractRefs("=VLOOKUP(A2,Rates,2,0)+Rates2", ["Rates"]);
    expect(refs.map((r) => r.text)).toEqual(["A2", "Rates"]);
    // A Set is used as given (callers resolving every cell build it once).
    expect(extractRefs("=VLOOKUP(A2,Rates,2,0)+Rates2", new Set(["Rates"])).map((r) => r.text)).toEqual(["A2", "Rates"]);
  });
  it("stays linear on a cell-sized formula, whatever it holds", () => {
    // Each was quadratic: a sheet-name pattern retried from every character of a long run (about 1.3 s at 50,000
    // characters for the first shape). Google allows 50,000 characters in one cell.
    const n = 50_000;
    for (const f of [`=${"a".repeat(n)}`, `=${"1".repeat(n)}`, `='${"a''".repeat(n / 3)}`, `='${"x ''".repeat(n / 4)}`, `=${"'".repeat(n)}`]) {
      const t0 = performance.now();
      extractRefs(f, new Set(["Rates"]));
      expect(performance.now() - t0, f.slice(0, 12)).toBeLessThan(250);
    }
    // The references a real formula makes are found exactly as before.
    expect(extractRefs("='It''s Q1'!A1+Q1!B2+'תקציב'!C3:C9+x!A1").map((r) => [r.sheet, r.text])).toEqual([
      ["It's Q1", "'It''s Q1'!A1"],
      ["Q1", "Q1!B2"],
      ["תקציב", "'תקציב'!C3:C9"],
      ["x", "x!A1"],
    ]);
  });
  it("normalizes to R1C1 so shifted copies compare equal", () => {
    expect(toR1C1("=B2*$C$1", 2, 4)).toBe("=R[0]C[-2]*R1C3");
    expect(toR1C1("=B3*$C$1", 3, 4)).toBe("=R[0]C[-2]*R1C3");
    expect(toR1C1("=SUM(Data!A1:A9)", 10, 1)).toBe("=SUM(Data!R[-9]C[0]:R[-1]C[0])");
  });
  it("rangeContains handles whole rows/columns", () => {
    expect(rangeContains(parseA1("B2:D5"), 3, 3)).toBe(true);
    expect(rangeContains(parseA1("B2:D5"), 6, 3)).toBe(false);
    expect(rangeContains(parseA1("C:C"), 999, 3)).toBe(true);
  });
});

describe("gridOrigin — where a values grid sits, from the range Google echoed", () => {
  it("bounded ranges: top-left plus size, whatever the tab is called", () => {
    expect(gridOrigin("'Sheet 1'!A1:F20")).toEqual({ row: 1, col: 1, rows: 20, cols: 6 });
    expect(gridOrigin("'תקציב 2026'!C5:F9")).toEqual({ row: 5, col: 3, rows: 5, cols: 4 });
    // An apostrophe (doubled when quoted) and a "!" inside the tab name must not move the origin.
    expect(gridOrigin("'דו''ח Q1!'!B2:C3")).toEqual({ row: 2, col: 2, rows: 2, cols: 2 });
    expect(gridOrigin("גיליון1!D4:E4")).toEqual({ row: 4, col: 4, rows: 1, cols: 2 });
    expect(gridOrigin("Sheet1!$B$2:$C$3")).toEqual({ row: 2, col: 2, rows: 2, cols: 2 });
  });
  it("single cells and multi-letter columns", () => {
    expect(gridOrigin("Sheet1!B5")).toEqual({ row: 5, col: 2, rows: 1, cols: 1 });
    expect(gridOrigin("Data!AA10:AZ12")).toEqual({ row: 10, col: 27, rows: 3, cols: 26 });
    expect(gridOrigin("Data!ZZ1:AAA2")).toEqual({ row: 1, col: 702, rows: 2, cols: 2 });
  });
  it("open-ended ranges start at the first row/column and have no size in that dimension", () => {
    expect(gridOrigin("Sheet1!A:D")).toEqual({ row: 1, col: 1, rows: undefined, cols: 4 });
    expect(gridOrigin("Sheet1!C:D")).toEqual({ row: 1, col: 3, rows: undefined, cols: 2 });
    expect(gridOrigin("Sheet1!2:5")).toEqual({ row: 2, col: 1, rows: 4, cols: undefined });
    expect(gridOrigin("Sheet1!B5:D")).toEqual({ row: 5, col: 2, rows: undefined, cols: 3 });
  });
  it("refuses a range with no coordinates instead of assuming A1 (a bare word may be a named range)", () => {
    expect(() => gridOrigin("Rates")).toThrow(/no cell coordinates/);
    expect(() => gridOrigin("'My Tab'")).toThrow(/shape=grid/);
  });
});

describe("cellsByAddress — values keyed by A1 address", () => {
  it("ragged rows: Google drops trailing blanks, the addresses do not move", () => {
    const g = cellsByAddress("'Sheet 1'!A1:D3", [
      ["Month", "Budget", "Actual", "Note"],
      ["Jul", "100", "90"],
      ["Aug", "", "80", "late"],
    ]);
    expect(Object.keys(g.cells)).toEqual(["A1", "B1", "C1", "D1", "A2", "B2", "C2", "A3", "C3", "D3"]);
    expect(g.cells.D1).toEqual({ value: "Note" });
    expect(g.cells.D2).toBeUndefined(); // dropped trailing blank
    expect(g.cells.B3).toBeUndefined(); // interior blank
    expect(g).toMatchObject({ rowCount: 3, columnCount: 4, cellCount: 10 });
  });
  it("a range that does not start at A1 puts index 0 at its own top-left", () => {
    const g = cellsByAddress("'Sheet 1'!C5:F9", [["x", "", "y"], [], ["z"]]);
    expect(g.cells).toEqual({ C5: { value: "x" }, E5: { value: "y" }, C7: { value: "z" } });
    expect(g).toMatchObject({ rowCount: 5, columnCount: 4, cellCount: 3 });
  });
  it("major_dimension=COLUMNS: values[i] is a column", () => {
    const g = cellsByAddress("Sheet1!B2:D3", [["b2", "b3"], ["c2"], ["", "d3"]], { majorDimension: "COLUMNS" });
    expect(g.cells).toEqual({ B2: { value: "b2" }, B3: { value: "b3" }, C2: { value: "c2" }, D3: { value: "d3" } });
    expect(g).toMatchObject({ rowCount: 2, columnCount: 3, cellCount: 4 });
  });
  it("multi-letter columns across the Z→AA and ZZ→AAA boundaries", () => {
    expect(Object.keys(cellsByAddress("Data!AY1:BA1", [["a", "b", "c"]]).cells)).toEqual(["AY1", "AZ1", "BA1"]);
    expect(Object.keys(cellsByAddress("Data!ZY7:AAB7", [["a", "b", "c", "d"]]).cells)).toEqual(["ZY7", "ZZ7", "AAA7", "AAB7"]);
  });
  it("whole-column and whole-row echoes: addresses from row 1 / column A, open sizes from the data", () => {
    const cols = cellsByAddress("Sheet1!C:D", [["h1", "h2"], [], ["x"]]);
    expect(cols.cells).toEqual({ C1: { value: "h1" }, D1: { value: "h2" }, C3: { value: "x" } });
    expect(cols).toMatchObject({ rowCount: 3, columnCount: 2 });
    const rows = cellsByAddress("Sheet1!2:5", [["a", "", "c"]]);
    expect(rows.cells).toEqual({ A2: { value: "a" }, C2: { value: "c" } });
    expect(rows).toMatchObject({ rowCount: 4, columnCount: 3 });
  });
  it("a single cell", () => {
    expect(cellsByAddress("Sheet1!B5", [["only"]])).toEqual({ rowCount: 1, columnCount: 1, cellCount: 1, cells: { B5: { value: "only" } } });
  });
  it("formulas: only on cells that have one, and a formula that displays blank still counts", () => {
    const g = cellsByAddress("S!A1:C2", [["3", "6"], ["x"]], { formulas: [[3, "=A1*2", '=IF(A1>5,"big","")'], ["x"]] });
    expect(g.cells).toEqual({ A1: { value: "3" }, B1: { value: "6", formula: "=A1*2" }, C1: { value: undefined, formula: '=IF(A1>5,"big","")' }, A2: { value: "x" } });
    expect(g.cellCount).toBe(4);
  });
  it("0 and false are values, not blanks", () => {
    expect(Object.keys(cellsByAddress("S!A1:C1", [[0, false, null]]).cells)).toEqual(["A1", "B1"]);
  });
  it("an all-empty range still reports cellCount 0 after strip() drops the empty cells object", () => {
    const g = cellsByAddress("'Sheet 1'!A1:B2", undefined);
    expect(g).toEqual({ rowCount: 2, columnCount: 2, cellCount: 0, cells: {} });
    expect(strip(g)).toEqual({ rowCount: 2, columnCount: 2, cellCount: 0 });
  });
  it("builds clean cells: no `value` key at all on a formula that displays blank", () => {
    const g = cellsByAddress("S!A1:B1", [["", "x"]], { formulas: [['=IF(1>2,"a","")', "x"]] });
    expect(Object.keys(g.cells.A1)).toEqual(["formula"]);
    expect(Object.keys(g.cells.B1)).toEqual(["value"]);
  });
});

describe("cellsByAddress — a character budget bounds what is built", () => {
  // A whole-tab read of hundreds of thousands of cells used to build one object per cell, have
  // strip() copy all of them and JSON.stringify the lot, only for ok() to cut the text at
  // MAX_OUTPUT_CHARS. With a budget, only what fits is built; everything else is still counted.
  const values = [
    ["Month", "Budget", "Actual"],
    ["Jul", "100", "90"],
    ["Aug", "80", "70"],
  ];

  it("charges each entry exactly what it adds to the serialized cells object", () => {
    const budget = { left: 1_000_000 };
    const g = cellsByAddress("'דו''ח'!B2:D4", values, { formulas: [["Month", "Budget", "Actual"], ["Jul", "100", "=C3-10"], ["Aug", 80, '=IF(1,"")']], budget });
    expect(g.truncated).toBeUndefined();
    expect(g.returnedCells).toBeUndefined();
    // n entries serialize as "{" + entries joined by "," + "}": the entry sizes plus 1.
    expect(1_000_000 - budget.left).toBe(JSON.stringify(strip(g.cells)).length - 1);
    expect(entryChars("D3", { value: "90", formula: "=C3-10" })).toBe('"D3":{"value":"90","formula":"=C3-10"},'.length);
  });

  it("stops at the first entry that does not fit, in read order, and keeps counting", () => {
    const fits = ["A1", "B1", "C1"].reduce((n, a, i) => n + entryChars(a, { value: values[0][i] }), 0);
    const budget = { left: fits + entryChars("A2", { value: "Jul" }) - 1 };
    const g = cellsByAddress("S!A1:C3", values, { budget });
    expect(Object.keys(g.cells)).toEqual(["A1", "B1", "C1"]);
    expect(g).toMatchObject({ rowCount: 3, columnCount: 3, cellCount: 9, truncated: true, returnedCells: 3 });
    expect(budget.left).toBe(entryChars("A2", { value: "Jul" }) - 1);
    // A short later entry that would still fit is not squeezed in: the cells are a prefix.
    expect(g.cells.C3).toBeUndefined();
  });

  it("one budget shared by several ranges: a later range gets what is left, or nothing", () => {
    const budget = { left: entryChars("A1", { value: "Month" }) + entryChars("B1", { value: "Budget" }) };
    const first = cellsByAddress("S!A1:B1", [["Month", "Budget"]], { budget });
    const second = cellsByAddress("S!A5:B5", [["x", "y"]], { budget });
    expect(first.truncated).toBeUndefined();
    expect(second).toMatchObject({ cellCount: 2, truncated: true, returnedCells: 0, cells: {} });
    expect(strip(second)).toEqual({ rowCount: 1, columnCount: 2, cellCount: 2, truncated: true, returnedCells: 0 });
    // An empty range is not "truncated" just because the budget ran out before it.
    expect(cellsByAddress("S!A9:B9", [], { budget }).truncated).toBeUndefined();
  });

  it("COLUMNS major dimension cuts in column order", () => {
    const g = cellsByAddress("S!A1:B2", [["a1", "a2"], ["b1", "b2"]], { majorDimension: "COLUMNS", budget: { left: entryChars("A1", { value: "a1" }) * 2 } });
    expect(Object.keys(g.cells)).toEqual(["A1", "A2"]);
    expect(g).toMatchObject({ cellCount: 4, returnedCells: 2, truncated: true });
  });

  it("400,000 cells against the reply limit: builds at most what one reply can carry", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => Array.from({ length: 20 }, (_, j) => `r${i}c${j}`));
    const budget = { left: MAX_OUTPUT_CHARS };
    const g = cellsByAddress("Data!A1:T20000", rows, { budget });
    const built = Object.keys(g.cells).length;
    expect(g.cellCount).toBe(400_000);
    expect(g).toMatchObject({ rowCount: 20_000, columnCount: 20, truncated: true, returnedCells: built });
    // The smallest possible entry is '"A1":{"value":0},' (17 chars): nothing past the limit exists.
    expect(built).toBeLessThanOrEqual(Math.floor(MAX_OUTPUT_CHARS / 17));
    expect(JSON.stringify(g.cells).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });
});

describe("format compaction", () => {
  it("hex colors and collapsed borders", () => {
    expect(colorHex({ red: 1, green: 0.5, blue: 0 })).toBe("#ff8000");
    expect(colorHex({ red: 1, alpha: 0.5 })).toBe("#ff000080");
    const border = { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 }, colorStyle: { rgbColor: {} } };
    const f = {
      numberFormat: { type: "NUMBER", pattern: "#,##0.00" },
      backgroundColor: { red: 1, green: 1, blue: 0 },
      backgroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 0 } },
      textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 0, green: 0, blue: 0 }, foregroundColorStyle: { rgbColor: {} } },
      borders: { top: border, bottom: border, left: border, right: border },
      horizontalAlignment: "RIGHT",
    };
    expect(compactFormat(f, new Set(["number_format", "fill", "text", "align", "borders"]))).toEqual({
      numberFormat: "NUMBER:#,##0.00",
      bg: "#ffff00",
      text: { bold: true, size: 10 },
      hAlign: "RIGHT",
      borders: { all: "SOLID" },
    });
    expect(compactFormat(f, new Set(["fill"]))).toEqual({ bg: "#ffff00" });
    expect(compactFormat({ borders: { top: border } }, new Set(["borders"]))).toEqual({ borders: { top: "SOLID" } });
    expect(compactFormat({}, new Set(["fill"]))).toBeUndefined();
  });
});

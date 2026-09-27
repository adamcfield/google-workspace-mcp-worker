/**
 * Sheets analysis tools: spreadsheet audit (error cells, circular references,
 * inconsistent formulas, ranges that stop short of the data), precedent tracing
 * (what a cell depends on) and dependent tracing (what depends on a cell).
 * Read-only; everything is computed from one or two spreadsheets.get / values
 * reads plus the pure helpers in sheets-a1.ts.
 */
import { z } from "zod";
import { API } from "../google/client.js";
import type { GoogleClient } from "../google/client.js";
import { tool, enc, type AnyRec } from "./_shared.js";
import { cellA1, colToLetters, extractRefs, parseA1, quoteSheet, rangeContains, toR1C1, a1Cells, type A1Range } from "./sheets-a1.js";
import { getSheetMeta, type SheetMeta } from "./sheets-verify.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ---- grid loading -------------------------------------------------------------

interface Cell {
  row: number; // 1-based
  col: number; // 1-based
  formula?: string;
  value?: unknown; // formattedValue (or user-entered scalar)
  error?: { type?: string; message?: string };
  empty: boolean;
}
interface Grid {
  title: string;
  sheetId: number;
  cells: Map<string, Cell>; // key "r,c"
  formulas: Cell[];
  maxRow: number;
  maxCol: number;
}

const key = (r: number, c: number) => `${r},${c}`;

/** The cell fields the audit and trace tools read: everything a cell shows. */
const ALL_CELL_FIELDS = "userEnteredValue,effectiveValue,formattedValue";

/**
 * Load every cell that has content (value, formula or error) for the given ranges (or all sheets).
 * `cells` narrows the fields asked for per cell (a cell none of them covers is not loaded), and `maxBytes`
 * refuses a larger response while it streams (ResponseTooLargeError); the audit and trace tools pass neither.
 */
async function loadGrids(g: GoogleClient, spreadsheetId: string, ranges?: string[], opts: { cells?: string; maxBytes?: number } = {}): Promise<Grid[]> {
  const bounded = opts.maxBytes !== undefined;
  const r = await g.get<AnyRec>(
    `${API.sheets}/spreadsheets/${enc(spreadsheetId)}`,
    {
      ranges,
      includeGridData: true,
      fields: `sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(${opts.cells ?? ALL_CELL_FIELDS}))))`,
      // A bounded read counts content, not indentation: Google pretty-prints JSON unless asked not to.
      prettyPrint: bounded ? false : undefined,
    },
    bounded ? { maxBytes: opts.maxBytes } : undefined,
  );
  const grids: Grid[] = [];
  for (const sheet of (r.sheets ?? []) as AnyRec[]) {
    const grid: Grid = { title: String(sheet.properties?.title ?? ""), sheetId: Number(sheet.properties?.sheetId ?? -1), cells: new Map(), formulas: [], maxRow: 0, maxCol: 0 };
    for (const block of (sheet.data ?? []) as AnyRec[]) {
      const r0 = Number(block.startRow ?? 0), c0 = Number(block.startColumn ?? 0);
      (block.rowData ?? []).forEach((row: AnyRec, ri: number) => {
        (row.values ?? []).forEach((c: AnyRec, ci: number) => {
          if (!c || (c.userEnteredValue === undefined && c.effectiveValue === undefined && c.formattedValue === undefined)) return;
          const cell: Cell = { row: r0 + ri + 1, col: c0 + ci + 1, empty: false };
          const uev = c.userEnteredValue ?? {};
          if (typeof uev.formulaValue === "string") cell.formula = uev.formulaValue;
          cell.value = c.formattedValue ?? uev.stringValue ?? uev.numberValue ?? uev.boolValue;
          if (c.effectiveValue?.errorValue) cell.error = { type: c.effectiveValue.errorValue.type, message: c.effectiveValue.errorValue.message };
          grid.cells.set(key(cell.row, cell.col), cell);
          if (cell.formula) grid.formulas.push(cell);
          grid.maxRow = Math.max(grid.maxRow, cell.row);
          grid.maxCol = Math.max(grid.maxCol, cell.col);
        });
      });
    }
    grids.push(grid);
  }
  return grids;
}

const a1 = (title: string, row: number, col: number) => `${quoteSheet(title)}!${cellA1(row, col)}`;

/**
 * meta.namedRanges by name (the first of a name wins, as a find() would), and the set of names — built once
 * per SheetMeta, because formulas look names up per reference: a scan of every name per formula made
 * resolving a spreadsheet's formulas cost cells × named ranges.
 */
interface NamedIndex {
  byName: Map<string, SheetMeta["namedRanges"][number]>;
  names: Set<string>;
}
const namedIndex = new WeakMap<SheetMeta, NamedIndex>();
function namedRanges(meta: SheetMeta): NamedIndex {
  let index = namedIndex.get(meta);
  if (!index) {
    const byName: NamedIndex["byName"] = new Map();
    for (const n of meta.namedRanges) if (!byName.has(n.name)) byName.set(n.name, n);
    index = { byName, names: new Set(byName.keys()) };
    namedIndex.set(meta, index);
  }
  return index;
}

/** Named range → A1Range on its sheet (undefined when the name is unknown). */
function namedRangeToA1(name: string, meta: SheetMeta): A1Range | undefined {
  const n = namedRanges(meta).byName.get(name);
  if (!n) return undefined;
  const gr = n.range;
  return {
    sheet: meta.titles.get(Number(gr.sheetId)),
    startCol: gr.startColumnIndex !== undefined ? Number(gr.startColumnIndex) + 1 : undefined,
    endCol: gr.endColumnIndex !== undefined ? Number(gr.endColumnIndex) : undefined,
    startRow: gr.startRowIndex !== undefined ? Number(gr.startRowIndex) + 1 : undefined,
    endRow: gr.endRowIndex !== undefined ? Number(gr.endRowIndex) : undefined,
  };
}

/** Resolve a formula reference to (sheet title, A1Range), using the formula's own sheet when unqualified. */
function resolveRef(ref: { sheet?: string; range: A1Range; name?: string }, ownSheet: string, meta: SheetMeta): { sheet: string; range: A1Range } | undefined {
  if (ref.name) {
    const r = namedRangeToA1(ref.name, meta);
    return r?.sheet ? { sheet: r.sheet, range: r } : undefined;
  }
  return { sheet: ref.sheet ?? ownSheet, range: ref.range };
}

const rangeText = (sheet: string, r: A1Range) => {
  const c = (x?: number) => (x === undefined ? "" : colToLetters(x));
  const row = (x?: number) => (x === undefined ? "" : String(x));
  const a = `${c(r.startCol)}${row(r.startRow)}`, b = `${c(r.endCol)}${row(r.endRow)}`;
  return `${quoteSheet(sheet)}!${a}${b && b !== a ? `:${b}` : ""}`;
};

// ---- audit checks -------------------------------------------------------------
//
// Severity. Error cells (the audit's `errors` list) and missingSheetRefs are ERRORS: the sheet shows
// a broken value right now. inconsistentFormulas and rangesStoppingBeforeData are WARNINGS:
// heuristics about how a model is built — worth a look, not proof of a bug. The audit's `ok` means
// "no errors"; `errorCount` and `warningCount` count the cells behind each.
//
// One finding per cell per category. Each check emits a cell at most once and merges its reasons
// into that finding (both directions of a broken fill-down; every range of a formula that stops
// short), and `onePerCell` holds the handler to that. Three things used to list a cell twice:
// a formula reading the same range twice (=IF(SUM(B2:B9)=0,0,SUM(B2:B9))), a formula reading two
// short ranges (=SUMPRODUCT(A2:A9,B2:B9)), and overlapping `ranges` (see `formulaCells`).

interface Finding {
  cell: string;
  formula?: string;
  [k: string]: unknown;
}

/**
 * Summary mode lists the warnings of each kind highest RANK first (ties in sheet order):
 *  - an inconsistent formula ranks by the size of the pattern it breaks — a break in a 40-row
 *    fill-down is better supported than one in a 3-row run;
 *  - a range stopping before data ranks by how FEW cells it misses. One row short of a run that
 *    goes on is the classic slip (a row added under a fixed range); a range that leaves out a long
 *    run is more often a deliberate partial range, so it must not crowd the slip out of the top 10.
 */
const RANK = new WeakMap<Finding, number>();

/**
 * The grid's formula cells, one per position. `grid.formulas` holds a cell once per data block
 * that contains it, so two overlapping `ranges` ("Model!A1:O20" and "Model!A15:O40") list the
 * overlap twice; `grid.cells` is keyed by position, so it is the de-duplicated view.
 */
const formulaCells = (grid: Grid): Cell[] => [...grid.cells.values()].filter((c) => c.formula !== undefined);

const isBlank = (c: Cell | undefined): boolean => !c || c.value === undefined || c.value === "";

/** Direction marks and non-breaking spaces Sheets puts inside formatted numbers (RTL locales, fr-FR grouping). */
const INVISIBLE = /[\u00a0\u200e\u200f\u202a-\u202f\u2066-\u2069]/g;
/** A displayed value that reads as a number: 1,234.5 · 1.234,5 € · (12) · $(1,200) · -3 · 45% · 1.2E+03. Dates, times and labels do not. */
const NUMBER_TEXT = /^[-+−(\s\p{Sc}]*\d[\d.,'\s]*(?:[eE][-+]?\d+)?[\s%)\p{Sc}]*$/u;
/** The accounting format's zero: a lone dash, optionally with a currency sign. */
const DASH_ZERO = /^[\s\p{Sc}]*[-–—][\s\p{Sc}]*$/u;
/**
 * A displayed date written with digits only: 01.02.2026 and 1.2.26 (de-DE and other dotted
 * locales), 2026.01.02, and the "-" and "/" forms. NUMBER_TEXT alone would read the dotted ones as
 * numbers; thousands grouping (1.234.567) has 3-digit groups, so it does not match here.
 */
const DATE_TEXT = /^(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/;

/**
 * Longest displayed value (after whitespace is collapsed) that can read as a number. A number
 * Sheets shows is a few dozen characters (a 1E+300 written out with grouping is about 400); a
 * cell can hold 50,000, and nothing past this is inspected.
 */
const NUMBER_TEXT_MAX = 1000;
const RUN_OF_SPACE = /\s\s/, RUN_OF_SPACE_G = /\s+/g;

/**
 * Does a cell's displayed value read as a number? Judged on the formatted value, so a date header ("Feb 2026", "01.02.2026") is a label.
 * Every run of whitespace is one space before NUMBER_TEXT runs: its digit group and its tail both
 * take whitespace, and a regular expression tries every split of a run between them — "1", 49,000
 * spaces and a letter cost 1.2 s per test. With single spaces the match is linear, and it accepts
 * exactly what it did (each class that takes whitespace takes any amount of it).
 */
function isNumeric(v: unknown): boolean {
  if (typeof v === "number") return true;
  if (typeof v !== "string") return false;
  let s = v.replace(INVISIBLE, " ").trim();
  if (RUN_OF_SPACE.test(s)) s = s.replace(RUN_OF_SPACE_G, " "); // only when there is a run: most values have none, and a copy each time is garbage
  return s !== "" && s.length <= NUMBER_TEXT_MAX && !DATE_TEXT.test(s) && (NUMBER_TEXT.test(s) || DASH_ZERO.test(s));
}

/** A column (vertical) or row of a grid, and the span a range covers along it. */
interface LineRef {
  vertical: boolean;
  line: number;
  lo: number;
  hi: number;
}

/** A bounded single-column (vertical) or single-row range of ≥2 cells, as a LineRef; anything else is undefined. */
function asLine(r: A1Range): LineRef | undefined {
  if (r.startCol === undefined || r.startRow === undefined || r.endCol === undefined || r.endRow === undefined) return undefined;
  if (r.startCol === r.endCol && r.startRow !== r.endRow) return { vertical: true, line: r.startCol, lo: Math.min(r.startRow, r.endRow), hi: Math.max(r.startRow, r.endRow) };
  if (r.startRow === r.endRow && r.startCol !== r.endCol) return { vertical: false, line: r.startRow, lo: Math.min(r.startCol, r.endCol), hi: Math.max(r.startCol, r.endCol) };
  return undefined;
}

/** Functions that roll a block up into one number. */
const AGGREGATE = /\b(?:SUM|SUMIFS?|SUMPRODUCT|SUBTOTAL|AGGREGATE|AVERAGEA?|AVERAGEIFS?|MIN|MAX|MEDIAN|COUNTA?|COUNTIFS?|PRODUCT)\s*\(/i;

/**
 * The ranges of a formula the audit's checks can use: its bounded references of two or more cells
 * (named ranges resolved), in order of first appearance, a repeat dropped (the same range written
 * with other $ anchors is kept apart, for `expandingWindow`). A single cell or an open-ended range
 * is never the block of a total (`lineTotal`) nor a range that stops short (`rangeGaps`), so it is
 * not kept, and each range is kept as numbers: `sheets[i]`, then five numbers per range in `nums` —
 * start row, end row, start column, end column, as written (so a range reads back as it was typed),
 * and the $ anchors of its written text (`ANCHOR_*`).
 * A resolved reference is an object that costs over 100 times its text, and the audit used to keep
 * every formula's for the whole audit: 40 cells of a 49,000-character =A1+A1+… (653,320 references)
 * held about +140 MB, and node needed a 150 MB heap to finish, over a Worker's 128 MB. No reference object is kept now.
 */
interface Ranges {
  sheets: string[];
  nums: number[];
  /** The line ranges by line and start (`lineIndex`), built the first time a neighbour's check asks. */
  lines?: LineIndex;
  /** The written text of the formula's reference when it has exactly one, of any kind (`totalShape`). */
  only?: string;
}
const RANGE_NUMS = 5;
/** Bits of the anchors number: a $ before the start's row / end's row / start's column / end's column, and whether the text has an end at all. */
const ANCHOR_START_ROW = 1, ANCHOR_END_ROW = 2, ANCHOR_START_COL = 4, ANCHOR_END_COL = 8, HAS_END = 16;
/** What a formula without ranges resolves to; each call gets its own, as `lines` is written to it. */
const noRanges = (): Ranges => ({ sheets: [], nums: [] });

/** The $ anchors of a reference's written text (after any sheet name), as `ANCHOR_*` bits. */
function anchorsOf(text: string): number {
  const [start, end] = text.slice(text.lastIndexOf("!") + 1).split(":");
  if (end === undefined) return 0;
  const row = (part: string) => /\$\d+$/.test(part), col = (part: string) => part.startsWith("$");
  return HAS_END | (row(start) ? ANCHOR_START_ROW : 0) | (row(end) ? ANCHOR_END_ROW : 0) | (col(start) ? ANCHOR_START_COL : 0) | (col(end) ? ANCHOR_END_COL : 0);
}

/** Range `i` of `x` as an A1Range. */
const rangeAt = (x: Ranges, i: number): A1Range => {
  const o = i * RANGE_NUMS, n = x.nums;
  return { startRow: n[o], endRow: n[o + 1], startCol: n[o + 2], endCol: n[o + 3] };
};

/**
 * Memoised per formula TEXT while one tab is checked (`withFormulaMemo`): a formula resolves the same
 * wherever it sits on a tab, so a fill-down of one fixed range (=B2/SUM($B$2:$B$13)) resolves once.
 * Bounded, as a fill-down of RELATIVE references has a different text in every row: each of its
 * two generations holds at most `MEMO_BYTES` of estimated memory (`weightOf`: the formula text it is
 * keyed by, the entry's objects and its line index) — when the newer one fills up it becomes the
 * older one and the oldest is
 * dropped, and a formula found in the older one moves to the newer one. The checks ask about a
 * formula and the formulas within two cells of it, in sheet order, so what they ask for again is
 * recent; a tab whose formulas fit (about 25,000 one-range formulas per generation) resolves each text once.
 * Unbounded (with the walk and shape memos unbounded too), it kept every formula's ranges and
 * their line index for the whole tab: 20,000 formulas of 40 ranges each needed a 96 MB heap, and a
 * relative fill-down of them, 20,000 rows × 2 columns, 150 MB (the audit before this change: 34-36
 * and 74 MB; now 44 and 78-80 MB). On the four heap fixtures of tests/sheets-analysis.test.ts the
 * audit now needs from 2 MB less to 10 MB more heap than before this change (the least heap in
 * which two runs in a row finish, bisected twice). Dropped as soon as that tab's checks finish.
 */
const MEMO_BYTES = 24 * 2 ** 20;
/**
 * What a formula's entry can cost, in bytes, counted high: the formula text it is keyed by and its
 * `only` text (up to two bytes a character), about 800 for the entry itself (the Map slot, the
 * Ranges object, its two arrays and, once built, the line index's Map and arrays), and about 120 per
 * range (its five numbers, its sheet, and its two slots in the line index). An earlier count in
 * "numbers" charged a one-range formula 28 units for about 800 real bytes, so its bound held about
 * 75,000 such entries (tens of MB) where it meant a few MB, and it did not count the key at all.
 */
const weightOf = (formula: string, x: Ranges) => 2 * (formula.length + (x.only?.length ?? 0)) + 800 + 120 * x.sheets.length;
class FormulaMemo {
  private newer = new Map<string, Ranges>();
  private older = new Map<string, Ranges>();
  private weight = 0;
  get(formula: string): Ranges | undefined {
    const x = this.newer.get(formula);
    if (x) return x;
    const old = this.older.get(formula);
    if (old) this.set(formula, old);
    return old;
  }
  set(formula: string, x: Ranges): void {
    this.newer.set(formula, x);
    if ((this.weight += weightOf(formula, x)) > MEMO_BYTES) {
      this.older = this.newer;
      this.newer = new Map();
      this.weight = 0;
    }
  }
}
const formulaMemos = new WeakMap<Grid, FormulaMemo>();
function withFormulaMemo<T>(grid: Grid, run: () => T): T {
  formulaMemos.set(grid, new FormulaMemo());
  try {
    return run();
  } finally {
    formulaMemos.delete(grid);
  }
}

/** `rangesOf` without the memo: extract, resolve, keep the bounded multi-cell ranges once each. */
function resolveRanges(formula: string, title: string, meta: SheetMeta): Ranges {
  const out: Ranges = { sheets: [], nums: [] };
  const refs = extractRefs(formula, namedRanges(meta).names);
  if (refs.length === 1) out.only = refs[0].text;
  const seen = refs.length > 1 ? new Set<string>() : undefined; // one reference has no repeat to drop
  for (const ref of refs) {
    const res = resolveRef(ref, title, meta);
    if (!res) continue;
    const { startRow: sr, endRow: er, startCol: sc, endCol: ec } = res.range;
    if (sr === undefined || er === undefined || sc === undefined || ec === undefined || (sr === er && sc === ec)) continue;
    const anchors = anchorsOf(ref.text);
    if (seen) {
      const k = `${sr},${er},${sc},${ec},${anchors},${res.sheet}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.sheets.push(res.sheet);
    out.nums.push(sr, er, sc, ec, anchors);
  }
  return out;
}

/** Formula cell `c` of `grid`: its ranges (`Ranges`), memoised while `grid` is checked. */
function rangesOf(c: Cell, grid: Grid, meta: SheetMeta): Ranges {
  if (!c.formula) return noRanges();
  const memo = formulaMemos.get(grid);
  let x = memo?.get(c.formula);
  if (!x) {
    x = resolveRanges(c.formula, grid.title, meta);
    memo?.set(c.formula, x);
  }
  return x;
}

/** A bounded block of cells: rows r0..r1, columns c0..c1. */
interface Block {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/**
 * The block `c` totals, if it is a total (or subtotal) of its own column (vertical) / row: an
 * aggregate over a ≥2-cell range of that same line lying wholly before or after it — `=SUM(D2:D13)`
 * in D14, `=SUM(B5:M5)` in N5, a quarterly `=SUM(B5:D5)` between the months, `=SUM(Amounts)` for a
 * named range. Its formula differs from the fill-down around it by design.
 */
function lineTotal(c: Cell, vertical: boolean, grid: Grid, meta: SheetMeta): Block | undefined {
  if (!c.formula || !AGGREGATE.test(c.formula)) return undefined;
  const x = rangesOf(c, grid, meta), n = x.nums;
  for (let i = 0; i < x.sheets.length; i++) {
    if (x.sheets[i] !== grid.title) continue;
    const o = i * RANGE_NUMS;
    const b: Block = { r0: Math.min(n[o], n[o + 1]), r1: Math.max(n[o], n[o + 1]), c0: Math.min(n[o + 2], n[o + 3]), c1: Math.max(n[o + 2], n[o + 3]) };
    if (vertical ? b.c0 <= c.col && c.col <= b.c1 && b.r1 > b.r0 && (b.r1 < c.row || b.r0 > c.row) : b.r0 <= c.row && c.row <= b.r1 && b.c1 > b.c0 && (b.c1 < c.col || b.c0 > c.col)) return b;
  }
  return undefined;
}

/**
 * What the range check keeps about a grid, per orientation (walks down columns, or along rows),
 * built on first use and dropped with the grid when the audit returns. Every part is sized by the
 * cells present or by the totals, never by the tab's bounding box, the number of tables or the
 * length of the walks.
 */
interface LineState {
  cells?: Map<number, Cell[]>; // `cellsByLine`
  headers: Map<number, boolean>; // `isHeaderLine`, by row (column)
  kinds: Map<number, Int32Array>; // `kindCounts`, by line
  stops: (Map<Cell, number> | undefined)[]; // `stopFrom`, by kind of walk: 2·numeric + dataLines
  totals?: TotalsIndex; // `totalsIndex`
  tables: Map<string, [number, number][]>; // `tableAround`, by span "lo:hi"
}
const lineStates = new WeakMap<Grid, [LineState, LineState]>();
function stateOf(grid: Grid, vertical: boolean): LineState {
  let states = lineStates.get(grid);
  if (!states) {
    const fresh = (): LineState => ({ headers: new Map(), kinds: new Map(), stops: [], tables: new Map() });
    lineStates.set(grid, (states = [fresh(), fresh()]));
  }
  return states[vertical ? 1 : 0];
}

/**
 * The cells of every column (vertical) or row of a grid, by line number, each list in order along
 * its line. Built once per grid and orientation, from the cells present. Everything the range check
 * reads about a line comes from here, never from positions 1..maxRow (maxCol): a tab's bounding box
 * can be far larger than its content — a 50,000-row log beside a 50-column table, one note in
 * column ALL — and per-line state sized by it cost 100+ MB and seconds on sheets release/1.6 read
 * in 0.1 s.
 */
function cellsByLine(grid: Grid, vertical: boolean): Map<number, Cell[]> {
  const state = stateOf(grid, vertical);
  if (state.cells) return state.cells;
  // Counted first, so each list is allocated at its final length: a tall tab has a list per row.
  const sizes = new Map<number, number>();
  grid.cells.forEach((c) => sizes.set(posOf(c, !vertical), (sizes.get(posOf(c, !vertical)) ?? 0) + 1));
  const lines = new Map<number, Cell[]>(), filled = new Map<number, number>();
  for (const [k, n] of sizes) lines.set(k, new Array<Cell>(n)), filled.set(k, 0);
  grid.cells.forEach((c) => {
    const k = posOf(c, !vertical), i = filled.get(k)!;
    lines.get(k)![i] = c;
    filled.set(k, i + 1);
  });
  // Cells arrive in the order they were loaded, which is already along each line within one block
  // of data; sort only a line that is not (a sort allocates a work area per call, sorted or not).
  for (const cells of lines.values()) {
    for (let i = 1; i < cells.length; i++) {
      if (posOf(cells[i - 1], vertical) > posOf(cells[i], vertical)) {
        cells.sort((a, b) => posOf(a, vertical) - posOf(b, vertical));
        break;
      }
    }
  }
  return (state.cells = lines);
}
const NO_CELLS: Cell[] = [];
/** The cells of column `line` (vertical) or row `line`, in order. */
const lineCells = (grid: Grid, vertical: boolean, line: number): Cell[] => cellsByLine(grid, vertical).get(line) ?? NO_CELLS;
/** A cell's position along a column (its row) or a row (its column). */
const posOf = (c: Cell, vertical: boolean) => (vertical ? c.row : c.col);
/** Index in `cells` (ordered along the line) of the first cell at position ≥ p; cells.length when none. */
function firstFrom(cells: Cell[], vertical: boolean, p: number): number {
  let lo = 0, hi = cells.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (posOf(cells[mid], vertical) < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index in `xs` (ascending) of the first value ≥ v; xs.length when none. */
function lowerBound(xs: Int32Array, v: number, from = 0, to = xs.length): number {
  while (from < to) {
    const mid = (from + to) >>> 1;
    if (xs[mid] < v) from = mid + 1;
    else to = mid;
  }
  return from;
}

/**
 * Every total or subtotal of a block in its own column (vertical) / row in a grid (`lineTotal`),
 * as points: the line a walk down (along) meets it on — its row (column) — and its position
 * across — its column (row). Sorted by position across, with a merge-sort tree over the lines:
 * `levels[d]` holds the lines sorted within each block of 2^d points. Built once per grid and
 * orientation, from the grid's totals: memory is (totals) × log2(totals) × 4 bytes, whatever the
 * tab's size, the number of tables or the length of the walks.
 */
interface TotalsIndex {
  across: Int32Array;
  levels: Int32Array[];
}
function totalsIndex(grid: Grid, vertical: boolean, meta: SheetMeta): TotalsIndex {
  const state = stateOf(grid, vertical);
  if (state.totals) return state.totals;
  const points: [number, number][] = [];
  grid.cells.forEach((x) => {
    if (x.formula !== undefined && lineTotal(x, vertical, grid, meta)) points.push([posOf(x, !vertical), posOf(x, vertical)]);
  });
  points.sort((a, b) => a[0] - b[0]);
  const n = points.length;
  let level = Int32Array.from(points, (x) => x[1]);
  const levels = [level];
  for (let w = 1; w < n; w *= 2) {
    const next = new Int32Array(n);
    for (let a = 0; a < n; a += 2 * w) {
      const m = Math.min(a + w, n), b = Math.min(a + 2 * w, n);
      let i = a, j = m, o = a;
      while (i < m && j < b) next[o++] = level[i] <= level[j] ? level[i++] : level[j++];
      while (i < m) next[o++] = level[i++];
      while (j < b) next[o++] = level[j++];
    }
    levels.push((level = next));
  }
  return (state.totals = { across: Int32Array.from(points, (x) => x[0]), levels });
}

/** The first line at or after `p` that holds any total; Infinity when none. */
function firstTotalLine(ix: TotalsIndex, p: number): number {
  const all = ix.levels[ix.levels.length - 1]; // the top level is one block: every line, sorted
  const at = lowerBound(all, p);
  return at < all.length ? all[at] : Infinity;
}

/**
 * The first line at or after `p` that holds a total positioned across within lo..hi — for a walk
 * down a column, the first row from `p` with a total in one of the columns of its table; Infinity
 * when none. The totals across lo..hi are one stretch of the index, covered by O(log n) blocks of
 * the tree, each a binary search: O(log² n), however many lines lie between `p` and the answer.
 */
function firstTotalIn(ix: TotalsIndex, p: number, lo: number, hi: number): number {
  let best = Infinity;
  // Block b of level d holds points b·2^d .. (b+1)·2^d - 1, its lines sorted; every block taken below lies wholly inside the stretch.
  const fromBlock = (d: number, b: number) => {
    const level = ix.levels[d], from = b << d, to = from + (1 << d), at = lowerBound(level, p, from, to);
    if (at < to && level[at] < best) best = level[at];
  };
  let i = lowerBound(ix.across, lo), j = lowerBound(ix.across, hi + 1);
  for (let d = 0; i < j; d++, i >>= 1, j >>= 1) {
    if (i & 1) fromBlock(d, i++);
    if (j & 1) fromBlock(d, --j);
  }
  return best;
}
/** Row `i` (column `i`) is a header: it has content and all of it is plain text — no number, no formula. */
function isHeaderLine(grid: Grid, vertical: boolean, i: number): boolean {
  const { headers } = stateOf(grid, vertical);
  let header = headers.get(i);
  if (header === undefined) {
    header = false;
    for (const x of lineCells(grid, !vertical, i)) {
      if (isBlank(x)) continue;
      header = x.formula === undefined && !isNumeric(x.value);
      if (!header) break;
    }
    headers.set(i, header);
  }
  return header;
}

/**
 * How many numbers and labels (non-blank, not a number) a column (vertical) or row holds up to each
 * of its cells: `counts[2k]` / `counts[2k+1]` over cells[0..k-1]. Sized by the line's cells, built
 * only for a line whose range is walked, so the kind of any range on it is two lookups — a column
 * of =SUM(Br:B$N) ranges, each ending where new data starts, no longer counts each range cell by cell.
 */
function kindCounts(grid: Grid, vertical: boolean, line: number): Int32Array {
  const { kinds } = stateOf(grid, vertical);
  let counts = kinds.get(line);
  if (!counts) {
    const cells = lineCells(grid, vertical, line), c = new Int32Array(2 * cells.length + 2);
    cells.forEach((x, k) => {
      const shown = !isBlank(x), number = shown && isNumeric(x.value);
      c[2 * k + 2] = c[2 * k] + (number ? 1 : 0);
      c[2 * k + 3] = c[2 * k + 1] + (shown && !number ? 1 : 0);
    });
    kinds.set(line, (counts = c));
  }
  return counts;
}

/**
 * The columns (rows, for a range along a row) of the table a range sits in: its own line plus
 * each neighbouring line that has content alongside the range, outward until a line is empty over
 * the range's whole span. Two tables side by side with a blank column between them are two tables.
 *
 * Measured once per span and table: a range's own line has content over its span (dataPastEnd
 * asks about no other), so the table found is the whole run of such lines around it, and any
 * later range of the same span on one of those lines is in the same table. The tables found are
 * kept per span as runs in order, so a lookup is a binary search and memory follows the number of
 * tables, not their height. A tall table of =AVERAGE(Br:Mr) rows used to be measured again for
 * every row (8,000 rows: 11 s).
 */
function tableAround(grid: Grid, l: LineRef): [number, number] {
  const { tables } = stateOf(grid, l.vertical), span = `${l.lo}:${l.hi}`;
  const found = tables.get(span) ?? tables.set(span, []).get(span)!;
  let i = 0;
  for (let j = found.length; i < j; ) {
    const mid = (i + j) >>> 1;
    if (found[mid][1] < l.line) i = mid + 1;
    else j = mid;
  }
  if (i < found.length && found[i][0] <= l.line) return found[i];
  const filled = (p: number) => {
    const cells = lineCells(grid, l.vertical, p), k = firstFrom(cells, l.vertical, l.lo);
    return k < cells.length && posOf(cells[k], l.vertical) <= l.hi;
  };
  let lo = l.line, hi = l.line;
  while (lo > 1 && filled(lo - 1)) lo--;
  while (hi < (l.vertical ? grid.maxCol : grid.maxRow) && filled(hi + 1)) hi++;
  const table: [number, number] = [lo, hi];
  if (filled(l.line)) found.splice(i, 0, table); // runs do not overlap, so it goes right where the search ended
  return table;
}

/** The start of `=FN(`: the function's name, and where its argument starts. */
const CALL_HEAD = /^=\s*([A-Za-z][\w.]*)\s*\(/;
/**
 * `=FN(arg)` and nothing more — one function call, no operator or second argument around it — as
 * [FN, arg] with the argument trimmed. Parsed, not matched by one regular expression: in
 * /\(\s*([^()]*?)\s*\)\s*$/ the three whitespace parts overlap, and the match cost the cube of
 * the length of a run of spaces after the "(" (=SUM(<2,000 spaces>(B1)): 1.2 s per test, run on
 * every cell of a fill-down). Each step here reads the formula once.
 */
function singleCall(formula: string): [string, string] | undefined {
  const m = CALL_HEAD.exec(formula);
  if (!m) return undefined;
  const rest = formula.slice(m[0].length).trimEnd(); // trim() and \s take the same whitespace
  if (!rest.endsWith(")")) return undefined;
  const arg = rest.slice(0, -1);
  return arg.includes("(") || arg.includes(")") ? undefined : [m[1], arg.trim()];
}
/** Whether a line is summed or averaged follows from its unit — an amount adds up, a price or a % does not. */
const SUM_OR_MEAN = /^(?:SUM|AVERAGEA?)$/i;

/**
 * The shape a cell of a totals row (column) is compared by, when the cell is EXACTLY one SUM or
 * AVERAGE of the block before or after it in its own column (row): that block relative to the
 * cell, with SUM and AVERAGE as one function. Anything else — a plug (=SUM(B5:M5)+500), a
 * multiplier (*1.1), a second argument, another function (MIN in a column of MAX) — keeps its
 * R1C1 shape, so it still breaks the pattern of its neighbours.
 */
function totalShape(c: Cell, vertical: boolean, grid: Grid, meta: SheetMeta): string | undefined {
  const m = singleCall(c.formula ?? "");
  if (!m || !SUM_OR_MEAN.test(m[0])) return undefined;
  if (rangesOf(c, grid, meta).only !== m[1]) return undefined; // the call's whole argument is its one reference
  const t = lineTotal(c, vertical, grid, meta);
  return t && `SUM|AVERAGE of R[${t.r0 - c.row}]:R[${t.r1 - c.row}] C[${t.c0 - c.col}]:C[${t.c1 - c.col}]`;
}

/**
 * How much the R1C1 shapes a tab's fill-down check keeps may weigh: the characters of the distinct
 * shapes plus `SHAPE_ENTRY` per cell. A cell sits in a column run and a row run, and its shape is
 * kept for the second. Each shape is kept once however many cells have it — a fill-down's cells all
 * do, which is the point of R1C1 — and the memo starts over when it would weigh more. Before, a
 * shape was kept per cell for the whole tab: the 40,000 cells of a relative fill-down of a
 * 40-range SUM kept 40,000 copies of one shape, longer than the formula.
 */
const SHAPE_WEIGHT = 1 << 22, SHAPE_ENTRY = 64;
function shapeMemo(): (c: Cell) => string {
  let byCell = new Map<Cell, string>(), distinct = new Map<string, string>(), weight = 0;
  return (c) => {
    const known = byCell.get(c);
    if (known !== undefined) return known;
    const fresh = toR1C1(c.formula!, c.row, c.col);
    let shape = distinct.get(fresh);
    if (shape === undefined) distinct.set(fresh, (shape = fresh)), (weight += fresh.length);
    if ((weight += SHAPE_ENTRY) > SHAPE_WEIGHT) (byCell = new Map()), (distinct = new Map()), (weight = 0);
    else byCell.set(c, shape);
    return shape;
  };
}

/** A formula whose R1C1 shape reads an earlier cell of its own column (=E2+D3) / row (=B5*1.05): a recurrence. */
const READS_PREVIOUS = { column: /(?<![!\w'])R\[-\d+\]C\[0\]/, row: /(?<![!\w'])R\[0\]C\[-\d+\]/ };

/**
 * A fill-down that breaks: along each column and each row, runs of ≥3 consecutive formula cells
 * whose R1C1 shape differs from the run's majority. Three kinds of cell differ BY DESIGN and are
 * not held to the pattern:
 *  - a total: an aggregate of the block before or after it in its own line (`lineTotal`) — the
 *    SUM row under a column of formulas, the totals column at a row's right edge, a quarterly
 *    subtotal between months. Totals are taken out of the run before its majority is counted.
 *  - a label formula heading the run: text (or a date label) on top of numbers, right after a
 *    header or the sheet's edge — D1 ="Amount ("&F1&")", C1 =EDATE(B1,1) over monthly figures.
 *  - the seed of a recurrence: when the pattern reads the previous cell of its line (=E2+D3
 *    running balance, =C5*1.05 growth) and the run starts right after a header, a label or a
 *    blank, its first cell has nothing of the pattern to read, so it differs on purpose (=D2).
 * And along a Total row each cell totals its own column (down a Total column, its own row); a row
 * that sums most columns but averages a price or a margin % (=SUM(B2:B9), =AVERAGE(C2:C9)) is
 * built that way on purpose. A cell that is exactly one SUM or AVERAGE of its block is compared by
 * that block (`totalShape`), so the AVERAGE matches its SUM neighbours, while a total that stops a
 * row short (=SUM(C2:C8)), a plug (+500), a multiplier or another function (MIN among MAX) does not.
 * A broken cell anywhere else — the middle of a run, or its end when it is not a total — is flagged.
 */
function inconsistentFormulas(grid: Grid, meta: SheetMeta): Finding[] {
  const out = new Map<string, Finding>();
  // A cell's R1C1 shape, computed once for its column run and its row run (`SHAPE_WEIGHT`).
  const shapeOf = shapeMemo();
  const check = (run: Cell[], vertical: boolean) => {
    const first = run[0];
    // Runs are maximal, so the cell before one is never a formula: it is blank, a value or off the grid.
    const before = vertical ? grid.cells.get(key(first.row - 1, first.col)) : grid.cells.get(key(first.row, first.col - 1));
    const afterHeader = isBlank(before) || !isNumeric(before!.value);
    // A cell's shape is taken right after its total check, while its ranges are fresh in the memo.
    let body: Cell[] = [], shapes: string[] = [];
    for (const c of run) {
      if (lineTotal(c, vertical, grid, meta)) continue;
      body.push(c);
      shapes.push(totalShape(c, !vertical, grid, meta) ?? shapeOf(c));
    }
    const rest = body.slice(1);
    if (body[0] === first && afterHeader && !isBlank(first) && !isNumeric(first.value) && rest.length > 0 && rest.filter((c) => isNumeric(c.value)).length >= 0.6 * rest.length) (body = rest), (shapes = shapes.slice(1));
    if (body.length < 3) return;
    const counts = new Map<string, number>();
    for (const s of shapes) counts.set(s, (counts.get(s) ?? 0) + 1);
    const [majority, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < 2 || n / body.length < 0.6) return;
    const direction = vertical ? "column" : "row";
    const seed = READS_PREVIOUS[direction].test(majority) && afterHeader ? first : undefined;
    const example = body[shapes.indexOf(majority)];
    body.forEach((c, i) => {
      if (shapes[i] === majority || c === seed) return;
      const k = key(c.row, c.col);
      let f = out.get(k);
      if (!f) out.set(k, (f = { cell: a1(grid.title, c.row, c.col), formula: c.formula, differsFrom: {} }));
      (f.differsFrom as Record<string, string>)[direction] = `${cellA1(example.row, example.col)} ${clipFormula(example.formula!)}`;
      RANK.set(f, Math.max(RANK.get(f) ?? 0, n));
    });
  };
  for (const vertical of [true, false]) {
    const lines = new Map<number, Cell[]>();
    for (const c of formulaCells(grid)) {
      const k = vertical ? c.col : c.row;
      (lines.get(k) ?? lines.set(k, []).get(k)!).push(c);
    }
    for (const cells of lines.values()) {
      cells.sort((a, b) => (vertical ? a.row - b.row : a.col - b.col));
      let run: Cell[] = [];
      for (const c of cells) {
        const prev = run[run.length - 1];
        if (prev && !(vertical ? c.row === prev.row + 1 : c.col === prev.col + 1)) {
          if (run.length >= 3) check(run, vertical);
          run = [];
        }
        run.push(c);
      }
      if (run.length >= 3) check(run, vertical);
    }
  }
  return [...out.values()];
}

/**
 * A running total (year-to-date) is an expanding window by construction: its start is anchored
 * and its end moves with the formula — =SUM($B$2:B7) in row 7, filled down from =SUM($B$2:B2) —
 * so every one of them but the last stops before data on purpose. Recognised by the reference
 * itself: a $ before the start's row (its column, for a range along a row) and none before the
 * end's, with the end on the formula's own row (column). A one-off total written =SUM($B$2:B9) in
 * B11 does not end on its own row and stays checked.
 */
function expandingWindow(anchors: number, l: LineRef, c: Cell): boolean {
  if (!(anchors & HAS_END)) return false;
  const [start, end] = l.vertical ? [ANCHOR_START_ROW, ANCHOR_END_ROW] : [ANCHOR_START_COL, ANCHOR_END_COL];
  return (anchors & start) !== 0 && (anchors & end) === 0 && (l.vertical ? c.row : c.col) === l.hi;
}

/** The four cells right next to a formula along its column and row: where its own fill continues. */
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * A formula's line ranges (`asLine`: one column or one row, ≥2 cells), per sheet, as two lists of
 * number triples sorted for binary search: `byLo` (line, lo, hi) and `byLen` (line, hi - lo, lo),
 * where line is `lineCode` (the column or row and the orientation in one number). Built once per
 * formula (`Ranges.lines`), so the neighbour checks below cost each range a few lookups: they used
 * to walk every range of a neighbour again, and build a list of them, up to 16 times per range —
 * 40 × 16 × 40 references per cell of a column of 40-range SUMs.
 */
type LineIndex = Map<string, { byLo: number[]; byLen: number[] }>;
const lineCode = (l: LineRef) => 2 * l.line + (l.vertical ? 1 : 0);
function lineIndex(x: Ranges): LineIndex {
  if (x.lines) return x.lines;
  const bySheet = new Map<string, [number, number, number][]>();
  for (let i = 0; i < x.sheets.length; i++) {
    const l = asLine(rangeAt(x, i));
    if (!l) continue;
    const list = bySheet.get(x.sheets[i]) ?? bySheet.set(x.sheets[i], []).get(x.sheets[i])!;
    list.push([lineCode(l), l.lo, l.hi]);
  }
  const byTriple = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const index: LineIndex = new Map();
  for (const [sheet, list] of bySheet) {
    index.set(sheet, {
      byLo: list.sort(byTriple).flat(),
      byLen: list.map(([k, lo, hi]) => [k, hi - lo, lo]).sort(byTriple).flat(),
    });
  }
  return (x.lines = index);
}
/** Index of the first triple of `xs` at or after (a, b, c); xs.length / 3 when none. */
function firstTriple(xs: number[], a: number, b: number, c: number): number {
  let lo = 0, hi = xs.length / 3;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, o = 3 * mid;
    if (xs[o] < a || (xs[o] === a && (xs[o + 1] < b || (xs[o + 1] === b && xs[o + 2] < c)))) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Is there a triple (a, b, c) with lo <= c <= hi? */
function hasTriple(xs: number[], a: number, b: number, lo: number, hi = lo): boolean {
  const o = 3 * firstTriple(xs, a, b, lo);
  return o < xs.length && xs[o] === a && xs[o + 1] === b && xs[o + 2] <= hi;
}

/**
 * The line ranges of the formulas around `c` (`lineIndex`), by offset (dr, dc) within 2 cells —
 * looked up in the grid once per cell, however many of c's ranges ask. Undefined where no formula is.
 */
function neighbourhood(c: Cell, grid: Grid, meta: SheetMeta): (dr: number, dc: number) => LineIndex | undefined {
  const found = new Map<number, LineIndex | undefined>();
  return (dr, dc) => {
    const k = 5 * (dr + 2) + dc + 2;
    if (!found.has(k)) {
      const n = grid.cells.get(key(c.row + dr, c.col + dc));
      found.set(k, n?.formula ? lineIndex(rangesOf(n, grid, meta)) : undefined);
    }
    return found.get(k);
  };
}
type Near = ReturnType<typeof neighbourhood>;

/**
 * Formula `c`'s range `l` ends at a deliberate boundary when c's OWN fill picks up where it leaves
 * off: a formula right next to c (along its column or row) reads a range of the same line that
 * starts after l's start and runs past its end — the next block of a partition (Q1 =SUM(B5:D5)
 * beside Q2 =SUM(E5:G5)) or the next step of a sliding window (=AVERAGE(B2:B4) above
 * =AVERAGE(B3:B5)). A grand total that also covers the start (=SUM(B2:B13)) is no such evidence,
 * and neither is a range read anywhere else in the spreadsheet: a moving-average column over the
 * same data reads a window starting right after almost any row, so it would excuse an unrelated
 * total that stops short (Plan!B16 =SUM(B2:B12) with B13 a plain number).
 * As lookups: a range of the line starting at hi+1 (it runs past hi+1, being ≥2 cells), or one of
 * l's length starting in lo+1..hi+1 (it then ends at or after hi+1).
 */
function deliberateEnd(near: Near, sheet: string, l: LineRef): boolean {
  const k = lineCode(l), next = l.hi + 1;
  return NEIGHBOURS.some(([dr, dc]) => {
    const s = near(dr, dc)?.get(sheet);
    return !!s && (hasTriple(s.byLo, k, next, -Infinity, Infinity) || hasTriple(s.byLen, k, l.hi - l.lo, l.lo + 1, next));
  });
}

/**
 * Formula `c`, reading range `l` on `sheet`, is one step of an expanding window written without
 * anchors (=SUM(Cash!B2:B3) in B6, =SUM(Cash!B2:B4) in B7 … — a report typed cell by cell): the
 * formula cells right next to `c` along its column or row read ranges from the same start whose
 * ends go on one cell at a time — the next one to hi+1, and the previous one to hi-1 or the one
 * after next to hi+2. It takes a chain of three consecutive cells of c's OWN fill-down: ranges
 * of the same shape read elsewhere prove nothing about `c`. A year-to-date column beside the data
 * reads B2:B3 … B2:B10 too, and must not make a Total =SUM(B2:B9) one row short look like one of
 * its steps; nor does a correct total elsewhere (=SUM(B2:B10) on a check tab) excuse it.
 */
function expandingFamily(near: Near, sheet: string, l: LineRef): boolean {
  const k = lineCode(l);
  const reachesTo = (dr: number, dc: number, hi: number) => {
    const s = near(dr, dc)?.get(sheet);
    return !!s && hasTriple(s.byLo, k, l.lo, hi);
  };
  return NEIGHBOURS.some(([dr, dc]) => reachesTo(dr, dc, l.hi + 1) && (reachesTo(-dr, -dc, l.hi - 1) || reachesTo(2 * dr, 2 * dc, l.hi + 2)));
}

/**
 * Where a walk along a line (`dataPastEnd`) that reaches the line's cell `k` meets the first
 * position that ends a run of the range's data: a blank (a position holding no cell, or a blank
 * cell), a formula, a value of the other kind (`numeric`), or a header line (when `dataLines`).
 * Totals are not looked at here: the answer is the same for every table, and `dataPastEnd` finds
 * the totals of its own table between here and there through `totalsIndex`. Every cell a scan
 * passes gets the same answer, kept per cell, so each cell of a line is scanned at most once per
 * kind of walk (at most four kinds, whatever the number of ranges or tables) however many ranges
 * end inside the same run of data — a column of weekly subtotals beside daily rows does not walk
 * the rest of the column once per subtotal.
 */
function stopFrom(grid: Grid, vertical: boolean, cells: Cell[], k: number, numeric: boolean, dataLines: boolean): number {
  const memos = stateOf(grid, vertical).stops, kind = 2 * +numeric + +dataLines;
  const memo = (memos[kind] ??= new Map<Cell, number>());
  const stops = (x: Cell) => isBlank(x) || x.formula !== undefined || isNumeric(x.value) !== numeric || (dataLines && isHeaderLine(grid, vertical, posOf(x, vertical)));
  let j = k, end: number | undefined;
  for (; ; j++) {
    const x = cells[j], p = posOf(x, vertical);
    if ((end = memo.get(x)) !== undefined) break;
    if (stops(x)) {
      end = p;
      break;
    }
    if (j + 1 === cells.length || posOf(cells[j + 1], vertical) !== p + 1) {
      end = p + 1; // the next position holds no cell: a blank
      break;
    }
  }
  for (let i = k; i <= j; i++) memo.set(cells[i], end);
  return end;
}

/** What a range leaves out: how many cells, and the first `MISSED_NAMES` of them by name. */
interface Missed {
  count: number;
  cells: string[];
}
/** A finding names at most this many of the cells a range misses; `missedCells` counts them all. */
const MISSED_NAMES = 10;
const NOTHING_MISSED: Missed = { count: 0, cells: [] };

/**
 * The plain data cells that continue a range's run past its end — what the formula leaves out.
 * The walk starts right after the range and stops at the first cell that is not more of the
 * same data:
 *  - the edge of the loaded grid, or a blank;
 *  - any formula — a total, a subtotal or another calculation right after a block is how
 *    fixed-size ranges are built (SUM(B2:B13) with the total in B14), not data it forgot;
 *  - a value of the other kind — a text header or label after a run of numbers (or a number
 *    after a run of labels) starts something else;
 *  - a cell in a totals row/column of the range's own table (a row holding a subtotal of a
 *    block in that table, `tableAround`: =COUNTA(A2:A9) stops at the "Total" label in A10 because
 *    D10 totals D2:D9), or in a header row/column (text only) when the range's own last row holds
 *    data. A total in ANOTHER table beside it (a blank column away) does not end this one: a
 *    side table's Total row can sit level with a month this range leaves out.
 * A total BELOW its own range in the same column (right of it in the same row, at `totalAt`) is
 * expected to cover every data cell up to itself, so there the walk skips blanks and ends at it.
 *
 * Cost follows the cells present. A range with nothing after it to walk — a total right under or
 * beside its range, a blank after its end — returns before anything is built. Otherwise the walk
 * reads the line's cells in order (`lineCells`), takes the range's kind from running counts
 * (`kindCounts`), skips a stretch of plain data in one step (`stopFrom`, the same for every table),
 * asks the grid's totals index once for the first total of its own table in that stretch
 * (`firstTotalIn`, measuring the table only when a line in the stretch holds any total), jumps over
 * blanks to the next cell present, and keeps only the count and the first `MISSED_NAMES` cells.
 * Nothing it keeps is per table: a walk that knew its table used to keep a stop memo of its own
 * for every row it passed, so a total on every row beside the data and a different table per
 * range (a staircase of markers) cost memory in tables × rows walked — 75,000 cells, +174 MB.
 */
function dataPastEnd(target: Grid, l: LineRef, meta: SheetMeta, totalAt?: number): Missed {
  const last = Math.min(totalAt !== undefined ? totalAt - 1 : Infinity, l.vertical ? target.maxRow : target.maxCol); // past the grid every cell is blank
  const cells = lineCells(target, l.vertical, l.line), n = cells.length;
  let k = firstFrom(cells, l.vertical, l.hi + 1);
  const at = (i: number) => (i < n ? posOf(cells[i], l.vertical) : Infinity);
  // Nothing to walk: no position left before `last`, or a blank right after the range with no total below to skip it.
  if (l.hi + 1 > last || at(k) > last || (totalAt === undefined && at(k) !== l.hi + 1)) return NOTHING_MISSED;
  const counts = kindCounts(target, l.vertical, l.line), a = firstFrom(cells, l.vertical, l.lo);
  const numbers = counts[2 * k] - counts[2 * a], labels = counts[2 * k + 1] - counts[2 * a + 1];
  if (!numbers && !labels) return NOTHING_MISSED;
  const numeric = numbers >= labels, dataLines = !isHeaderLine(target, l.vertical, l.hi);
  const missed: Missed = { count: 0, cells: [] };
  /** Positions from..to-1 are more of the range's data. */
  const take = (from: number, to: number) => {
    missed.count += to - from;
    for (let i = from; i < to && missed.cells.length < MISSED_NAMES; i++) missed.cells.push(l.vertical ? cellA1(i, l.line) : cellA1(l.line, i));
  };
  // The range's table, looked up only once the walk passes a line holding a total (most walks never do).
  let table: [number, number] | undefined;
  // p: the next position to look at; k: the index of the first cell at or after it.
  for (let p = l.hi + 1; p <= last; ) {
    const s = at(k) === p ? stopFrom(target, l.vertical, cells, k, numeric, dataLines) : p;
    const e = Math.min(s, last + 1);
    // p..e-1 are cells of the range's data in a row, unless one of their lines holds a total of this table, which ends the walk there.
    if (p < e) {
      const totals = totalsIndex(target, l.vertical, meta);
      if (firstTotalLine(totals, p) < e) {
        const [lo, hi] = (table ??= tableAround(target, l));
        const t = firstTotalIn(totals, p, lo, hi);
        if (t < e) {
          take(p, t);
          break;
        }
      }
    }
    take(p, e);
    if (s > last) break;
    k += s - p; // p..s-1 are cells k.. in a row, so s is cell k when present
    const x = at(k) === s ? cells[k] : undefined;
    // s ends the walk — a formula, a value of the other kind, a header line, a blank — except a blank on the way to a total below, which skips to the next cell present.
    if (!isBlank(x) || totalAt === undefined) break;
    if (x) k++;
    p = at(k);
  }
  return missed;
}

/**
 * How many walk results (`dataPastEnd`) a tab's range check keeps, by range text: a fill-down reading
 * one fixed range (=B2/SUM($B$2:$B$13) in every row) walks it once, not once per row. Only walks
 * that got past the range's end are kept — most return at once, and cost nothing to repeat — and the
 * memo starts over when full, and when the tab's check ends. Kept for the whole audit, one entry per
 * distinct range, it held 1.2 million entries for 300 cells of 4,000 distinct ranges each; with
 * every formula cell's resolved references kept too, that audit needed a 420 MB heap (before this
 * change: 26 MB; now 36 MB).
 */
const WALK_MEMO_ENTRIES = 4096;

/**
 * A finding lists at most this many of its formula's short ranges: the ones fewest cells short
 * (the likeliest slips, as `RANK` orders findings), in formula order. `missedCells` totals every
 * short range and `shortRanges` (only when some are left out) counts them. Unbounded, one cell of
 * a 49,000-character formula of 7,000 two-cell ranges over a block of numbers listed all 7,000
 * with up to 10 cell names each, held for every such cell before `max_findings` applies: 150
 * cells ran out of memory in a 128 MB heap, and in a larger one their summary was 4.1 MB.
 */
const SHORT_RANGES_LISTED = 10;

/**
 * Single-column (or single-row) bounded ranges that stop while their data run goes on — e.g.
 * SUM(B2:B9) while B10 holds another plain number. One finding per formula cell, listing its
 * short ranges (up to `SHORT_RANGES_LISTED`) with the cells each misses (`dataPastEnd`), unless
 * the range is a step of a running total (`expandingWindow`, `expandingFamily`) or ends where the formula's own fill picks
 * up (`deliberateEnd`). Those three look only at the formula and its neighbours, so they run
 * first: a moving average's windows are excused without walking the column once per window.
 */
function rangeGaps(grid: Grid, grids: Map<string, Grid>, meta: SheetMeta): Finding[] {
  const out: Finding[] = [];
  const walked = new Map<string, Missed>(); // `WALK_MEMO_ENTRIES`
  for (const c of formulaCells(grid)) {
    const listed: { text: string; missed: Missed; order: number }[] = []; // `SHORT_RANGES_LISTED`
    const seen = new Set<string>();
    let missedCells = 0, shortRanges = 0;
    const x = rangesOf(c, grid, meta);
    let near: Near | undefined;
    for (let i = 0; i < x.sheets.length; i++) {
      const sheet = x.sheets[i], range = rangeAt(x, i);
      const target = grids.get(sheet);
      const l = asLine(range);
      if (!target || !l) continue;
      const text = rangeText(sheet, range);
      if (seen.has(text) || expandingWindow(x.nums[i * RANGE_NUMS + 4], l, c)) continue;
      seen.add(text);
      near ??= neighbourhood(c, grid, meta);
      if (deliberateEnd(near, sheet, l) || expandingFamily(near, sheet, l)) continue;
      const pos = l.vertical ? c.row : c.col;
      const totalAt = target === grid && (l.vertical ? c.col : c.row) === l.line && pos > l.hi ? pos : undefined;
      // A walk to a total below ends at the first formula after the range, which is at the total or
      // before it, so where the total sits does not change the result: one walk per range, too.
      const memoKey = totalAt === undefined ? text : `${text} below`;
      let missed = walked.get(memoKey);
      if (!missed) {
        missed = dataPastEnd(target, l, meta, totalAt);
        if (missed !== NOTHING_MISSED) {
          if (walked.size >= WALK_MEMO_ENTRIES) walked.clear();
          walked.set(memoKey, missed);
        }
      }
      if (!missed.count) continue;
      missedCells += missed.count;
      const entry = { text, missed, order: shortRanges++ };
      if (listed.length < SHORT_RANGES_LISTED) listed.push(entry);
      else {
        // Replace the listed range missing the most cells (the latest of those), if this one misses fewer.
        let worst = 0;
        for (let j = 1; j < listed.length; j++) if (listed[j].missed.count >= listed[worst].missed.count) worst = j;
        if (missed.count < listed[worst].missed.count) listed[worst] = entry;
      }
    }
    if (!missedCells) continue;
    const beyond: Record<string, string[]> = {};
    for (const e of listed.sort((p, q) => p.order - q.order)) beyond[e.text] = [...e.missed.cells];
    const f: Finding = { cell: a1(grid.title, c.row, c.col), formula: c.formula, dataBeyondRange: beyond, missedCells };
    if (shortRanges > listed.length) f.shortRanges = shortRanges;
    RANK.set(f, -missedCells);
    out.push(f);
  }
  return out;
}

/**
 * A finding names at most this many missing sheets, in formula order; `missingSheetCount` (only
 * when some are left out) counts them all. Unbounded, a 49,000-character formula naming 6,000
 * missing sheets listed every name, held for each such cell before `max_findings` applies: 700
 * cells ran out of memory in a 128 MB heap, and in a larger one the summary of 200 was 9 MB.
 */
const MISSING_SHEETS_LISTED = 10;
const NO_SHEETS = { names: [] as string[], count: 0 };
/** Formulas that reference a sheet title that does not exist (usually already #REF!, but named explicitly). */
function missingSheets(grid: Grid, meta: SheetMeta): Finding[] {
  const out: Finding[] = [];
  // By formula text: a fill-down of one formula is parsed once (the answer depends on the text alone).
  const byFormula = new Map<string, { names: string[]; count: number }>();
  for (const c of formulaCells(grid)) {
    let missing = byFormula.get(c.formula!);
    if (!missing) {
      const all = new Set(extractRefs(c.formula!).filter((r) => r.sheet && !meta.ids.has(r.sheet)).map((r) => r.sheet!));
      missing = all.size ? { names: [...all].slice(0, MISSING_SHEETS_LISTED), count: all.size } : NO_SHEETS; // one shared empty entry for the formulas that name none
      byFormula.set(c.formula!, missing);
    }
    if (!missing.count) continue;
    const f: Finding = { cell: a1(grid.title, c.row, c.col), formula: c.formula, missingSheets: [...missing.names] };
    if (missing.count > missing.names.length) f.missingSheetCount = missing.count;
    out.push(f);
  }
  return out;
}

// ---- audit output ---------------------------------------------------------------

/** Formulas longer than this are cut to FORMULA_MAX - 3 chars + "…" in findings (a 12-month SUMIFS across a long tab name runs to hundreds). */
const FORMULA_MAX = 120;
const clipFormula = (f: string) => (f.length > FORMULA_MAX ? `${f.slice(0, FORMULA_MAX - 3)}…` : f);
/** A finding with its formula clipped; `formulaLength` (only when clipped) is the real length. */
function clipFinding(f: Finding): Finding {
  if (f.formula === undefined || f.formula.length <= FORMULA_MAX) return f;
  const { cell, formula, ...rest } = f;
  return { cell, formula: clipFormula(formula), formulaLength: formula.length, ...rest };
}

/** One finding per cell: a repeat merges into the first (lists and objects united, the first's scalars kept). */
function onePerCell(findings: Finding[]): Finding[] {
  const byCell = new Map<string, Finding>();
  for (const f of findings) {
    const prev = byCell.get(f.cell);
    if (!prev) {
      byCell.set(f.cell, f);
      continue;
    }
    for (const [k, v] of Object.entries(f)) {
      const p = prev[k];
      if (Array.isArray(p) && Array.isArray(v)) prev[k] = [...new Set([...p, ...v])];
      else if (p && v && typeof p === "object" && typeof v === "object") prev[k] = { ...(v as AnyRec), ...(p as AnyRec) };
      else if (p === undefined) prev[k] = v;
    }
  }
  return [...byCell.values()];
}

/** Summary mode lists this many warnings per category (errors are always listed, up to max_findings). */
const TOP_WARNINGS = 10;

// ---- tools --------------------------------------------------------------------

export const sheetsAnalysisTools = [
  tool({
    name: "sheets_audit_spreadsheet",
    description:
      "Health check of a spreadsheet (or selected ranges): formula errors, plus warnings about broken fill-downs and short ranges. Errors: cells showing #REF!, #DIV/0!, #N/A, #NAME?, … (Google's message, circular flag) and formulas naming a missing sheet. Warnings: a formula unlike its column/row neighbours (totals and headers excepted) and a range stopping just before more plain data (SUM(B2:B9) while B10 holds a number). ok = no errors; errorCount/warningCount count cells. Read-only; run it after editing a model.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string(),
      ranges: z.array(z.string()).optional().describe("A1 ranges or tab names to audit (default: every tab). Narrow this on very large spreadsheets."),
      detail: z.enum(["summary", "findings"]).default("summary").describe("summary: counts, errors, top 10 warnings per kind. findings: all. Both up to max_findings"),
      max_findings: z.number().int().min(1).max(2000).default(200).describe("Cap per category"),
    },
    handler: async (a, { g }) => {
      const [meta, grids] = await Promise.all([getSheetMeta(g, a.spreadsheet_id), loadGrids(g, a.spreadsheet_id, a.ranges)]);
      const byTitle = new Map(grids.map((x) => [x.title, x]));
      const errors: Finding[] = [];
      const inconsistent: Finding[] = [];
      const gaps: Finding[] = [];
      const missing: Finding[] = [];
      let cellsScanned = 0, formulas = 0;
      // Appended one by one: a spread of a list this long can exceed the arguments a call may take.
      const append = (to: Finding[], xs: Finding[]) => {
        for (const x of xs) to.push(x);
      };
      for (const grid of grids) {
        cellsScanned += grid.cells.size;
        formulas += formulaCells(grid).length; // not grid.formulas: overlapping `ranges` list a cell twice there
        append(errors, gridErrors(grid)); // the same list sheets_delete_sheet's post-check reports
        // What a formula resolves to is memoised while its tab is checked, and released before the next tab.
        withFormulaMemo(grid, () => {
          append(missing, missingSheets(grid, meta));
          append(inconsistent, inconsistentFormulas(grid, meta));
          append(gaps, rangeGaps(grid, byTitle, meta));
        });
      }
      const found = {
        errorCells: onePerCell(errors),
        missingSheetRefs: onePerCell(missing),
        inconsistentFormulas: onePerCell(inconsistent),
        rangesStoppingBeforeData: onePerCell(gaps),
      };
      // Severity counts are CELLS: a formula naming a missing sheet usually also shows #REF!, and is one error, not two.
      const cellsIn = (...lists: Finding[][]) => new Set(lists.flat().map((f) => f.cell)).size;
      const errorCount = cellsIn(found.errorCells, found.missingSheetRefs);
      const warningCount = cellsIn(found.inconsistentFormulas, found.rangesStoppingBeforeData);
      const summaryOnly = a.detail !== "findings"; // the schema default, also when a caller bypasses zod
      const warningCap = summaryOnly ? Math.min(TOP_WARNINGS, a.max_findings) : a.max_findings;
      // Errors keep sheet order; summary mode ranks warnings (see RANK) so the ten shown are the likeliest real.
      const list = (xs: Finding[], cap: number, ranked: boolean) => {
        const ordered = ranked ? [...xs].sort((p, q) => (RANK.get(q) ?? 0) - (RANK.get(p) ?? 0)) : xs;
        const items = ordered.slice(0, cap).map(clipFinding);
        return xs.length > cap ? { items, truncated: xs.length - cap } : { items };
      };
      const warningsCut = Math.max(found.inconsistentFormulas.length, found.rangesStoppingBeforeData.length) > warningCap;
      return {
        ok: errorCount === 0,
        errorCount,
        warningCount,
        sheets: grids.map((x) => x.title),
        cellsScanned,
        formulas,
        summary: {
          errorCells: found.errorCells.length,
          circularReferences: found.errorCells.filter((f) => f.circular).length,
          missingSheetRefs: found.missingSheetRefs.length,
          inconsistentFormulas: found.inconsistentFormulas.length,
          rangesStoppingBeforeData: found.rangesStoppingBeforeData.length,
        },
        // `errors` is the LIST of error cells, as it always was (and as in verifyCells); the counts are errorCount/summary.
        errors: list(found.errorCells, a.max_findings, false),
        missingSheetRefs: list(found.missingSheetRefs, a.max_findings, false),
        inconsistentFormulas: list(found.inconsistentFormulas, warningCap, summaryOnly),
        rangesStoppingBeforeData: list(found.rangesStoppingBeforeData, warningCap, summaryOnly),
        note: summaryOnly && warningsCut ? `Showing the top ${warningCap} warnings per kind; detail=findings lists the rest (up to max_findings).` : undefined,
      };
    },
  }),

  tool({
    name: "sheets_trace_precedents",
    description:
      "Dependency tree of a cell: its formula, the cells/ranges it reads (resolving sheet-qualified and named ranges), their values, and recursively the formulas behind them up to `depth`. Shows exactly where a number comes from. Ranges larger than `expand_range_cells` are listed with their values but not expanded further.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string(),
      cell: z.string().describe("A1 with tab, e.g. 'Summary!B12' or 'תקציב 2026'!C7"),
      depth: z.number().int().min(1).max(8).default(3),
      max_nodes: z.number().int().min(1).max(500).default(80).describe("Stop expanding after this many cells"),
      expand_range_cells: z.number().int().min(1).max(500).default(50).describe("Ranges with more cells than this are shown as values only"),
    },
    handler: async (a, { g }) => {
      const meta = await getSheetMeta(g, a.spreadsheet_id);
      const start = parseA1(a.cell);
      if (!start.sheet || start.startCol === undefined || start.startRow === undefined) throw new Error("cell must be a single cell with a tab name, e.g. 'Sheet1!B2'");
      if (!meta.ids.has(start.sheet)) throw new Error(`No tab named '${start.sheet}'. Tabs: ${[...meta.ids.keys()].join(", ")}`);
      const names = meta.namedRanges.map((n) => n.name);
      const base = `${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/values:batchGet`;
      const fetchRanges = async (ranges: string[]) => {
        if (!ranges.length) return { formulas: [] as AnyRec[], values: [] as AnyRec[] };
        const [f, v] = await Promise.all([
          g.get<AnyRec>(base, { ranges, valueRenderOption: "FORMULA" }),
          g.get<AnyRec>(base, { ranges, valueRenderOption: "FORMATTED_VALUE" }),
        ]);
        return { formulas: (f.valueRanges ?? []) as AnyRec[], values: (v.valueRanges ?? []) as AnyRec[] };
      };
      interface Node {
        cell: string;
        value?: unknown;
        formula?: string;
        precedents?: unknown[];
        note?: string;
      }
      const visited = new Set<string>();
      let nodes = 0;
      let truncated = false;
      // Level-wise expansion: each level is a single pair of batchGet calls.
      const expand = async (targets: { sheet: string; range: A1Range; node: Node | AnyRec; text: string }[], level: number): Promise<void> => {
        if (!targets.length || level > a.depth) return;
        const ranges = targets.map((t) => rangeText(t.sheet, t.range));
        const { formulas, values } = await fetchRanges(ranges);
        const next: typeof targets = [];
        targets.forEach((t, i) => {
          const fRows: unknown[][] = formulas[i]?.values ?? [];
          const vRows: unknown[][] = values[i]?.values ?? [];
          const single = a1Cells(t.range) === 1;
          if (single) {
            const n = t.node as Node;
            const f = fRows[0]?.[0];
            n.value = vRows[0]?.[0];
            if (typeof f === "string" && f.startsWith("=")) {
              n.formula = f;
              n.precedents = [];
              for (const ref of extractRefs(f, names)) {
                const res = resolveRef(ref, t.sheet, meta);
                if (!res) {
                  n.precedents.push({ ref: ref.text, note: "unresolved reference" });
                  continue;
                }
                const text = rangeText(res.sheet, res.range);
                const child: Node = { cell: text };
                n.precedents.push(child);
                if (visited.has(text)) {
                  child.note = "see above (already expanded)";
                  continue;
                }
                if (nodes >= a.max_nodes) {
                  truncated = true;
                  child.note = "not expanded (max_nodes)";
                  continue;
                }
                visited.add(text);
                nodes++;
                next.push({ sheet: res.sheet, range: res.range, node: child, text });
              }
            }
          } else {
            const n = t.node as AnyRec;
            const cells = a1Cells(t.range);
            n.cells = cells;
            n.values = vRows;
            const formulaCells: { cell: string; formula: string }[] = [];
            const r0 = t.range.startRow ?? 1, c0 = t.range.startCol ?? 1;
            fRows.forEach((row, ri) => row.forEach((f, ci) => {
              if (typeof f === "string" && f.startsWith("=")) formulaCells.push({ cell: cellA1(r0 + ri, c0 + ci), formula: f });
            }));
            if (formulaCells.length) {
              if (cells > a.expand_range_cells) {
                n.formulas = formulaCells.slice(0, 20);
                n.note = `${formulaCells.length} formula cells in range — not expanded (range > expand_range_cells)`;
              } else {
                n.formulaCells = [];
                for (const fc of formulaCells) {
                  const text = `${quoteSheet(t.sheet)}!${fc.cell}`;
                  const child: Node = { cell: text };
                  n.formulaCells.push(child);
                  if (visited.has(text)) {
                    child.note = "see above";
                    continue;
                  }
                  if (nodes >= a.max_nodes) {
                    truncated = true;
                    child.note = "not expanded (max_nodes)";
                    continue;
                  }
                  visited.add(text);
                  nodes++;
                  next.push({ sheet: t.sheet, range: parseA1(fc.cell), node: child, text });
                }
              }
            }
          }
        });
        await expand(next, level + 1);
      };
      const rootText = rangeText(start.sheet, start);
      const root: Node = { cell: rootText };
      visited.add(rootText);
      nodes++;
      await expand([{ sheet: start.sheet, range: start, node: root, text: rootText }], 1);
      if (!root.formula) root.note = "not a formula — nothing to trace";
      return { ...root, depth: a.depth, nodes, truncated: truncated || undefined };
    },
  }),

  tool({
    name: "sheets_trace_dependents",
    description:
      "Reverse dependency lookup: every formula in the spreadsheet that reads a given cell (directly, through a range that contains it, via a sheet-qualified reference or a named range), and recursively the formulas that read those, up to `depth`. Use it before changing or deleting a cell to see what breaks.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string(),
      cell: z.string().describe("A1 with tab, e.g. 'Data!B4'"),
      depth: z.number().int().min(1).max(6).default(2),
      max_results: z.number().int().min(1).max(1000).default(200),
    },
    handler: async (a, { g }) => {
      const [meta, grids] = await Promise.all([getSheetMeta(g, a.spreadsheet_id), loadGrids(g, a.spreadsheet_id)]);
      const start = parseA1(a.cell);
      if (!start.sheet || start.startCol === undefined || start.startRow === undefined) throw new Error("cell must be a single cell with a tab name, e.g. 'Sheet1!B2'");
      if (!meta.ids.has(start.sheet)) throw new Error(`No tab named '${start.sheet}'. Tabs: ${[...meta.ids.keys()].join(", ")}`);
      // Pre-resolve every formula's references once.
      const formulas = resolveFormulas(grids, meta);
      const dependentsOf = (sheet: string, row: number, col: number) =>
        formulas.filter((f) => f.refs.some((x) => x.res!.sheet === sheet && rangeContains(x.res!.range, row, col))).map((f) => ({ ...f, via: f.refs.filter((x) => x.res!.sheet === sheet && rangeContains(x.res!.range, row, col)).map((x) => x.text) }));
      const seen = new Set<string>([a1(start.sheet, start.startRow, start.startCol)]);
      const levels: { level: number; dependents: { cell: string; formula: string; value?: unknown; via: string[] }[] }[] = [];
      let frontier = [{ sheet: start.sheet, row: start.startRow, col: start.startCol }];
      let total = 0;
      let truncated = false;
      for (let level = 1; level <= a.depth && frontier.length; level++) {
        const found: { cell: string; formula: string; value?: unknown; via: string[] }[] = [];
        const next: typeof frontier = [];
        for (const f of frontier) {
          for (const d of dependentsOf(f.sheet, f.row, f.col)) {
            if (seen.has(d.cell)) continue;
            seen.add(d.cell);
            if (total >= a.max_results) {
              truncated = true;
              break;
            }
            total++;
            found.push({ cell: d.cell, formula: d.formula, value: d.value, via: [...new Set(d.via)] });
            const p = parseA1(d.cell);
            if (p.sheet && p.startRow !== undefined && p.startCol !== undefined) next.push({ sheet: p.sheet, row: p.startRow, col: p.startCol });
          }
        }
        if (found.length) levels.push({ level, dependents: found });
        frontier = next;
      }
      return { cell: a1(start.sheet, start.startRow, start.startCol), formulasScanned: formulas.length, dependents: total, levels, truncated: truncated || undefined, note: total ? undefined : "No formula reads this cell" };
    },
  }),
];

// ---- shared with sheets_batch_update_spreadsheet ------------------------------
// Additive exports only: the batch-update dry run previews a deletion with the same reference
// resolution sheets_trace_dependents walks, and its post-check reuses the audit's grid loader
// and error extraction, so the tools cannot disagree about what "a formula reads this cell" or
// "this cell shows an error" means.

export { loadGrids };
export type { Grid as SheetGrid, Cell as SheetCell, Finding as SheetFinding };

/** A formula cell with every reference resolved once to (sheet, A1Range): unqualified refs on its own sheet, named ranges to their target. */
export interface ResolvedFormula {
  cell: string;
  sheet: string;
  row: number;
  col: number;
  formula: string;
  value?: unknown;
  refs: { text: string; res: { sheet: string; range: A1Range } }[];
}

/** Every formula in `grids` with its references pre-resolved (unresolvable ones dropped) — what sheets_trace_dependents searches. */
export function resolveFormulas(grids: Grid[], meta: SheetMeta): ResolvedFormula[] {
  const { names } = namedRanges(meta);
  return grids.flatMap((grid) =>
    grid.formulas.map((c) => ({
      cell: a1(grid.title, c.row, c.col),
      sheet: grid.title,
      row: c.row,
      col: c.col,
      formula: c.formula!,
      value: c.value,
      refs: extractRefs(c.formula!, names).flatMap((ref) => {
        const res = resolveRef(ref, grid.title, meta);
        return res ? [{ text: ref.text, res }] : [];
      }),
    })),
  );
}

/**
 * Every cell of `grid` that evaluates to an error, in the audit's finding shape: {cell, formula, error (Google's type), message, circular?}.
 * The one implementation: sheets_audit_spreadsheet's `errors` and the post-check of sheets_delete_sheet and
 * sheets_batch_update_spreadsheet both list these, so they cannot disagree about which cells are broken.
 */
export function gridErrors(grid: Grid): Finding[] {
  const out: Finding[] = [];
  for (const c of grid.cells.values()) {
    if (!c.error) continue;
    const isCircular = /circular/i.test(c.error.message ?? "");
    out.push({ cell: a1(grid.title, c.row, c.col), formula: c.formula, error: c.error.type, message: c.error.message, ...(isCircular ? { circular: true } : {}) });
  }
  return out;
}

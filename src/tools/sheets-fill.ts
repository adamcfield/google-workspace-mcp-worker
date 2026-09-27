/**
 * Planning for `sheets_fill_range`: write one value into the top-left cell of a range and fill it
 * across the rest, the way dragging the fill handle does.
 *
 * Why a tool of its own: the alternative is writing every copy of a formula yourself, and every
 * copy repeats the whole formula — tab name included — with its references shifted by hand. A
 * twelve-month row of one formula on a tab with a long Hebrew name cost ~8.6K characters per
 * write in QA (~21.6K once JSON-escaped). Here the formula is sent once.
 *
 * How: ONE spreadsheets.batchUpdate with two requests, in this order —
 *  1. `updateCells` on the top-left cell (the value typed by content: formula, number, boolean, text);
 *  2. `copyPaste` from that single cell onto the whole range, `PASTE_NORMAL`.
 * Google adjusts relative references on a copyPaste exactly as on a paste in the UI. `repeatCell`
 * does NOT — it writes the identical formula text into every cell — so it is never used here.
 *
 * The tab resolution here (`resolveSheet`) is also what `qualifyRange` gives the value writes'
 * optional `sheet_id`, so a tab id means the same thing, with the same errors, on every Sheets write.
 *
 * Pure: the handler in `sheets.ts` does the I/O. Unit-tested in `tests/sheets-fill.test.ts`.
 */
import type { AnyRec } from "./_shared.js";
import { cellA1, gridRangeToA1, parseA1, quoteSheet } from "./sheets-a1.js";
import type { SheetMeta, Verification } from "./sheets-verify.js";

/** Largest range one call may fill. A larger fill is almost always a mistyped range. */
export const MAX_FILL_CELLS = 50_000;
/** Up to this many cells are re-read in full; above it verification reads a head and a tail band. */
export const FILL_VERIFY_CELLS = 5_000;
/** Cells per verification band when the range is sampled (two bands ≤ `FILL_VERIFY_CELLS`). */
const BAND_CELLS = FILL_VERIFY_CELLS / 2;
/** Longest `value`: what one Google Sheets cell holds. */
export const MAX_FILL_VALUE_CHARS = 50_000;
/** Error cells a fill's reply lists; `errorCount` carries the rest. */
export const FILL_ERRORS_LISTED = 10;

export interface FillPlan {
  sheetId: number;
  /** Sheet-qualified A1 of the whole destination, e.g. `'תקציב 2026'!C2:N2`. */
  range: string;
  /** The top-left cell, unqualified (`C2`) — the tab is already in `range`. */
  topLeft: string;
  cells: number;
  /** The batchUpdate requests, in the order they must run. */
  requests: AnyRec[];
  /** Sheet-qualified A1 ranges to re-read for verification. */
  verifyRanges: string[];
  /** True when `verifyRanges` is a head/tail sample of a range over `FILL_VERIFY_CELLS`. */
  sampled: boolean;
}

/**
 * The top-left cell's `userEnteredValue`, typed by content the way the Sheets UI types what is
 * entered: `=` starts a formula, a plain number is a number, TRUE/FALSE are booleans, a leading
 * apostrophe forces text (and is not stored), and anything else is text. Dates, percentages and
 * currency stay text here — write them as a formula (`=DATE(2026,1,31)`) to get a typed value.
 */
export function typedValue(value: string): AnyRec {
  if (value.startsWith("=")) return { formulaValue: value };
  if (value.startsWith("'")) return { stringValue: value.slice(1) };
  const t = value.trim();
  // `\d+(?:\.\d*)?`, not `\d+\.?\d*`: the same numbers, but the latter splits a digit run between
  // its two `\d`s in every way before failing, quadratic on a long run that is not a number.
  if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(t) && Number.isFinite(Number(t))) return { numberValue: Number(t) };
  if (/^(?:true|false)$/i.test(t)) return { boolValue: t.toLowerCase() === "true" };
  return { stringValue: value };
}

/** "Tabs (sheet_id): Sheet1 (0), Budget (7)" — capped, for error messages that must say what exists. */
function tabList(meta: SheetMeta): string {
  const tabs = [...meta.titles.entries()].map(([id, title]) => `${title} (${id})`);
  return `Tabs (sheet_id): ${tabs.slice(0, 20).join(", ")}${tabs.length > 20 ? ", …" : ""}`;
}

/** Exact title first, then a unique case-insensitive match (A1 tab names are not case-sensitive). */
function sheetIdByTitle(meta: SheetMeta, title: string): number | undefined {
  const exact = meta.ids.get(title);
  if (exact !== undefined) return exact;
  const folded = [...meta.ids.entries()].filter(([t]) => t.toLowerCase() === title.toLowerCase());
  return folded.length === 1 ? folded[0][1] : undefined;
}

/**
 * Which tab the fill lands on. A tab named in `range` and a `sheet_id` must agree; an unqualified
 * range with no `sheet_id` is accepted only when the spreadsheet has exactly one tab, because a fill
 * can overwrite thousands of cells and "the first tab" is a guess about which one was meant.
 */
function resolveSheet(range: string, named: string | undefined, sheetId: number | undefined, meta: SheetMeta): number {
  if (named !== undefined) {
    const id = sheetIdByTitle(meta, named);
    if (id === undefined) throw new Error(`No tab named '${named}'. ${tabList(meta)}`);
    if (sheetId !== undefined && sheetId !== id) {
      throw new Error(`range names tab '${named}' (sheet_id ${id}) but sheet_id is ${sheetId}${meta.titles.has(sheetId) ? ` ('${meta.titles.get(sheetId)}')` : " (no such tab)"}. Give the tab once: in range or as sheet_id.`);
    }
    return id;
  }
  if (sheetId !== undefined) {
    if (!meta.titles.has(sheetId)) throw new Error(`No tab with sheet_id ${sheetId}. ${tabList(meta)}`);
    return sheetId;
  }
  if (meta.titles.size === 1) return [...meta.titles.keys()][0];
  throw new Error(`range '${range}' names no tab and the spreadsheet has ${meta.titles.size}: pass sheet_id or qualify the range ('Tab'!C2:N2). ${tabList(meta)}`);
}

/**
 * `range` on tab `sheetId`, for `sheets_write_range` / `sheets_batch_write_ranges`: an unqualified
 * range gets the tab's title, quoted as A1 needs it (`'תקציב 2026'!C2:N2`, `'Bob''s plan'!B2`), so
 * a long tab name need not be sent; a range that names its tab is sent as given once it agrees.
 * Same resolution and errors as a fill: an unknown `sheetId`, or a tab name that is not `sheetId`.
 */
export function qualifyRange(range: string, sheetId: number, meta: SheetMeta): string {
  const named = parseA1(range).sheet;
  const id = resolveSheet(range, named, sheetId, meta);
  if (named !== undefined) return range;
  const tab = quoteSheet(meta.titles.get(id) ?? "");
  const cells = range.trim();
  return cells ? `${tab}!${cells}` : tab;
}

/**
 * Verification ranges: the whole range up to `FILL_VERIFY_CELLS`, else a band at each end along
 * the longer side. Every cell holds the same formula shifted, so a formula that is wrong at all is
 * wrong at the top-left, and one whose references run off the data breaks at the far end — the
 * two places the bands look.
 */
function verifyBands(sheetId: number, r0: number, c0: number, r1: number, c1: number, titles: Map<number, string>): { ranges: string[]; sampled: boolean } {
  const rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  const a1 = (ra: number, ca: number, rb: number, cb: number) => gridRangeToA1({ sheetId, startRowIndex: ra - 1, endRowIndex: rb, startColumnIndex: ca - 1, endColumnIndex: cb }, titles);
  if (rows * cols <= FILL_VERIFY_CELLS) return { ranges: [a1(r0, c0, r1, c1)], sampled: false };
  if (rows >= cols) {
    const k = Math.max(1, Math.floor(BAND_CELLS / cols));
    return { ranges: [a1(r0, c0, r0 + k - 1, c1), a1(r1 - k + 1, c0, r1, c1)], sampled: true };
  }
  const k = Math.max(1, Math.floor(BAND_CELLS / rows));
  return { ranges: [a1(r0, c0, r1, c0 + k - 1), a1(r0, c1 - k + 1, r1, c1)], sampled: true };
}

/**
 * Plan a fill: resolve the tab, bound-check the range and build the two requests. Throws with a
 * message that says what to do instead on every input it refuses — an open-ended or named range,
 * an unknown tab, a tab named twice inconsistently, a range past the grid or over `MAX_FILL_CELLS`.
 */
export function planFill(range: string, sheetId: number | undefined, value: string, meta: SheetMeta): FillPlan {
  const a1 = parseA1(range);
  // parseA1 reads only the first two corners, so `C2:N2:Z9` would silently fill C2:N2. The text
  // after the last `!` is the cell part whatever the tab name contains.
  const cellPart = range.slice(range.lastIndexOf("!") + 1);
  if ((cellPart.match(/:/g) ?? []).length > 1 || a1.startCol === undefined || a1.startRow === undefined || a1.endCol === undefined || a1.endRow === undefined) {
    throw new Error(`range must be a block with both corners, e.g. 'Sheet1'!C2:N2 or C2:C40 — got '${range}'. Whole columns/rows, bare tab names and named ranges are not accepted.`);
  }
  // parseA1 reads "A0" as row 0, which would become grid index -1 and a bare 400 from Google.
  if (a1.startRow < 1 || a1.endRow < 1) throw new Error(`range '${range}' names row 0, but rows start at 1 (e.g. C2:C40).`);
  const id = resolveSheet(range, a1.sheet, sheetId, meta);
  const r0 = Math.min(a1.startRow, a1.endRow), r1 = Math.max(a1.startRow, a1.endRow);
  const c0 = Math.min(a1.startCol, a1.endCol), c1 = Math.max(a1.startCol, a1.endCol);
  const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
  if (cells > MAX_FILL_CELLS) throw new Error(`range covers ${cells.toLocaleString("en-US")} cells; one fill is limited to ${MAX_FILL_CELLS.toLocaleString("en-US")}. Split it into smaller ranges.`);
  const grid = meta.grids.get(id);
  const title = meta.titles.get(id) ?? `sheet#${id}`;
  if (grid?.rowCount !== undefined && r1 > grid.rowCount) throw new Error(`range ends at row ${r1} but '${title}' has ${grid.rowCount} rows. Add rows first (appendDimension) or end the range sooner.`);
  if (grid?.columnCount !== undefined && c1 > grid.columnCount) throw new Error(`range ends at column ${c1} but '${title}' has ${grid.columnCount} columns. Add columns first (appendDimension) or end the range sooner.`);

  const source = { sheetId: id, startRowIndex: r0 - 1, endRowIndex: r0, startColumnIndex: c0 - 1, endColumnIndex: c0 };
  const destination = { sheetId: id, startRowIndex: r0 - 1, endRowIndex: r1, startColumnIndex: c0 - 1, endColumnIndex: c1 };
  const requests: AnyRec[] = [{ updateCells: { start: { sheetId: id, rowIndex: r0 - 1, columnIndex: c0 - 1 }, rows: [{ values: [{ userEnteredValue: typedValue(value) }] }], fields: "userEnteredValue" } }];
  // A one-cell "fill" is just the write; pasting a cell onto itself would add nothing.
  if (cells > 1) requests.push({ copyPaste: { source, destination, pasteType: "PASTE_NORMAL", pasteOrientation: "NORMAL" } });
  const { ranges, sampled } = verifyBands(id, r0, c0, r1, c1, meta.titles);
  return { sheetId: id, range: gridRangeToA1(destination, meta.titles), topLeft: cellA1(r0, c0), cells, requests, verifyRanges: ranges, sampled };
}

/** A fill's verification as the reply carries it: the full count, and the first error cells only. */
export interface FillVerification extends Verification {
  errorCount: number;
  /** Set when `errors` lists the first `FILL_ERRORS_LISTED` of `errorCount`. */
  errorsTruncated?: true;
}

/**
 * Cap the error cells a fill reports. A fill writes one formula shifted cell by cell, so a single
 * mistake — a misspelt tab name — breaks every cell it reaches: listed in full, a 2,000-row fill
 * replied with ~230K characters and a 5,000-row one ran past the output cap and stopped being
 * JSON. The first cells show what went wrong; `errorCount` says how far it reached.
 */
export function capFillVerification(v: Verification, max = FILL_ERRORS_LISTED): FillVerification {
  const out: FillVerification = { cells: v.cells, ok: v.ok, errorCount: v.errors.length, errors: v.errors.slice(0, max) };
  if (v.errors.length > max) out.errorsTruncated = true;
  return out;
}

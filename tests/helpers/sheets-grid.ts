/**
 * A spreadsheets.get with includeGridData answered the way Google answers it, for the Sheets tool
 * tests: `ranges` resolved with Google's A1 rules and the `fields` mask applied to every cell.
 *
 * - no `ranges`: every tab, whole;
 * - `'Title'` (quoted): that tab, whole — quoting makes it a tab even when the title reads like a cell;
 * - `Title!A1:B2` / `'Title'!A1:B2`: that block of the tab;
 * - an unquoted range that reads like a cell (`A1`, `Q1`, `Jan2024`): that cell of the FIRST sheet.
 *   That is Google's documented rule, and why a whole-tab read must quote the title;
 * - any other unquoted name: the tab with that title.
 *
 * Tabs come back in the response's tab order, one entry per tab, with one data block per range.
 */
import { parseA1 } from "../../src/tools/sheets-a1.js";

type Rec = Record<string, any>;
interface Box {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}
const ALL = Number.MAX_SAFE_INTEGER;

/** The cell fields a `fields` mask keeps, e.g. ["userEnteredValue/formulaValue", "formattedValue"]; undefined = every field. */
function cellFields(fields: unknown): string[] | undefined {
  const m = typeof fields === "string" ? /values\(([^()]*)\)/.exec(fields) : null;
  return m ? m[1].split(",").map((s) => s.trim()) : undefined;
}

/** A cell as Google returns it under the mask: `head` keeps the whole field, `head/sub` only that part of it. */
function project(cell: Rec | null | undefined, keep: string[] | undefined): Rec {
  if (!cell || !keep) return cell ?? {};
  const out: Rec = {};
  for (const item of keep) {
    const [head, sub] = item.split("/");
    const v = cell[head];
    if (v === undefined) continue;
    if (sub === undefined) out[head] = v;
    else if (v && typeof v === "object" && v[sub] !== undefined) out[head] = { ...(out[head] ?? {}), [sub]: v[sub] };
  }
  return out;
}

/** The cells of a fake tab inside `box`, as one data block anchored at the box's top-left. */
function block(sheet: Rec, box: Box, keep: string[] | undefined): Rec {
  const rows = new Map<number, Map<number, Rec>>();
  for (const b of (sheet.data ?? []) as Rec[]) {
    const r0 = Number(b.startRow ?? 0), c0 = Number(b.startColumn ?? 0);
    const rowData = (b.rowData ?? []) as Rec[];
    for (let ri = 0; ri < rowData.length; ri++) {
      const row = r0 + ri + 1;
      if (row < box.r0 || row > box.r1) continue;
      const values = (rowData[ri]?.values ?? []) as Rec[];
      for (let ci = 0; ci < values.length; ci++) {
        const col = c0 + ci + 1;
        if (col < box.c0 || col > box.c1 || !values[ci]) continue;
        (rows.get(row) ?? rows.set(row, new Map()).get(row)!).set(col, project(values[ci], keep));
      }
    }
  }
  let lastR = 0;
  for (const r of rows.keys()) lastR = Math.max(lastR, r);
  const rowData: Rec[] = [];
  for (let r = box.r0; r <= lastR; r++) {
    const cells = rows.get(r);
    let lastC = 0;
    for (const c of cells?.keys() ?? []) lastC = Math.max(lastC, c);
    const values: Rec[] = [];
    for (let c = box.c0; c <= lastC; c++) values.push(cells?.get(c) ?? {});
    rowData.push(values.length ? { values } : {});
  }
  return { startRow: box.r0 - 1, startColumn: box.c0 - 1, rowData };
}

const boxOf = (a: { startRow?: number; endRow?: number; startCol?: number; endCol?: number }): Box => ({
  r0: a.startRow ?? 1,
  r1: a.startRow === undefined ? ALL : a.endRow ?? ALL,
  c0: a.startCol ?? 1,
  c1: a.startCol === undefined ? ALL : a.endCol ?? ALL,
});

/** Answer one grid read from `resp` (every tab's cells, unmasked) under Google's range rules and the call's field mask. */
export function answerGridRead(params: Rec | undefined, resp: { sheets: Rec[] }): { sheets: Rec[] } {
  const keep = cellFields(params?.fields);
  if (!params?.ranges) return { ...resp, sheets: resp.sheets.map((s) => ({ ...s, data: s.data ? [block(s, { r0: 1, r1: ALL, c0: 1, c1: ALL }, keep)] : undefined })) };
  const wanted = new Map<Rec, Rec[]>();
  const add = (sheet: Rec | undefined, box: Box) => sheet && (wanted.get(sheet) ?? wanted.set(sheet, []).get(sheet)!).push(block(sheet, box, keep));
  const byTitle = (t: string) => resp.sheets.find((s) => s.properties?.title === t);
  for (const range of params.ranges as string[]) {
    const whole = /^'((?:[^']|'')*)'$/.exec(range);
    if (whole) {
      add(byTitle(whole[1].replace(/''/g, "'")), boxOf({}));
      continue;
    }
    const a = parseA1(range);
    const cellLike = a.startCol !== undefined && a.startRow !== undefined;
    if (a.sheet !== undefined && range.includes("!")) add(byTitle(a.sheet), boxOf(a));
    else if (cellLike) add(resp.sheets[0], boxOf(a)); // Google: an unquoted A1 reference is on the first sheet
    else add(byTitle(a.sheet ?? range), boxOf({}));
  }
  return { ...resp, sheets: resp.sheets.filter((s) => wanted.has(s)).map((s) => ({ ...s, data: wanted.get(s) })) };
}

/** JSON length of a value, without building the string (a text-heavy fake would otherwise allocate the whole body). */
export function jsonLength(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === "string") return v.length + 2;
  if (typeof v !== "object") return String(v).length;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + jsonLength(x) + 1, 1);
  let n = 1;
  for (const [k, x] of Object.entries(v as Rec)) if (x !== undefined) n += k.length + 3 + jsonLength(x) + 1;
  return n;
}

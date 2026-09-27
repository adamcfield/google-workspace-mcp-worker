/**
 * What sheets_delete_sheet's default post-check and a dry run's deletion preview resolve at once. Every
 * reference in a formula resolves to an object that takes over 100 times its text in heap, so the batches
 * eachResolvedFormula hands the resolver are bounded in formula characters, not only in formula cells: 1,000
 * cells of 8,000-character formulas (889 references each, 7.7 MB — under both read caps) resolved as one
 * batch of 889,000 references ran out of a 128 MB heap before the delete was sent. The resolver is wrapped
 * here so every call's size can be measured; the answers are the real ones.
 * Tool output is parsed as JSON, never asserted on whitespace.
 */
import { describe, it, expect, vi } from "vitest";
import { ok, type AnyRec } from "../src/tools/_shared.js";
import { answerGridRead } from "./helpers/sheets-grid.js";

/** Per resolver call: the formula characters it was handed and the references it resolved. */
const calls: { chars: number; refs: number; formulas: number }[] = [];
vi.mock("../src/tools/sheets-analysis.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tools/sheets-analysis.js")>();
  return {
    ...real,
    resolveFormulas: (grids: Parameters<typeof real.resolveFormulas>[0], meta: Parameters<typeof real.resolveFormulas>[1]) => {
      const out = real.resolveFormulas(grids, meta);
      calls.push({
        chars: grids.reduce((n, g) => n + g.formulas.reduce((m, c) => m + (c.formula?.length ?? 0), 0), 0),
        refs: out.reduce((n, f) => n + f.refs.length, 0),
        formulas: out.length,
      });
      return out;
    },
  };
});

const { sheetsTools } = await import("../src/tools/sheets.js");
const { RESOLVE_CHUNK_CHARS, eachResolvedFormula } = await import("../src/tools/sheets-verify.js");

const deleteSheet = sheetsTools.find((t) => t.name === "sheets_delete_sheet")!;
const batchUpdate = sheetsTools.find((t) => t.name === "sheets_batch_update_spreadsheet")!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [] });
const wire = (data: unknown) => JSON.parse(ok(data).content[0].text);

/** No batch may resolve more than this many references: RESOLVE_CHUNK_CHARS of "A1+" is about 33,000. */
const REFS_PER_CALL_MAX = 40_000;

/** A spreadsheet of tab Gone (sheetId 0, 10 x 10 numbers) and tab Calc, one formula per row of column A. */
function spreadsheet(formula: string, rows: number) {
  const gone = Array.from({ length: 10 }, (_, r) => ({ values: Array.from({ length: 10 }, (_, c) => ({ userEnteredValue: { numberValue: r * 10 + c }, effectiveValue: { numberValue: r * 10 + c } })) }));
  const calc = Array.from({ length: rows }, () => ({ values: [{ userEnteredValue: { formulaValue: formula }, effectiveValue: { numberValue: 1 } }] }));
  const before = { sheets: [{ properties: { sheetId: 0, title: "Gone" }, data: [{ rowData: gone }] }, { properties: { sheetId: 1, title: "Calc" }, data: [{ rowData: calc }] }] };
  const meta = {
    sheets: [
      { properties: { sheetId: 0, title: "Gone", gridProperties: { rowCount: 10, columnCount: 10 } } },
      { properties: { sheetId: 1, title: "Calc", gridProperties: { rowCount: rows, columnCount: 26 } } },
    ],
  };
  let deleted = false;
  const posts: AnyRec[] = [];
  const g: any = {
    get: async (_url: string, params: AnyRec) => (params?.includeGridData ? answerGridRead(params, deleted ? { sheets: [before.sheets[1]] } : before) : meta),
    post: async (_url: string, body: AnyRec) => {
      posts.push(body);
      if (body.requests?.[0]?.deleteSheet) deleted = true;
      return { replies: body.requests.map(() => ({})) };
    },
  };
  return { g, posts };
}

// 889 references to a cell of the tab being deleted: 8,000 characters. 1,000 of them are 7.7 MB of formula text.
const readsGone = "=" + Array.from({ length: 889 }, () => "Gone!B12").join("+");
// 16,333 references on its own tab: 49,000 characters, just under Google's 50,000-character cell limit.
const dense = "=" + Array.from({ length: 16_333 }, () => "A1").join("+");

describe("formula references are resolved in batches bounded by characters, not only by cells", () => {
  it("sheets_delete_sheet (default post_check) over 1,000 formulas of 889 references each: no batch over 40,000 references", async () => {
    calls.length = 0;
    const { g, posts } = spreadsheet(readsGone, 1_000);
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(r).toMatchObject({ deleted: true, sheet: "Gone", postCheck: { sheets: ["Calc"], errorCount: 0, ok: true } });
    expect(posts.map((b) => b.requests[0])).toEqual([{ deleteSheet: { sheetId: 0 } }]);
    // Every formula was resolved, once.
    expect(calls.reduce((n, c) => n + c.formulas, 0)).toBe(1_000);
    expect(calls.reduce((n, c) => n + c.refs, 0)).toBe(889_000);
    // One batch of all 1,000 cells resolved 889,000 references at once: 22 times this budget.
    expect(Math.max(...calls.map((c) => c.refs))).toBeLessThanOrEqual(REFS_PER_CALL_MAX);
    expect(Math.max(...calls.map((c) => c.chars))).toBeLessThanOrEqual(RESOLVE_CHUNK_CHARS);
  });

  it("sheets_delete_sheet over 40 cells of 49,000-character formulas (16,333 references each): no batch over 40,000 references", async () => {
    calls.length = 0;
    const { g } = spreadsheet(dense, 40);
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(r).toMatchObject({ deleted: true, sheet: "Gone", postCheck: { errorCount: 0, ok: true } });
    expect(calls.reduce((n, c) => n + c.refs, 0)).toBe(40 * 16_333);
    // Before: 653,320 references in one batch, 16 times this budget.
    expect(Math.max(...calls.map((c) => c.refs))).toBeLessThanOrEqual(REFS_PER_CALL_MAX);
  });

  it("a dry run's deleteSheet preview over the same 1,000 formulas counts them all, within the same budget", async () => {
    calls.length = 0;
    const { g, posts } = spreadsheet(readsGone, 1_000);
    const args = { spreadsheet_id: "sid", requests: [{ deleteSheet: { sheetId: 0 } }], dry_run: true, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false };
    const r = wire(await batchUpdate.handler(args, ctx(g)));
    expect(posts).toEqual([]);
    expect(r.requests[0].preview).toMatchObject({ dependentFormulas: 1_000, refErrors: 1_000 });
    expect(Math.max(...calls.map((c) => c.refs))).toBeLessThanOrEqual(REFS_PER_CALL_MAX);
  });

  it("eachResolvedFormula keeps every formula once, in order: at most 1,000 short cells a batch, a formula longer than the budget alone", () => {
    const cell = (row: number, formula: string) => ({ row, col: 1, formula });
    const short = Array.from({ length: 2_500 }, (_, i) => cell(i + 1, `=A${i + 1}`));
    const long = "=" + "B1+".repeat(40_000) + "B1"; // 120,003 characters, over the budget on its own
    const grid = { title: "T", sheetId: 0, cells: new Map(), formulas: [...short, cell(2_501, long), cell(2_502, "=C1"), cell(2_503, "=C2")], maxRow: 2_503, maxCol: 1 } as any;
    const meta = { titles: new Map([[0, "T"]]), ids: new Map([["T", 0]]), grids: new Map(), namedRanges: [] } as any;
    const sizes: number[] = [];
    const resolve = (grids: any[]) => {
      sizes.push(grids[0].formulas.length);
      return grids[0].formulas.map((c: any) => ({ cell: `T!A${c.row}`, sheet: "T", row: c.row, col: c.col, formula: c.formula, refs: [] }));
    };
    const rows = [...eachResolvedFormula([grid], meta, resolve)].map((f) => f.row);
    expect(rows).toEqual(Array.from({ length: 2_503 }, (_, i) => i + 1));
    expect(sizes).toEqual([1_000, 1_000, 500, 1, 2]);
  });
});

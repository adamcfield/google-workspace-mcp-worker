/**
 * The benchmark file itself, and the scoring built on it.
 *
 * A labeled benchmark is only worth the labels: a case naming a tool that does not exist, or a
 * duplicate id quietly overwriting another case, turns a passing score into a number that means
 * nothing. These checks run in CI so the file cannot rot against the catalog it scores.
 */

import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/tools/_groups.js";
import cases from "./../bench/jev/cases.json" with { type: "json" };
// @ts-expect-error — the scorer is plain JavaScript shared with scripts/jev-bench.mjs.
import { scoreCase, scoreRun } from "./../bench/jev/score.mjs";

const names = new Set(ALL_TOOLS.map((t) => t.name));
const writeNames = new Set(ALL_TOOLS.filter((t) => t.write).map((t) => t.name));
const isWrite = (name: string) => writeNames.has(name);
const KINDS = ["single", "multi", "ambiguous", "mutation"];

describe("the benchmark file", () => {
  it("holds between 50 and 100 cases", () => {
    expect(cases.cases.length).toBeGreaterThanOrEqual(50);
    expect(cases.cases.length).toBeLessThanOrEqual(100);
  });

  it("covers every case kind, with mutation cases well represented", () => {
    const counts = new Map(KINDS.map((k) => [k, cases.cases.filter((c) => c.kind === k).length]));
    for (const kind of KINDS) expect(counts.get(kind), kind).toBeGreaterThanOrEqual(10);
  });

  it("covers both languages the server is used in", () => {
    for (const lang of ["en", "he"]) expect(cases.cases.filter((c) => c.lang === lang).length, lang).toBeGreaterThanOrEqual(5);
  });

  it("gives every case a unique id and a non-empty request", () => {
    const ids = cases.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases.cases) expect(c.request.trim().length, c.id).toBeGreaterThan(0);
  });

  it("names only tools that exist", () => {
    for (const c of cases.cases) {
      for (const name of [...c.required.flat(), ...c.forbidden]) expect(names.has(name), `${c.id} names ${name}`).toBe(true);
    }
  });

  it("never requires and forbids the same tool in one case", () => {
    for (const c of cases.cases) {
      const forbidden = new Set(c.forbidden);
      for (const name of c.required.flat()) expect(forbidden.has(name), `${c.id}: ${name}`).toBe(false);
    }
  });

  it("carries no addresses or domains outside the documentation-reserved ones", () => {
    // The repository is public. A benchmark is exactly the kind of file where a real address gets
    // left behind, so the rule is checked rather than remembered.
    const text = JSON.stringify(cases);
    for (const address of text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []) expect(address, address).toMatch(/@example\.(com|org|net)$/);
  });
});

describe("scoring", () => {
  const testCase = { id: "T1", kind: "multi", lang: "en", request: "r", required: [["a", "b"], ["c"]], forbidden: ["d"] };

  it("counts a slot as recalled when any one of its interchangeable tools was selected", () => {
    const row = scoreCase(testCase, { tools: ["b", "c"] }, () => false);
    expect(row.recalledSlots).toBe(2);
    expect(row.missedSlots).toEqual([]);
  });

  it("scores a partly answered multi-step request below a fully answered one", () => {
    const partial = scoreCase(testCase, { tools: ["a"] }, () => false);
    expect(partial.recalledSlots).toBe(1);
    expect(partial.slots).toBe(2);
    expect(partial.missedSlots).toEqual([["c"]]);
  });

  it("reports a forbidden selection rather than folding it into a score", () => {
    const row = scoreCase(testCase, { tools: ["a", "c", "d"] }, () => false);
    expect(row.forbiddenSelected).toEqual(["d"]);
    expect(scoreRun([row]).pass).toBe(false);
  });

  it("derives the mutation subset from the catalog, not from the case's own label", () => {
    // A case labeled `multi` whose second step writes still has to clear the mutation gate.
    const writing = { ...testCase, required: [["gmail_search_messages"], ["gmail_send_message"]] };
    const row = scoreCase(writing, { tools: ["gmail_search_messages"] }, isWrite);
    expect(row.mutating).toBe(true);
    const report = scoreRun([row]);
    expect(report.mutation.cases).toBe(1);
    expect(report.mutation.recall).toBe(0.5);
    expect(report.pass).toBe(false);
  });

  it("passes only when mutation recall is complete and nothing forbidden was selected", () => {
    const writing = { ...testCase, required: [["gmail_send_message"]], forbidden: ["gmail_trash_message"] };
    const row = scoreCase(writing, { tools: ["gmail_send_message"] }, isWrite);
    const report = scoreRun([row], { catalogTokens: 1000 });
    expect(report.mutation.recall).toBe(1);
    expect(report.pass).toBe(true);
  });

  it("counts a selected tool that answers no slot as an extra", () => {
    const row = scoreCase(testCase, { tools: ["a", "c", "zzz"] }, () => false);
    expect(row.extraTools).toBe(1);
  });
});

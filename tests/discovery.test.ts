/**
 * Discovery regression set (instruction 7, finding 2).
 *
 * The manual QA acceptance pass needed re-queries to reach five tools whose keywords it had
 * already typed correctly — every one of them a case where a SAME-GROUP sibling answered first.
 * This pins what the deterministic router does with those requests so the recall cannot quietly
 * regress, and prints the whole table when it does.
 *
 * What this measures, and what it does not: `route()` is this server's own ranking, the one
 * `google_select_tools` and the mutation gate are built on. It is NOT the client-side tool search
 * that produced the QA misses — that runs inside the client, over the tool names and descriptions
 * in `tools/list`, and cannot be measured from here. What the two share is the metadata: the
 * names, the routing copy and the descriptions this repository controls. So the set is honest
 * about being a proxy, and it is the only proxy that is reproducible in CI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS } from "../src/tools/index.js";
import { buildManifest } from "../src/tools/_manifest.js";
import { route } from "../src/tools/_router.js";

interface Case {
  query: string;
  required: string;
  qa?: string;
  sibling_of?: string;
}

const { cases } = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/discovery-cases.json", import.meta.url)), "utf8")) as { cases: Case[] };
const MANIFEST = buildManifest(ALL_TOOLS, new Set(ALL_TOOLS.map((t) => t.name)));

/** 0-based rank of the required tool in the router's candidates, or -1 when it is absent. */
function rankOf(c: Case): { rank: number; got: string[] } {
  const got = route(c.query, MANIFEST, { limit: 10 }).candidates.map((x) => x.name);
  return { rank: got.indexOf(c.required), got };
}

/**
 * The floors this PR measured. They are floors, not targets: raising one is a win that should be
 * committed with the change that earned it, and lowering one needs a reason in the PR body.
 */
export const RECALL_FLOOR = { at1: 20, at5: 22, total: 22 } as const;

describe("tool discovery", () => {
  it("every case names a real tool, and no case is a duplicate", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const c of cases) {
      expect(names.has(c.required), `${c.required} is not a tool`).toBe(true);
      if (c.sibling_of) expect(names.has(c.sibling_of), `${c.sibling_of} is not a tool`).toBe(true);
    }
    expect(new Set(cases.map((c) => c.query)).size).toBe(cases.length);
    expect(cases.length).toBe(RECALL_FLOOR.total);
  });

  it("finds every required tool inside the exposed set", () => {
    // Top 5 is the number that matters in practice: `selectTools` exposes at most 14 schemas and
    // the prefilter keeps 10 from the whole-catalog pass, so a tool outside the top few is a tool
    // the model never sees.
    const misses = cases.filter((c) => {
      const { rank } = rankOf(c);
      return rank < 0 || rank >= 5;
    });
    if (misses.length) {
      for (const c of misses) {
        const { rank, got } = rankOf(c);
        console.log(`${rank < 0 ? "MISS" : `rank ${rank + 1}`}  "${c.query}" wanted ${c.required}, got ${got.slice(0, 5).join(", ")}`);
      }
    }
    expect(misses.map((c) => `${c.query} → ${c.required}`)).toEqual([]);
  });

  it("answers with the right sibling first, for at least as many cases as when this was measured", () => {
    const hits = { at1: 0, at5: 0 };
    const table: string[] = [];
    for (const c of cases) {
      const { rank, got } = rankOf(c);
      if (rank === 0) hits.at1 += 1;
      if (rank >= 0 && rank < 5) hits.at5 += 1;
      table.push(`${rank < 0 ? "MISS   " : `rank ${rank + 1} `} ${c.required.padEnd(28)} ← ${c.query}  [${got.slice(0, 3).join(", ")}]`);
    }
    if (hits.at1 < RECALL_FLOOR.at1) console.log(table.join("\n"));
    expect(hits.at5, "recall@5").toBeGreaterThanOrEqual(RECALL_FLOOR.at5);
    expect(hits.at1, "recall@1 dropped below the measured floor").toBeGreaterThanOrEqual(RECALL_FLOOR.at1);
  });
});

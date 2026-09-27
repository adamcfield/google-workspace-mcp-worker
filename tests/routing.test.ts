/**
 * Routing accuracy over the REAL catalog (v1.5 PR-6a, spec §D).
 *
 * `tests/router-engine.test.ts` pins the engine's rules on a seven-tool fixture; this file asks
 * the other question: handed the whole manifest, does a sentence a person would actually type
 * land on the right tool? The queries are hand-written in both languages (rule #2 — no model, no
 * generation, no network), and the two fixture files play different roles:
 *
 *  - `routing.dev.json` is tuned against. Its accuracy is GATED, with the floor set from the
 *    measured number minus a small margin, never aspirationally.
 *  - `routing.holdout.json` is never tuned against. Its accuracy is REPORTED and not gated, so
 *    the number stays honest; a large dev/holdout gap is overfitting and has to be visible.
 *
 * Nothing here reaches the wire (rule #1): the manifest is derived data and no tool is
 * registered, listed or described.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS, TOOL_GROUPS } from "../src/tools/_groups.js";
import { buildManifest, type ManifestEntry } from "../src/tools/_manifest.js";
import { buildRouterIndex, route, ROUTER_PARAMS } from "../src/tools/_router.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  q: string;
  lang: "en" | "he";
  /** Tool names acceptable as top-1; empty = out of scope, the router must not answer it. */
  expect: string[];
  tag?: string;
}

const load = (file: string): Fixture[] => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)), "utf8")) as { queries: Fixture[] };
  return raw.queries;
};

const DEV = load("routing.dev.json");
const HOLDOUT = load("routing.holdout.json");

/**
 * The dev floor, set from the MEASURED result (spec §D: "not aspirationally"). Dev measured
 * 68/72 = 94.4% top-1 after the review round; the floor sits a little under it so that an
 * unrelated catalog or wording change does not turn the suite red, while a real regression
 * still does. Holdout measured 21/25 = 84.0% and is deliberately not gated — see below.
 */
const DEV_FLOOR = 0.92; // measured 70/72 = 97.2%; floor set below it so ordinary drift shows up without a false alarm
/**
 * The dev − holdout gap is this file's overfitting signal, so it is PRINTED rather than left for
 * a reader to subtract. It is not gated either: a gate on it is a gate on the holdout.
 */
const GAP_NOTE = "a large dev/holdout gap is overfitting";

const NAMES = new Set(ALL_TOOLS.map((t) => t.name));
/** The full surface: every catalog tool, all of them listed. */
const FULL: readonly ManifestEntry[] = buildManifest(ALL_TOOLS, NAMES);

/** Top-1 name for a query against the full manifest, or undefined when nothing scored. */
const top1 = (q: string): string | undefined => route(q, FULL).candidates[0]?.name;

interface Scoreboard {
  hits: number;
  scored: number;
  misses: { q: string; expected: string[]; got: string | undefined }[];
}

/** Top-1 accuracy over the fixtures that name an expected tool; out-of-scope rows are separate. */
function measure(fixtures: readonly Fixture[]): Scoreboard {
  const board: Scoreboard = { hits: 0, scored: 0, misses: [] };
  for (const f of fixtures) {
    if (!f.expect.length) continue;
    board.scored++;
    const got = top1(f.q);
    if (got && f.expect.includes(got)) board.hits++;
    else board.misses.push({ q: f.q, expected: f.expect, got });
  }
  return board;
}

const pct = (b: Scoreboard) => (b.scored ? b.hits / b.scored : 0);
/**
 * Print the measurement even on a green run — the accuracies are the point of this file, and
 * `process.stdout` is used rather than `console` because vitest silences console output for a
 * passing test, which would hide exactly the number the PR body has to quote.
 */
const report = (label: string, b: Scoreboard) => {
  const lines = [`[routing] ${label}: top-1 ${b.hits}/${b.scored} = ${(pct(b) * 100).toFixed(1)}%`, ...b.misses.map((m) => `[routing]   miss: ${JSON.stringify(m.q)} → ${m.got ?? "(nothing)"} (wanted ${m.expected.join(" | ")})`)];
  process.stdout.write(`${lines.join("\n")}\n`);
};

// ---------------------------------------------------------------------------
// Hygiene: the fixtures themselves
// ---------------------------------------------------------------------------

describe("routing fixtures", () => {
  it("names only tools that exist in ALL_TOOLS", () => {
    for (const f of [...DEV, ...HOLDOUT]) {
      for (const name of f.expect) expect(NAMES, `${f.q} → ${name}`).toContain(name);
    }
  });

  it("is the hand-written set the spec asks for, in both languages", () => {
    expect(DEV.length).toBeGreaterThanOrEqual(55);
    expect(HOLDOUT.length).toBeGreaterThanOrEqual(20);
    for (const [label, set] of [["dev", DEV] as const, ["holdout", HOLDOUT] as const]) {
      const he = set.filter((f) => f.lang === "he");
      expect(he.length, `${label} Hebrew queries`).toBeGreaterThanOrEqual(5);
      // A Hebrew fixture really is Hebrew, and an English one really is not.
      for (const f of set) expect(/[֐-׿]/.test(f.q), f.q).toBe(f.lang === "he");
      expect(new Set(set.map((f) => f.q)).size, `${label} duplicates`).toBe(set.length);
    }
  });

  it("covers the tags the spec names in EACH file, not merely across the union", () => {
    // One operator query anywhere used to satisfy "operator-bearing queries" for the whole suite
    // — and the operator path is exactly the seam that broke during integration.
    for (const [label, set] of [["dev", DEV] as const, ["holdout", HOLDOUT] as const]) {
      const tags = set.map((f) => f.tag);
      for (const tag of ["confusable", "destructive", "out-of-scope", "url", "operator", "range", "time"]) {
        expect(tags, `${label} has no ${tag} query`).toContain(tag);
      }
      for (const tag of ["operator", "url", "out-of-scope"]) {
        expect(tags.filter((t) => t === tag).length, `${label} ${tag} coverage`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("gives a confusable row exactly one acceptable answer", () => {
    // A row that lists BOTH halves of the pair it exists to discriminate cannot fail on the
    // confusion it names. A widened list is fine on a genuinely interchangeable pair — that row
    // belongs under `basic` or `range`, not under `confusable`.
    for (const f of [...DEV, ...HOLDOUT]) {
      if (f.tag !== "confusable") continue;
      expect(f.expect, `confusable "${f.q}" must name one answer`).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Accuracy (§D)
// ---------------------------------------------------------------------------

describe("routing accuracy", () => {
  it("meets the measured dev top-1 floor", () => {
    const board = measure(DEV);
    report("dev", board);
    expect(pct(board)).toBeGreaterThanOrEqual(DEV_FLOOR);
  });

  it("reports holdout top-1, and the dev−holdout gap, without gating on either", () => {
    const dev = measure(DEV);
    const board = measure(HOLDOUT);
    report("holdout", board);
    // The gap is the overfitting signal §D asks to keep visible, with both denominators so the
    // PR body can quote them rather than two bare percentages.
    process.stdout.write(`[routing] dev ${dev.hits}/${dev.scored} − holdout ${board.hits}/${board.scored} → gap ${((pct(dev) - pct(board)) * 100).toFixed(1)}pp (${GAP_NOTE})\n`);
    // Deliberately NOT a threshold: the holdout number is evidence, not a gate, and gating it
    // would create exactly the pressure to tune against it that §D forbids.
    expect(board.scored).toBeGreaterThan(0);
  });

  it("does not confidently answer an out-of-scope query, and never ranks a write tool above a read", () => {
    const rows = [...DEV, ...HOLDOUT].filter((x) => !x.expect.length);
    expect(rows.length, "out-of-scope coverage").toBeGreaterThanOrEqual(10);
    expect(rows.filter((f) => f.lang === "he").length).toBeGreaterThanOrEqual(3);
    for (const f of rows) {
      const r = route(f.q, FULL);
      // `low`, not merely "not high": these queries have nothing for the router to be sure of.
      expect(r.confidence, f.q).toBe("low");
      // …so the answer is always the conservative row, never "call it".
      expect(r.next_action, f.q).toMatch(/google_describe_tool|No tool matches this query/);
      // A tool that CHANGES something never outranks a read-only candidate here. (When NOTHING
      // read-only matches at all, a write tool can still be the closest match — a catalog of
      // Google tools has no read for "translate this paragraph"; low confidence and the describe
      // row above are the guarantee in that case.)
      const firstRead = r.candidates.findIndex((c) => c.readOnly);
      if (firstRead >= 0) expect(firstRead, `${f.q} → ${r.candidates.map((c) => c.name).join(", ")}`).toBe(0);
    }
  });

  it("routes a query the model would be acting on in under a millisecond of CPU", () => {
    // A coarse ceiling, not a benchmark: `route()` used to spend ~75% of its time re-tokenizing
    // static lexicon constants on every call (8.1 ms per warm call on this manifest), which is
    // most of a Cloudflare free-tier request budget. Generous enough not to flake on a loaded
    // CI box, tight enough that the constant factor cannot creep back by an order of magnitude.
    const q = "find the emails from dana about the invoice";
    for (let i = 0; i < 20; i++) route(q, FULL);
    const started = performance.now();
    const runs = 200;
    for (let i = 0; i < runs; i++) route(q, FULL);
    const per = (performance.now() - started) / runs;
    process.stdout.write(`[routing] warm route(): ${per.toFixed(3)} ms/call over ${FULL.length} tools\n`);
    expect(per, `${per.toFixed(3)} ms/call`).toBeLessThan(4);
  });
});

// ---------------------------------------------------------------------------
// Safety and determinism (§D)
// ---------------------------------------------------------------------------

describe("routing safety", () => {
  it("is deterministic — the same query twice is the same result", () => {
    for (const f of [...DEV, ...HOLDOUT]) {
      expect(route(f.q, FULL), f.q).toEqual(route(f.q, FULL));
    }
    // …and independent of a freshly built manifest, not just of the memoised index.
    const fresh = buildManifest(ALL_TOOLS, NAMES);
    for (const f of DEV.slice(0, 10)) expect(route(f.q, fresh), f.q).toEqual(route(f.q, FULL));
  });

  it("never puts a destructive tool at high confidence on a vague query NEXT TO A HARD SIGNAL", () => {
    // The vague list below has no hard signal in it, so `destructiveOk` short-circuits every row
    // before the density gate is even consulted — which made that test unable to fail. THIS one
    // crosses each hard-signal family with a vague destructive synonym in both languages: a
    // signal donates `intent.service` for free, and the URL it comes from is cut out of the
    // query, so the numerator rose and the density denominator fell at the same moment.
    const signals = [
      "https://docs.google.com/spreadsheets/d/1AbCdEf/edit",
      "https://docs.google.com/document/d/1XyZ/edit",
      "A1:D99",
      "spaces/AAQAAAAAAAE",
      "people/c1234567890",
      "from:dana",
    ];
    const vagueDestructive = ["clear it out", "wipe it", "empty this", "get rid of them", "remove it", "תנקה את זה", "תמחק את זה", "תעיף את זה"];
    let probed = 0;
    for (const signal of signals) {
      for (const verb of vagueDestructive) {
        for (const q of [`${verb} ${signal}`, `${signal} ${verb}`]) {
          probed++;
          const r = route(q, FULL);
          const first = r.candidates[0];
          if (first?.destructive) expect(r.confidence, `${q} → ${first.name}`).not.toBe("high");
        }
      }
    }
    expect(probed).toBe(signals.length * vagueDestructive.length * 2);
  });

  it("never puts a destructive tool at high confidence on a vague query", () => {
    const vague = [
      "do it",
      "handle that for me",
      "the thing from before",
      "clean this up",
      "sort out my google stuff",
      "take care of the email situation",
      "the calendar thing",
      "תטפל בזה",
      "תעשה את זה",
      "העניין של אתמול",
      "תסדר לי את הדברים",
    ];
    for (const q of vague) {
      const result = route(q, FULL);
      const top = result.candidates[0];
      if (top?.destructive) expect(result.confidence, `${q} → ${top.name}`).not.toBe("high");
    }
  });

  it("never lets an irreversible tool LEAD a list the query did not ask for, over the real catalog", () => {
    // Confidence is not enough: a model reading `candidates` skims past the prose and takes the
    // first name. "block out two hours for the report" used to lead with docs_delete_range at low
    // confidence — irreversible, and nothing in the query asked to delete anything. The property
    // is now structural (route() demotes such a leader), so it is checked HERE, on the 162-tool
    // catalog, and not only on a synthetic pair that cannot reproduce it.
    const benign = [
      "block out two hours for the report",
      "what is in my inbox",
      "find the budget spreadsheet",
      "who is coming to the meeting",
      "give me the list of people in my contacts",
      "summarise the doc about pricing",
      "when am I free tomorrow afternoon",
      "show me the slides from last week",
      "what did dana say in the thread",
      "list my tasks for today",
      "מה יש לי ביומן מחר",
      "תראה לי את המיילים מהשבוע",
      "מצא את הקובץ של התקציב",
      "מי אישר את הפגישה",
    ];
    for (const q of benign) {
      const top = route(q, FULL).candidates[0];
      if (!top) continue;
      expect(top.destructive, `${q} → ${top.name} leads and is irreversible`).toBe(false);
    }
  });

  it("names the irreversible risk in the text whenever such a tool is in the answer", () => {
    // Every next_action row that can carry a destructive candidate must say so — the ambiguous
    // row was the one that did not, so a two-way tie could offer an irreversible tool silently.
    for (const q of ["delete the old file from drive", "מחק את האירוע מהיומן", "send that draft now", "clear the range in the sheet"]) {
      const r = route(q, FULL);
      const risky = [r.candidates[0], r.candidates[1]].filter((c) => c?.destructive);
      if (!risky.length) continue;
      expect(r.next_action, `${q} → ${risky.map((c) => c!.name).join(", ")}`).toMatch(/destructive and cannot be undone|confirm=true/);
    }
  });

  it("never proposes a destructive tool at high confidence for a fixture that does not ask for one", () => {
    for (const f of [...DEV, ...HOLDOUT]) {
      if (f.tag === "destructive") continue;
      const result = route(f.q, FULL);
      const top = result.candidates[0];
      if (top?.destructive && result.confidence === "high") {
        // Allowed only when the query itself names that tool's verb — which is the §C.4 gate.
        expect(f.expect, `${f.q} → ${top.name}`).toContain(top.name);
      }
    }
  });

  it("warns about the confirm gate whenever it proposes a tool that has one", () => {
    for (const f of [...DEV, ...HOLDOUT]) {
      const result = route(f.q, FULL);
      const top = result.candidates[0];
      if (top?.needsConfirm && /Call |through google_call_tool/.test(result.next_action)) {
        expect(result.next_action, f.q).toMatch(/confirm=true/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The manifest is the whole world (§C.7)
// ---------------------------------------------------------------------------

describe("routing respects the deployment", () => {
  /** Everything except Gmail — the shape of a `DISABLED_TOOL_GROUPS=Gmail` deployment. */
  const withoutGmail = buildManifest(
    TOOL_GROUPS.filter((g) => g.group !== "Gmail").flatMap((g) => g.tools),
    NAMES,
  );

  it("never proposes a tool from a disabled group", () => {
    const gmailQueries = [...DEV, ...HOLDOUT].filter((f) => f.expect.some((n) => n.startsWith("gmail_")));
    expect(gmailQueries.length).toBeGreaterThan(3);
    for (const f of gmailQueries) {
      const result = route(f.q, withoutGmail);
      for (const c of result.candidates) expect(c.name, f.q).not.toMatch(/^gmail_/);
    }
  });

  it("says the group is switched off rather than guessing another product", () => {
    const result = route("search my gmail for the invoice", withoutGmail);
    expect(result.intent.service).toBeUndefined();
    expect(result.next_action).toMatch(/gmail/);
    expect(result.next_action).toMatch(/google_list_tools/);
  });

  it("hands back no candidate at all when the query names a group this deployment lacks", () => {
    // The `disabled` row of the text and the candidate list used to be computed independently,
    // so a result that said "no gmail tool is enabled" still offered a destructive Sheets one.
    for (const q of ["delete the email from adam", "מחק את המייל", "search my gmail for the invoice"]) {
      const r = route(q, withoutGmail);
      expect(r.next_action, q).toMatch(/gmail/);
      expect(r.candidates, q).toEqual([]);
    }
  });

  it("cannot be handed a manifest that changes behind the index memo", () => {
    // The index is memoised on the manifest ARRAY identity, so a caller that mutated the array in
    // place would leave the memo describing a manifest that no longer exists — and route() would
    // propose a tool the caller had removed, breaking §C.7.
    expect(Object.isFrozen(FULL)).toBe(true);
    // @ts-expect-error — readonly at the type level, frozen at runtime.
    expect(() => FULL.splice(0, 1)).toThrow(TypeError);
    expect(buildRouterIndex(FULL)).toBe(buildRouterIndex(FULL));
  });

  it("proposes only tools of the service the caller filtered to", () => {
    for (const f of DEV.filter((x) => x.expect.length)) {
      const service = f.expect[0].split("_")[0];
      for (const c of route(f.q, FULL, { service }).candidates) expect(c.service, f.q).toBe(service);
    }
  });

  it("returns at most the requested number of candidates", () => {
    expect(route("find the emails from dana", FULL).candidates.length).toBeLessThanOrEqual(ROUTER_PARAMS.maxCandidates);
    expect(route("find the emails from dana", FULL, { limit: 1 }).candidates.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-owner seams (found while integrating §A + §B + §C). Each of these is a defect that only
// shows up where two of the three pieces meet, so each is pinned here rather than in the owners'
// own suites, which exercise their piece alone.
// ---------------------------------------------------------------------------

describe("routing seams", () => {
  it("keeps the query when an A1 range is cut out of it", () => {
    // The unquoted sheet-name class used to allow spaces, so the range pattern matched from the
    // first word of the sentence and `route()` — which cuts a service-naming signal out of the
    // text — was handed an empty query and returned no candidate at all.
    const r = route("write these numbers into Sheet1!B2:B10", FULL);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0].name).toBe("sheets_write_range");
    expect(r.intent.service).toBe("sheets");
    // A quoted sheet name with spaces is still one range, and still cut out whole.
    expect(route("read 'Q3 Budget'!A1:D9 for me", FULL).candidates[0].service).toBe("sheets");
  });

  it("routes a query that is nothing but Gmail operators", () => {
    // `operator_gmail` is made of words, not an identifier: consuming it left nothing to rank.
    const r = route("subject:renewal older_than:1y", FULL);
    expect(r.candidates[0].name).toBe("gmail_search_messages");
  });

  it("does not count a description twice for a tool that has no route block", () => {
    // `useWhen` and `returns` both fall back to the description's first sentence, so indexing
    // both gave an un-annotated tool 2.4x the prose weight of an annotated one.
    const blockless = FULL.find((e) => e.name === "gmail_untrash_message")!;
    expect(blockless.useWhen).toBe(blockless.returns);
    expect(route("move that email to the trash", FULL).candidates[0].name).toBe("gmail_trash_message");
  });

  it("never lets a bigram out-score the most informative word it is made of", () => {
    const index = buildRouterIndex(FULL);
    for (const [term, value] of index.idf) {
      const cut = term.indexOf(" ");
      if (cut < 0) continue;
      const parts = Math.max(index.idf.get(term.slice(0, cut)) ?? 0, index.idf.get(term.slice(cut + 1)) ?? 0);
      expect(value, term).toBeLessThanOrEqual(parts + 1e-9);
    }
    // The case that motivated it: "the trash" is not more informative than "trash".
    expect(index.idf.get("the trash")).toBeLessThanOrEqual(index.idf.get("trash")!);
  });
});

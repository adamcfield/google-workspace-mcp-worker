/**
 * The routing manifest (v1.5 PR-6a, spec §A). Nothing here touches the wire: the manifest is
 * derived data the router scores against, so these tests pin the derivation (names, groups,
 * required/optional, the description fallback), the purity of `buildManifest`, and the shape
 * of the hand-written `ROUTE_BLOCKS` table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ALL_TOOLS, TOOL_GROUPS } from "../src/tools/_groups.js";
import { COMPACT_TOOL_NAMES, META_ALWAYS } from "../src/tools/surface.js";
import { NAME_EXEMPTIONS, parseToolName } from "../src/tools/naming.js";
import { tool, type ToolDef } from "../src/tools/_shared.js";
import { ALL_GROUP_HINTS } from "../src/tools/_group-hints.js";
import { buildManifest, firstSentence, groupOf, GROUP_HINTS, MAX_FALLBACK_CHARS, MAX_USE_WHEN_CHARS, ROUTE_BLOCKS, type ManifestEntry } from "../src/tools/_manifest.js";
import { FUNCTION_WORDS } from "../src/tools/_lexicon.js";
import { tokenize } from "../src/tools/_router.js";

const repo = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

const NAMES = new Set(ALL_TOOLS.map((t) => t.name));
const ALL_LISTED = new Set(NAMES);
const MANIFEST = buildManifest(ALL_TOOLS, ALL_LISTED);
const entry = (name: string): ManifestEntry => {
  const hit = MANIFEST.find((e) => e.name === name);
  if (!hit) throw new Error(`no manifest entry for ${name}`);
  return hit;
};
/** group name per tool, straight from the catalog — the independent source the derivation is checked against. */
const GROUP_OF_TOOL = new Map(TOOL_GROUPS.flatMap((g) => g.tools.map((t) => [t.name, g.group] as const)));
/** Every tool name mentioned anywhere in a string. */
const mentioned = (text: string): string[] => [...new Set(text.match(/[a-z]+(?:_[a-z0-9]+)+/g) ?? [])].filter((n) => NAMES.has(n));

describe("buildManifest", () => {
  it("covers every catalog tool, in order", () => {
    expect(MANIFEST.map((e) => e.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("takes service, verb and resource from parseToolName, and never re-parses by hand", () => {
    for (const e of MANIFEST) {
      const parsed = parseToolName(e.name);
      if (parsed) {
        expect({ service: e.service, verb: e.verb, resource: e.resource }, e.name).toEqual(parsed);
        expect(e.resource, e.name).not.toBe("");
      } else {
        // The two grandfathered names (exempt from the grammar until 2.0) stay routable with an empty verb.
        expect(NAME_EXEMPTIONS, e.name).toContain(e.name);
        expect(e.verb, e.name).toBe("");
      }
    }
    expect(entry("google_whoami")).toMatchObject({ service: "google", verb: "", resource: "whoami", group: "Meta" });
    expect(entry("google_api_request")).toMatchObject({ service: "google", verb: "", resource: "api_request" });
    expect(entry("calendar_get_free_busy")).toMatchObject({ service: "calendar", verb: "get", resource: "free_busy" });
    expect(entry("gmail_batch_modify_message_labels")).toMatchObject({ verb: "batch_modify", resource: "message_labels" });
  });

  it("throws on a name that neither parses nor is exempt, instead of skipping it", () => {
    const bogus = tool({ name: "frobnicate", description: "Nope.", input: {}, handler: async () => ({}) });
    expect(() => buildManifest([bogus], new Set())).toThrow(/frobnicate/);
    const unknownVerb = tool({ name: "gmail_frobnicate_thing", description: "Nope.", input: {}, handler: async () => ({}) });
    expect(() => buildManifest([unknownVerb], new Set())).toThrow(/VERB_KINDS/);
  });

  it("derives each tool's catalog group from its service segment", () => {
    for (const e of MANIFEST) expect(e.group, e.name).toBe(GROUP_OF_TOOL.get(e.name));
    expect(new Set(MANIFEST.map((e) => e.group)).size).toBe(TOOL_GROUPS.length);
    expect(groupOf("gmail")).toBe("Gmail");
    expect(groupOf("google")).toBe("Meta");
    // Unknown service: capitalised, never thrown away.
    expect(groupOf("keep")).toBe("Keep");
  });

  it("splits the zod input shape into required and optional keys", () => {
    for (const e of MANIFEST) {
      const def = ALL_TOOLS.find((t) => t.name === e.name)!;
      const keys = Object.keys(def.input);
      expect([...e.required, ...e.optional].sort(), e.name).toEqual([...keys].sort());
      expect(e.required.filter((k) => e.optional.includes(k)), e.name).toEqual([]);
      for (const k of e.optional) expect((def.input[k] as z.ZodType).safeParse(undefined).success, `${e.name}.${k}`).toBe(true);
      for (const k of e.required) expect((def.input[k] as z.ZodType).safeParse(undefined).success, `${e.name}.${k}`).toBe(false);
    }
    expect(entry("sheets_read_range").required).toEqual(["spreadsheet_id", "range"]);
    expect(entry("sheets_read_range").optional).not.toContain("range");
    expect(entry("google_whoami")).toMatchObject({ required: [], optional: [] });
    // A `.default()` is optional on the wire even though the handler always sees a value.
    expect(entry("google_api_request").optional).toContain("confirm");
  });

  it("copies the flags and scope of the definition", () => {
    for (const e of MANIFEST) {
      const def = ALL_TOOLS.find((t) => t.name === e.name)!;
      expect({ write: e.write, destructive: e.destructive, idempotent: e.idempotent }, e.name).toEqual({ write: def.write === true, destructive: def.destructive === true, idempotent: def.idempotent === true });
      expect(e.scope, e.name).toBe(def.scope);
    }
    expect(entry("gmail_send_message")).toMatchObject({ write: true, destructive: true });
    expect(entry("gmail_search_messages")).toMatchObject({ write: false, destructive: false });
  });

  it("marks `listed` from the set it is given, not from the definition", () => {
    const listed = new Set(["gmail_search_messages"]);
    const narrow = buildManifest(ALL_TOOLS, listed);
    expect(narrow.filter((e) => e.listed).map((e) => e.name)).toEqual(["gmail_search_messages"]);
    // Hidden ≠ absent: an unlisted tool stays in the manifest and stays routable (surface.ts).
    expect(narrow).toHaveLength(ALL_TOOLS.length);
    expect(MANIFEST.every((e) => e.listed)).toBe(true);
  });

  it("gives every tool a non-empty useWhen and returns, block or not", () => {
    for (const e of MANIFEST) {
      expect(e.useWhen.length, e.name).toBeGreaterThan(0);
      expect(e.returns.length, e.name).toBeGreaterThan(0);
      expect(e.useWhen.length, e.name).toBeLessThanOrEqual(MAX_FALLBACK_CHARS);
      expect(e.returns.length, e.name).toBeLessThanOrEqual(MAX_FALLBACK_CHARS);
    }
    const unblocked = MANIFEST.filter((e) => !ROUTE_BLOCKS[e.name]);
    expect(unblocked.length).toBeGreaterThan(0);
    for (const e of unblocked) {
      const def = ALL_TOOLS.find((t) => t.name === e.name)!;
      expect(e.useWhen, e.name).toBe(firstSentence(def.description));
      expect(e.returns, e.name).toBe(firstSentence(def.description));
      expect(e.doNotUseWhen, e.name).toBeUndefined();
      expect({ k: e.keywords, h: e.keywordsHe, r: e.related }, e.name).toEqual({ k: [], h: [], r: [] });
    }
    expect(entry("sheets_add_sheet").useWhen).toBe("Add a new tab (sheet) to a spreadsheet.");
    expect(entry("gmail_search_messages").useWhen).toBe(ROUTE_BLOCKS.gmail_search_messages.useWhen);
  });

  it("is pure: same input, deep-equal output, and the definitions are untouched", () => {
    const before = JSON.stringify(ALL_TOOLS.map((t) => ({ n: t.name, k: Object.keys(t.input) })));
    const a = buildManifest(ALL_TOOLS, ALL_LISTED);
    const b = buildManifest(ALL_TOOLS, ALL_LISTED);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Frozen, not merely copied: `_router.ts` memoises its index on the array's identity, so a
    // mutation behind that memo would leave the index describing a manifest that no longer exists.
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0])).toBe(true);
    expect(Object.isFrozen(a[0].keywords)).toBe(true);
    // @ts-expect-error — readonly at the type level; this documents that it is frozen at runtime too.
    expect(() => a[0].keywords.push("mutated")).toThrow(TypeError);
    // @ts-expect-error — the manifest array itself cannot grow or shrink behind the index memo.
    expect(() => a.splice(0, 1)).toThrow(TypeError);
    expect(buildManifest(ALL_TOOLS, ALL_LISTED)[0].keywords).not.toContain("mutated");
    expect(JSON.stringify(ALL_TOOLS.map((t) => ({ n: t.name, k: Object.keys(t.input) })))).toBe(before);
  });

  it("routes only the tools it was given", () => {
    const two: ToolDef<any>[] = ALL_TOOLS.filter((t) => t.name === "gmail_read_message" || t.name === "tasks_list_tasks");
    expect(buildManifest(two, ALL_LISTED).map((e) => e.name)).toEqual(["gmail_read_message", "tasks_list_tasks"]);
    expect(buildManifest([], ALL_LISTED)).toEqual([]);
  });
});

describe("firstSentence", () => {
  it("stops at the first real terminator", () => {
    expect(firstSentence("Alpha beta. Gamma delta.")).toBe("Alpha beta.");
    expect(firstSentence("Only one sentence, no terminator")).toBe("Only one sentence, no terminator");
  });

  it("does not cut at an abbreviation or inside an unclosed parenthesis", () => {
    expect(firstSentence("Create an event from text (e.g. 'lunch tomorrow at 1'). Then more.")).toBe("Create an event from text (e.g. 'lunch tomorrow at 1').");
    expect(firstSentence("Search Drive files (files.list across My Drive + shared drives). More.")).toBe("Search Drive files (files.list across My Drive + shared drives).");
    expect(firstSentence("Do it, i.e. quickly. Next.")).toBe("Do it, i.e. quickly.");
  });

  it("clips an over-long sentence at a word boundary, never past the cap", () => {
    const long = `${"word ".repeat(60)}end.`;
    const clipped = firstSentence(long);
    expect(clipped.length).toBeLessThanOrEqual(MAX_FALLBACK_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toMatch(/\s…$/);
    expect(firstSentence(`${"x".repeat(400)}.`).length).toBeLessThanOrEqual(MAX_FALLBACK_CHARS);
  });
});

describe("ROUTE_BLOCKS", () => {
  const names = Object.keys(ROUTE_BLOCKS);

  it("is the hand-written core set and every key is a real tool", () => {
    for (const n of names) expect(NAMES.has(n), `${n} is not a tool`).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    // Pinned so growing or shrinking the table is always an explicit diff (spec §A.3: ~45).
    // 85 = 79 + sheets_fill_range (separates it from sheets_write_range) + the five Docs editing/comment tools (docs_replace_section, docs_update_paragraph_style, docs_list_comments, docs_create_comment, docs_create_reply).
    expect(names).toHaveLength(85);
    expect(names.length).toBeGreaterThanOrEqual(45);
  });

  it("covers the compact surface, the meta tools and every group", () => {
    for (const n of COMPACT_TOOL_NAMES) expect(names, `compact tool ${n} has no route block`).toContain(n);
    for (const n of META_ALWAYS) expect(names, `meta tool ${n} has no route block`).toContain(n);
    const covered = new Set(names.map((n) => GROUP_OF_TOOL.get(n)));
    expect([...covered].sort()).toEqual(TOOL_GROUPS.map((g) => g.group).sort());
  });

  it("covers every tool the routing fixtures name (§A.3)", () => {
    // §A.3 asks for "every tool named by the routing fixtures", which the compact/meta/group
    // checks above cannot see. Enforced here so the requirement is checked, not remembered.
    const fixture = (file: string): string[] => (JSON.parse(repo(`tests/fixtures/${file}`)) as { queries: { expect: string[] }[] }).queries.flatMap((q) => q.expect);
    for (const n of new Set([...fixture("routing.dev.json"), ...fixture("routing.holdout.json")])) {
      expect(names, `fixture tool ${n} has no route block`).toContain(n);
    }
  });

  it("keeps grammar out of the keyword lists", () => {
    // A keyword made only of function words ("from", "who is") hands a question opener a high IDF
    // and lets it outvote the question — see FUNCTION_WORDS in _lexicon.ts.
    for (const [n, b] of Object.entries(ROUTE_BLOCKS)) {
      for (const k of [...(b.keywords ?? []), ...(b.keywordsHe ?? [])]) {
        const words = tokenize(k).tokens;
        expect(words.length > 0 && words.every((w) => FUNCTION_WORDS.has(w)), `${n}: "${k}" is only function words`).toBe(false);
      }
    }
  });

  it("states useWhen as a short verb phrase", () => {
    // Imperative openers only: a useWhen answers "when do I reach for this", never "this tool is…".
    const IMPERATIVES = new Set(["add", "archive", "call", "cancel", "check", "compose", "copy", "create", "download", "end", "fill", "find", "format", "get", "give", "grant", "inspect", "let", "list", "look", "mark", "move", "overwrite", "post", "put", "read", "remove", "reply", "save", "search", "see", "send", "start", "swap", "write"]);
    for (const [n, b] of Object.entries(ROUTE_BLOCKS)) {
      expect(b.useWhen.length, `${n} useWhen too long`).toBeLessThanOrEqual(MAX_USE_WHEN_CHARS);
      expect(b.useWhen, n).toMatch(/^[a-z][a-z-]+ /);
      expect(IMPERATIVES.has(b.useWhen.split(" ")[0]), `${n}: "${b.useWhen.split(" ")[0]}" is not an imperative opener`).toBe(true);
      expect(b.useWhen.trim(), n).toBe(b.useWhen);
      expect(b.returns?.length ?? 1, n).toBeGreaterThan(0);
    }
  });

  it("points doNotUseWhen at a real sibling tool", () => {
    for (const [n, b] of Object.entries(ROUTE_BLOCKS)) {
      if (!b.doNotUseWhen) continue;
      const siblings = mentioned(b.doNotUseWhen).filter((x) => x !== n);
      expect(siblings.length, `${n}: doNotUseWhen names no existing tool — "${b.doNotUseWhen}"`).toBeGreaterThan(0);
    }
    // Every block in the core set earns its keep by naming an alternative.
    expect(Object.entries(ROUTE_BLOCKS).filter(([, b]) => !b.doNotUseWhen).map(([n]) => n)).toEqual([]);
  });

  it("lists only real, other tools under related", () => {
    for (const [n, b] of Object.entries(ROUTE_BLOCKS)) {
      for (const r of b.related ?? []) {
        expect(NAMES.has(r), `${n} related: ${r} is not a tool`).toBe(true);
        expect(r, `${n} relates to itself`).not.toBe(n);
      }
      expect(new Set(b.related ?? []).size, `${n} has duplicate related`).toBe((b.related ?? []).length);
    }
  });

  it("carries English and Hebrew keywords for every block", () => {
    for (const [n, b] of Object.entries(ROUTE_BLOCKS)) {
      expect(b.keywords?.length ?? 0, `${n} has no English keywords`).toBeGreaterThan(0);
      expect(b.keywordsHe?.length ?? 0, `${n} has no Hebrew keywords`).toBeGreaterThan(0);
      for (const k of b.keywords ?? []) {
        expect(k, `${n}: "${k}" must be lower case`).toBe(k.toLowerCase());
        expect(k.trim(), n).toBe(k);
        expect(k, `${n}: "${k}" repeats the tool name`).not.toBe(n);
      }
      for (const k of b.keywordsHe ?? []) expect(k, `${n}: "${k}" has no Hebrew letters`).toMatch(/[֐-׿]/);
      expect(new Set(b.keywords).size, `${n} has duplicate keywords`).toBe((b.keywords ?? []).length);
      expect(new Set(b.keywordsHe).size, `${n} has duplicate Hebrew keywords`).toBe((b.keywordsHe ?? []).length);
    }
  });
});

describe("GROUP_HINTS", () => {
  it("mirrors the product groups of the catalog (Meta excluded, as google_list_tools reports it separately)", () => {
    expect(GROUP_HINTS.map((g) => [g.group, g.prefix])).toEqual(TOOL_GROUPS.filter((g) => g.group !== "Meta").map((g) => [g.group, g.prefix]));
    for (const g of GROUP_HINTS) expect(g.hint.length, g.group).toBeGreaterThan(20);
  });

  it("is the one list google_list_tools returns, not a second copy of it", () => {
    // It used to be two hand-kept copies, pinned to each other by a string match here. The text
    // never drifted; the numbers around it did. Now meta.ts reads the same leaf module, and what
    // this asserts is that it still holds no copy of its own.
    const src = repo("src/tools/meta.ts");
    expect(src).toContain('from "./_group-hints.js"');
    for (const g of GROUP_HINTS) expect(src, `${g.group} is copied into meta.ts again`).not.toContain(`hint: "${g.hint}"`);
    // And the wire list is those rows plus Meta, which GROUP_HINTS deliberately omits.
    expect(ALL_GROUP_HINTS.map((g) => g.group)).toEqual(["Meta", ...GROUP_HINTS.map((g) => g.group)]);
  });
});

describe("off the wire", () => {
  it("is not imported by anything that registers or lists tools", () => {
    for (const file of ["src/tools/index.ts", "src/tools/_groups.ts", "src/tools/_shared.ts", "src/tools/listing.ts", "src/tools/surface.ts", "src/tools/meta.ts", "src/agent.ts"]) {
      expect(repo(file), `${file} must not depend on the routing manifest`).not.toContain("_manifest.js");
    }
  });
});

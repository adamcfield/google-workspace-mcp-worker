/**
 * The routing lexicon (v1.5 PR-6a, spec §B). Two jobs:
 *  1. COVERAGE — every service, verb and resource the registered tools actually use has an
 *     entry with at least one English AND one Hebrew term, so no tool is unroutable in either
 *     language. The catalog comes from `_groups.ts` (the leaf module), never from `index.ts`.
 *  2. HYGIENE — terms are lowercase, trimmed, unique and in the language they claim; hard
 *     signals are stateless regexes that point at real services/resources.
 * Nothing here touches the wire: the lexicon registers no tool and lists nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS } from "../src/tools/_groups.js";
import { NAME_EXEMPTIONS, parseToolName, VERBS } from "../src/tools/naming.js";
import {
  EN_TERMS,
  FUNCTION_WORDS,
  HARD_SIGNALS,
  HE_TERMS,
  matchHardSignals,
  RESOURCE_LEXICON,
  SERVICE_LEXICON,
  VERB_LEXICON,
  type LexEntry,
} from "../src/tools/_lexicon.js";
import { FUNCTION_TOKENS, tokenize } from "../src/tools/_router.js";

const HEBREW = /[֐-׿]/;

const parsed = ALL_TOOLS.map((t) => ({ name: t.name, parts: parseToolName(t.name) }));
const usedServices = [...new Set(ALL_TOOLS.map((t) => t.name.split("_")[0]!))].sort();
const usedVerbs = [...new Set(parsed.flatMap((p) => (p.parts ? [p.parts.verb as string] : [])))].sort();
const usedResources = [...new Set(parsed.flatMap((p) => (p.parts && p.parts.resource ? [p.parts.resource] : [])))].sort();

const entries = (lex: Readonly<Record<string, LexEntry>>): [string, LexEntry][] => Object.entries(lex);
const allEntries: [string, string, LexEntry][] = [
  ...entries(SERVICE_LEXICON).map(([k, v]) => ["SERVICE", k, v] as [string, string, LexEntry]),
  ...entries(VERB_LEXICON as Readonly<Record<string, LexEntry>>).map(([k, v]) => ["VERB", k, v] as [string, string, LexEntry]),
  ...entries(RESOURCE_LEXICON).map(([k, v]) => ["RESOURCE", k, v] as [string, string, LexEntry]),
];

describe("lexicon coverage", () => {
  it("the fixture set is the real catalog (sanity)", () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(100);
    // Only the decision-4B exemptions may fail to parse.
    const unparsed = parsed.filter((p) => !p.parts).map((p) => p.name);
    expect(unparsed.sort()).toEqual([...NAME_EXEMPTIONS].sort());
  });

  it("every service a registered tool uses has EN and HE terms", () => {
    const missing = usedServices.filter((s) => !SERVICE_LEXICON[s]);
    expect(missing).toEqual([]);
    for (const s of usedServices) {
      expect(SERVICE_LEXICON[s]!.en.length, `${s}.en`).toBeGreaterThan(0);
      expect(SERVICE_LEXICON[s]!.he.length, `${s}.he`).toBeGreaterThan(0);
    }
  });

  it("every verb a registered tool uses has EN and HE terms", () => {
    const missing = usedVerbs.filter((v) => !(VERB_LEXICON as Record<string, LexEntry>)[v]);
    expect(missing).toEqual([]);
    for (const v of usedVerbs) {
      const entry = (VERB_LEXICON as Record<string, LexEntry>)[v]!;
      expect(entry.en.length, `${v}.en`).toBeGreaterThan(0);
      expect(entry.he.length, `${v}.he`).toBeGreaterThan(0);
    }
  });

  it("VERB_LEXICON is keyed by the naming grammar, with no invented verbs", () => {
    expect(Object.keys(VERB_LEXICON).sort()).toEqual([...VERBS].sort());
  });

  it("every verb carries the ת- imperative a Hebrew speaker types at a bot", () => {
    // `תשלח`, `תסמן`, `תנתק` — the form used when ADDRESSING the assistant. Eleven verbs had no
    // ת- form at all, which is why `תסמן את המשימה כבוצעה` could not name the `complete` verb —
    // and a verb is the only key the §C.4 destructive gate has.
    for (const [verb, entry] of Object.entries(VERB_LEXICON)) {
      const imperative = entry.he.filter((t) => /^ת[א-ת]{2,}/.test(t));
      expect(imperative.length, `${verb} has no ת- form in ${JSON.stringify(entry.he)}`).toBeGreaterThan(0);
    }
  });

  it("every resource parseToolName yields has EN and HE terms", () => {
    const missing = usedResources.filter((r) => !RESOURCE_LEXICON[r]);
    expect(missing).toEqual([]);
    for (const r of usedResources) {
      expect(RESOURCE_LEXICON[r]!.en.length, `${r}.en`).toBeGreaterThan(0);
      expect(RESOURCE_LEXICON[r]!.he.length, `${r}.he`).toBeGreaterThan(0);
    }
  });

  it("RESOURCE_LEXICON has no orphan entries", () => {
    const orphans = Object.keys(RESOURCE_LEXICON).filter((r) => !usedResources.includes(r));
    expect(orphans).toEqual([]);
  });

  it("pins today's coverage counts so a catalog change is visible in the diff", () => {
    expect({ services: usedServices.length, verbs: usedVerbs.length, resources: usedResources.length }).toEqual({ services: 14, verbs: 37, resources: 89 }); // verbs +1: `fill` (sheets_fill_range); resources +5: the Docs editing/comment tools
  });
});

describe("lexicon hygiene", () => {
  it("terms are non-empty, trimmed and unique within an entry", () => {
    for (const [kind, key, entry] of allEntries) {
      for (const lang of ["en", "he"] as const) {
        const terms = entry[lang];
        for (const t of terms) {
          expect(t, `${kind} ${key}.${lang}`).toBe(t.trim());
          expect(t.length, `${kind} ${key}.${lang} empty term`).toBeGreaterThan(0);
        }
        expect(new Set(terms).size, `${kind} ${key}.${lang} duplicates`).toBe(terms.length);
      }
    }
  });

  it("English terms are lowercase and carry no Hebrew letters", () => {
    for (const [kind, key, entry] of allEntries) {
      for (const t of entry.en) {
        expect(t, `${kind} ${key}.en not lowercase`).toBe(t.toLowerCase());
        expect(HEBREW.test(t), `${kind} ${key}.en "${t}" has Hebrew letters`).toBe(false);
      }
    }
  });

  it("Hebrew terms actually contain Hebrew letters", () => {
    for (const [kind, key, entry] of allEntries) {
      for (const t of entry.he) expect(HEBREW.test(t), `${kind} ${key}.he "${t}" is not Hebrew`).toBe(true);
    }
  });

  it("no term is made only of function words", () => {
    // A phrase whose every word is grammar ("what is", `מה יש`) is what let a question opener
    // outvote the question: those words are rare across the catalog, so they earn a high IDF.
    for (const [kind, key, entry] of allEntries) {
      for (const lang of ["en", "he"] as const) {
        for (const t of entry[lang]) {
          const words = tokenize(t).tokens;
          expect(words.length > 0 && words.every((w) => FUNCTION_TOKENS.has(w)), `${kind} ${key}.${lang}: "${t}" is only function words`).toBe(false);
        }
      }
    }
    expect(FUNCTION_WORDS.has("what")).toBe(true);
    expect(FUNCTION_WORDS.has("spreadsheet")).toBe(false);
    expect([...FUNCTION_WORDS].some((w) => HEBREW.test(w))).toBe(true);
  });

  it("the term sets gate the tokenizer's folding", () => {
    // Clitic stripping is lexicon-gated: `המייל` strips because `מייל` is a term…
    expect(HE_TERMS.has("מייל")).toBe(true);
    expect(HE_TERMS.has("פגישה")).toBe(true);
    // …and `מחר` survives because its stripped form is not.
    expect(HE_TERMS.has("חר")).toBe(false);
    expect(EN_TERMS.has("spreadsheet")).toBe(true);
    expect(EN_TERMS.has("message")).toBe(true);
    expect([...EN_TERMS].every((t) => !HEBREW.test(t))).toBe(true);
  });

  it("is a leaf module: no manifest, engine or index import", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/tools/_lexicon.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports).toEqual(["./naming.js"]);
  });
});

describe("hard signals", () => {
  it("each signal is keyed by its own id and points at a real service and resources", () => {
    for (const [key, sig] of Object.entries(HARD_SIGNALS)) {
      expect(sig.id).toBe(key);
      expect(sig.note.length).toBeGreaterThan(0);
      if (sig.service) expect(SERVICE_LEXICON[sig.service], `${key} service`).toBeDefined();
      for (const r of sig.resources ?? []) expect(RESOURCE_LEXICON[r], `${key} resource ${r}`).toBeDefined();
    }
  });

  it("no regex is global or sticky (lastIndex would make routing non-deterministic)", () => {
    for (const [key, sig] of Object.entries(HARD_SIGNALS)) {
      expect(sig.re.global, `${key} is /g`).toBe(false);
      expect(sig.re.sticky, `${key} is /y`).toBe(false);
      expect(sig.re.test(""), `${key} matches the empty query`).toBe(false);
    }
  });

  it("recognises the Google document URLs", () => {
    const cases: [string, string][] = [
      ["https://docs.google.com/spreadsheets/d/1AbC_de-F/edit#gid=0", "url_sheets"],
      ["https://docs.google.com/document/d/1AbC_de-F/edit", "url_docs"],
      ["https://docs.google.com/presentation/d/1AbC_de-F/edit", "url_slides"],
      ["https://docs.google.com/forms/d/1AbC_de-F/edit", "url_forms"],
      ["https://forms.gle/abc123", "url_forms"],
      ["https://drive.google.com/drive/folders/1AbC_de-F", "url_drive"],
      ["https://drive.google.com/file/d/1AbC_de-F/view", "url_drive"],
      ["https://mail.google.com/mail/u/0/#inbox/FMfcgz", "url_gmail"],
      ["https://calendar.google.com/calendar/u/0/r/day", "url_calendar"],
      ["https://meet.google.com/abc-defg-hij", "url_meet"],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "url_youtube"],
      ["https://youtu.be/dQw4w9WgXcQ", "url_youtube"],
      ["https://photos.google.com/photo/AF1Qip", "url_photos"],
    ];
    for (const [q, id] of cases) expect(matchHardSignals(q).map((s) => s.id), q).toContain(id);
  });

  it("recognises operators, ranges and resource names", () => {
    expect(matchHardSignals("search from:dana@example.com has:attachment").map((s) => s.id)).toContain("operator_gmail");
    expect(matchHardSignals("קרא את הטווח Sheet1!A1:D20").map((s) => s.id)).toContain("range_a1");
    expect(matchHardSignals("write to A1:D20").map((s) => s.id)).toContain("range_a1");
    expect(matchHardSignals("'Q3 Budget'!B2").map((s) => s.id)).toContain("range_a1");
    expect(matchHardSignals("post to spaces/AAAA1234/messages/xyz.1").map((s) => s.id)).toContain("space_chat");
    expect(matchHardSignals("update people/c1234567890").map((s) => s.id)).toContain("resource_contacts");
    expect(matchHardSignals("share it with dana@example.com").map((s) => s.id)).toContain("address_email");
    expect(matchHardSignals("join abc-defg-hij").map((s) => s.id)).toContain("code_meet");
  });

  it("recognises time words in both languages", () => {
    expect(matchHardSignals("what's on my calendar tomorrow morning").map((s) => s.id)).toContain("time_en");
    expect(matchHardSignals("meetings on 2026-09-20 at 14:30").map((s) => s.id)).toContain("time_en");
    expect(matchHardSignals("מה יש לי ביומן מחר בבוקר").map((s) => s.id)).toContain("time_he");
    expect(matchHardSignals("תקבע פגישה בשבוע הבא").map((s) => s.id)).toContain("time_he");
  });

  it("stays quiet on prose that only looks structured", () => {
    expect(matchHardSignals("send a thank you note to the team")).toEqual([]);
    expect(matchHardSignals("תשלח מייל לדנה")).toEqual([]);
    // A lone cell reference is not a signal; a span or a sheet-qualified cell is.
    expect(matchHardSignals("put it in cell B2")).toEqual([]);
    expect(matchHardSignals("the meeting is at 10:30").map((s) => s.id)).toEqual(["time_en"]);
  });

  it("is deterministic — the same query gives the same signals twice", () => {
    const q = "forward https://docs.google.com/spreadsheets/d/1AbC/edit to dana@example.com tomorrow";
    const first = matchHardSignals(q).map((s) => s.id);
    const second = matchHardSignals(q).map((s) => s.id);
    expect(second).toEqual(first);
    expect(first).toEqual([...new Set(first)]);
  });
});

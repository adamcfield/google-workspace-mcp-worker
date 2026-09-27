/**
 * Router contracts (v1.5 PR-3): the zod v4 schemas, input shapes and tuning constants the
 * discovery tools (google_search_tools / google_describe_tool / google_call_tool /
 * google_call_write_tool) will use. Schemas only — the routing engine and the tool
 * registrations land in PR-6; nothing here changes the wire surface.
 */
import { z } from "zod";
// Leaf imports only: the lexicon (data + pure helpers) and the manifest's TYPE. `_manifest.ts` is
// imported `type`-only on purpose, so this module pulls in no catalog and no cycle is possible.
import { EN_TERMS, FUNCTION_WORDS, HE_TERMS, matchHardSignals, RESOURCE_LEXICON, SERVICE_LEXICON, VERB_LEXICON, type HardSignal, type LexEntry } from "./_lexicon.js";
import type { ManifestEntry } from "./_manifest.js";

/** How sure the router is that the top candidate is the right tool. */
export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/** One tool the router proposes for a query. */
export const RouteCandidate = z.object({
  name: z.string(),
  service: z.string(),
  summary: z.string(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  listed: z.boolean(),
  needsConfirm: z.boolean(),
  params: z.array(z.string()),
  source: z.string(),
});
export type RouteCandidate = z.infer<typeof RouteCandidate>;

/** The result of routing one query: parsed intent, ranked candidates and what to do next. */
export const RouteResult = z.object({
  query: z.string(),
  intent: z.object({ service: z.string().optional(), verb: z.string().optional(), resource: z.string().optional() }),
  candidates: z.array(RouteCandidate),
  confidence: Confidence,
  ambiguity: z.boolean(),
  next_action: z.string(),
});
export type RouteResult = z.infer<typeof RouteResult>;

// Input shapes of the discovery tools (decisions 1-B, 5-A, 17-A); registered by PR-6. Raw shapes so they plug into tool({ input }).

/** `google_search_tools`: free-text query, optional service prefix, candidate limit. */
export const SEARCH_TOOLS_INPUT = {
  query: z.string().describe("What you want to do, in your words (English or Hebrew); empty = the group map"),
  service: z.string().optional().describe("Restrict to one service prefix, e.g. 'gmail'"),
  limit: z.number().int().min(1).max(10).default(3).describe("Max candidates"),
};
/** `google_describe_tool`: one exact tool name. */
export const DESCRIBE_TOOL_INPUT = { name: z.string().describe("Exact tool name") };
/** `google_call_tool`: dispatch a read-only tool by name with its arguments. */
export const CALL_TOOL_INPUT = {
  name: z.string().describe("Exact tool name (read-only tools only)"),
  arguments: z.record(z.string(), z.unknown()).default({}).describe("Arguments for that tool"),
};
/** `google_call_write_tool`: dispatch a write tool by name; `confirm` must be exactly true. */
export const CALL_WRITE_TOOL_INPUT = {
  name: z.string().describe("Exact tool name of a write tool"),
  arguments: z.record(z.string(), z.unknown()).default({}).describe("Arguments for that tool"),
  confirm: z.literal(true).describe("Must be exactly true — only pass it after the user explicitly asked for this action"),
};

/**
 * Ranking parameters: one constants object by design, so tuning the router is always an explicit
 * diff. The first three shipped in PR-3 and keep their values; everything below them is the PR-6a
 * engine's scoring, off the wire and pinned key by key in `tests/router-engine.test.ts`.
 */
export const ROUTER_PARAMS = {
  /** How many candidates `route()` returns by default (PR-3). */
  maxCandidates: 3,
  /** Relative margin over the runner-up that `high` confidence needs (PR-3). */
  highMargin: 0.25,
  /** Relative margin below which two candidates are ambiguous rather than merely close (PR-3). */
  mediumMargin: 0.1,

  // --- tokenizer (§C.1) ---
  /** Query characters looked at; a pasted wall of text costs a bounded amount of work. */
  maxQueryChars: 500,
  /** Unigrams kept per text; bigrams are formed from these. */
  maxTokens: 40,
  /** Shortest ASCII token typo tolerance applies to. Hebrew is never fuzzy-matched. */
  fuzzyMinChars: 5,
  /** What a one-edit match is worth against an exact one. */
  fuzzyPenalty: 0.6,
  /** A two-word phrase is far more specific than either word, and scores accordingly. */
  bigramBoost: 1.6,
  /**
   * …except when BOTH of its words are grammar. Without this a bigram of two function words
   * ("what is") scored 1.6 while each of its words scored 0.25, so an English question opener
   * outweighed the question — and `what is on my todo list` landed on `tasks_get_task`.
   */
  functionBigramWeight: 0.25,
  /**
   * How many function words a bigram may skip over. Hebrew's accusative `את` sits between a verb
   * and its object, so `תחפש את הקובץ` has to yield `חפש קובץ` — the form the keyword lists are
   * written in — or 144 of the 249 hand-written Hebrew keywords can never match natural phrasing.
   */
  bigramSkip: 1,

  // --- BM25F-lite (§C.2, §C.3) ---
  /** Field weights: the tool's own name, then its facets, then the hand-written intent text. */
  weights: { name: 3, facet: 2.4, keyword: 2, useWhen: 1.4, returns: 1 },
  /** BM25 k1: the point where repeating a term stops buying much. */
  saturation: 1.2,
  /** Term frequency cap per field — a word repeated in one short field is not three times the evidence. */
  maxTermFrequency: 3,

  // --- facet bonuses and penalties (§C.3) ---
  /** The query named this tool's service. */
  serviceBonus: 1.2,
  /** The query used a word for this tool's verb (also the destructive gate — see §C.4). */
  verbBonus: 0.8,
  /** The query named this tool's resource. */
  resourceBonus: 1,
  /**
   * …and named it in the same number. `<verb>_<resource>` encodes list-vs-one in the resource's
   * plurality (`list_labels` vs `get_label`), which the stemmer otherwise folds away, so a
   * singular query prefers the singular tool and a plural one the plural tool.
   */
  pluralAgreementBonus: 0.5,
  /** A hard signal (a URL, an operator, an A1 range) named this tool's service. */
  signalServiceBonus: 1.5,
  /** …and its resource (a document URL naming a spreadsheet is strong evidence about the noun). */
  signalResourceBonus: 1.5,
  /** The query spells the tool's name out: nothing else can reasonably win. */
  exactNameBonus: 6,
  /** A service named explicitly in the query heavily discounts every other service. */
  crossServiceDiscount: 0.35,
  /** Per-term cost of a `doNotUseWhen` word the tool's positive fields do not share. */
  avoidPenalty: 0.8,
  /** What a bare function word ("what", "the", `את`) is worth next to a content word. */
  functionWordWeight: 0.25,
  /**
   * Score multiplier for a DESTRUCTIVE tool the query never named the verb of. The confidence
   * gate (§C.4) already refuses to call such a tool, but it said nothing about RANKING, so a
   * scheduling question could still be answered with `docs_delete_range` at the top of the list —
   * and PR-6b hands that list to a model. An irreversible tool does not lead a list it was not
   * asked for.
   */
  destructiveNoVerbPenalty: 0.5,

  // --- confidence gate (§C.4) ---
  /** Below this a tool is not a candidate at all. */
  minScore: 1,
  /**
   * Confidence floors are DENSITY floors: `score / sqrt(query tokens)`. A BM25 sum grows with the
   * query, so a flat floor would quietly demand more of a three-word Hebrew question than of a
   * ten-word English one. Dividing by the square root of the token count keeps "תמחק את האירוע"
   * and "delete the standup event from my calendar" on the same scale.
   */
  mediumMinDensity: 1.5,
  /**
   * Density floor for `high`. Recalibrated from 3 to 2.8 when the bigram IDF cap (see
   * `buildRouterIndex`) took the inflation out of every multi-word score: the same queries that
   * used to clear 3 now land just under it, and an out-of-scope query sits around 1.1–1.7, so
   * the headroom the gate relies on is unchanged.
   */
  highMinDensity: 2.8,
  /** Matching facets (service / verb / resource) `high` needs. */
  highMinFacets: 2,
  /**
   * …and what a DESTRUCTIVE tool needs, counted from the query's own WORDS only (§C.4). A hard
   * signal donates `intent.service` for free, so with the ordinary floor of 2 a single vague
   * synonym next to a pasted URL — "clear it out https://docs.google.com/spreadsheets/d/…" —
   * was enough to reach `high` on `sheets_clear_range`. Three word-earned facets means the user
   * wrote the verb AND the noun AND the product.
   */
  destructiveHighMinFacets: 3,

  // --- output shape ---
  /** Ceiling for `route`'s `limit` option; matches `SEARCH_TOOLS_INPUT.limit`. */
  maxLimit: 10,
  /** Parameter names carried on a candidate. */
  maxParams: 8,
  /** Parameter names named in `next_action` text. */
  maxNamedParams: 4,
} as const;

// ===========================================================================
// The engine (v1.5 PR-6a §C). Everything below is pure: it reads the manifest it is handed and
// the lexicon, and returns a `RouteResult`. No I/O, no fetch, no model, no session state, and —
// rule #1 — nothing here reaches the wire: no tool is registered, listed or described from it.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Tokenizer (§C.1)
// ---------------------------------------------------------------------------

/** Hebrew points and cantillation: dropped before anything else looks at a word. */
const NIQQUD_RE = /[֑-ׇ]/gu;
/** Final forms → their base letter, so `אלבום` and `אלבומים` share a stem. */
const FINAL_FORMS: Readonly<Record<string, string>> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
/** The one-letter clitics ה ב ל כ מ ו ש, stripped only when what is left is a lexicon term. */
const CLITICS = new Set(["ה", "ב", "ל", "כ", "מ", "ו", "ש"]);
/** Any Hebrew letter — decides which stemmer applies, and blocks fuzzy matching. */
const HEBREW_RE = /[א-ת]/;
/** A token fuzzy matching may touch: ASCII only, never Hebrew (one edit changes the word). */
const ASCII_WORD_RE = /^[a-z][a-z0-9]*$/;
/** Word separator: everything that is not a letter, a digit or an apostrophe. */
export const SPLIT_RE = /[^\p{L}\p{N}']+/u;
/** The apostrophe shapes Hebrew uses in `צ'אט` / `ג'ימייל`, folded to ASCII `'`. */
const APOSTROPHES_RE = /[׳’ʼ`]/g;
/** The Meta service: a catch-all whose words ("google", "tool", "account") are generic, so a
 * product service wins a tie against it when the query names one (see `readIntent`). */
export const META_SERVICE = "google";

/** NFKC + lowercase + niqqud stripping + final-letter folding. No lexicon, no stemming. */
export function fold(word: string): string {
  const base = word.normalize("NFKC").toLowerCase().replace(NIQQUD_RE, "").replace(APOSTROPHES_RE, "'");
  let out = "";
  for (const ch of base) out += FINAL_FORMS[ch] ?? ch;
  return out.replace(/^'+|'+$/g, "");
}

/** Every single word of a set of (possibly multi-word) lexicon terms, folded. */
function wordsOf(terms: Iterable<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const term of terms) for (const part of fold(term).split(SPLIT_RE)) if (part.length > 1) out.add(part);
  return out;
}

/** Folded Hebrew lexicon words. Clitic stripping is gated on this: `המייל` → `מייל`, `מחר` stays. */
const HE_STEMS: ReadonlySet<string> = wordsOf(HE_TERMS);
/** Folded English lexicon words. Singularisation is gated on this: `sheets` → `sheet`, `address` stays. */
const EN_WORDS: ReadonlySet<string> = wordsOf(EN_TERMS);
/**
 * Folded Hebrew VERB words. The ת- imperative — `תסמן`, `תשלח`, the form a Hebrew speaker uses
 * when addressing a bot — is stripped only against THIS set, never against the whole lexicon, so
 * `תמונה`, `תשובה` and `תיקייה` keep their first letter while `תסמן` reduces to the listed `סמן`.
 */
const HE_VERB_STEMS: ReadonlySet<string> = wordsOf(Object.values(VERB_LEXICON).flatMap((e) => [...e.he]));
/** `FUNCTION_WORDS` (language data, `_lexicon.ts`) folded the way a query token is folded. */
export const FUNCTION_TOKENS: ReadonlySet<string> = new Set([...FUNCTION_WORDS].map(fold));

/** English plural → singular, but only when the singular is a word the lexicon knows. */
function singularise(word: string): string {
  if (!word.endsWith("s") || word.length < 4) return word;
  const candidates = word.endsWith("ies") ? [`${word.slice(0, -3)}y`, word.slice(0, -1)] : word.endsWith("es") ? [word.slice(0, -2), word.slice(0, -1)] : [word.slice(0, -1)];
  for (const candidate of candidates) if (candidate.length > 2 && EN_WORDS.has(candidate)) return candidate;
  return word;
}

/** Strip the ת- imperative prefix and up to two clitics, each gated on the lexicon. */
function declitic(word: string): string {
  // The ת- pass runs FIRST and is gated on the verb words alone, so the two forms of one verb
  // (`שלח` and `תשלח`) collapse to one token on both sides of the index instead of competing.
  if (word.length > 3 && word.startsWith("\u05EA") && HE_VERB_STEMS.has(word.slice(1))) return word.slice(1);
  // A definite form can itself BE a lexicon word, because a multi-word term like `תוכן הקובץ`
  // contributes `הקובצ` to the stem set. Returning it here left `הקובץ` and `קובץ` as two
  // different tokens, so a keyword written `חפש קובץ` was unreachable from the ordinary phrasing
  // `תחפש את הקובץ`. The definite article is the one clitic where the bare noun is always the
  // better token, so it wins even when the definite form is itself listed.
  if (HE_STEMS.has(word)) {
    const bare = word.slice(1);
    return word.startsWith("\u05D4") && bare.length >= 2 && HE_STEMS.has(bare) ? bare : word;
  }
  for (const cut of [1, 2]) {
    if (word.length - cut < 2) break;
    if (![...word.slice(0, cut)].every((ch) => CLITICS.has(ch))) break;
    const stem = word.slice(cut);
    if (HE_STEMS.has(stem)) return stem;
  }
  return word;
}

/** One word: folded, then stemmed by the lexicon of its script (Hebrew clitics / English plurals). */
export function stemWord(word: string): string {
  const folded = fold(word);
  if (!folded) return folded;
  if (HEBREW_RE.test(folded)) return declitic(folded);
  return ASCII_WORD_RE.test(folded) ? singularise(folded) : folded;
}

/** Whether a RAW word is a plural form — read before stemming folds the two numbers together. */
export function isPluralWord(raw: string): boolean {
  const folded = fold(raw);
  if (folded.length < 4) return false;
  if (HEBREW_RE.test(folded)) return folded.endsWith("\u05D9\u05DE") || folded.endsWith("\u05D5\u05EA");
  return ASCII_WORD_RE.test(folded) && folded !== singularise(folded);
}

/**
 * The index pairs a bigram is built from: every adjacent pair, plus ONE pair that skips a
 * function word. Hebrew's accusative `את` is obligatory between a verb and its object, so
 * `תחפש את הקובץ` only yields the indexed term `חפש קובץ` through the skip; English degrades
 * gracefully without it, which is why the Hebrew side needed it and the English side did not.
 */
function bigramPairs(tokens: readonly string[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    pairs.push([i, i + 1]);
    let j = i + 1;
    for (let skipped = 0; skipped < ROUTER_PARAMS.bigramSkip && j + 1 < tokens.length && FUNCTION_TOKENS.has(tokens[j]); skipped++) {
      pairs.push([i, ++j]);
    }
  }
  return pairs;
}

/** A tokenized query or index field: unigrams, adjacent bigrams, and the two as one term list. */
export interface Tokens {
  /** Stemmed single words, in order, capped at `ROUTER_PARAMS.maxTokens`. */
  tokens: string[];
  /** Adjacent pairs joined by a space — how a multi-word lexicon term ("free busy") matches. */
  bigrams: string[];
  /** `tokens` then `bigrams`, deduplicated: what the index stores and what scoring iterates. */
  terms: string[];
  /** Whether any RAW word was a plural form (`labels`, `מיילים`) — see `pluralAgreementBonus`. */
  plural: boolean;
}

/**
 * Text → terms. Caps first (`maxQueryChars`, then `maxTokens`), so a pasted wall of text costs a
 * bounded amount of work; one-character tokens are dropped (a lone letter is a clitic or noise).
 */
export function tokenize(text: string): Tokens {
  const clipped = String(text ?? "").slice(0, ROUTER_PARAMS.maxQueryChars);
  const tokens: string[] = [];
  let plural = false;
  for (const raw of clipped.split(SPLIT_RE)) {
    if (tokens.length >= ROUTER_PARAMS.maxTokens) break;
    const token = stemWord(raw);
    if (token.length <= 1) continue;
    tokens.push(token);
    plural ||= isPluralWord(raw);
  }
  const bigrams = bigramPairs(tokens).map(([a, b]) => `${tokens[a]} ${tokens[b]}`);
  return { tokens, bigrams, terms: [...new Set([...tokens, ...bigrams])], plural };
}

/**
 * Damerau-Levenshtein distance ≤ 1 (one insertion, deletion, substitution or adjacent
 * transposition). A predicate, not a distance: the engine never needs the number.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const gap = long.length - short.length;
  if (gap > 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  if (gap === 1) {
    // One insertion in `long`: everything after the first mismatch lines up with an offset of one.
    for (let k = i; k < short.length; k++) if (short[k] !== long[k + 1]) return false;
    return true;
  }
  let j = short.length - 1;
  while (j > i && short[j] === long[j]) j--;
  if (i === j) return true; // one substitution
  return j === i + 1 && short[i] === long[j] && short[j] === long[i]; // one adjacent transposition
}

// ---------------------------------------------------------------------------
// 2. Index (§C.2)
// ---------------------------------------------------------------------------

/**
 * The fields a term can appear in. `ROUTER_PARAMS.weights` is keyed by these, strongest first.
 *
 * §C.2 lists "…and description" among the indexed fields; there is deliberately no sixth field.
 * A tool WITHOUT a route block has its description's first sentence as both `useWhen` and
 * `returns` (`_manifest.ts`), so its description IS indexed, through `useWhen`. A tool WITH a
 * block has hand-written intent text instead, and indexing its description as well would undo
 * what the block is for: the block exists because the description — written for a model that has
 * already chosen the tool — is full of parameter names, formats and caveats that match the wrong
 * queries. So §C.2's "description" is read here as "the description fallback", and an annotated
 * tool's raw description is excluded ON PURPOSE. `ManifestEntry` therefore carries no
 * `description` field either.
 */
export const ROUTER_FIELDS = ["name", "facet", "keyword", "useWhen", "returns"] as const;
/** One of `ROUTER_FIELDS`. */
export type RouterField = (typeof ROUTER_FIELDS)[number];

/** One tool's postings: term → term frequency per field, plus its negative and facet vocabulary. */
interface ToolIndex {
  entry: ManifestEntry;
  terms: Map<string, Partial<Record<RouterField, number>>>;
  /** Terms of `doNotUseWhen` that hit no positive field of this tool (§C.3). */
  avoid: Set<string>;
  /**
   * The words that count as naming this tool's verb — the destructive gate's "explicit verb" —
   * PRE-TOKENIZED. They are static lexicon data, and re-tokenizing them inside the scoring loop
   * cost ~75% of a `route()` call (15,949 `tokenize` calls for one eight-word query).
   */
  verbTerms: string[][];
  /** The words that count as naming this tool's resource, pre-tokenized for the same reason. */
  resourceTerms: string[][];
  /** Whether this tool's resource segment is plural (`labels`, `events`) — see `pluralAgreementBonus`. */
  pluralResource: boolean;
}

/** The scoring index over one manifest. Derived data only — never session state. */
export interface RouterIndex {
  manifest: readonly ManifestEntry[];
  tools: ToolIndex[];
  /** term → inverse document frequency over the manifest. */
  idf: Map<string, number>;
  /** Single-word ASCII terms long enough for typo tolerance, sorted for a deterministic pick. */
  fuzzyVocab: string[];
  /** Service segments present in this manifest ("gmail", "sheets", …). */
  services: Set<string>;
  /** Tool name → its index row, for the exact-name shortcut. */
  byName: Map<string, ToolIndex>;
}

/**
 * One lexicon term as word lists, memoised for the process. The lexicons and the route blocks are
 * module constants, so every distinct term is tokenized exactly once however many queries run.
 */
const TERM_WORDS = new Map<string, string[]>();
function termWords(term: string): string[] {
  let words = TERM_WORDS.get(term);
  if (!words) TERM_WORDS.set(term, (words = tokenize(term).tokens));
  return words;
}

/** Both languages of a lexicon entry, or nothing when the key is unknown. */
function lexTerms(lex: Readonly<Record<string, LexEntry>>, key: string): readonly string[] {
  const hit = key ? lex[key] : undefined;
  return hit ? [...hit.en, ...hit.he] : [];
}

/** `message_labels` → `message labels`, so a name segment tokenizes like ordinary text. */
const words = (segment: string): string => segment.split("_").join(" ");

/**
 * A term with no content word in it: pure grammar, and never evidence about a tool. Indexed
 * fields drop these (`fieldTerms`). A hand-written phrase carries incidental function words with
 * it ("who is in the group", "what is on my calendar"), and because those words are rare ACROSS
 * the catalog they earn a high IDF — which let `what is …` outvote the question. A MIXED bigram
 * ("who am", "what can") is not grammar and still indexes: that is how the Meta tools are found.
 */
function isGrammar(term: string): boolean {
  for (const word of term.split(" ")) if (!FUNCTION_TOKENS.has(word)) return false;
  return true;
}

/**
 * Memo of an INDEX field's terms. `addTerms` is called only from `buildRouterIndex`, over static
 * data, and the same lexicon text is indexed once per tool that shares the facet — so the same
 * strings were being tokenized dozens of times per index build.
 */
const FIELD_TERMS = new Map<string, readonly string[]>();
function fieldTerms(text: string): readonly string[] {
  let terms = FIELD_TERMS.get(text);
  if (!terms) FIELD_TERMS.set(text, (terms = tokenize(text).terms.filter((t) => !isGrammar(t))));
  return terms;
}

function addTerms(into: Map<string, Partial<Record<RouterField, number>>>, field: RouterField, text: string): void {
  for (const term of fieldTerms(text)) {
    const posting = into.get(term) ?? {};
    posting[field] = (posting[field] ?? 0) + 1;
    into.set(term, posting);
  }
}

/** Memoised per manifest array (§C.2): the same array is indexed once per isolate. */
const INDEX_CACHE = new WeakMap<object, RouterIndex>();

/**
 * Build — or reuse — the scoring index for one manifest. Pure with respect to `manifest`.
 *
 * CONTRACT: the memo is keyed on the ARRAY IDENTITY, and `buildManifest` returns a fresh array on
 * every call, so "built once per isolate" only holds for a caller that builds the manifest once
 * per isolate and reuses it (PR-6b must hold it in a module-level cache keyed by the surface, not
 * rebuild it per `google_search_tools` call — the cold path is roughly an order of magnitude more
 * expensive than a warm one). `buildManifest` freezes what it returns, so a memoised manifest
 * cannot be mutated behind this cache.
 */
export function buildRouterIndex(manifest: readonly ManifestEntry[]): RouterIndex {
  const cached = INDEX_CACHE.get(manifest as object);
  if (cached) return cached;
  const tools: ToolIndex[] = manifest.map((entry) => {
    const terms = new Map<string, Partial<Record<RouterField, number>>>();
    addTerms(terms, "name", words(entry.name));
    const verbTermText = [words(entry.verb), ...lexTerms(VERB_LEXICON, entry.verb)].filter(Boolean);
    const resourceTermText = [words(entry.resource), ...lexTerms(RESOURCE_LEXICON, entry.resource)].filter(Boolean);
    // `entry.group` folds to the same token as `entry.service` for 13 of the 14 services (Gmail →
    // gmail), so indexing both silently doubled that token's frequency for every non-Meta tool.
    const group = fold(entry.group) === fold(entry.service) ? [] : [entry.group];
    for (const facet of [entry.service, ...group, ...lexTerms(SERVICE_LEXICON, entry.service), ...verbTermText, ...resourceTermText]) addTerms(terms, "facet", facet);
    for (const keyword of [...entry.keywords, ...entry.keywordsHe]) addTerms(terms, "keyword", keyword);
    addTerms(terms, "useWhen", entry.useWhen);
    // A tool with no route block falls back to the first sentence of its description for BOTH
    // `useWhen` and `returns` (see `_manifest.ts`). Indexing it twice would give an un-annotated
    // tool 2.4x the prose weight of an annotated one — a quiet bonus for having no route block.
    if (entry.returns !== entry.useWhen) addTerms(terms, "returns", entry.returns);
    const avoid = new Set<string>();
    if (entry.doNotUseWhen) {
      // Only terms the tool does NOT itself use can count against it: a word in both its own
      // text and its warning says nothing about which of the pair the query means.
      //
      // An earlier round exempted the SIBLING's verb from this filter, on the theory that the
      // separating word is usually that verb. Measured on the real catalog it did no work on the
      // pairs it was written for (what fixed those was the doNotUseWhen prose in _manifest.ts)
      // and it fired where it hurt: gmail_create_draft names gmail_send_message, so "send" landed
      // in the DRAFT tool's avoid set and every "draft an email I will send later" query pushed
      // the irreversible send tool UP. Reverted deliberately — see the PR body.
      for (const term of fieldTerms(entry.doNotUseWhen)) if (!terms.has(term)) avoid.add(term);
    }
    const resourceTail = entry.resource.split("_").pop() ?? "";
    return { entry, terms, avoid, verbTerms: verbTermText.map(termWords), resourceTerms: resourceTermText.map(termWords), pluralResource: isPluralWord(resourceTail) };
  });
  const df = new Map<string, number>();
  for (const tool of tools) for (const term of tool.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log(1 + (tools.length - count + 0.5) / (count + 0.5)));
  // A bigram is never more informative than its most informative word. Without this, EVERY
  // bigram that occurs in exactly one tool takes the maximum IDF the corpus can hand out, which
  // over a catalog of this size is more than the best content word scores — so an incidental
  // prose pair ("the trash", "from drive", "the document") outvoted the word the query is
  // actually about, and `bigramBoost` then multiplied the mistake. Capping at the parts keeps a
  // real phrase ahead of its own words (the boost still applies) and takes filler out of the run.
  for (const [term, value] of idf) {
    const cut = term.indexOf(" ");
    if (cut < 0) continue;
    const parts = Math.max(idf.get(term.slice(0, cut)) ?? 0, idf.get(term.slice(cut + 1)) ?? 0);
    if (parts && value > parts) idf.set(term, parts);
  }
  const fuzzyVocab = [...df.keys()].filter((t) => t.length >= ROUTER_PARAMS.fuzzyMinChars && ASCII_WORD_RE.test(t)).sort();
  const index: RouterIndex = { manifest, tools, idf, fuzzyVocab, services: new Set(manifest.map((e) => e.service)), byName: new Map(tools.map((t) => [t.entry.name, t])) };
  INDEX_CACHE.set(manifest as object, index);
  return index;
}

// ---------------------------------------------------------------------------
// 3. Intent (§C.3)
// ---------------------------------------------------------------------------

/** What the query itself says, before any tool is scored. */
export interface RouteIntent {
  /** A service the query names AND this manifest has. */
  service?: string;
  /**
   * True only when the query's own WORDS named `service`. A hard signal donates a service for
   * free, and the §C.4 destructive gate must count evidence the USER wrote, not evidence a
   * pasted URL contributed.
   */
  serviceFromQuery: boolean;
  verb?: string;
  resource?: string;
  /** A service the query names that this deployment does NOT enable — the `disabled` next action. */
  missingService?: string;
  /** Hard signals that matched the RAW query, in `HARD_SIGNALS` declaration order. */
  signals: HardSignal[];
}

/** A term hits when every one of its words is a query token; the hit is its word count. */
function wordsHit(parts: readonly string[], tokens: ReadonlySet<string>): number {
  return parts.length && parts.every((w) => tokens.has(w)) ? parts.length : 0;
}

/** The same, for a term still in string form — tokenized once per distinct term, then memoised. */
function termHit(term: string, tokens: ReadonlySet<string>): number {
  return wordsHit(termWords(term), tokens);
}

/** The most specific hit (most words) among a list of terms; 0 when none of them hits. */
function bestHit(terms: readonly string[], tokens: ReadonlySet<string>): number {
  let best = 0;
  for (const term of terms) best = Math.max(best, termHit(term, tokens));
  return best;
}

/** …and over pre-tokenized terms (`ToolIndex.verbTerms` / `resourceTerms`): no tokenizing at all. */
function bestWordsHit(terms: readonly (readonly string[])[], tokens: ReadonlySet<string>): number {
  let best = 0;
  for (const parts of terms) best = Math.max(best, wordsHit(parts, tokens));
  return best;
}

/**
 * The key whose lexicon entry hits hardest — the one the query NAMES. Two rules keep it honest:
 * the Meta catch-all ("google", "tool", "account") loses a tie to any product key, and a tie
 * between two product keys yields NOTHING when `tieIsNoAnswer` is set. A query that names two
 * services equally well has not named one, and inventing a winner there would hand the
 * cross-service discount (§C.3) to a coin flip — "find the pricing doc in drive" must not become
 * a Docs query because `docs` sorts before `drive`. Only the SERVICE is read that strictly: the
 * verb and the resource are reported intent, they carry no discount, and their singular/plural
 * keys ("event" and "events") tie constantly, so there the alphabetical winner is kept.
 */
function bestKey(keys: readonly string[], lex: Readonly<Record<string, LexEntry>>, tokens: ReadonlySet<string>, tieIsNoAnswer = false): string | undefined {
  let winner: string | undefined;
  let score = 0;
  let tied = false;
  for (const key of [...keys].sort()) {
    const hit = Math.max(bestHit(lexTerms(lex, key), tokens), termHit(words(key), tokens));
    if (!hit) continue;
    if (hit > score) {
      [score, winner, tied] = [hit, key, false];
    } else if (hit === score && winner !== key) {
      if (winner === META_SERVICE) winner = key;
      else if (key !== META_SERVICE) tied = true;
    }
  }
  return tied && tieIsNoAnswer ? undefined : winner;
}

/** Read the query's own service / verb / resource: hard signals first (§B), then the lexicon. */
export function readIntent(query: string, index: RouterIndex, tokens: ReadonlySet<string>, signals: readonly HardSignal[] = matchHardSignals(query)): RouteIntent {
  const intent: RouteIntent = { signals: [...signals], serviceFromQuery: false };
  const fromWords = bestKey(Object.keys(SERVICE_LEXICON), SERVICE_LEXICON, tokens, true);
  const named = signals.find((s) => s.service)?.service ?? fromWords;
  if (named && index.services.has(named)) {
    intent.service = named;
    intent.serviceFromQuery = fromWords === named;
  } else if (named) intent.missingService = named;
  const verb = bestKey([...new Set(index.manifest.map((e) => e.verb).filter(Boolean))], VERB_LEXICON, tokens);
  if (verb) intent.verb = verb;
  const resources = new Set(index.manifest.map((e) => e.resource).filter(Boolean));
  const resource = bestKey([...resources], RESOURCE_LEXICON, tokens) ?? signals.flatMap((s) => [...(s.resources ?? [])]).find((r) => resources.has(r));
  if (resource) intent.resource = resource;
  return intent;
}

// ---------------------------------------------------------------------------
// 4. Scoring (§C.3)
// ---------------------------------------------------------------------------

/** One scored tool, before it becomes a `RouteCandidate`. */
interface Scored {
  tool: ToolIndex;
  score: number;
  /** Strongest matching field — becomes `candidate.source`. */
  field: RouterField;
  serviceMatch: boolean;
  /** The query used a word for THIS tool's verb. The destructive gate turns on this flag. */
  verbMatch: boolean;
  resourceMatch: boolean;
}

/** A query term as scoring sees it: the index term it resolved to, and at what discount. */
interface ResolvedTerm {
  term: string;
  weight: number;
}

/** The query as scoring sees it: terms with their weights, plus the tokens intent reads. */
interface ResolvedQuery {
  terms: ResolvedTerm[];
  /**
   * The unigrams a FACET may be read from: the query's own stemmed words, never a typo
   * correction. A correction is a guess worth RANKING on (at `fuzzyPenalty`), not worth
   * declaring the user's intent with: "search my inbox for the contract from legal" is one edit
   * from `contact`, which handed a mail search to the contacts tools, and on a deployment
   * without Gmail the word `gmail` itself is one edit from `email`, which quietly turned "that
   * group is switched off" into a wrong answer.
   */
  tokenSet: Set<string>;
}

/**
 * Resolve the query against the index vocabulary: exact first, then one typo for long ASCII
 * words only (never Hebrew — a single edit there changes the word). Bigrams are rebuilt from the
 * CORRECTED tokens, and inherit the discount of a corrected part.
 */
function resolveQuery(tokens: Tokens, index: RouterIndex): ResolvedQuery {
  const corrected = tokens.tokens.map((token) => {
    if (index.idf.has(token)) return { token, weight: 1 };
    // A word the lexicon knows is not a typo, whatever it is one edit away from. Without this,
    // `gmail` on a deployment with Gmail switched off (so `gmail` is in no indexed field) was
    // "corrected" to `email` — and the router answered instead of saying the group is off.
    if (EN_WORDS.has(token) || HE_STEMS.has(token)) return { token, weight: 1 };
    if (token.length < ROUTER_PARAMS.fuzzyMinChars || !ASCII_WORD_RE.test(token)) return { token, weight: 1 };
    const near = index.fuzzyVocab.find((candidate) => withinOneEdit(token, candidate));
    return near ? { token: near, weight: ROUTER_PARAMS.fuzzyPenalty } : { token, weight: 1 };
  });
  const seen = new Set<string>();
  const terms: ResolvedTerm[] = [];
  const push = (term: string, weight: number) => {
    if (seen.has(term)) return;
    seen.add(term);
    terms.push({ term, weight });
  };
  for (const { token, weight } of corrected) push(token, weight * (FUNCTION_TOKENS.has(token) ? ROUTER_PARAMS.functionWordWeight : 1));
  // The SAME pairing the index uses (`bigramPairs`), so a skip-bigram written into a keyword and
  // a skip-bigram read out of a query are the same term — two sources of truth here meant a fix
  // to one had to be applied twice.
  for (const [a, b] of bigramPairs(corrected.map((c) => c.token))) {
    const pair = `${corrected[a].token} ${corrected[b].token}`;
    const bothGrammar = FUNCTION_TOKENS.has(corrected[a].token) && FUNCTION_TOKENS.has(corrected[b].token);
    push(pair, ROUTER_PARAMS.bigramBoost * Math.min(corrected[a].weight, corrected[b].weight) * (bothGrammar ? ROUTER_PARAMS.functionBigramWeight : 1));
  }
  return { terms, tokenSet: new Set(tokens.tokens) };
}

/** BM25F-lite: the weighted term frequency across fields, saturated once, times the term's IDF. */
function scoreTool(tool: ToolIndex, resolved: readonly ResolvedTerm[], index: RouterIndex, intent: RouteIntent, tokens: ReadonlySet<string>, plural: boolean): Scored | undefined {
  let terms = 0;
  let best = 0;
  let field: RouterField = "facet";
  for (const { term, weight } of resolved) {
    const posting = tool.terms.get(term);
    if (!posting) continue;
    let weighted = 0;
    for (const f of ROUTER_FIELDS) {
      const tf = Math.min(posting[f] ?? 0, ROUTER_PARAMS.maxTermFrequency);
      if (!tf) continue;
      const contribution = ROUTER_PARAMS.weights[f] * tf;
      weighted += contribution;
      if (contribution > best) {
        best = contribution;
        field = f;
      }
    }
    terms += (index.idf.get(term) ?? 0) * (weighted / (weighted + ROUTER_PARAMS.saturation)) * weight;
  }
  // A facet bonus never carries a tool the query did not touch at all.
  if (terms <= 0) return undefined;
  const { entry } = tool;
  const serviceMatch = intent.service === entry.service;
  const verbMatch = bestWordsHit(tool.verbTerms, tokens) > 0;
  const resourceMatch = bestWordsHit(tool.resourceTerms, tokens) > 0;
  let score = terms;
  if (serviceMatch) score += ROUTER_PARAMS.serviceBonus;
  if (verbMatch) score += ROUTER_PARAMS.verbBonus;
  if (resourceMatch) score += ROUTER_PARAMS.resourceBonus;
  // Number agreement: the only signal `<verb>_<resource>` gives for "one of" vs "all of".
  if (resourceMatch && tool.pluralResource === plural) score += ROUTER_PARAMS.pluralAgreementBonus;
  for (const signal of intent.signals) {
    if (signal.service && signal.service === entry.service) score += ROUTER_PARAMS.signalServiceBonus;
    if (entry.resource && signal.resources?.includes(entry.resource)) score += ROUTER_PARAMS.signalResourceBonus;
  }
  // An irreversible tool does not LEAD a list it was never asked for (§C.4 extended from
  // labelling to ranking): PR-6b hands `candidates` to a model, which skims past the prose.
  if (entry.destructive && !verbMatch) score *= ROUTER_PARAMS.destructiveNoVerbPenalty;
  // A service the query named explicitly heavily discounts every other service (§C.3).
  if (intent.service && entry.service !== intent.service) score *= ROUTER_PARAMS.crossServiceDiscount;
  for (const { term } of resolved) if (tool.avoid.has(term)) score -= ROUTER_PARAMS.avoidPenalty * (index.idf.get(term) ?? 0);
  return { tool, score: Math.max(0, score), field, serviceMatch, verbMatch, resourceMatch };
}

// ---------------------------------------------------------------------------
// 5. next_action (§C.5) — a table, never free-form prose
// ---------------------------------------------------------------------------

/** Which row of the `NEXT_ACTION` table a result landed on. */
export type NextActionKind = "empty" | "filtered" | "disabled" | "none" | "ambiguous" | "proxy" | "call" | "describe";

/** What `NEXT_ACTION` builders are handed. */
export interface NextActionInput {
  /** The service that made the answer empty: the query's (`disabled`) or the caller's (`filtered`). */
  service?: string;
  top?: RouteCandidate;
  second?: RouteCandidate;
}

const withParams = (params: readonly string[]) => (params.length ? ` with ${params.slice(0, ROUTER_PARAMS.maxNamedParams).join(", ")}` : "");
const gate = (c: RouteCandidate | undefined) =>
  c ? `${c.destructive ? " It is destructive and cannot be undone — get an explicit go-ahead from the user first." : ""}${c.needsConfirm ? " Pass confirm=true only after the user asked for this action." : ""}` : "";

/**
 * The deterministic next_action text, one builder per case (§C.5). Exported so tests pin the exact
 * strings: because the PR-3 contract keeps `ambiguity` a boolean, this text is the ONLY place the
 * reason is worded, and it must not drift by accident.
 */
export const NEXT_ACTION: Readonly<Record<NextActionKind, (a: NextActionInput) => string>> = {
  empty: () => "Empty query: call google_list_tools for the group map, then search again with words from the group you need.",
  // The CALLER's own filter emptied the list, not the query: saying "no tool matches this query"
  // there blames the user for the narrowing and hides the one thing that would fix it.
  filtered: (a) => `No tool has the service prefix '${a.service}' on this deployment — that is not one of its services. Search again without the service filter, or call google_list_tools for the group map.`,
  disabled: (a) => `No ${a.service} tool is enabled on this deployment — that group is switched off or its scope was not granted. Call google_list_tools to see which groups are available.`,
  none: () => "No tool matches this query. Call google_list_tools for the group map, then search again with the product name and what you want to do with it.",
  ambiguous: (a) =>
    `Two tools fit and neither is clearly better: ${a.top?.name} (${a.top?.summary}) and ${a.second?.name} (${a.second?.summary}). Ask the user which one they mean, or call google_describe_tool on each, before calling either.${gate(a.top)}${gate(a.second)}`,
  proxy: (a) => `${a.top?.name} is not advertised in tools/list on this deployment. Call it through google_call_tool (google_call_write_tool for a write tool)${withParams(a.top?.params ?? [])}.${gate(a.top)}`,
  call: (a) => `Call ${a.top?.name} directly${withParams(a.top?.params ?? [])}.${gate(a.top)}`,
  // §C.5's conservative row. The proxy detail is part of the TEXT here rather than a row of its
  // own, because "is it listed" and "how sure am I" are orthogonal: on a compact deployment the
  // top candidate is usually hidden, and choosing the row on `listed` first made "call it through
  // google_call_tool" the answer to a weak match on a destructive tool.
  describe: (a) => `${a.top?.name} is the closest match but the signal is weak. Call google_describe_tool with name=${a.top?.name} to check its arguments before calling it.${a.top && !a.top.listed ? " It is not advertised in tools/list, so call it through google_call_tool (google_call_write_tool for a write tool)." : ""}${gate(a.top)}`,
};

// ---------------------------------------------------------------------------
// 6. route() (§C.4, §C.6, §C.7)
// ---------------------------------------------------------------------------

/** Caller-supplied narrowing; `service` is the `google_search_tools` prefix filter. */
export interface RouteOptions {
  /** Max candidates to return (1…10); defaults to `ROUTER_PARAMS.maxCandidates`. */
  limit?: number;
  /** Restrict candidates to one service prefix, e.g. "gmail". */
  service?: string;
}

/** A tool name spelled out in the query ("call gmail_send_message") — an unambiguous request. */
const NAME_IN_QUERY_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

function toCandidate(scored: Scored, intent: RouteIntent): RouteCandidate {
  const { entry } = scored.tool;
  const signal = intent.signals.find((s) => s.service && s.service === entry.service);
  return {
    name: entry.name,
    service: entry.service,
    summary: entry.useWhen,
    readOnly: !entry.write,
    destructive: entry.destructive,
    listed: entry.listed,
    needsConfirm: entry.required.includes("confirm") || entry.optional.includes("confirm"),
    params: [...entry.required, ...entry.optional].slice(0, ROUTER_PARAMS.maxParams),
    source: signal ? `${scored.field}+${signal.id}` : scored.field,
  };
}

/**
 * Route one query against one manifest.
 *
 * Candidates come ONLY from `manifest` (§C.7): a tool this deployment does not enable can never be
 * proposed, because the engine has no other list of names to invent from. The result is `.parse()`d
 * against the PR-3 `RouteResult` schema before it is returned, so a shape bug fails here rather
 * than reaching a caller.
 */
export function route(query: string, manifest: readonly ManifestEntry[], opts: RouteOptions = {}): RouteResult {
  const raw = String(query ?? "").slice(0, ROUTER_PARAMS.maxQueryChars);
  const index = buildRouterIndex(manifest);
  const signals = matchHardSignals(raw);
  // The query as the USER wrote it. `density` divides by THIS count, not by the post-consumption
  // one: cutting a URL out shrank the denominator at the same moment its signal bonuses inflated
  // the numerator, which is how a vague verb next to a pasted link reached `high`.
  const rawTokens = tokenize(raw).tokens.length;
  // A structural signal is CONSUMED, not tokenized: the words inside a document URL ("docs",
  // "google", "com", the id) are noise that would outvote the real question. Only a signal that
  // names a service AND is an opaque identifier is cut — a time word carries no id and stays a
  // word, and a Gmail operator (`consume: false`) is made of words that name the search tool.
  // Every occurrence goes, not just the first: a fresh /g copy is used so the shared regex keeps
  // no `lastIndex` and routing stays deterministic.
  const text = signals.reduce((acc, s) => (s.service && s.consume !== false ? acc.replace(new RegExp(s.re.source, `${s.re.flags}g`), " ") : acc), raw);
  const tokens = tokenize(text);
  const { terms: resolved, tokenSet } = resolveQuery(tokens, index);
  const intent = readIntent(raw, index, tokenSet, signals);
  // `Math.trunc(NaN)` is NaN and `slice(0, NaN)` is empty, so an unvalidated caller limit used to
  // turn a perfectly good match into "No tool matches this query".
  const asked = Math.trunc(opts.limit ?? ROUTER_PARAMS.maxCandidates);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), ROUTER_PARAMS.maxLimit) : ROUTER_PARAMS.maxCandidates;
  const wanted = opts.service ? fold(opts.service).split("_")[0] : undefined;
  const named = new Set([...fold(raw).matchAll(NAME_IN_QUERY_RE)].map(([m]) => m));

  const scored: Scored[] = [];
  for (const tool of index.tools) {
    if (wanted && tool.entry.service !== wanted) continue;
    const exact = named.has(tool.entry.name);
    const hit = scoreTool(tool, resolved, index, intent, tokenSet, tokens.plural) ?? (exact ? { tool, score: 0, field: "name" as RouterField, serviceMatch: true, verbMatch: true, resourceMatch: true } : undefined);
    if (!hit) continue;
    if (exact) hit.score += ROUTER_PARAMS.exactNameBonus;
    if (hit.score >= ROUTER_PARAMS.minScore) scored.push(hit);
  }
  // Deterministic order: score first, then the name — never the manifest's incidental order.
  scored.sort((a, b) => b.score - a.score || (a.tool.entry.name < b.tool.entry.name ? -1 : 1));
  // A caller filter that names no service of this deployment, and a query that names a service
  // this deployment does not enable, both mean "nothing here can do that" — and a result that
  // SAYS so must not also hand the caller a tool from a different product. Dropping the ranking
  // is what keeps the text and `candidates` from contradicting each other.
  const unknownFilter = Boolean(wanted && !index.services.has(wanted));
  const ranked = unknownFilter || intent.missingService ? [] : scored;
  const top = ranked[0];
  const second = ranked[1];
  const margin = top && top.score > 0 ? (top.score - (second?.score ?? 0)) / top.score : 0;
  const facets = top ? Number(top.serviceMatch) + Number(top.verbMatch) + Number(top.resourceMatch) : 0;
  // …and the same count restricted to evidence the query's own WORDS carry (§C.4).
  const wordFacets = top ? Number(top.serviceMatch && intent.serviceFromQuery) + Number(top.verbMatch) + Number(top.resourceMatch) : 0;

  // §C.4 — `high` needs a real margin, two matching facets and a score floor; a DESTRUCTIVE tool
  // also needs an explicit verb match AND `destructiveHighMinFacets` facets the user wrote, so no
  // vague query — and no vague query next to a pasted URL — can land on one at high confidence.
  const destructiveOk = !top?.tool.entry.destructive || (top.verbMatch && wordFacets >= ROUTER_PARAMS.destructiveHighMinFacets);
  const density = top ? top.score / Math.sqrt(Math.max(1, rawTokens)) : 0;
  const confidence: Confidence = !top
    ? "low"
    : density >= ROUTER_PARAMS.highMinDensity && margin >= ROUTER_PARAMS.highMargin && facets >= ROUTER_PARAMS.highMinFacets && destructiveOk
      ? "high"
      : density >= ROUTER_PARAMS.mediumMinDensity && margin >= ROUTER_PARAMS.mediumMargin
        ? "medium"
        : "low";
  const ambiguity = Boolean(second) && margin < ROUTER_PARAMS.mediumMargin;

  // The multiplier above lowers an unasked-for destructive tool's SCORE; it does not guarantee it
  // never leads. On the real catalog it still did ("block out two hours for the report" led with
  // docs_delete_range), and PR-6b hands `candidates` to a model that skims past the prose. So the
  // property is enforced structurally, not statistically: if the leader is destructive and the
  // query never named its verb, the best non-destructive candidate takes the lead and the
  // destructive one follows it. Ordering only — nothing is dropped, and a query that DID ask for
  // the destructive verb is untouched.
  const lead = ranked[0];
  if (lead?.tool.entry.destructive && !lead.verbMatch) {
    const safe = ranked.findIndex((s) => !s.tool.entry.destructive);
    if (safe > 0) ranked.splice(0, 0, ...ranked.splice(safe, 1));
  }
  const candidates = ranked.slice(0, limit).map((s) => toCandidate(s, intent));
  // `ambiguity` is decided on the RANKING, so the runner-up the text names comes from the ranking
  // too — with `limit: 1` the ambiguous row used to print the literal text "undefined (undefined)".
  const runnerUp = second ? toCandidate(second, intent) : undefined;
  const kind: NextActionKind = !tokens.tokens.length && !intent.signals.length
    ? "empty"
    : unknownFilter
      ? "filtered"
      : intent.missingService
        ? "disabled"
        : !candidates.length
          ? "none"
          : ambiguity
            ? "ambiguous"
            : confidence === "high"
              ? candidates[0].listed
                ? "call"
                : "proxy"
              : "describe";
  const next_action = NEXT_ACTION[kind]({ service: unknownFilter ? String(opts.service) : intent.missingService, top: candidates[0], second: runnerUp });

  return RouteResult.parse({
    query: raw,
    intent: { service: intent.service, verb: intent.verb, resource: intent.resource },
    candidates,
    confidence,
    ambiguity,
    next_action,
  });
}

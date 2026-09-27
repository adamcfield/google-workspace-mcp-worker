/**
 * The routing engine (v1.5 PR-6a, spec §C): tokenizer, index, BM25F-lite scoring, the confidence
 * gate and the deterministic `next_action` table.
 *
 * Everything here runs against a SMALL hand-built manifest, not the catalog: the engine's job is
 * to rank whatever manifest it is handed, and a fixture of seven tools makes each rule visible on
 * its own. The catalog-wide accuracy numbers live in `tests/routing.test.ts` (spec §D).
 *
 * Nothing in this file touches the wire — no tool is registered, listed or described (rule #1) —
 * and nothing reaches the network or a model (rule #2): every input is written out by hand.
 */
import { describe, it, expect } from "vitest";
import type { ManifestEntry } from "../src/tools/_manifest.js";
import {
  buildRouterIndex,
  fold,
  FUNCTION_TOKENS,
  NEXT_ACTION,
  ROUTER_FIELDS,
  ROUTER_PARAMS,
  RouteResult,
  route,
  readIntent,
  stemWord,
  tokenize,
  withinOneEdit,
} from "../src/tools/_router.js";

// ---------------------------------------------------------------------------
// A seven-tool manifest: two confusable Gmail reads, a destructive send, a calendar pair,
// an UNLISTED Sheets tool (the proxy case) and a Tasks write. Drive and Photos are absent on
// purpose — a query that names them must land on the "group is disabled" row.
// ---------------------------------------------------------------------------

const make = (over: Partial<ManifestEntry> & Pick<ManifestEntry, "name" | "service" | "verb" | "resource">): ManifestEntry => ({
  group: over.service,
  useWhen: "",
  returns: "",
  keywords: [],
  keywordsHe: [],
  related: [],
  write: false,
  destructive: false,
  idempotent: false,
  listed: true,
  required: [],
  optional: [],
  ...over,
});

const MANIFEST: ManifestEntry[] = [
  make({
    name: "gmail_search_messages",
    service: "gmail",
    verb: "search",
    resource: "messages",
    useWhen: "find mail by sender, subject, label or date",
    returns: "message ids with snippets",
    keywords: ["find mail", "search email", "from someone", "about"],
    keywordsHe: ["חפש מייל", "מצא הודעה"],
    required: ["query"],
    optional: ["max_results"],
  }),
  make({
    name: "gmail_read_message",
    service: "gmail",
    verb: "read",
    resource: "message",
    useWhen: "read the body of one message whose id is known",
    returns: "headers and the body text",
    keywords: ["read email", "open mail", "body"],
    keywordsHe: ["קרא מייל", "תוכן ההודעה"],
    doNotUseWhen: "the message still has to be found — use gmail_search_messages.",
    required: ["message_id"],
    optional: ["max_chars"],
  }),
  make({
    name: "gmail_send_message",
    service: "gmail",
    verb: "send",
    resource: "message",
    useWhen: "send a new mail as the connected account",
    returns: "the sent message id",
    keywords: ["send email", "mail them"],
    keywordsHe: ["שלח מייל", "תשלח הודעה"],
    write: true,
    destructive: true,
    required: ["to", "subject", "body", "confirm"],
  }),
  make({
    name: "calendar_list_events",
    service: "calendar",
    verb: "list",
    resource: "events",
    useWhen: "list the events in a time range",
    returns: "events with start, end and attendees",
    keywords: ["agenda", "schedule", "what is on"],
    keywordsHe: ["מה יש ביומן", "סדר יום"],
    optional: ["time_min", "time_max"],
  }),
  make({
    name: "calendar_delete_event",
    service: "calendar",
    verb: "delete",
    resource: "event",
    useWhen: "delete an event from a calendar",
    returns: "confirmation that the event is gone",
    keywords: ["cancel the meeting", "remove event"],
    keywordsHe: ["בטל פגישה", "תמחק אירוע"],
    write: true,
    destructive: true,
    idempotent: true,
    required: ["calendar_id", "event_id"],
  }),
  make({
    name: "sheets_read_range",
    service: "sheets",
    verb: "read",
    resource: "range",
    useWhen: "read the values of a known A1 range or a whole tab",
    returns: "the cell values as rows",
    keywords: ["read cells", "values", "column"],
    keywordsHe: ["קרא תאים", "ערכים"],
    listed: false,
    required: ["spreadsheet_id", "range"],
  }),
  make({
    name: "tasks_create_task",
    service: "tasks",
    verb: "create",
    resource: "task",
    useWhen: "add a task to a task list",
    returns: "the new task id",
    keywords: ["add a todo", "remind me to"],
    keywordsHe: ["תוסיף משימה", "מטלה חדשה"],
    write: true,
    required: ["title"],
    optional: ["tasklist_id", "due"],
  }),
];

const top = (query: string, opts?: Parameters<typeof route>[2]) => route(query, MANIFEST, opts).candidates[0]?.name;

/**
 * Two tools that are word-for-word the same in different products: the only way to build a
 * genuine tie now that a destructive tool is pushed down when the query never named its verb.
 * `ambiguity` and the `ambiguous` next_action row are exercised against this.
 */
const TIE: ManifestEntry[] = [
  make({ name: "gmail_read_thread", service: "gmail", verb: "read", resource: "thread", useWhen: "read a whole conversation", returns: "every message in the conversation", keywords: ["conversation", "whole chain"], required: ["thread_id"] }),
  make({ name: "chat_read_thread", service: "chat", verb: "read", resource: "thread", useWhen: "read a whole conversation", returns: "every message in the conversation", keywords: ["conversation", "whole chain"], required: ["thread_id"] }),
];

// ---------------------------------------------------------------------------
// ROUTER_PARAMS — every constant pinned, so tuning is always an explicit diff (rule #3).
// ---------------------------------------------------------------------------

describe("ROUTER_PARAMS", () => {
  it("pins every scoring constant", () => {
    expect(ROUTER_PARAMS).toEqual({
      maxCandidates: 3,
      highMargin: 0.25,
      mediumMargin: 0.1,
      maxQueryChars: 500,
      maxTokens: 40,
      fuzzyMinChars: 5,
      fuzzyPenalty: 0.6,
      bigramBoost: 1.6,
      functionBigramWeight: 0.25,
      bigramSkip: 1,
      weights: { name: 3, facet: 2.4, keyword: 2, useWhen: 1.4, returns: 1 },
      saturation: 1.2,
      maxTermFrequency: 3,
      serviceBonus: 1.2,
      verbBonus: 0.8,
      resourceBonus: 1,
      pluralAgreementBonus: 0.5,
      signalServiceBonus: 1.5,
      signalResourceBonus: 1.5,
      exactNameBonus: 6,
      crossServiceDiscount: 0.35,
      avoidPenalty: 0.8,
      functionWordWeight: 0.25,
      destructiveNoVerbPenalty: 0.5,
      minScore: 1,
      mediumMinDensity: 1.5,
      highMinDensity: 2.8,
      highMinFacets: 2,
      destructiveHighMinFacets: 3,
      maxLimit: 10,
      maxParams: 8,
      maxNamedParams: 4,
    });
  });

  it("keeps the three PR-3 values and the weight keys the index uses", () => {
    expect([ROUTER_PARAMS.maxCandidates, ROUTER_PARAMS.highMargin, ROUTER_PARAMS.mediumMargin]).toEqual([3, 0.25, 0.1]);
    expect(Object.keys(ROUTER_PARAMS.weights)).toEqual([...ROUTER_FIELDS]);
    // The name of a tool outweighs its prose, and a facet outweighs a keyword.
    expect(ROUTER_PARAMS.weights.name).toBeGreaterThan(ROUTER_PARAMS.weights.facet);
    expect(ROUTER_PARAMS.weights.facet).toBeGreaterThan(ROUTER_PARAMS.weights.keyword);
    expect(ROUTER_PARAMS.weights.keyword).toBeGreaterThan(ROUTER_PARAMS.weights.returns);
    // A destructive tool is held to a strictly higher bar than an ordinary one.
    expect(ROUTER_PARAMS.destructiveHighMinFacets).toBeGreaterThan(ROUTER_PARAMS.highMinFacets);
    expect(ROUTER_PARAMS.destructiveNoVerbPenalty).toBeLessThan(1);
    // Grammar is worth the same little as a unigram whether it comes alone or in a pair.
    expect(ROUTER_PARAMS.bigramBoost * ROUTER_PARAMS.functionBigramWeight).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// §C.1 tokenizer
// ---------------------------------------------------------------------------

describe("tokenizer", () => {
  it("applies NFKC, lowercases and drops one-character noise", () => {
    expect(tokenize("ＧＭＡＩＬ Search").tokens).toEqual(["gmail", "search"]);
    expect(tokenize("a b spreadsheet").tokens).toEqual(["spreadsheet"]);
  });

  it("strips niqqud and folds Hebrew final letters", () => {
    expect(fold("מֵייל")).toBe("מייל");
    expect(fold("אלבום")).toBe("אלבומ");
    expect(fold("מיילים")).toBe("מיילימ");
    // Folding is what makes the two forms comparable at all.
    expect(fold("אלבום").endsWith("ם")).toBe(false);
  });

  it("strips a clitic only when the lexicon knows what is left", () => {
    expect(stemWord("המייל")).toBe("מייל");
    expect(stemWord("ביומן")).toBe("יומנ");
    expect(stemWord("מחר")).toBe("מחר"); // ־מ is a clitic, but חר is not a word
    expect(stemWord("שלח")).toBe("שלח"); // ־ש is a clitic, but לח is not a word
  });

  it("singularises English only when the singular is a lexicon word", () => {
    expect(stemWord("spreadsheets")).toBe("spreadsheet");
    expect(stemWord("messages")).toBe("message");
    expect(stemWord("address")).toBe("address");
    expect(stemWord("progress")).toBe("progress");
  });

  it("emits adjacent bigrams for multi-word terms", () => {
    const t = tokenize("free busy tomorrow");
    expect(t.bigrams).toEqual(["free busy", "busy tomorrow"]);
    expect(t.terms).toEqual(["free", "busy", "tomorrow", "free busy", "busy tomorrow"]);
  });

  it("caps at 500 characters and 40 tokens", () => {
    const long = `${"word ".repeat(200)}needle`;
    const t = tokenize(long);
    expect(t.tokens.length).toBe(ROUTER_PARAMS.maxTokens);
    expect(t.tokens).not.toContain("needle");
    expect(tokenize(`${"x".repeat(499)} spreadsheet`).tokens).toEqual([`${"x".repeat(499)}`]);
  });
});

describe("withinOneEdit", () => {
  it("accepts one substitution, insertion, deletion or adjacent transposition", () => {
    expect(withinOneEdit("calendar", "calender")).toBe(true);
    expect(withinOneEdit("spredsheet", "spreadsheet")).toBe(true);
    expect(withinOneEdit("spreadsheet", "spredsheet")).toBe(true);
    expect(withinOneEdit("mesage", "message")).toBe(true);
    expect(withinOneEdit("recieve", "receive")).toBe(true);
    expect(withinOneEdit("event", "event")).toBe(true);
  });

  it("rejects two edits or more", () => {
    expect(withinOneEdit("spredsheat", "spreadsheet")).toBe(false);
    expect(withinOneEdit("calendar", "calandra")).toBe(false);
    expect(withinOneEdit("event", "events!")).toBe(false);
    expect(withinOneEdit("", "ab")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §C.2 index
// ---------------------------------------------------------------------------

describe("index", () => {
  it("is memoised per manifest array", () => {
    expect(buildRouterIndex(MANIFEST)).toBe(buildRouterIndex(MANIFEST));
    expect(buildRouterIndex([...MANIFEST])).not.toBe(buildRouterIndex(MANIFEST));
  });

  it("indexes no term that is only grammar, and records the resource's plurality", () => {
    const index = buildRouterIndex(MANIFEST);
    for (const tool of index.tools) {
      for (const term of tool.terms.keys()) expect(term.split(" ").every((w) => FUNCTION_TOKENS.has(w)), `${tool.entry.name}: "${term}"`).toBe(false);
    }
    // "what is on" is a calendar_list_events keyword — its content survives, its grammar does not.
    expect(index.byName.get("calendar_list_events")?.terms.has("what is")).toBe(false);
    expect(index.byName.get("calendar_list_events")?.pluralResource).toBe(true);
    expect(index.byName.get("calendar_delete_event")?.pluralResource).toBe(false);
    expect(tokenize("what labels exist").plural).toBe(true);
    expect(tokenize("what label exists").plural).toBe(false);
  });

  it("indexes a group only when it is not just the service spelled again", () => {
    // `groupOf("gmail")` is "Gmail", which folds to the same token — indexing both silently
    // doubled that token's frequency for every non-Meta tool.
    const own = buildRouterIndex([make({ name: "gmail_read_message", service: "gmail", group: "Gmail", verb: "read", resource: "message" })]).tools[0];
    const other = buildRouterIndex([make({ name: "gmail_read_message", service: "gmail", group: "Photos", verb: "read", resource: "message" })]).tools[0];
    // The service token is counted the same either way: the group never inflates it…
    expect(own.terms.get("gmail")?.facet).toBe(other.terms.get("gmail")?.facet);
    // …and a group that really is a different word (Meta, or the mislabelled one here) indexes.
    expect(own.terms.has("photo")).toBe(false);
    expect(other.terms.get("photo")?.facet).toBeGreaterThan(0);
  });

  it("indexes the name, the facets, the keywords and the intent text of every entry", () => {
    const index = buildRouterIndex(MANIFEST);
    expect(index.tools.length).toBe(MANIFEST.length);
    const send = index.byName.get("gmail_send_message");
    expect(send?.terms.get("send")).toMatchObject({ name: expect.any(Number), facet: expect.any(Number) });
    expect(send?.terms.get("שלח")).toBeDefined(); // Hebrew keyword and verb lexicon
    expect(send?.terms.get("sent")).toMatchObject({ returns: 1 });
    expect(index.services).toEqual(new Set(["gmail", "calendar", "sheets", "tasks"]));
  });

  it("gives a rare term more IDF than a common one", () => {
    const index = buildRouterIndex(MANIFEST);
    expect(index.idf.get("gmail")!).toBeLessThan(index.idf.get("agenda")!);
    expect(index.idf.get("agenda")!).toBeGreaterThan(0);
  });

  it("keeps doNotUseWhen terms that no positive field shares", () => {
    const read = buildRouterIndex(MANIFEST).byName.get("gmail_read_message");
    expect([...(read?.avoid ?? [])]).toContain("found");
    expect([...(read?.avoid ?? [])]).not.toContain("message");
  });

  it("counts only words the tool does not use itself, sibling verb included", () => {
    // An earlier round exempted the named sibling's VERB from this filter. It was reverted: on the
    // real catalog it did nothing for the pair it was written for, and it fired where it hurt.
    const pair: ManifestEntry[] = [
      make({ name: "drive_share_file", service: "drive", verb: "share", resource: "file", useWhen: "grant access to a file", returns: "the permission id", keywords: ["give access", "share"], doNotUseWhen: "access is being taken away — use drive_delete_permission to remove it." }),
      make({ name: "drive_delete_permission", service: "drive", verb: "delete", resource: "permission", useWhen: "revoke one person's access", returns: "confirmation", keywords: ["revoke access", "stop sharing"] }),
    ];
    const index = buildRouterIndex(pair);
    const avoid = index.byName.get("drive_share_file")!.avoid;
    expect([...avoid]).toContain("remove");
    // "access" is in this tool's OWN text, so it says nothing about which of the pair is meant.
    expect([...avoid]).not.toContain("access");
    expect(route("remove access to that file", pair).candidates[0].name).toBe("drive_delete_permission");
  });

  it("never turns a warning into a push toward the irreversible sibling", () => {
    // The regression the exemption caused: gmail_create_draft names gmail_send_message, so "send"
    // landed in the DRAFT tool's avoid set and every "draft an email I will send later" query
    // pushed the send tool up. The word is in the draft tool's own text, so it must not count.
    const pair: ManifestEntry[] = [
      make({ name: "gmail_create_draft", service: "gmail", verb: "create", resource: "draft", useWhen: "prepare an email to send later", returns: "the draft id", keywords: ["draft", "write an email to send"], doNotUseWhen: "the user asked to send now — use gmail_send_message." }),
      make({ name: "gmail_send_message", service: "gmail", verb: "send", resource: "message", useWhen: "send an email now", returns: "the message id", destructive: true }),
    ];
    expect([...buildRouterIndex(pair).byName.get("gmail_create_draft")!.avoid]).not.toContain("send");
    expect(route("draft an email I will send later", pair).candidates[0].name).toBe("gmail_create_draft");
  });
});

// ---------------------------------------------------------------------------
// §C.3 intent and scoring
// ---------------------------------------------------------------------------

describe("intent", () => {
  const intentOf = (q: string) => readIntent(q, buildRouterIndex(MANIFEST), new Set(tokenize(q).tokens));

  it("reads service, verb and resource from the query's own words", () => {
    const intent = intentOf("delete the standup event from my calendar");
    expect(intent.service).toBe("calendar");
    expect(intent.verb).toBe("delete");
    expect(intent.resource).toBe("event");
  });

  it("reads Hebrew as a first-class input", () => {
    const intent = intentOf("שלח מייל לדנה");
    expect(intent.service).toBe("gmail");
    expect(intent.verb).toBe("send");
  });

  it("names no service when the query names two equally well", () => {
    expect(intentOf("find the pricing doc in the spreadsheet").service).toBeUndefined();
  });

  it("reports a service this deployment does not have as missing, never as a candidate", () => {
    const intent = intentOf("share the file in google drive");
    expect(intent.service).toBeUndefined();
    expect(intent.missingService).toBe("drive");
  });

  it("takes a hard signal over the lexicon", () => {
    expect(intentOf("what is in A1:D20 of that file").signals.map((s) => s.id)).toContain("range_a1");
    expect(intentOf("mail me about spaces/AAQA/messages/x").signals.map((s) => s.id)).toContain("space_chat");
  });
});

describe("scoring", () => {
  it("routes plain English to the right tool", () => {
    expect(top("find the mail from Dana about the invoice")).toBe("gmail_search_messages");
    expect(top("what is on my agenda tomorrow")).toBe("calendar_list_events");
    expect(top("add a todo to call the supplier")).toBe("tasks_create_task");
    expect(top("read the values in that column")).toBe("sheets_read_range");
  });

  it("routes plain Hebrew to the right tool", () => {
    expect(top("שלח מייל לדנה")).toBe("gmail_send_message");
    expect(top("מה יש ביומן מחר")).toBe("calendar_list_events");
    expect(top("תוסיף משימה לקנות חלב")).toBe("tasks_create_task");
    expect(top("תמחק את האירוע")).toBe("calendar_delete_event");
  });

  it("tolerates one typo in a long English word, and never in Hebrew", () => {
    expect(top("cancel the meating")).toBe("calendar_delete_event");
    expect(top("search my emial")).toBe("gmail_search_messages");
    expect(top("read the mesage body")).toBe("gmail_read_message");
    // A Hebrew typo is a different word: it must not silently become one.
    expect(tokenize("מיול").tokens).toEqual(["מיול"]);
  });

  it("does not let a typo correction name the service — only rank", () => {
    // A correction is a guess. `gmail` on a Gmail-less deployment is one edit from `email`, and
    // letting the guess speak for the user turned "that group is switched off" into an answer.
    const off = route("search my gmail for the invoice", MANIFEST.filter((e) => e.service !== "gmail"));
    expect(off.intent.service).toBeUndefined();
    expect(off.next_action).toBe(NEXT_ACTION.disabled({ service: "gmail" }));
  });

  it("collapses the ת- imperative onto the verb it is a form of", () => {
    expect(tokenize("תסמן את המשימה").tokens).toEqual(["סמנ", "את", "משימה"]);
    // …and only when the remainder is a VERB: an ordinary noun keeps its first letter.
    expect(stemWord("תמונה")).toBe("תמונה");
    expect(stemWord("תשובה")).toBe("תשובה");
  });

  it("bridges one function word when it builds a bigram", () => {
    // Hebrew's accusative `את` is obligatory, so the pair the keyword lists are written in only
    // exists as a skip-bigram.
    // The pair must be the one a keyword is WRITTEN in (`חפש קובץ`), not the definite form: an
    // earlier version pinned `חפש הקובצ`, which no keyword can ever match, so the test passed
    // while the lookup it stands for failed.
    expect(tokenize("תחפש את הקובץ").bigrams).toContain("חפש קובצ");
    expect(tokenize("תחפש קובץ").bigrams).toContain("חפש קובצ");
    expect(tokenize("read the message").bigrams).toContain("read message");
    // One skip, not two: `ROUTER_PARAMS.bigramSkip`.
    expect(tokenize("send it to the boss").bigrams).not.toContain("send boss");
  });

  it("discounts other services once the query names one", () => {
    const named = route("read the gmail message", MANIFEST);
    expect(named.intent.service).toBe("gmail");
    expect(named.candidates.every((c) => c.service === "gmail")).toBe(true);
  });

  it("lets doNotUseWhen push a tool down when its own fields do not answer", () => {
    const withoutAvoid = route("find that mail", MANIFEST).candidates.map((c) => c.name);
    expect(withoutAvoid[0]).toBe("gmail_search_messages");
    expect(withoutAvoid.indexOf("gmail_read_message")).toBeGreaterThan(0);
  });

  it("proposes only tools from the manifest it was given", () => {
    const names = new Set(MANIFEST.map((e) => e.name));
    for (const q of ["share a photo album", "send an email", "delete everything", "מה קורה"]) {
      for (const c of route(q, MANIFEST).candidates) expect(names.has(c.name)).toBe(true);
    }
    expect(route("send an email to dana", []).candidates).toEqual([]);
  });

  it("honours the service filter and the candidate limit", () => {
    expect(route("read the message", MANIFEST, { service: "calendar" }).candidates.every((c) => c.service === "calendar")).toBe(true);
    expect(route("the message", MANIFEST, { limit: 1 }).candidates.length).toBe(1);
    expect(route("the message", MANIFEST, { limit: 99 }).candidates.length).toBeLessThanOrEqual(MANIFEST.length);
    expect(route("the message", MANIFEST).candidates.length).toBe(ROUTER_PARAMS.maxCandidates);
  });

  it("wins outright when the query spells a tool name out", () => {
    const r = route("call gmail_read_message for me", MANIFEST);
    expect(r.candidates[0].name).toBe("gmail_read_message");
    expect(r.confidence).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// §C.4 confidence — including the safety half of "no silent choice"
// ---------------------------------------------------------------------------

describe("confidence", () => {
  it("is high only with a margin, two facets and a score", () => {
    const r = route("delete the standup event from my calendar", MANIFEST);
    expect(r.candidates[0].name).toBe("calendar_delete_event");
    expect(r.confidence).toBe("high");
    expect(r.ambiguity).toBe(false);
  });

  it("never lets a destructive tool reach high without an explicit verb", () => {
    for (const q of ["that event", "the standup meeting tomorrow", "mail dana", "the invoice mail", "אירוע", "המייל של דנה"]) {
      const r = route(q, MANIFEST);
      const first = r.candidates[0];
      if (first?.destructive) expect(r.confidence, `${q} → ${first.name}`).not.toBe("high");
    }
  });

  it("does let a destructive tool reach high when the user said the verb", () => {
    const r = route("send the email", MANIFEST);
    expect(r.candidates[0].name).toBe("gmail_send_message");
    expect(r.candidates[0].destructive).toBe(true);
    expect(r.confidence).toBe("high");
  });

  it("reports ambiguity when the top two are within the medium margin", () => {
    const r = route("read the whole conversation", TIE);
    expect(r.candidates.length).toBe(2);
    expect(r.ambiguity).toBe(true);
    expect(r.confidence).toBe("low");
  });

  it("holds a destructive tool to a higher bar than the facet count alone", () => {
    // A hard signal donates the service for free, so a vague verb next to a pasted URL used to
    // clear the ordinary two-facet floor: "clear it out <sheets url>" reached `high` on a tool
    // that wipes cells. The gate counts facets the QUERY's OWN WORDS earned.
    const sheets: ManifestEntry[] = [
      make({ name: "sheets_clear_range", service: "sheets", verb: "clear", resource: "range", useWhen: "clear the values in a range", returns: "the cleared range", keywords: ["clear the cells", "wipe the values"], write: true, destructive: true, idempotent: true, required: ["spreadsheet_id", "range"] }),
      make({ name: "sheets_read_range", service: "sheets", verb: "read", resource: "range", useWhen: "read the values of a range", returns: "the values", keywords: ["read cells"], required: ["spreadsheet_id", "range"] }),
    ];
    for (const q of ["clear it out https://docs.google.com/spreadsheets/d/1AbCdEf/edit", "wipe it out A1:ZZ999", "תנקה את זה A1:D99"]) {
      const r = route(q, sheets);
      if (r.candidates[0]?.destructive) expect(r.confidence, `${q} → ${r.candidates[0].name}`).not.toBe("high");
    }
    // Not a blanket ban: spell the verb, the noun and the product out and the gate lets it through.
    const spelled = route("delete the standup event from my calendar", MANIFEST);
    expect(spelled.candidates[0]).toMatchObject({ name: "calendar_delete_event", destructive: true });
    expect(spelled.confidence).toBe("high");
  });

  it("does not let an irreversible tool LEAD a list it was not asked for", () => {
    // The §C.4 gate governed the label; ranking was untouched, so a scheduling question could be
    // answered with a delete tool at the top of the list — which PR-6b hands to a model.
    const r = route("the standup meeting tomorrow", MANIFEST);
    expect(r.candidates[0]?.destructive ?? false).toBe(false);
  });

  it("stays low on a query with nothing to go on", () => {
    expect(route("do the thing", MANIFEST).confidence).toBe("low");
    expect(route("", MANIFEST).confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// §C.5 next_action
// ---------------------------------------------------------------------------

describe("next_action", () => {
  it("covers every case with deterministic text", () => {
    expect(route("", MANIFEST).next_action).toBe(NEXT_ACTION.empty({}));
    expect(route("share the file in google drive", MANIFEST).next_action).toBe(NEXT_ACTION.disabled({ service: "drive" }));
    expect(route("zzzz qqqq", MANIFEST).next_action).toBe(NEXT_ACTION.none({}));
    const ambiguous = route("read the whole conversation", TIE);
    expect(ambiguous.next_action).toBe(NEXT_ACTION.ambiguous({ top: ambiguous.candidates[0], second: ambiguous.candidates[1] }));
    const proxied = route("read the values in that column", MANIFEST);
    expect(proxied.candidates[0].listed).toBe(false);
    expect(proxied.confidence).toBe("high");
    expect(proxied.next_action).toBe(NEXT_ACTION.proxy({ top: proxied.candidates[0] }));
    const call = route("delete the standup event from my calendar", MANIFEST);
    expect(call.next_action).toBe(NEXT_ACTION.call({ top: call.candidates[0] }));
    // The caller's own filter emptied the list, not the query (§Q16).
    const filtered = route("find the emails from dana", MANIFEST, { service: "photos" });
    expect(filtered.candidates).toEqual([]);
    expect(filtered.next_action).toBe(NEXT_ACTION.filtered({ service: "photos" }));
    expect(filtered.next_action).toMatch(/photos/);
  });

  it("names the runner-up even when the caller asked for one candidate", () => {
    // `ambiguity` is decided on the ranking, so the text has to be too: built from `candidates`
    // it printed the literal string "undefined (undefined)" whenever limit was 1.
    const one = route("read the whole conversation", TIE, { limit: 1 });
    expect(one.ambiguity).toBe(true);
    expect(one.candidates).toHaveLength(1);
    expect(one.next_action).not.toContain("undefined");
    expect(one.next_action).toContain("gmail_read_thread");
    expect(one.next_action).toContain("chat_read_thread");
  });

  it("tells a weak match to be described first even when it is hidden", () => {
    // §C.5's conservative row must survive a compact deployment: choosing the row on `listed`
    // before confidence made "call it through google_call_tool" the answer to a weak match.
    const hidden = MANIFEST.map((e) => ({ ...e, listed: false }));
    const weak = route("anything about the invoice", hidden);
    expect(weak.confidence).not.toBe("high");
    expect(weak.candidates[0].listed).toBe(false);
    expect(weak.next_action).toBe(NEXT_ACTION.describe({ top: weak.candidates[0] }));
    expect(weak.next_action).toContain("google_describe_tool");
    expect(weak.next_action).toContain("google_call_tool");
  });

  it("says nothing here can do that without also offering another product tool", () => {
    // The `disabled` row and the candidate list used to be computed independently, so a result
    // whose text said "no drive tool is enabled" still handed the caller a destructive Sheets one.
    const r = route("delete the file from google drive", MANIFEST);
    expect(r.next_action).toBe(NEXT_ACTION.disabled({ service: "drive" }));
    expect(r.candidates).toEqual([]);
    expect(r.confidence).toBe("low");
  });

  it("names the parameters and the gates the caller has to satisfy", () => {
    const send = route("send the email", MANIFEST);
    expect(send.next_action).toContain("Call gmail_send_message directly with to, subject, body, confirm.");
    expect(send.next_action).toContain("It is destructive");
    expect(send.next_action).toContain("confirm=true");
    const list = route("what is on my agenda tomorrow", MANIFEST);
    expect(list.next_action).not.toContain("destructive");
    expect(list.next_action).not.toContain("confirm=true");
  });

  it("sends a weak match to google_describe_tool first", () => {
    // One faint keyword hit and no facet at all: a real candidate, but not one to call blind.
    // "what is on my agenda tomorrow" used to sit here and now clears the `high` gate — which is
    // the right answer for that query, so the weak case needed a genuinely weaker one.
    const weak = route("anything about the invoice", MANIFEST);
    expect(weak.confidence).not.toBe("high");
    expect(weak.next_action).toBe(NEXT_ACTION.describe({ top: weak.candidates[0] }));
  });
});

// ---------------------------------------------------------------------------
// §C.6 the returned shape
// ---------------------------------------------------------------------------

describe("route", () => {
  it("returns a RouteResult that parses against the PR-3 schema", () => {
    for (const q of ["send an email to dana", "מה יש ביומן מחר", "", "read A1:D20", "zzz"]) {
      const r = route(q, MANIFEST);
      expect(() => RouteResult.parse(r)).not.toThrow();
      expect(r.query).toBe(q);
      for (const c of r.candidates) {
        expect(c.params.length).toBeLessThanOrEqual(ROUTER_PARAMS.maxParams);
        expect(c.source.length).toBeGreaterThan(0);
      }
    }
  });

  it("fills readOnly, destructive, listed and needsConfirm from the manifest entry", () => {
    const send = route("send the email", MANIFEST).candidates[0];
    expect(send).toMatchObject({ name: "gmail_send_message", service: "gmail", readOnly: false, destructive: true, listed: true, needsConfirm: true });
    const read = route("read the values in that column", MANIFEST).candidates[0];
    expect(read).toMatchObject({ name: "sheets_read_range", readOnly: true, destructive: false, listed: false, needsConfirm: false });
    expect(send.summary).toBe("send a new mail as the connected account");
  });

  it("is deterministic: the same query twice is the same result", () => {
    for (const q of ["find the mail from Dana", "מה יש ביומן מחר", "the message", "do the thing", ""]) {
      expect(route(q, MANIFEST)).toEqual(route(q, MANIFEST));
      expect(route(q, [...MANIFEST])).toEqual(route(q, MANIFEST)); // and not an artefact of the memo
    }
  });

  it("ignores a caller limit that is not a finite number", () => {
    // `Math.trunc(NaN)` is NaN and `slice(0, NaN)` is empty, so an unvalidated limit turned a
    // perfectly good match into "No tool matches this query".
    const sane = route("send the email", MANIFEST).candidates;
    expect(route("send the email", MANIFEST, { limit: Number.NaN }).candidates).toEqual(sane);
    expect(route("send the email", MANIFEST, { limit: Number.POSITIVE_INFINITY }).candidates).toEqual(sane);
    expect(route("send the email", MANIFEST, { limit: 0 }).candidates).toHaveLength(1);
  });

  it("caps the query it echoes at maxQueryChars", () => {
    const r = route("x".repeat(600), MANIFEST);
    expect(r.query.length).toBe(ROUTER_PARAMS.maxQueryChars);
  });
});


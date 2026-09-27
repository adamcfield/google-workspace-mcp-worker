/**
 * The deterministic mutation gate.
 *
 * Tool selection narrows ~160 tool schemas down to the handful a request actually needs. A
 * language model is good at that narrowing and bad at being trusted with it: the failure that
 * matters is not "picked a slightly worse tool", it is "quietly dropped the tool that would have
 * asked the user before sending, deleting or overwriting something".
 *
 * So the gate is computed here, deterministically, from the request text and the catalog alone,
 * before any model is consulted. Whatever the model later proposes is UNIONED with this set —
 * never intersected with it. A model cannot remove a tool the gate put in, and a model failure
 * leaves the gate's answer standing on its own.
 *
 * Two rules do the work:
 *
 *  1. **No stated change, no writing tools.** If the request names no mutating verb, the gate
 *     returns nothing, and since the ranker is restricted to read tools the selection cannot
 *     contain a write at all. "Find the emails from the supplier" and "send an email to the
 *     supplier" score alike on a similarity ranker; they do not here.
 *  2. **A change with no stated target is only guessed at when a mistake is recoverable or
 *     re-confirmed.** For "remove it" the gate ranks writing tools and then refuses: the best
 *     candidates are irreversible, the request names no object, and nothing would ask the user
 *     again before it ran. A non-destructive write in the same position is allowed through, and so
 *     is an irreversible one that carries its own `confirm` argument — "send it" reaches the send
 *     tools precisely because sending asks first.
 *
 *     The target is judged PER TOOL. An irreversible tool is offered only when the request names
 *     that tool's own service or its own resource, or pastes an object that belongs to it — naming
 *     something else does not count. "delete the comment" names a comment, and no irreversible
 *     tool deletes comments, so it is refused like "remove it"; it must not become a licence to
 *     offer `drive_delete_file` or `calendar_delete_event`, which is what a single request-wide
 *     "named anything at all" flag did. Every irreversible tool, `confirm` or not, also needs its
 *     own verb said — a recoverable verb's family is no route to one — and, on a request that names
 *     anything, a place within the gate's cap in the ranking: refusing one tool never brings up
 *     another that ranked below it.
 */

import { VERB_KINDS, VERBS, type Kind, type Verb } from "../tools/naming.js";
import { VERB_LEXICON, SERVICE_LEXICON, RESOURCE_LEXICON } from "../tools/_lexicon.js";
import { fold, tokenize, route, SPLIT_RE, META_SERVICE, ROUTER_PARAMS } from "../tools/_router.js";
import { matchHardSignals, type HardSignal } from "../tools/_lexicon.js";
import type { ManifestEntry } from "../tools/_manifest.js";

/** Tuning constants, in one object so a change is visible in a diff. */
export const GATE_PARAMS = {
  /** How deep the router is asked to rank before the write pool is filtered out of the result. */
  rankDepth: 10,
  /** Writing tools kept from the whole-catalog ranking pass. */
  globalDepth: 3,
  /** Writing tools kept from each service's ranking pass. */
  perServiceDepth: 2,
  /**
   * Ceiling on the gate's ranked answer. The gate's tools are pinned downstream — no cap may evict
   * them — so an unbounded gate crowds out the reading tools the same request needs. Kept in rank
   * order, with the services the request actually named ranked first. A tool admitted on evidence
   * comes on top: the tools of each `OWN_EVIDENCE_VERBS` verb the request read (`fill` has one) and
   * each `OWN_EVIDENCE_CUES` / `OWN_EVIDENCE_PATTERNS` tool whose cue or pattern it read.
   */
  maxTools: 5,
} as const;

/** The document elements a spacing or alignment cue is tied to. */
const DOC_TEXT_ELEMENTS = ["paragraph", "paragraphs", "table", "heading"] as const;

/**
 * "add more space below the table", "less space between the paragraphs": a change in the amount
 * of space, next to a document element. Both halves are required — see the `update` entry below —
 * so "how much space above the table is there" (no change asked) and "more messages from the team
 * space" (no document element) stay reads.
 */
const SPACE_CHANGE_NEAR_DOC_ELEMENT: readonly string[] = ["add", "put", "leave", "more", "less", "extra", "increase", "reduce"].flatMap((change) =>
  DOC_TEXT_ELEMENTS.map((element) => `${change} space ${element}`),
);

/**
 * "justify the paragraphs", "center the title", "align the text to the right": alignment, tied to
 * the text being aligned. Bare "justify" is how people ask for reasons ("justify the budget in the
 * email"), "center" is a noun ("the cost center in the report") and "align" means "agree", so none
 * of the three counts on its own.
 */
const ALIGN_DOC_TEXT: readonly string[] = ["justify", "center", "align"].flatMap((verb) =>
  ["text", "paragraph", "paragraphs", "title", "heading", "headings"].map((element) => `${verb} ${element}`),
);

/**
 * "comment on the proposal doc that the numbers are wrong": "comment" as the verb. The bare pair
 * "comment on" would also match every question about the comments ON a document ("show me the
 * comments on the design doc"), so the cue needs what the comment should say to follow.
 */
const COMMENT_ON_DOC: readonly string[] = ["doc", "document", "section"].flatMap((target) => ["that", "saying"].map((what) => `comment on ${target} ${what}`));

/**
 * Mutation cues the shared routing lexicon does not carry.
 *
 * `VERB_LEXICON` is tuned for ranking: it answers "which tool is this about". The gate asks a
 * different question — "did the user ask for something to change at all" — and has to err the
 * other way, because a missed cue means a writing tool is never offered while a spurious one only
 * costs a few schema tokens. These entries may therefore only ever ADD mutation intent.
 *
 * They are kept here rather than merged into the shared lexicon so that tuning the gate's recall
 * cannot move the ranker's tuned fixtures underneath it.
 */
export const MUTATION_CUES: Partial<Record<Verb, { en: readonly string[]; he: readonly string[] }>> = {
  // A comment is created, and so is a reply to one (resolving included). The gate narrows its pool
  // to the verbs it read BEFORE ranking, so a comment request has to read as `create` itself:
  // "reply to the comment" read only as `send` (mail tools), "mark the comment as resolved" only as
  // `modify` and "respond to the comment" only as `rsvp`, and the reply tool was never in the pool.
  // "mark" and "סמן" are also the Tasks words for done, so the resolved cues name the comment too.
  create: {
    en: [
      "book", "schedule", "set up", "arrange", "put together",
      "leave a comment", "post a comment", "write a comment", "reply to comment", "respond to comment", "answer comment", "resolve comment", "mark comment resolved",
      ...COMMENT_ON_DOC,
    ],
    he: [
      "תקבע", "קבע", "לקבוע", "תזמן", "לתזמן", "תארגן",
      "תשאיר הערה", "תכתוב הערה", "תענה להערה", "תגיב להערה", "תסגור את ההערה", "תפתור את ההערה", "סמן הערה כפתורה", "תסמן הערה כפתורה", "תסמן הערה נפתרה",
    ],
  },
  upload: { en: ["save to drive", "save it to", "put it in drive", "store in drive", "save the file to"], he: ["תשמור בדרייב", "שמור בדרייב", "להעלות לדרייב"] },
  send: { en: ["email me", "email them", "email him", "email her", "email it", "mail me", "message them", "post a message", "post in", "reply to"], he: ["תשלח לי", "תשלח להם", "תמסור", "תפרסם"] },
  // Paragraph formatting. Spacing is asked for as more or less of it, or as a change of the space
  // next to a paragraph, table or heading: "add more space below the table" is a style change, not
  // an insert. Never a bare "more space", "add space" or "space below": matching is by word set in
  // any order, "more" is a function word, and "space" is the Chat and Meet noun and a Drive storage
  // word, so those cues read "show me more messages from the team space", "which files take up
  // more space in my drive" and "for each of the chat spaces below" as requests to change
  // something. Alignment and double spacing are tied to the text or document the same way.
  //
  // The Hebrew cues are imperatives tied to what changes ("תגדיל ריווח", "תיישר את הכותרת"). A bare
  // "תגדיל" / "להגדיל" is also how a budget question is asked ("בכמה להגדיל את התקציב"), and the
  // infinitive "ליישר" is how a how-to question is asked ("איך ליישר טקסט במסמך").
  update: {
    en: [
      "rename", "renaming", "set the", "change the",
      "more spacing", "less spacing", "add spacing", "increase spacing", "reduce spacing", "tighten spacing", "double spacing", "single spacing", "make line spacing",
      "double space doc", "double space document", "double space text", "double space paragraphs",
      "center align", "right align", "left align",
      ...SPACE_CHANGE_NEAR_DOC_ELEMENT,
      ...ALIGN_DOC_TEXT,
    ],
    he: [
      "תשנה את השם", "לשנות שם", "תשנה",
      "תגדיל ריווח", "תגדיל רווח", "תקטין ריווח", "תקטין רווח", "תוסיף ריווח", "תוסיף רווח",
      "תיישר טקסט", "תיישר פסקה", "תיישר הפסקה", "תיישר כותרת", "תיישר הכותרת", "תיישר למרכז", "תיישר לימין", "תיישר לשמאל", "תיישר לשני הצדדים",
      "תמרכז כותרת", "תמרכז הכותרת", "תמרכז טקסט",
    ],
  },
  // Rewording is tied to a document noun. "rewrite" / "reword" / "redo" alone are how people ask
  // for their answer to be reformatted or a lookup repeated ("rewrite this summary of my inbox",
  // "redo the search"), and as bare cues they offered trash and batch-update tools for both.
  replace: {
    en: ["rewrite section", "reword section", "redo section", "rewrite doc", "reword doc", "redo doc", "rewrite document", "reword document", "redo document"],
    he: ["תכתוב מחדש סעיף", "תנסח מחדש סעיף", "לנסח מחדש סעיף", "תכתוב מחדש מסמך", "תנסח מחדש מסמך", "לנסח מחדש מסמך", "תנסח מחדש במסמך", "לנסח מחדש במסמך"],
  },
  append: { en: ["log", "record it", "jot down"], he: ["תרשום", "לרשום"] },
  // Verb phrases only. A bare noun does not ask for a change: "what labels do I have in Gmail" is
  // a question about labels, and a cue of "label" alone turned it into a request to relabel mail.
  modify: { en: ["put a label", "add a label", "apply a label", "archive", "mark as", "mark it"], he: ["תייג", "לתייג", "תסמן", "לארכב"] },
  delete: { en: ["revoke", "remove access", "get rid of", "take off"], he: ["תבטל גישה", "להסיר"] },
  share: { en: ["give access", "invite", "grant access"], he: ["תן גישה", "לתת גישה", "תזמין"] },
  // "Copy this formula across to December" asks for a fill, not a file copy. Without these the only
  // verb read is `copy`, whose kind (`mutating`) does not admit the fill tool, so the gate never
  // offered it. Unlike every other cue, a fill term is read as a PHRASE (`evidenceIn`): its first
  // word is the verb, and every word after it is in the verb's clause, in any order. English
  // plurals fold to the singular, so "copy" + "formula"
  // alone also matched "copy the budget spreadsheet with its formulas". The English copy cues
  // therefore carry a direction too (down, across, right, the rest, the months) or a destination
  // inside the sheet: a column, a row, cells, or a typed A1 range, which reads as the word "cell"
  // (see `readRequest`). So "copy the formula in C2 to D2:N2", "to the whole column", "to the
  // other cells" and "to all rows" are fills. "whole", "other" and "all" are not cues on their own:
  // "copy the whole spreadsheet with all its formulas" duplicates a file. Hebrew needs neither:
  // the plural נוסחאות is a different token from נוסחה, so "the formula" is one formula being
  // copied. The bare fill verbs are here and not in VERB_LEXICON.fill because the ranker indexes
  // the lexicon (see the note there). "What formula is in C2" holds no verb and changes nothing.
  fill: {
    en: ["fill down", "fill across", "fill right", "fill formula", "copy formula down", "copy formula across", "copy formula right", "copy formula rest", "copy formula month", "copy formula months", "copy formula column", "copy formula row", "copy formula cell", "extend formula", "drag formula"],
    he: ["מלא נוסחה", "מלא למטה", "מלא לרוחב", "העתק נוסחה", "תעתיק נוסחה", "להעתיק נוסחה", "גרור נוסחה", "תגרור נוסחה"],
  },
};

/** Verbs that change something. Derived from the name grammar, so a new verb is covered by adding it there. */
export const MUTATING_VERBS: readonly Verb[] = VERBS.filter((v) => VERB_KINDS[v] !== "read");

/**
 * Resources named by naming another one. The per-tool target check (`namesTargetOf`) compares a
 * tool's resource with the resources a request names, and two of the catalog's resources are
 * almost never called by their own name:
 *
 *  - a Drive `file` is "the onboarding document", "the budget spreadsheet", "the Q3 deck" — the
 *    tool that deletes one is `drive_delete_file`, not a Docs or Sheets tool;
 *  - a Meet `conference` is "the meeting" — "end the meeting" ends the conference it holds.
 */
const ALSO_NAMED_BY: Readonly<Record<string, readonly string[]>> = {
  file: ["document", "spreadsheet", "presentation", "form"],
  conference: ["event"],
};

/** Services whose objects are Drive files, and the resources that name a file outright. */
const FILE_SERVICES: ReadonlySet<string> = new Set(["drive", "docs", "sheets", "slides", "forms"]);
const FILE_RESOURCES: ReadonlySet<string> = new Set(["file", "files", "folder"]);

/**
 * Verbs whose tools are admitted only when the request names that verb itself, never through the
 * family latitude `gateTools` gives recoverable verbs.
 *
 * `fill` writes one value into EVERY cell of a range, and its word is everyday language: "fill
 * in / fill out the sheet" asks for different values in different cells (`write`), and Hebrew
 * מלא is also "full" (הדוח המלא, the full report). The tool's own name puts "fill" in the ranking
 * index, which no keyword change can take out, so on those requests it outranked
 * sheets_write_range and took its slot in the capped gate. Admission is therefore decided on
 * evidence of a fill (VERB_LEXICON.fill and MUTATION_CUES.fill: a direction or destination, a
 * formula, a drag, autofill), not on the rank of a word the tool shares with ordinary requests —
 * in both directions: no evidence, no fill tool however it ranks; evidence, and the fill tool is
 * in the gate however it ranks (first, on top of the ranked answer; see `gateTools`) — unless the
 * request names other products and not Sheets, because "drag down" and "autofill" name none.
 * The evidence is read as phrases, not as a bag of words (`evidenceIn`): "fill in the right
 * names" holds "fill" and "right", and המלא ("the full") folds to מלא, but neither asks for a fill.
 *
 * The latitude is closed in the other direction too: reading `fill` admits the fill tools and
 * nothing else of its kind. A fill cue is read on a destination inside the sheet ("the formula
 * cells", "row totals"), which a file copy can mention too, so a read of one must not be able to
 * crowd the file copy, clear or send the request named out of the capped gate. And a fill that no
 * enabled tool can do pins nothing: it never falls back to the other writes.
 */
export const OWN_EVIDENCE_VERBS: ReadonlySet<Verb> = new Set<Verb>(["fill"]);

/**
 * Cues that are evidence for ONE tool, not for their verb: read and admitted exactly as the
 * evidence of an `OWN_EVIDENCE_VERBS` verb is, with the admission narrowed from that verb's tools
 * to the tool each entry is keyed by. `verb` is what `MutationIntent.verbs` reports for a cue read.
 *
 * Rows and columns are deleted, inserted and moved only through spreadsheets.batchUpdate. Without
 * these, "delete rows 5 to 7" gated to sheets_delete_sheet — which removes the whole tab — and
 * never to the tool that deletes rows (and whose dry run shows what they break). They are not
 * `MUTATION_CUES.batch_update`: that verb is `mutating_idempotent`, and a recoverable verb opens
 * its whole kind to the ranked gate (`rankedWrites`), so "insert two rows above row 5 in the
 * sheet", an additive request, put the trash, untrash, move, complete and modify tools in the pool
 * of the capped gate; "תכניס שתי שורות מעל שורה 5 בגיליון" (the same request in Hebrew) and
 * "תמחק את שורות 5 עד 7" pinned sheets_write_range, which overwrites cells, and the first of them
 * never reached the tool that inserts rows. As evidence they admit sheets_batch_update_spreadsheet
 * and nothing else: read as phrases (`evidenceIn`), put on top of the ranked answer, and never
 * passed on as a verb, so the rest of the gate is the one the request gets without them. (They
 * land wherever the request names Sheets, and "row" and "column" are Sheets words, so they always do.)
 *
 * Only these phrases are evidence. `batch_update` itself stays an ordinary verb: its lexicon words
 * ("format", "chart") are ranked as before, and "rename" still reaches the tool through `update`.
 * Nor are they ranking words (the tool's route block in `_manifest.ts`): the router indexes a
 * keyword word by word, and "delete", "insert", "move", "row" and "column" on this tool moved it
 * into the router's top ten for other requests, where it cost another write its place ("מחק
 * עמודות" lost drive_delete_file) or joined a request that names nothing ("move it").
 */
export const OWN_EVIDENCE_CUES: Readonly<Record<string, { verb: Verb; en: readonly string[]; he: readonly string[] }>> = {
  sheets_batch_update_spreadsheet: {
    verb: "batch_update",
    en: ["delete rows", "delete columns", "remove rows", "remove columns", "insert rows", "insert columns", "insert a row", "insert a column", "move rows", "move columns"],
    he: ["מחק שורות", "תמחק שורות", "למחוק שורות", "מחק עמודות", "תמחק עמודות", "למחוק עמודות", "הכנס שורות", "תכניס שורות", "להכניס שורות", "הכנס עמודות", "תכניס עמודות"],
  },
};

/**
 * A change of the space next to a document element, as the user writes it: a change verb, the
 * space, a position and the heading, title, table, paragraph or section it is next to, in that
 * order — "add more space above the heading", "reduce the space below the table", "תקטין את הרווח
 * מתחת לטבלה". Evidence for docs_update_paragraph_style alone, read and admitted like an
 * `OWN_EVIDENCE_CUES` cue (`OWN_EVIDENCE_PATTERNS`).
 *
 * A pattern and not ranking words: the ranking index reads every word of a keyword on its own, so
 * the position words the tool once carried ("spacing above", "רווח מתחת", "ריווח שורות") made it a
 * match for Sheets row requests ("insert two rows above row 5 in the sheet", "תשנה את השורות"),
 * and without them "add space above the heading in the doc" ranked it nowhere. Here the words
 * count only together and in order, so a row request (no space), a Chat or Meet space ("add the
 * table to the Engineering space": no position next to an element) and a question ("how much space
 * is above the heading": no change verb) are not read. Bounded repetitions only, over the capped
 * text: one pass, linear in the text.
 */
const SPACE_NEAR_DOC_ELEMENT: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:add|put|leave|insert|increase|reduce|decrease|tighten|widen|shrink|cut|trim|make|give|set|change|adjust|fix)\s+` +
      String.raw`(?:(?:some|more|less|extra|the|a|an|little|bit|of|lot|bigger|smaller|larger|any|much)\s+){0,4}` +
      String.raw`(?:space|spacing|room|gap|gaps|whitespace|padding)\s+(?:(?:just|right|directly|immediately)\s+)?` +
      String.raw`(?:above|below|under|underneath|beneath|over|after|before|between|around)\s+` +
      String.raw`(?:(?:the|this|that|these|those|each|every|all|of|first|last|next|previous|main|both|my|our)\s+){0,3}` +
      String.raw`(?:headings?|titles?|subtitles?|tables?|paragraphs?|sections?)\b`,
    "i",
  ),
  new RegExp(
    String.raw`(?:^|[\s"'(«“])ו?(?:תוסיף|הוסף|להוסיף|תגדיל|הגדל|להגדיל|תקטין|הקטן|להקטין|תצמצם|צמצם|לצמצם|תשאיר|השאר|להשאיר|תשנה|שנה|לשנות|תקבע|קבע)\s+` +
      String.raw`(?:(?:עוד|קצת|את|יותר|פחות|מעט)\s+){0,3}ה?(?:ריווח|רווח|מרווח|רווחים|מרווחים)(?:\s+(?:עוד|קצת|יותר|פחות|מעט)){0,2}\s+` +
      String.raw`ש?(?:מעל|מתחת|בין|אחרי|לפני|מסביב|סביב)\s+(?:ל|ה|לה)?(?:טבלה|טבלאות|טבלת|כותרת|כותרות|פסקה|פסקאות|פיסקה|פיסקאות|סעיף|סעיפים)(?=$|[\s.,;:!?"')»”])`,
    "u",
  ),
];

/**
 * Evidence for one tool that is a pattern of the request's text rather than a set of words: read
 * over the capped text with links cut (like the stand-ins), admitted exactly as an
 * `OWN_EVIDENCE_CUES` cue is — on top of the ranked answer, and only on the product the request
 * aims at. The tool stays in the ranking: when it also ranks, it holds its ranked place in the cap,
 * so the gate then carries one other ranked tool fewer (only the fill tools are left out of the
 * ranking, see `rankingCatalog`). The words a match consumed do not count as aiming: "space" is
 * also the Chat and Meet noun, and "add more space below the table" names no Chat space.
 */
export const OWN_EVIDENCE_PATTERNS: Readonly<Record<string, { verb: Verb; patterns: readonly RegExp[] }>> = {
  docs_update_paragraph_style: { verb: "update", patterns: SPACE_NEAR_DOC_ELEMENT },
};

/**
 * Writing tools that get no family latitude (`rankedWrites`) and no fallback to every write: each
 * is admitted only when the request says its own verb, or one of the verbs listed for it.
 *
 * docs_replace_section sets a stated end state, so it is flagged recoverable, but it erases: the
 * section's old body goes, all of it when the new text is empty, and tables in it go whole.
 * Through `trash`'s family, "discard the section", "throw away the section" and "תזרוק את הסעיף"
 * reached it on requests release/1.6 refused with needsTarget, while the same requests refused
 * docs_delete_range, which does the same deletion, because `delete` was not said. It is admitted
 * by `replace` (which the rewording cues read too: "rewrite the section", "reword the doc", "תכתוב
 * מחדש את הסעיף") and by the verbs that ask for new content where the old was, `update` ("update /
 * change / edit / fix the Budget section") and `write` ("write / overwrite the section"). Not by
 * `trash`, `move`, `complete`, `modify`, `batch_update` ("format") or any other of the family.
 */
export const OWN_VERB_ONLY_TOOLS: Readonly<Record<string, readonly Verb[]>> = {
  docs_replace_section: ["update", "write"],
};

/**
 * A formula as typed into a cell: `=` STARTING a token (after the start of the text, a space, a
 * quote or a bracket), then a function, a reference or a bracket ("=B2*1.17", "=SUM(", "=$B$1").
 * "Fill C2:C40 with =B2*1.17" says "formula" by writing one, so it counts as the word for the fill
 * cues ("fill formula"). An `=` inside a word is not a cell entry: `==`, `<=`, `>=`, `!=`, and
 * `name=value` — which is how every link's query string is spelt.
 */
const FORMULA_LITERAL_RE = /(?:^|[\s"'`“”‘’«»(\[{])=\s*[A-Za-z$(]/;

/**
 * A link, cut out before the stand-ins are looked for: they read what the user wrote, never the
 * inside of a link. Google's default share link ends in `?usp=sharing`, whose `=s` read as a typed
 * formula, so "fill in the budget sheet <link>" became a fill; and a Sheets link can carry
 * `range=A1:D10`, which is the link's own anchor, not a destination the user named. With a scheme
 * or `www.`, or a bare host followed by a path (`docs.google.com/spreadsheets/d/…`, the form the
 * URL hard signals also accept).
 */
const LINK_RE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;

/**
 * Where the words of an own-evidence term (`OWN_EVIDENCE_VERBS`, `OWN_EVIDENCE_CUES`) may be: after
 * its verb, in any order, up to the end of the verb's clause — "fill the total in the last column
 * down to the bottom", "copy down the formula", "delete the last three rows". The clause ends at
 * punctuation followed by a space or the end of the text (a range's `:` and a decimal point are
 * inside a word), at a conjunction, or at a Hebrew word that joins "and" to another verb
 * ("ותשלח"). So "fill in the names and scroll down" and "fill the sheet, then scroll down" do not
 * reach the direction of the next clause.
 */
const CLAUSE_END_RE = /[.,;:!?](?:\s|$)|[\n\u2013\u2014]/u;
const CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "or", "but", "then", "או", "אבל", "אז", "ואז"].map(fold));

/**
 * The particles that make "fill" another verb: "fill in / fill out" (a form, a sheet, the right
 * names) writes different values into different cells, `write`'s job — also with a pronoun
 * between ("fill it in"). Read on the word right after a term's verb.
 */
const PARTICLES: ReadonlySet<string> = new Set(["in", "out"]);
const PRONOUNS: ReadonlySet<string> = new Set(["it", "them", "this", "that", "these", "those"]);
/** Two words whose first is not the direction it spells: "fill the sheet right now". */
const NOT_A_DIRECTION: ReadonlySet<string> = new Set(["right now", "right away", "right after", "right before", "right here", "right there", "right below", "right above"]);
/**
 * "Right" after "the" is the adjective ("fill the names in the right column", "the right tab"),
 * unless "to" or "toward(s)" comes first: "fill it to the right" is the direction.
 */
const ARTICLE_ADJECTIVE: ReadonlySet<string> = new Set(["right"]);
const TOWARD: ReadonlySet<string> = new Set(["to", "toward", "towards"]);
/**
 * A file, tab or folder named between a term's verb and its "formula" is what the verb acts on:
 * "copy the budget spreadsheet including the formula cells" copies a file that has formulas in it,
 * "copy the doc with the formula table rows" a document. The formula is the object only when it
 * comes first: "copy the formula to all rows of the budget spreadsheet".
 */
let formulaWords: ReadonlySet<string> | undefined;
let fileObjects: ReadonlySet<string> | undefined;
const isFormulaWord = (form: string) => (formulaWords ??= new Set(termTokens(["formula", "נוסחה"]).flat())).has(form);
const isFileObject = (form: string) =>
  (fileObjects ??= new Set(termTokens(["spreadsheet", "workbook", "sheet", "tab", "doc", "document", "file", "folder", "deck", "presentation", "קובץ", "מסמך", "תיקייה"]).flat())).has(form);

/**
 * Verbs that are also an adjective, as the bare word: Hebrew מלא is the imperative "fill" and the
 * masculine "full". The adjective follows its noun (דוח מלא, "a full report"), the imperative opens
 * its clause, so the bare word is read as the verb only there (`requestWords`). The other forms
 * are verbs only: תמלא, ותמלא, ומלא.
 */
const ADJECTIVE_TOO: ReadonlySet<string> = new Set(["מלא"]);
/** Where a clause opens: after punctuation, after a conjunction (`CONJUNCTIONS`), or after one of these ("please fill down"). */
const CLAUSE_BREAK_RE = /[.,;:!?\n\u2013\u2014]/;
const CLAUSE_OPENERS: ReadonlySet<string> = new Set(["please", "now", "then", "just", "בבקשה", "אנא", "עכשיו", "כעת", "אז", "ואז", "גם", "רק", "פשוט"].map(fold));

/** What the gate read out of the request, before it looked at any tool. */
export interface MutationIntent {
  /** The request asks for something to change. */
  mutating: boolean;
  /** The mutating verbs it named, in catalog order. */
  verbs: Verb[];
  /** Service prefixes the request named (`gmail`, `sheets`). */
  services: string[];
  /** Resources the request named, as `RESOURCE_LEXICON` keys (`comment`, `event`). */
  resources: string[];
  /**
   * The request named some service, resource or pasted object. Rule 2 reads it only as a ceiling:
   * a request that names nothing gets no irreversible tool without `confirm`, and there the
   * `confirm` tools are offered in rank order. It never licenses a tool on its own, because naming
   * one thing is no evidence about a tool that acts on another — see `namesTargetOf`.
   */
  targeted: boolean;
}

/** Every term of a lexicon entry, folded and split the way the query tokenizer splits text. */
function termTokens(terms: readonly string[]): string[][] {
  return terms.map((t) => tokenize(t).tokens).filter((t) => t.length > 0);
}

/** Whether every token of `phrase` appears in `tokens` (a phrase matches out of order, like the index does). */
function phraseIn(phrase: readonly string[], tokens: ReadonlySet<string>): boolean {
  return phrase.every((t) => tokens.has(t));
}

/**
 * The request's tokens, plus every further reduction of each one.
 *
 * Hebrew joins "and" to the next word, and in a two-clause request that word is nearly always the
 * verb that changes something — so a prefix the gate cannot see through is a writing tool it never
 * offers. Two things go wrong, and both are handled here because the shared tokenizer's clitic
 * stripping is gated on recognising the stem underneath:
 *
 *  - It strips ONE clitic per pass. `ותשתף` comes back as `תשתפ` — conjunction gone, imperative
 *    prefix still attached — while the lexicon holds the twice-reduced `שתפ`. Re-tokenizing each
 *    token finishes the job.
 *  - When it does not recognise the stem it strips nothing at all: `ותקבע` survives whole, so
 *    re-tokenizing it changes nothing and the leading conjunction has to come off directly.
 *
 * Additive in both cases: a reduced form is offered ALONGSIDE the original, never instead of it,
 * so nothing the first pass matched can stop matching.
 */
function requestTokens(request: string): Set<string> {
  return new Set(tokenize(String(request ?? "")).tokens.map(fold).flatMap(formsOf));
}

/** One token and every further reduction of it (see `requestTokens`). */
function formsOf(token: string): string[] {
  const out = [token];
  const reduce = (form: string) => {
    for (const again of tokenize(form).tokens) out.push(fold(again));
  };
  reduce(token);
  if (/^\u05D5/.test(token) && token.length >= 3) reduce(token.slice(1));
  return out;
}

/** One word of the request, in order, as `evidenceIn` reads it. */
interface Word {
  /** Every form it is read as: the forms `requestTokens` gives it. */
  forms: ReadonlySet<string>;
  /**
   * The forms it may be read as when it is a term's VERB: not one reached by cutting the Hebrew
   * definite article ה off the word. A verb never takes the article, so המלא / והמלא are "the
   * full", not the imperative מלא ("fill") they fold to; תמלא and ותמלא still are. Nor a bare
   * `ADJECTIVE_TOO` word that does not open its clause: דוח מלא is "a full report".
   */
  verbForms: ReadonlySet<string>;
  /** The word as typed, folded (no stemming). */
  raw: string;
  /** A clause starts here: after `CLAUSE_END_RE`, at a conjunction, or at "and" + a verb in Hebrew. */
  startsClause: boolean;
}

/** The first word of every mutating verb's terms: a Hebrew "and" joined to one of these opens a clause. */
let verbHeads: ReadonlySet<string> | undefined;
function isVerbHead(form: string): boolean {
  verbHeads ??= new Set(
    MUTATING_VERBS.flatMap((v) => {
      const lex = VERB_LEXICON[v];
      const extra = MUTATION_CUES[v];
      return termTokens([...(lex?.en ?? []), ...(lex?.he ?? []), ...(extra?.en ?? []), ...(extra?.he ?? [])]).map((t) => t[0]);
    }),
  );
  return verbHeads.has(form);
}

/** The request's words, in order, split and capped as the query tokenizer splits and caps them. */
function requestWords(text: string): Word[] {
  const words: Word[] = [];
  // Split keeping the separators (odd indexes), so a clause break between two words is visible.
  const pieces = text.slice(0, ROUTER_PARAMS.maxQueryChars).split(new RegExp(`(${SPLIT_RE.source})`, "u"));
  let between = "";
  for (let p = 0; p < pieces.length && words.length < ROUTER_PARAMS.maxTokens; p++) {
    const part = pieces[p] ?? "";
    const [stem] = p % 2 === 0 ? tokenize(part).tokens : [];
    if (!stem) {
      between += part;
      continue;
    }
    const raw = fold(part);
    const previous = words[words.length - 1];
    const opensClause = !previous || CLAUSE_BREAK_RE.test(between) || CLAUSE_OPENERS.has(previous.raw) || CONJUNCTIONS.has(previous.raw);
    const brokeClause = CLAUSE_END_RE.test(between);
    between = "";
    const forms = new Set(formsOf(fold(stem)));
    const cutsArticle = (form: string) => form !== raw && raw.endsWith(form) && raw.slice(0, raw.length - form.length).includes("\u05D4");
    const adjective = (form: string) => form === raw && ADJECTIVE_TOO.has(form) && !opensClause;
    // "and" joined to a verb: one of the mutating verbs' first words, or any verb in the
    // imperative/future ת- form ("ותגלול", and scroll).
    const joinsVerb = /^\u05D5/.test(raw) && raw.length >= 3 && ((/^\u05EA/.test(raw.slice(1)) && raw.length >= 4) || formsOf(raw.slice(1)).some(isVerbHead));
    const startsClause = !!previous && (brokeClause || CONJUNCTIONS.has(raw) || joinsVerb);
    words.push({ forms, verbForms: new Set([...forms].filter((form) => !cutsArticle(form) && !adjective(form))), raw, startsClause });
  }
  return words;
}

const holds = (word: Word | undefined, set: ReadonlySet<string>) => !!word && [...word.forms].some((form) => set.has(form));

/**
 * Whether the request holds `term` as a phrase: its first word as a verb (not in "fill in / fill
 * out", `PARTICLES`), and every later word after it, in any order, before its clause ends (a
 * clause break, a conjunction: `startsClause`), each on a word of its own, not as the first
 * half of `NOT_A_DIRECTION`, not as the adjective "the right" (`ARTICLE_ADJECTIVE`), and a
 * "formula" with no file, tab or folder between it and the verb (`isFileObject`). A word that a
 * typed stand-in supplies (`standIns`: "formula" for a typed formula, "cell" for a typed A1
 * range) holds wherever the formula or range was typed.
 *
 * `phraseIn`, which every other verb uses, reads a term's words anywhere and in any order. That
 * read "fill right" into "insert two rows … and fill in the right names", "fill down" into
 * "scroll down and fill in the prices", and "מלא למטה" into "מחק את הדוח המלא שמופיע למטה"
 * (delete the full report shown below), and the gate pinned a cell overwrite to all three. The
 * words after the verb keep no order and no distance within the clause: "copy down the formula",
 * "fill the dates in column A down to row 100".
 */
function evidenceIn(term: readonly string[], words: readonly Word[], standIns: ReadonlySet<string>): boolean {
  const [verb, ...rest] = term;
  if (verb === undefined) return false;
  const idiom = (j: number, want: string) =>
    [...words[j].forms].some((a) => [...(words[j + 1]?.forms ?? [])].some((b) => NOT_A_DIRECTION.has(`${a} ${b}`))) ||
    (ARTICLE_ADJECTIVE.has(want) && words[j - 1]?.raw === "the" && !TOWARD.has(words[j - 2]?.raw ?? ""));
  const phrasal = (i: number) => holds(words[i + 1], PARTICLES) || (holds(words[i + 1], PRONOUNS) && holds(words[i + 2], PARTICLES));
  return words.some((word, i) => {
    if (!word.verbForms.has(verb) || phrasal(i)) return false;
    let end = i + 1;
    while (end < words.length && !words[end].startsClause) end++;
    const used = new Set<number>();
    const fits = (k: number): boolean => {
      if (k === rest.length) return true;
      const want = rest[k];
      if (standIns.has(want) && fits(k + 1)) return true;
      for (let j = i + 1; j < end; j++) {
        if (used.has(j) || !words[j].forms.has(want) || idiom(j, want)) continue;
        if (isFormulaWord(want) && words.slice(i + 1, j).some((w) => [...w.forms].some(isFileObject))) continue;
        used.add(j);
        if (fits(k + 1)) return true;
        used.delete(j);
      }
      return false;
    };
    return fits(0);
  });
}

/** The services whose words the request holds (`SERVICE_LEXICON`, matched like the verbs). */
function servicesNamed(tokens: ReadonlySet<string>): string[] {
  return Object.keys(SERVICE_LEXICON).filter((s) => {
    const lex = SERVICE_LEXICON[s];
    return lex ? termTokens([...lex.en, ...lex.he]).some((p) => phraseIn(p, tokens)) : false;
  });
}

/** Read mutation intent out of a request. Pure: same text in, same answer out, no catalog needed. */
export function readMutationIntent(request: string): MutationIntent {
  return readRequest(request).intent;
}

/**
 * `readMutationIntent`, plus `typedServices`: the services named once what the request TYPES is
 * counted as the words it stands in for (a formula for "formula", an A1 range for "cell", both
 * Sheets words). Only `gateTools` reads it, to decide where own evidence (`OWN_EVIDENCE_VERBS`,
 * `OWN_EVIDENCE_CUES`) may land; `intent.services` stays the request's own words, because the
 * ranked gate and the read passes are tuned on those.
 *
 * Also `cued`, the `OWN_EVIDENCE_CUES` tools whose cues the request holds, and `rankedVerbs`, the
 * verbs the ranked gate is computed for: every verb read, less `OWN_EVIDENCE_VERBS` and less a verb
 * read only through a cue of `OWN_EVIDENCE_CUES`; and `signals`, the hard signals of the whole text,
 * which the per-tool target check (`namesTargetOf`) reads again.
 */
function readRequest(request: string): { intent: MutationIntent; typedServices: string[]; cued: string[]; rankedVerbs: Verb[]; signals: HardSignal[] } {
  const raw = String(request ?? "");
  const tokens = requestTokens(raw);
  const signals = matchHardSignals(raw);
  // Verbs only: a formula literal stands in for the WORD "formula", and a typed A1 range
  // ("D2:N2", "Sheet1!C2") for the word "cell" — the destination the English copy cues accept in
  // place of a direction. Neither names a service here: `services` reads the request's own words.
  // Both are looked for in the text with its links cut out (LINK_RE); a link still counts as a
  // concrete target below, from the signals of the whole text.
  // Capped first: all they feed (the words, the stand-ins) is read up to the router's cap anyway,
  // and LINK_RE is quadratic on a long run of dotted words.
  const typed = raw.slice(0, ROUTER_PARAMS.maxQueryChars).replace(LINK_RE, " ");
  const standIns = [FORMULA_LITERAL_RE.test(typed) ? "formula נוסחה" : "", matchHardSignals(typed).some((s) => s.id === "range_a1") ? "cell" : ""].join(" ").trim();
  const standInTokens = standIns ? requestTokens(standIns) : new Set<string>();
  const verbTokens = standIns ? new Set([...tokens, ...standInTokens]) : tokens;
  // `OWN_EVIDENCE_VERBS` and `OWN_EVIDENCE_CUES` are read as phrases over what the user typed
  // (`evidenceIn`), every other verb as a bag of words over the whole text (`phraseIn`).
  const words = requestWords(typed);
  const read = MUTATING_VERBS.filter((v) => {
    const lex = VERB_LEXICON[v];
    const extra = MUTATION_CUES[v];
    const terms = [...(lex?.en ?? []), ...(lex?.he ?? []), ...(extra?.en ?? []), ...(extra?.he ?? [])];
    if (!terms.length) return false;
    return OWN_EVIDENCE_VERBS.has(v) ? termTokens(terms).some((p) => evidenceIn(p, words, standInTokens)) : termTokens(terms).some((p) => phraseIn(p, verbTokens));
  });
  const patterned = Object.keys(OWN_EVIDENCE_PATTERNS).filter((name) => OWN_EVIDENCE_PATTERNS[name]?.patterns.some((re) => re.test(typed)));
  const cued = [
    ...Object.keys(OWN_EVIDENCE_CUES).filter((name) => {
      const cue = OWN_EVIDENCE_CUES[name];
      return !!cue && termTokens([...cue.en, ...cue.he]).some((p) => evidenceIn(p, words, standInTokens));
    }),
    ...patterned,
  ];
  const cuedVerbs = new Set(cued.map((name) => OWN_EVIDENCE_CUES[name]?.verb ?? OWN_EVIDENCE_PATTERNS[name]?.verb));
  const verbs = MUTATING_VERBS.filter((v) => read.includes(v) || cuedVerbs.has(v));
  const services = servicesNamed(tokens);
  const resources = Object.keys(RESOURCE_LEXICON).filter((r) => {
    const lex = RESOURCE_LEXICON[r];
    return lex ? termTokens([...lex.en, ...lex.he]).some((p) => phraseIn(p, tokens)) : false;
  });
  // A pasted A1 range, document URL, message id or address is the most concrete target a request
  // can carry. Without this, "clear the values in Sheet1!A2:D100" counted as having named nothing —
  // it spells out the exact cells — and the gate refused to offer the tool that clears them.
  const namesConcreteObject = signals.length > 0;
  const intent = { mutating: verbs.length > 0, verbs, services, resources, targeted: services.length > 0 || resources.length > 0 || namesConcreteObject };
  // Where own evidence may land. A pattern's own words are cut out first (`OWN_EVIDENCE_PATTERNS`):
  // the "space" of "add space below the table" is no Chat space. Over the capped text, as the
  // tokenizer reads it anyway; links stay, since a document link aims at Docs.
  let aimTokens = verbTokens;
  if (patterned.length) {
    let cut = raw.slice(0, ROUTER_PARAMS.maxQueryChars);
    for (const name of patterned) for (const re of OWN_EVIDENCE_PATTERNS[name]?.patterns ?? []) cut = cut.replace(new RegExp(re.source, `${re.flags}g`), " ");
    aimTokens = new Set([...requestTokens(cut), ...standInTokens]);
  }
  const typedServices = standIns || patterned.length ? servicesNamed(aimTokens) : services;
  return { intent, typedServices, cued, rankedVerbs: read.filter((v) => !OWN_EVIDENCE_VERBS.has(v)), signals };
}

/**
 * Whether the request names THIS tool's target: its own service, its own resource, or a pasted
 * object that belongs to it. Rule 2 asks this of every irreversible tool separately.
 *
 * Per tool, because a request-wide "named something" is not evidence about any one tool. "delete
 * the comment" names a comment; the irreversible delete tools delete sheets, files, events and
 * drafts, and none of them is the comment. With one flag for the whole request, every noun added
 * to the lexicon widened what an unaimed delete could reach.
 *
 * A pasted object that belongs to one product — a document URL, an A1 range, a Chat or People
 * resource name — counts for that product's service and the resources its pattern declares. An
 * email address or a time belongs to none: it says WHICH, not what. On its own it counts for what
 * it identifies without help — the contact, message or sharing entry an address declares, the
 * calendar event a time does ("cancel my 3pm"). Next to a named thing it only qualifies that
 * thing — "delete the draft to bob@example.com" is about a draft, and "delete the comment from
 * yesterday" names no event — with one exception: an address next to a named FILE is whose access
 * to it ("remove bob@example.com from the budget spreadsheet").
 */
function namesTargetOf(request: string, intent: MutationIntent, signals: readonly HardSignal[]): (entry: ManifestEntry) => boolean {
  const services = new Set(intent.services);
  const resources = new Set(intent.resources);
  for (const signal of signals.filter((s) => s.service)) {
    services.add(signal.service!);
    for (const r of signal.resources ?? []) resources.add(r);
  }
  const alsoNamed = () => {
    for (const [resource, namers] of Object.entries(ALSO_NAMED_BY)) if (namers.some((r) => resources.has(r))) resources.add(resource);
  };
  alsoNamed();
  const namedSomething = services.size > 0 || resources.size > 0;
  const namesFile = [...services].some((s) => FILE_SERVICES.has(s)) || [...resources].some((r) => FILE_RESOURCES.has(r));
  for (const signal of signals.filter((s) => !s.service)) {
    const declared = signal.resources?.length ? signal.resources : ["event"];
    if (!namedSomething) for (const r of declared) resources.add(r);
    else if (namesFile && declared.includes("permission")) resources.add("permission");
  }
  alsoNamed();
  const spelled = spellsResource(request);
  return (entry) => services.has(entry.service) || resources.has(entry.resource) || spelled(entry.resource);
}

/** The gate's answer for one request. */
export interface GateResult {
  intent: MutationIntent;
  /** Tool names that must appear in the final selection, whatever a model says. */
  tools: string[];
  /**
   * The request asked for a change but named nothing to change, and the change is not one the
   * tool itself would confirm. The caller must ask the user which object they mean.
   */
  needsTarget: boolean;
}

/**
 * How strongly a request evidences a tool's resource segment, as the length of the longest part of
 * it the request actually contains.
 *
 * Adjacent words are also joined before comparing, because catalog resources are single tokens
 * that people write as two: "task list" has to be able to evidence `tasklist`, or the more
 * specific tool can never win against the shorter name nested inside it.
 */
function resourceEvidence(request: string): (resource: string) => number {
  const vocabulary = requestVocabulary(request);
  return (resource: string) => {
    const parts = String(resource ?? "").split("_").filter(Boolean);
    let score = 0;
    for (const part of parts) if (vocabulary.has(fold(part))) score = Math.max(score, part.length);
    return score;
  };
}

/**
 * Whether a request spells out EVERY word of a tool's resource segment — "completed tasks" for
 * `completed_tasks`, "task list" for `tasklist`. The ranking is content with the longest word
 * (`resourceEvidence`); a target is not. "clear completed" evidences `completed_tasks` well enough
 * to rank, and names no tasks at all.
 */
function spellsResource(request: string): (resource: string) => boolean {
  const vocabulary = requestVocabulary(request);
  return (resource: string) => {
    const parts = String(resource ?? "").split("_").filter(Boolean);
    return parts.length > 0 && parts.every((part) => vocabulary.has(fold(part)) || tokenize(part).tokens.some((t) => vocabulary.has(fold(t))));
  };
}

/** The request's folded tokens plus every adjacent pair joined ("task list" → `tasklist`). */
function requestVocabulary(request: string): Set<string> {
  const tokens = tokenize(String(request ?? "")).tokens.map(fold);
  const vocabulary = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) vocabulary.add(tokens[i] + tokens[i + 1]);
  return vocabulary;
}

/** A tool that asks the user again before it acts. */
function confirmGated(entry: ManifestEntry): boolean {
  return entry.required.includes("confirm") || entry.optional.includes("confirm");
}

/**
 * Rank against the FULL catalog and keep the names that are in `pool`, best first.
 *
 * Ranking a filtered sub-catalog directly does not work, and fails in a way worth recording: the
 * router treats a service the query names but the catalog lacks as "that product is switched off
 * here" and deliberately returns nothing rather than answer from a different product. Hand it a
 * pool of, say, the share-verb tools and ask it about "the Q3 deck", and it sees no Slides tools,
 * concludes Slides is disabled, and drops the whole ranking — so the gate came back empty for
 * every request that mentioned a product other than the one being written to.
 *
 * Passing the real catalog and filtering afterwards keeps that veto pointed at real deployment
 * config, where it belongs, instead of at the gate's own bookkeeping.
 */
function rank(request: string, manifest: readonly ManifestEntry[], pool: ReadonlySet<string>, keep: number, service?: string): string[] {
  if (!pool.size) return [];
  // Ask for the router's full depth and cut AFTER filtering. Cutting first is the same mistake in
  // a different place: a request like "clear the values in Sheet1!A2:D100" ranks several Sheets
  // readers above the one writing tool, so a top-2 slice filtered down to the write pool is empty
  // and the gate reports no mutation on a request that plainly asks for one.
  const opts = service ? { limit: GATE_PARAMS.rankDepth, service } : { limit: GATE_PARAMS.rankDepth };
  return route(request, manifest, opts).candidates.map((c) => c.name).filter((name) => pool.has(name)).slice(0, keep);
}

/**
 * The catalog the gate ranks against: the deployment's, minus the tools of `OWN_EVIDENCE_VERBS`.
 *
 * Those tools are admitted on evidence alone (see `gateTools`), so ranking them decides nothing,
 * and leaving them in cost the other writes their places. The router is asked for its top ten and
 * the result filtered to the write pool afterwards (see `rank`), so a tool that cannot be admitted
 * still took one of the ten: on "copy the cells from <sheet link> down to the summary tab" the
 * fill tool ranked second on "down" and pushed sheets_write_range, tenth, out of the gate.
 *
 * A service's last tool is never taken away, because the router reads a named service that the
 * catalog lacks as "switched off here" and drops the whole ranking (see `rank`). Cached per
 * manifest, so the router's own index cache (keyed by the array) keeps working.
 */
const RANKING_CATALOG = new WeakMap<readonly ManifestEntry[], readonly ManifestEntry[]>();
function rankingCatalog(manifest: readonly ManifestEntry[]): readonly ManifestEntry[] {
  const cached = RANKING_CATALOG.get(manifest);
  if (cached) return cached;
  const ownEvidence = (e: ManifestEntry) => OWN_EVIDENCE_VERBS.has(e.verb as Verb);
  const covered = new Set(manifest.filter((e) => !ownEvidence(e)).map((e) => e.service));
  const kept = manifest.filter((e) => !ownEvidence(e) || !covered.has(e.service));
  const out = kept.length === manifest.length ? manifest : kept;
  RANKING_CATALOG.set(manifest, out);
  return out;
}

/**
 * The set of writing tools a request must not lose, computed without any model.
 *
 * Deterministic and total: it either returns tools, or returns none and says a target is missing.
 * It never throws on odd input — an empty request is simply not a mutation.
 *
 * `OWN_EVIDENCE_VERBS` are settled apart from everything else. Their tools are admitted on the
 * evidence that was read, whatever they rank, and put first; the rest of the answer is computed
 * as if those verbs had not been read, against a catalog without their tools. So a request that
 * reads a fill gets exactly the gate it would get without the fill, plus the fill tool. A cue of
 * `OWN_EVIDENCE_CUES` is settled the same way, for its one tool: admitted and put first, and the
 * rest computed as if the cue had not been read (its tool stays in the ranking catalog, because
 * its verb is still an ordinary one). The points below are the fill's; they hold for both:
 *
 *  - Not on rank. A destination ("the whole column", "all rows", "the other cells") is fill
 *    evidence but deliberately not one of the fill tool's ranking words (see its route block), so
 *    "copy the formula to the whole column on the <tab> tab" ranked it below the router's top ten
 *    and the gate offered only sheets_copy_sheet and drive_copy_file, which duplicate a whole tab
 *    or file.
 *  - On top of the cap, not inside it. Inside, it cost the request its fifth write: "copy the
 *    formula to the whole column and trash the old draft email" lost gmail_trash_message, and
 *    "copy the doc with the formula table rows and rename it" (a file copy that reads a fill)
 *    lost drive_copy_file. The gate is then at most `maxTools` plus those verbs' own tools (one, for a fill).
 *  - No fallback. A fill that no enabled tool can do pins nothing, where the fallback for an
 *    unspelt verb is every write: on a deployment without Sheets, "autofill the message" pinned
 *    gmail_trash_message and "drag down the email" gmail_send_message.
 *  - Not across products. The evidence lands only on a service the request names (a typed
 *    formula or A1 range names Sheets), or on any when it names none. "Drag down", "drag across"
 *    and "autofill" name no product, so "drag the 2pm meeting down to 4pm on my calendar" and
 *    "autofill the form with my details" pinned a Sheets cell overwrite, for most of them as the
 *    only write. They now get the gate they would get without the fill tool. The Meta service is
 *    not a product here: its words ("account", "tool", "server", "workspace", חשבון) are generic
 *    and nothing is filled there, so "autofill the account numbers down" still gets the fill tool.
 *    Trade-off: any other product's word diverts the evidence, even in a request that only means
 *    Sheets and even when that product is not enabled ("autofill the due dates" reads Tasks, "drag
 *    down the schedule" Calendar, "fill the rate down for each person" Contacts, "fill the label
 *    down" Gmail, "fill down the file names" Drive); those get the gate without the fill tool.
 */
export function gateTools(request: string, manifest: readonly ManifestEntry[]): GateResult {
  const { intent, evidenced, ranked, rankedVerbs, signals } = rankAll(request, manifest);
  if (!intent.mutating) return { intent, tools: [], needsTarget: false };
  const byName = new Map(manifest.map((e) => [e.name, e]));

  // Rule 2 for the tools admitted on evidence: without a target, nothing irreversible that would
  // not ask. They are not ranked, so the cap and the per-tool checks below do not apply to them:
  // the evidence is their verb, and it lands only on the product the request aims at (`landsOn`).
  const onEvidence = evidenced.filter((name) => {
    const entry = byName.get(name);
    return !!entry && (intent.targeted || !entry.destructive || confirmGated(entry));
  });

  // Rule 2 for the ranked tools, per tool. A recoverable write stands on the ranking alone. An
  // irreversible one has to clear every check below that applies to it; what is left out is
  // refused rather than guessed at, and when nothing is left the caller is told to ask which object
  // was meant.
  //
  //  - Its own verb. The request must have said `delete`, `send`, `trash`… itself (or the tail of a
  //    compound verb) — one of the verbs the ranking was computed for (`rankedVerbs`), so a verb
  //    read only as own evidence (`fill`, an `OWN_EVIDENCE_CUES` cue) says nothing here. A
  //    recoverable verb admits its whole family into the pool, and one tool in that family is
  //    irreversible: `gmail_trash_message`. Through "rename", "reduce spacing" or "right align" it
  //    reached every request that mentioned an email, questions included ("does the email have
  //    double spacing"). It stays in the pool — taking it out would move the tools ranked below it
  //    up — and is simply not offered.
  //  - The cap. It is offered only from where the ranking placed it, within the first
  //    `maxTools` of the ranked list, never promoted into a slot a refused tool vacated — `confirm`
  //    or not. "delete the event and send the summary" ranks `chat_send_message` eighth; dropping
  //    the unaimed deletes above it must not bring it up. A request that names nothing is the one
  //    exception, and only for a tool that asks the user again: "send it" reaches the send tools
  //    because every other irreversible tool is refused outright there, exactly as before targets
  //    were judged per tool. The tools admitted on evidence sit on top; the fill tools are not
  //    ranked at all, while a cue or pattern tool that also ranks keeps its ranked place in the five.
  //  - Its own target, unless it asks the user again. The request must name ITS service, ITS
  //    resource or an object of its own — "delete the comment" names a comment, which is no licence
  //    to delete a file, a tab or an event.
  //
  // So the rule only ever removes: over the same ranking, no irreversible tool is offered that the
  // single request-wide flag (first five when anything was named, confirm tools only otherwise)
  // did not offer. Recoverable tools move up as they always have.
  const aimsAt = namesTargetOf(request, intent, signals);
  const allowed = ranked.filter((name, position) => {
    const entry = byName.get(name);
    if (!entry) return false;
    // Ranked through a family, held in place, and refused here (`OWN_VERB_ONLY_TOOLS`).
    const only = OWN_VERB_ONLY_TOOLS[name];
    if (only && !saysVerb(rankedVerbs, entry.verb) && !only.some((v) => rankedVerbs.includes(v))) return false;
    if (!entry.destructive) return true;
    if (!saysVerb(rankedVerbs, entry.verb)) return false;
    const withinCap = position < GATE_PARAMS.maxTools;
    if (confirmGated(entry)) return withinCap || !intent.targeted;
    return intent.targeted && withinCap && aimsAt(entry);
  });
  // Rank order, not name order: the caller's cap cuts from the back of this list.
  const tools = [...onEvidence, ...allowed.slice(0, GATE_PARAMS.maxTools).filter((name) => !onEvidence.includes(name))];
  // A target is missing only where a ranking was asked for and nothing survived: a request whose
  // one verb is own evidence that lands nowhere gets an empty gate and no question.
  return { intent, tools, needsTarget: tools.length === 0 && rankedVerbs.length > 0 };
}

/** The request said this verb itself, or the tail of this compound verb (`batch_update` for "update"). */
function saysVerb(verbs: readonly Verb[], verb: string): boolean {
  return verbs.some((v) => verb === v || verb.endsWith(`_${v}`));
}

/** The gate's ranking, before rule 2 has looked at any tool. */
export interface GateRanking {
  intent: MutationIntent;
  /**
   * The tools admitted on the request's own evidence (`OWN_EVIDENCE_VERBS`, `OWN_EVIDENCE_CUES`),
   * wherever they rank. They go on top of the answer. The fill tools are left out of the ranking
   * (`rankingCatalog`); a cue or pattern tool that also ranks keeps its place in the cap, so the
   * gate then carries one other ranked tool fewer.
   */
  evidenced: string[];
  /**
   * The writing tools the ranked verbs (`rankedVerbs`) admit, best first, at most one
   * irreversible tool per service. Rule 2 filters this list and never reorders it, so an
   * irreversible tool the gate offers from it on a request that names anything sits within the
   * first `GATE_PARAMS.maxTools` here.
   */
  ranked: string[];
  /** `evidenced`, then `ranked` without them: the order the gate's answer follows. */
  ordered: string[];
  /** The verbs the ranking was computed for: every verb read, less the own-evidence ones. */
  rankedVerbs: Verb[];
}

/**
 * Rank the writing tools a request could mean. The first half of `gateTools`, exported so the
 * tests can hold rule 2 to the ranking it was given rather than to a copy of its own logic.
 */
export function rankWrites(request: string, manifest: readonly ManifestEntry[]): GateRanking {
  const { intent, evidenced, ranked, ordered, rankedVerbs } = rankAll(request, manifest);
  return { intent, evidenced, ranked, ordered, rankedVerbs };
}

/** `rankWrites`, plus the hard signals of the request, which rule 2's per-tool target check reads. */
function rankAll(request: string, manifest: readonly ManifestEntry[]): GateRanking & { signals: HardSignal[] } {
  const { intent, typedServices, cued, rankedVerbs, signals } = readRequest(request);
  if (!intent.mutating) return { intent, evidenced: [], ranked: [], ordered: [], rankedVerbs, signals };

  const own = new Set(intent.verbs.filter((v) => OWN_EVIDENCE_VERBS.has(v)));
  // Where the evidence may land: the products the request names, a typed formula or A1 range
  // counting as Sheets; anywhere, when it names none. Some fill words name no product ("drag
  // down", "autofill"), so without this "drag the meeting down to 4pm on my calendar" or
  // "autofill the form" pinned a cell overwrite as the request's only write. The Meta service is
  // no product to aim at (see above), so "fill down for every account" stays a Sheets fill.
  const aimedAt = typedServices.filter((s) => s !== META_SERVICE);
  const landsOn = (e: ManifestEntry) => aimedAt.length === 0 || aimedAt.includes(e.service);
  const evidenced = manifest.filter((e) => e.write && (own.has(e.verb as Verb) || cued.includes(e.name)) && landsOn(e)).map((e) => e.name);
  const ranked = rankedVerbs.length ? rankedWrites(request, intent, rankedVerbs, rankingCatalog(manifest)) : [];
  return { intent, evidenced, ranked, ordered: [...evidenced, ...ranked.filter((name) => !evidenced.includes(name))], rankedVerbs, signals };
}

/** The ranked part of the gate: the writes for `verbs`, best first, before rule 2 (`GateRanking.ranked`). */
function rankedWrites(request: string, intent: MutationIntent, verbs: readonly Verb[], manifest: readonly ManifestEntry[]): string[] {
  const writes = manifest.filter((e) => e.write);
  // The verb the user said narrows the pool before anything is ranked: "delete the event" must not
  // reach `calendar_create_event` however well that scores on "event". The narrowing is dropped
  // only when it would leave nothing at all — a cue matched a verb no enabled tool spells — since
  // an empty gate on a request that plainly asks for a change is the one outcome worth avoiding.
  // Which writing verbs the request could mean.
  //
  // `batch_update` is an `update` and `quick_add` is an `add`, so a compound verb keeps the promise
  // of its tail — that is what lets "rename" reach `sheets_batch_update_spreadsheet`.
  //
  // Beyond that, a RECOVERABLE verb also admits its whole family: someone who says "add them to
  // the document" means `docs_append_text`, and holding them to the exact word `add` offers them
  // `sheets_add_sheet` instead. Irreversible verbs get no such latitude — `delete` never widens to
  // `clear`, and `send` never widens to `end` — because there the cost of guessing one word over
  // is not a wasted schema but a wrong action.
  //
  // `OWN_EVIDENCE_VERBS` get no family latitude in EITHER direction: `gateTools` admits their
  // tools on the request's own evidence and passes their verbs over, and no other verb's family
  // or fallback reaches their tools here. A fill read into "copy the budget spreadsheet including
  // the formula cells" once put every `mutating_idempotent` tool in the pool
  // (sheets_batch_update_spreadsheet, gmail_untrash_message, the replace tools,
  // gmail_trash_message), and in a gate capped at five they pushed out drive_copy_file,
  // sheets_clear_range and the send tools the request named.
  const recoverableKinds = new Set<Kind>(
    verbs
      .filter((v) => !OWN_EVIDENCE_VERBS.has(v))
      .map((v): Kind => VERB_KINDS[v])
      .filter((k) => k !== "destructive" && k !== "destructive_idempotent"),
  );
  // `OWN_VERB_ONLY_TOOLS` rank like the rest but are offered only on their own verb or a verb
  // listed for them (refused in `gateTools`, after the ranking).
  const matchesVerb = (e: ManifestEntry) => {
    if (OWN_EVIDENCE_VERBS.has(e.verb as Verb)) return false;
    if (saysVerb(verbs, e.verb)) return true;
    // A tool of `OWN_VERB_ONLY_TOOLS` stays in the pool through its family like any other, so it
    // holds its ranked place: taking it out moved the tools below it up, and "delete the
    // formatting from the doc" then ranked drive_delete_file inside the cap. `gateTools` refuses it
    // unless its own verb or a verb listed for it was said.
    const only = OWN_VERB_ONLY_TOOLS[e.name];
    if (only && only.some((v) => verbs.includes(v))) return true;
    const kind = VERB_KINDS[e.verb as Verb];
    return kind !== undefined && recoverableKinds.has(kind);
  };
  const byVerb = writes.filter(matchesVerb);
  const pool = byVerb.length ? byVerb : writes.filter((e) => !OWN_EVIDENCE_VERBS.has(e.verb as Verb) && !OWN_VERB_ONLY_TOOLS[e.name]);
  const byName = new Map(pool.map((e) => [e.name, e]));
  const names = new Set(pool.map((e) => e.name));
  // Which services to look in: the ones the request named AND every service that owns a tool for
  // the verb it named. The union, not either/or — "revoke access to the budget spreadsheet" names
  // Sheets and needs Drive, and "share the spec document" names Docs and needs Drive. Searching
  // only the named services misses the tool; searching only the verb's services loses the
  // disambiguation the named one provides.
  const services = [...new Set([...intent.services, ...pool.map((e) => e.service)])];
  // Order matters, because the answer is capped. A service the request NAMED is better evidence
  // than one merely inferred from the verb, so those passes come first; the whole-catalog pass
  // follows; services reached only through the verb come last.
  const named = intent.services.filter((s) => services.includes(s));
  const inferred = services.filter((s) => !named.includes(s));
  const ranked = [
    ...named.flatMap((service) => rank(request, manifest, names, GATE_PARAMS.perServiceDepth, service)),
    ...rank(request, manifest, names, GATE_PARAMS.globalDepth),
    ...inferred.flatMap((service) => rank(request, manifest, names, GATE_PARAMS.perServiceDepth, service)),
  ];
  // One irreversible tool per service. A single request does not delete two different kinds of
  // thing, so past the best candidate in a service the rest are noise a caller might act on.
  // Which one is best is not simply the router's order: for "delete the task list named Old
  // Drafts" the router prefers `tasks_delete_task`, because `tasklist` is one token and the
  // request wrote it as two words. So candidates are compared on the most specific resource the
  // request actually evidences — `tasklist` beats `task` — and the router's order breaks ties.
  const evidence = resourceEvidence(request);
  const best = new Map<string, string>();
  for (const name of new Set(ranked)) {
    const entry = byName.get(name);
    if (!entry?.destructive) continue;
    const held = best.get(entry.service);
    if (!held || evidence(entry.resource) > evidence(byName.get(held)?.resource ?? "")) best.set(entry.service, name);
  }
  const keptDestructive = new Set(best.values());
  const ordered = [...new Set(ranked)].filter((name) => {
    const entry = byName.get(name);
    return !entry?.destructive || keptDestructive.has(name);
  });
  return ordered;
}

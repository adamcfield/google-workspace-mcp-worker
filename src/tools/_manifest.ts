/**
 * The routing manifest (v1.5 PR-6a): one `ManifestEntry` per tool, built from the catalog the
 * caller passes in. Off the wire — nothing here is registered, listed or described to a client;
 * it is the data the router (`_router.ts`) scores a query against.
 *
 * Two sources feed an entry:
 *  1. the `ToolDef` itself — name, flags, scope and the zod input shape (required/optional);
 *  2. a hand-written `ROUTE_BLOCKS` entry, when one exists, for the intent text a description
 *     cannot carry: when to reach for the tool, which sibling to prefer instead, and the English
 *     and Hebrew words a user actually types.
 *
 * A tool WITHOUT a block is still routable: `useWhen`/`returns` fall back to the first sentence
 * of its description, so the manifest always covers the whole catalog (`tests/manifest.test.ts`
 * pins that). Blocks buy precision on the confusable core, not coverage.
 *
 * This module is a LEAF on purpose: its only runtime import is `naming.ts`. It takes the tool
 * list as an argument instead of importing `_groups.ts`, so nothing here can ever pull the
 * catalog (and through it every tool module) into a consumer, and no import cycle is possible.
 */
import type { z } from "zod";
import type { ToolDef } from "./_shared.js";
import { NAME_EXEMPTIONS, parseToolName } from "./naming.js";
import { GROUP_HINTS } from "./_group-hints.js";

/** Hand-written routing intent for one tool. All of it is data — no prose, no sentences to read aloud. */
export interface RouteBlock {
  /** Verb phrase, ≤ `MAX_USE_WHEN_CHARS`: the situation this tool is the right answer to. */
  useWhen: string;
  /** The sibling tool to prefer instead, and when. Must name a real tool. */
  doNotUseWhen?: string;
  /** What the call gives back, so the router can rank "I need X" queries. */
  returns?: string;
  /** English words a user types for this (never the tool's own name tokens — the index has those). */
  keywords?: string[];
  /** Hebrew words a user types for this. First-class, not an afterthought: the server is used in both languages. */
  keywordsHe?: string[];
  /** Tools a caller often needs before or after this one. Must all exist. */
  related?: string[];
}

/** One tool as the router sees it. Derived data only — never session state. */
export interface ManifestEntry {
  name: string;
  /** First name segment (`gmail`, `sheets`, `google`). */
  service: string;
  /** Catalog group the service belongs to (`Gmail`, `Sheets`, `Meta`). */
  group: string;
  /** Verb from `VERB_KINDS`; "" for the two grandfathered `NAME_EXEMPTIONS`. */
  verb: string;
  /** Everything after the verb (`message_labels`, `free_busy`). */
  resource: string;
  useWhen: string;
  doNotUseWhen?: string;
  returns: string;
  /** Frozen: `buildManifest` copies these out of `ROUTE_BLOCKS` and freezes the result (see below). */
  keywords: readonly string[];
  keywordsHe: readonly string[];
  /** Tools a caller often needs before or after this one. §A.1 payload for PR-6b's
   * `google_describe_tool`; the PR-6a router does not read it (nor `idempotent`). */
  related: readonly string[];
  write: boolean;
  destructive: boolean;
  idempotent: boolean;
  scope?: string;
  /** Whether `tools/list` advertises it here (a hidden tool is still callable — see surface.ts). */
  listed: boolean;
  /** Input keys with no default and no `.optional()`. */
  required: readonly string[];
  /** Input keys a caller may omit. */
  optional: readonly string[];
}

/** Ceiling for a hand-written `useWhen`; a longer one is a description, not a routing signal. */
export const MAX_USE_WHEN_CHARS = 140;
/** Ceiling for a `useWhen`/`returns` derived from a description. */
export const MAX_FALLBACK_CHARS = 160;

/**
 * The group rows, re-exported from the leaf that owns them (`_group-hints.ts`) so every consumer
 * — this module's `groupOf`, and `google_list_tools` on the wire — reads one list.
 */
export { GROUP_HINTS } from "./_group-hints.js";


/** service segment → catalog group. `google` is the Meta group, which `GROUP_HINTS` omits. */
const GROUP_BY_SERVICE: ReadonlyMap<string, string> = new Map<string, string>([...GROUP_HINTS.map((g) => [g.prefix.replace(/_$/, ""), g.group] as [string, string]), ["google", "Meta"]]);

/** The catalog group a tool's service segment belongs to; the capitalised service when unknown. */
export function groupOf(service: string): string {
  return GROUP_BY_SERVICE.get(service) ?? service.charAt(0).toUpperCase() + service.slice(1);
}

const EXEMPT: ReadonlySet<string> = new Set<string>(NAME_EXEMPTIONS);

/** `<service>_<verb>_<resource>` via `parseToolName`; the exempt names keep an empty verb. */
function splitName(name: string): { service: string; verb: string; resource: string } {
  const parsed = parseToolName(name);
  if (parsed) return parsed;
  if (EXEMPT.has(name)) {
    const [service, ...rest] = name.split("_");
    return { service: service ?? name, verb: "", resource: rest.join("_") };
  }
  // Not a silent skip: an unroutable tool is a bug in the name, and the suite says so.
  throw new Error(`buildManifest: '${name}' is neither <service>_<verb>_<resource> (see VERB_KINDS in naming.ts) nor one of NAME_EXEMPTIONS`);
}

/** Abbreviations whose dot does not end a sentence (checked against the tail of the candidate). */
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|resp|no|fig|dr|mr|ms|a\.m|p\.m)|\s[A-Za-z])\.$/;

/** Clip at a word boundary with an ellipsis when over `max`; the result never exceeds `max`. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const kept = space > (max - 1) * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.—-]+$/, "")}…`;
}

/**
 * The first sentence of a description, for tools with no route block. Skips terminators that
 * belong to an abbreviation (`e.g.`, `i.e.`) or sit inside an unclosed parenthesis, since the
 * descriptions are full of both.
 */
export function firstSentence(text: string, max = MAX_FALLBACK_CHARS): string {
  const s = text.trim();
  const terminator = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = terminator.exec(s)) !== null) {
    const head = s.slice(0, m.index + 1);
    if (ABBREVIATION.test(head)) continue;
    const opens = (head.match(/\(/g) ?? []).length;
    if (opens > (head.match(/\)/g) ?? []).length) continue;
    return clip(head, max);
  }
  return clip(s, max);
}

/** Input keys split by whether the schema accepts `undefined` (optional or defaulted). */
function splitParams(input: z.ZodRawShape | undefined): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, schema] of Object.entries(input ?? {})) {
    ((schema as z.ZodType).safeParse(undefined).success ? optional : required).push(key);
  }
  return { required, optional };
}

/**
 * The routing manifest for one deployment: `defs` is what this session may CALL (the manifest of
 * surface.ts, never `ALL_TOOLS` blindly) and `listed` is what `tools/list` advertises, so the
 * router can say "call it through the proxy" for a tool that is callable but hidden.
 *
 * Pure: no I/O, no globals, no mutation of `defs`; the same inputs always give the same output,
 * which is what lets `_router.ts` memoise its index on the returned array.
 */
export function buildManifest(defs: readonly ToolDef<z.ZodRawShape>[], listed: ReadonlySet<string>): readonly ManifestEntry[] {
  const entries = defs.map((def) => {
    const { service, verb, resource } = splitName(def.name);
    const block = ROUTE_BLOCKS[def.name];
    const summary = firstSentence(def.description);
    const { required, optional } = splitParams(def.input);
    const entry: ManifestEntry = {
      name: def.name,
      service,
      group: groupOf(service),
      verb,
      resource,
      useWhen: block?.useWhen ?? summary,
      returns: block?.returns ?? summary,
      keywords: [...(block?.keywords ?? [])],
      keywordsHe: [...(block?.keywordsHe ?? [])],
      related: [...(block?.related ?? [])],
      write: def.write === true,
      destructive: def.destructive === true,
      idempotent: def.idempotent === true,
      listed: listed.has(def.name),
      required,
      optional,
    };
    if (block?.doNotUseWhen) entry.doNotUseWhen = block.doNotUseWhen;
    if (def.scope) entry.scope = def.scope;
    // Frozen, not merely copied. `_router.ts` memoises its index on THIS array's identity, so a
    // caller that mutated the array (or an entry's keyword list) in place would leave the memo
    // describing a manifest that no longer exists — and `route()` would then propose a tool the
    // caller had removed, breaking the §C.7 "candidates come only from the manifest" invariant.
    // Freezing makes that impossible instead of merely unlikely.
    for (const list of [entry.keywords, entry.keywordsHe, entry.related, entry.required, entry.optional]) Object.freeze(list);
    return Object.freeze(entry);
  });
  return Object.freeze(entries);
}

/**
 * Hand-written routing intent for the core set: the 16 `COMPACT_TOOL_NAMES`, the 3 Meta tools
 * and the tools a query most often lands between, covering all 14 groups. Everything else routes
 * on its description (see `buildManifest`) — this table buys precision, not coverage, so adding
 * a tool here is a judgement call and never a requirement.
 *
 * Rules the suite enforces: the key is a real tool, `useWhen` is a verb phrase of at most
 * `MAX_USE_WHEN_CHARS`, `doNotUseWhen` names a real OTHER tool, `related` names real tools, and
 * every block carries both English and Hebrew keywords.
 */
export const ROUTE_BLOCKS: Readonly<Record<string, RouteBlock>> = {
  // ---- Meta ----------------------------------------------------------------
  google_whoami: {
    useWhen: "check which Google account is connected, which scopes were granted, or why a tool returned a permission error",
    doNotUseWhen: "you want the catalog of capabilities rather than the identity — use google_list_tools.",
    returns: "email, hosted domain, granted and missing scopes, token expiry and serverVersion",
    keywords: ["who am i", "account", "identity", "signed in", "scopes", "permission denied", "403", "server version"],
    keywordsHe: ["מי אני", "חשבון", "מחובר", "הרשאות", "גרסה", "שגיאת הרשאה"],
    related: ["google_list_tools"],
  },
  google_list_tools: {
    useWhen: "list the tool groups this deployment enables, with their name prefixes, to see where a capability lives or why it is missing",
    doNotUseWhen: "you need the connected account instead of the catalog — use google_whoami.",
    returns: "name, prefix, hint and tool count per enabled group, the disabled groups, plus serverVersion",
    keywords: ["what can you do", "tools", "catalog", "groups", "capabilities", "prefix", "tool map"],
    keywordsHe: ["כלים", "מה אתה יודע לעשות", "קבוצות", "רשימת כלים", "יכולות"],
    related: ["google_whoami"],
  },
  google_api_request: {
    useWhen: "call a Google REST endpoint no dedicated tool covers; mutations need confirm=true",
    doNotUseWhen: "a dedicated tool exists for that endpoint (e.g. gmail_send_message) — it validates input, keeps the safety gates and returns compact output.",
    returns: "the raw Google API response (json, or text for exports)",
    keywords: ["raw api", "rest endpoint", "escape hatch", "googleapis", "not covered", "custom call"],
    keywordsHe: ["קריאה ישירה", "נקודת קצה", "api גולמי", "בקשה מותאמת"],
    related: ["google_list_tools"],
  },

  // ---- Sheets --------------------------------------------------------------
  sheets_list_spreadsheets: {
    useWhen: "find a spreadsheet by name when its id is unknown, or list the spreadsheets in a Drive folder",
    doNotUseWhen: "the spreadsheet id is already known — use sheets_get_spreadsheet.",
    returns: "id, name, owner and modified time per spreadsheet",
    keywords: ["spreadsheet", "which spreadsheet", "find sheet", "by name", "excel file", "workbook"],
    keywordsHe: ["גיליון", "גליון", "איזה גיליון", "למצוא גיליון", "אקסל", "רשימת גיליונות"],
    related: ["sheets_get_spreadsheet", "drive_search_files"],
  },
  sheets_get_spreadsheet: {
    useWhen: "inspect a spreadsheet's tabs, grid sizes and named ranges before reading or writing cells",
    doNotUseWhen: "the cell values themselves are wanted — use sheets_read_range.",
    returns: "title, locale, timezone and every tab with sheetId, index and row/column counts",
    keywords: ["tabs", "sheet names", "structure", "how many rows", "named range", "metadata", "sheet id"],
    keywordsHe: ["לשוניות", "טאבים", "מבנה", "כמה שורות", "טווח מוגדר", "מזהה לשונית"],
    related: ["sheets_read_range", "sheets_audit_spreadsheet"],
  },
  sheets_read_range: {
    useWhen: "read the values of a known A1 range or of a whole tab",
    doNotUseWhen: "formulas, notes or formatting are needed too — use sheets_read_cells.",
    returns: "the cell values as rows or keyed by A1 cell address, with the range that was read",
    keywords: ["read cells", "get the cells", "cells from", "values", "range", "column", "row", "what is in the sheet", "a1"],
    keywordsHe: ["קרא", "תאים", "טווח", "ערכים", "עמודה", "שורה", "מה כתוב בגיליון"],
    related: ["sheets_batch_read_ranges", "sheets_read_cells"],
  },
  sheets_write_range: {
    useWhen: "overwrite a known A1 range with new values",
    doNotUseWhen: "rows should go after the existing data instead — use sheets_append_rows.",
    returns: "the updated range and cell count, re-read to verify",
    keywords: ["write", "write into the sheet", "put the totals in", "set values", "update cells", "overwrite", "fill in", "paste values"],
    keywordsHe: ["כתוב", "עדכן", "מלא", "שנה תאים", "הדבק", "לרשום בגיליון"],
    related: ["sheets_append_rows", "sheets_batch_write_ranges"],
  },
  sheets_append_rows: {
    useWhen: "add rows at the end of a table without knowing where the data stops",
    doNotUseWhen: "the target range is known and must be overwritten — use sheets_write_range.",
    returns: "the range the rows landed in and how many cells changed",
    keywords: ["append", "add a row", "new row", "log a line", "at the bottom", "end of table"],
    keywordsHe: ["הוסף שורה", "שורה חדשה", "בסוף הטבלה", "להוסיף נתונים"],
    related: ["sheets_write_range"],
  },
  sheets_batch_update_spreadsheet: {
    useWhen: "format cells, add or delete tabs, freeze rows, set filters or charts — anything only spreadsheets.batchUpdate can do",
    doNotUseWhen: "only values go into cells — use sheets_write_range.",
    returns: "a summary of the applied requests (dry_run previews them instead)",
    keywords: ["format", "formatting", "colour", "bold", "conditional formatting", "freeze", "chart", "filter", "merge cells", "column width", "rename tab", "rename sheet", "rename"],
    keywordsHe: ["עיצוב", "צבע", "מודגש", "עיצוב מותנה", "הקפאת שורות", "גרף", "מיזוג תאים", "רוחב עמודה", "שינוי שם לשונית", "לשנות שם"],
    related: ["sheets_write_range", "sheets_add_sheet"],
  },
  sheets_create_spreadsheet: {
    useWhen: "create a brand-new spreadsheet, optionally with named tabs and initial data",
    doNotUseWhen: "the spreadsheet exists and only needs another tab — use sheets_add_sheet.",
    returns: "the new spreadsheetId and its url",
    keywords: ["new spreadsheet", "create a sheet", "blank workbook", "start a spreadsheet"],
    keywordsHe: ["צור גיליון", "גיליון חדש", "לפתוח גיליון"],
    related: ["sheets_add_sheet", "sheets_write_range"],
  },
  sheets_audit_spreadsheet: {
    useWhen: "find broken formulas, #REF!/#DIV/0! errors or circular references across a spreadsheet",
    doNotUseWhen: "one cell's dependency tree is the question — use sheets_trace_precedents.",
    returns: "every erroring cell with its formula, error type and a likely cause",
    keywords: ["error", "broken formula", "ref", "div/0", "n/a", "circular reference", "audit", "health check", "why does it fail"],
    keywordsHe: ["שגיאה", "שגיאות", "נוסחה שבורה", "הפניה מעגלית", "בדיקת תקינות", "למה לא עובד"],
    related: ["sheets_trace_precedents", "sheets_trace_dependents"],
  },

  // ---- Drive ---------------------------------------------------------------
  drive_search_files: {
    useWhen: "find a file or folder by name, type, owner or full text, or list what a folder contains",
    doNotUseWhen: "the file id is known and its content is wanted — use drive_read_file.",
    returns: "id, name, mimeType, owners, modified time and link per file",
    keywords: ["find a file", "search drive", "folder contents", "where is the file", "pdf", "shared with me", "by owner", "file named", "deck", "slide deck", "presentation named"],
    keywordsHe: ["חפש קובץ", "דרייב", "תיקייה", "איפה הקובץ", "קבצים", "שיתפו איתי", "מצגת", "קובץ בשם"],
    related: ["drive_get_file", "drive_read_file"],
  },
  drive_read_file: {
    useWhen: "read or export the content of a Drive file by id, including PDFs and Office files",
    doNotUseWhen: "the file is a Google Doc and its outline matters — use docs_read_document.",
    returns: "the file's text with totalChars/returnedChars and a truncation flag",
    keywords: ["read the file", "file content", "open the pdf", "extract text", "what does the file say"],
    keywordsHe: ["קרא קובץ", "תוכן הקובץ", "פתח קובץ", "טקסט מהקובץ"],
    related: ["drive_search_files", "docs_read_document"],
  },
  drive_upload_file: {
    useWhen: "create a Drive file from content already in hand, optionally inside a folder",
    doNotUseWhen: "the file exists and only its bytes change — use drive_update_file_content; to download or read an existing file use drive_read_file.",
    returns: "the new file id, name and link",
    keywords: ["upload", "save to drive", "create a file", "put in drive", "attach to drive"],
    keywordsHe: ["העלה", "שמור בדרייב", "קובץ חדש", "העלאה לדרייב"],
    related: ["drive_create_folder", "drive_update_file_content"],
  },
  drive_share_file: {
    useWhen: "grant someone access to a file or folder, or make it shareable by link",
    doNotUseWhen: "access is being taken away — use drive_delete_permission to remove or revoke one person's access, or to stop sharing with them.",
    returns: "the created permission id, role and type",
    keywords: ["share", "give access", "permission", "link sharing", "anyone with the link", "add a collaborator"],
    keywordsHe: ["שתף", "שיתוף", "הרשאה", "תן גישה", "קישור לשיתוף"],
    related: ["drive_list_permissions", "drive_delete_permission"],
  },
  drive_delete_file: {
    useWhen: "remove a Drive file or folder — trashed by default, permanent only when explicitly asked",
    doNotUseWhen: "it should only leave a folder, not Drive — use drive_move_file.",
    returns: "the file id and whether it was trashed or permanently deleted",
    keywords: ["delete", "remove the file", "trash", "bin", "get rid of"],
    keywordsHe: ["מחק", "תמחק", "למחוק", "מחיקה", "לאשפה", "תמחק קובץ", "מחק את הקובץ", "תמחק את הקובץ", "להיפטר"],
    related: ["drive_update_file", "drive_move_file"],
  },

  // ---- Docs ----------------------------------------------------------------
  docs_read_document: {
    useWhen: "read the text of a Google Doc",
    doNotUseWhen: "heading outline and body indexes are needed for an edit — use docs_get_document.",
    returns: "the document text with totalChars/returnedChars and a truncation flag",
    keywords: ["read the doc", "document text", "what does the doc say", "open the document", "summarise the doc"],
    keywordsHe: ["מסמך", "קרא מסמך", "תוכן המסמך", "מה כתוב במסמך", "סכם מסמך"],
    related: ["docs_get_document", "docs_export_document"],
  },
  docs_create_document: {
    useWhen: "create a new Google Doc, optionally with initial text and inside a Drive folder",
    doNotUseWhen: "text is going into a document that already exists — use docs_append_text.",
    returns: "the new documentId and its url",
    keywords: ["new doc", "create a document", "write me a doc", "start a document"],
    keywordsHe: ["צור מסמך", "מסמך חדש", "לכתוב מסמך"],
    related: ["docs_append_text", "docs_insert_text"],
  },
  docs_replace_text: {
    useWhen: "swap every occurrence of a string in a document, e.g. filling a template placeholder",
    doNotUseWhen: "new text goes at one position — use docs_insert_text.",
    returns: "how many occurrences were replaced",
    keywords: ["replace", "find and replace", "template", "placeholder", "swap the name"],
    keywordsHe: ["החלף", "מצא והחלף", "תבנית", "שנה טקסט", "מלא תבנית"],
    related: ["docs_insert_text", "docs_batch_update_document"],
  },

  // ---- Gmail ---------------------------------------------------------------
  gmail_search_messages: {
    useWhen: "find mail with Gmail search syntax — by sender, subject, date, label, attachment or unread state",
    doNotUseWhen: "a message id is already in hand and its body is wanted — use gmail_read_message.",
    returns: "id, threadId, date, from, subject, snippet and labels per match",
    keywords: ["search mail", "find the email", "from a sender", "unread", "inbox", "subject", "has attachment", "last week"],
    keywordsHe: ["חפש מייל", "מיילים", "דואר", "לא נקרא", "תיבת דואר", "ממי", "נושא", "מהשבוע"],
    related: ["gmail_read_message", "gmail_read_thread"],
  },
  gmail_read_message: {
    useWhen: "read one message's headers, body and attachment list once its id is known",
    doNotUseWhen: "the whole conversation matters — use gmail_read_thread.",
    returns: "headers, body text (capped by max_chars) and attachment metadata",
    keywords: ["read the email", "body", "full message", "what did they write", "attachments on it"],
    keywordsHe: ["קרא מייל", "גוף ההודעה", "מה כתוב במייל", "תוכן המייל"],
    related: ["gmail_read_thread", "gmail_download_attachment"],
  },
  gmail_read_thread: {
    useWhen: "read a whole conversation in order, e.g. to catch up on a back-and-forth before replying",
    doNotUseWhen: "only one specific message matters — use gmail_read_message.",
    returns: "every message of the thread with headers and body text",
    keywords: ["thread", "conversation", "the whole exchange", "all the replies", "catch up"],
    keywordsHe: ["שרשור", "שיחה", "כל ההתכתבות", "התגובות", "לעדכן אותי"],
    related: ["gmail_search_messages", "gmail_read_message"],
  },
  gmail_create_draft: {
    useWhen: "compose mail for the user to review — the default way to write a reply or a new message",
    doNotUseWhen: "the user explicitly asked to send it now — use gmail_send_message.",
    returns: "the draftId and messageId of the saved draft",
    keywords: ["draft", "compose", "write an email", "prepare a reply", "for review", "answer them", "do not send", "without sending"],
    keywordsHe: ["טיוטה", "נסח", "כתוב מייל", "הכן תשובה", "תענה להם", "בלי לשלוח", "אל תשלח עדיין"],
    related: ["gmail_send_draft", "gmail_update_draft"],
  },
  gmail_send_message: {
    useWhen: "send mail immediately, only after the user explicitly asked to send; requires confirm=true",
    doNotUseWhen: "sending has not been approved yet — use gmail_create_draft.",
    returns: "the sent message id and its thread id",
    keywords: ["send the email", "send now", "mail it", "fire it off"],
    keywordsHe: ["שלח מייל", "שליחה", "תשלח עכשיו", "שלח להם"],
    related: ["gmail_create_draft", "gmail_send_draft"],
  },
  gmail_send_draft: {
    useWhen: "send a draft the user already reviewed, by draftId; requires confirm=true",
    doNotUseWhen: "no draft exists yet, or the user said not to send it yet — use gmail_create_draft.",
    returns: "the sent message id and its thread id",
    keywords: ["send the draft", "approve and send", "go ahead and send", "the draft is ready"],
    keywordsHe: ["שלח את הטיוטה", "אשר ושלח", "תשלח את זה"],
    related: ["gmail_create_draft", "gmail_read_draft"],
  },
  gmail_modify_message_labels: {
    useWhen: "mark one message read/unread, star it or archive it by adding and removing labels",
    doNotUseWhen: "hundreds of messages need the same change — use gmail_batch_modify_message_labels.",
    returns: "the message id and its labels after the change",
    keywords: ["label", "archive", "mark as read", "mark unread", "star it", "important", "move to a label"],
    keywordsHe: ["תווית", "ארכיון", "סמן כנקרא", "לא נקרא", "כוכב", "העבר לתווית"],
    related: ["gmail_batch_modify_message_labels", "gmail_list_labels"],
  },
  gmail_trash_message: {
    useWhen: "move mail to Trash when the user asks to delete it (recoverable for 30 days)",
    doNotUseWhen: "it should only leave the inbox — archive it with gmail_modify_message_labels.",
    returns: "the message id and its labels after trashing",
    keywords: ["delete the email", "trash", "bin", "remove the message", "throw it away"],
    keywordsHe: ["מחק מייל", "לאשפה", "תמחק הודעה", "זרוק"],
    related: ["gmail_untrash_message", "gmail_modify_message_labels"],
  },

  // ---- Calendar ------------------------------------------------------------
  calendar_list_calendars: {
    useWhen: "get the calendar ids the account can see, before reading or writing on a non-primary calendar",
    doNotUseWhen: "the events themselves are wanted — use calendar_list_events.",
    returns: "id, summary, access role, primary flag and time zone per calendar",
    keywords: ["calendars", "which calendar", "calendar id", "shared calendar", "subscribed calendars"],
    keywordsHe: ["יומנים", "איזה יומן", "יומן משותף", "מזהה יומן"],
    related: ["calendar_list_events", "calendar_get_free_busy"],
  },
  calendar_list_events: {
    useWhen: "see what is scheduled in a time window, or search events by text",
    doNotUseWhen: "free slots are the question, not the events — use calendar_get_free_busy.",
    returns: "event id, summary, start/end, attendees and Meet link per event",
    keywords: ["events", "calendar events", "list events", "my events", "schedule", "agenda", "what is on my calendar", "meetings today", "upcoming", "this week", "my day"],
    keywordsHe: ["יומן", "מה מתוכנן לי", "פגישות", "היום", "מחר", "השבוע", "לוח זמנים"],
    related: ["calendar_get_event", "calendar_get_free_busy"],
  },
  calendar_get_free_busy: {
    useWhen: "check when people or rooms are free before proposing a meeting time",
    doNotUseWhen: "the event details are wanted, not availability — use calendar_list_events.",
    returns: "busy intervals per calendar with busyCount, and unreadable calendars under unavailable",
    keywords: ["free", "busy", "availability", "when can we meet", "open slot", "clash", "conflict"],
    keywordsHe: ["פנוי", "תפוס", "זמינות", "מתי אפשר", "חלון פנוי", "התנגשות"],
    related: ["calendar_list_events", "calendar_create_event"],
  },
  calendar_create_event: {
    useWhen: "put a new event on a calendar with explicit times, attendees and an optional Meet link",
    doNotUseWhen: "the request is one natural-language sentence with no structure — use calendar_quick_add_event.",
    returns: "the new event id, times, attendees and link",
    keywords: ["schedule", "book", "create a meeting", "invite", "new event", "put in the calendar"],
    keywordsHe: ["קבע פגישה", "תקבע", "אירוע חדש", "הוסף ליומן", "תזמן"],
    related: ["calendar_quick_add_event", "calendar_get_free_busy"],
  },
  calendar_delete_event: {
    useWhen: "cancel an event the user asked to remove; irreversible and attendees are notified",
    doNotUseWhen: "only the time or details change — use calendar_update_event.",
    returns: "confirmation that the event was deleted",
    keywords: ["cancel", "delete the event", "remove the meeting", "call it off"],
    keywordsHe: ["בטל פגישה", "מחק אירוע", "ביטול", "תבטל"],
    related: ["calendar_update_event"],
  },

  // ---- Tasks ---------------------------------------------------------------
  tasks_list_tasks: {
    useWhen: "see the open (or completed) to-dos in a task list, with due dates and subtasks",
    doNotUseWhen: "the tasklist id is not known yet — use tasks_list_tasklists.",
    returns: "task id, title, notes, due date, status and parent per task",
    keywords: ["todo", "to-do list", "tasks", "what is still open", "due", "checklist", "action items"],
    keywordsHe: ["משימות", "מטלות", "רשימת משימות", "מה עלי לעשות", "תאריך יעד"],
    related: ["tasks_list_tasklists", "tasks_get_task"],
  },
  tasks_create_task: {
    useWhen: "add a to-do with an optional due date, notes or parent task",
    doNotUseWhen: "the item belongs on a calendar at a fixed time — use calendar_create_event.",
    returns: "the new task id, title and due date",
    keywords: ["add a task", "remind me to", "new todo", "action item", "follow up on"],
    keywordsHe: ["הוסף משימה", "משימה חדשה", "תזכיר לי", "לעשות", "מטלה"],
    related: ["tasks_list_tasks", "tasks_update_task"],
  },
  tasks_complete_task: {
    useWhen: "mark a to-do as done",
    doNotUseWhen: "the task should disappear entirely — use tasks_delete_task.",
    returns: "the task with status completed and its completion time",
    keywords: ["done", "complete", "finished", "check it off", "mark as done"],
    keywordsHe: ["בוצע", "סיימתי", "סמן כבוצע", "השלם משימה", "גמרתי"],
    related: ["tasks_uncomplete_task", "tasks_delete_task"],
  },

  // ---- Contacts ------------------------------------------------------------
  contacts_search_contacts: {
    useWhen: "look up a person's email, phone or details by name, nickname or organisation",
    doNotUseWhen: "the people/c… resource name is already known — use contacts_get_contact.",
    returns: "resource name, display name, emails and phone numbers per match",
    keywords: ["contact", "email address of", "phone number", "look up a person", "details for"],
    keywordsHe: ["איש קשר", "אנשי קשר", "מספר טלפון", "כתובת מייל של", "מי זה", "פרטים של"],
    related: ["contacts_get_contact", "contacts_list_contacts"],
  },
  contacts_create_contact: {
    useWhen: "save a new person to the account's contacts with names, emails and phone numbers",
    doNotUseWhen: "the person already exists and needs a change — use contacts_update_contact.",
    returns: "the new contact's resource name and stored fields",
    keywords: ["add a contact", "new contact", "save the number", "save this person"],
    keywordsHe: ["הוסף איש קשר", "שמור מספר", "איש קשר חדש"],
    related: ["contacts_update_contact", "contacts_search_contacts"],
  },

  // ---- Chat ----------------------------------------------------------------
  chat_list_spaces: {
    useWhen: "find the Chat space, room or DM to work in, or list the ones the user belongs to",
    doNotUseWhen: "the direct message with one named person is wanted — use chat_find_direct_message.",
    returns: "space resource name, display name, type and member count",
    keywords: ["chat space", "room", "group chat", "dm", "which space", "google chat"],
    keywordsHe: ["צאט", "מרחב", "קבוצה", "חדר", "צ'אט"],
    related: ["chat_find_direct_message", "chat_list_messages"],
  },
  chat_list_messages: {
    useWhen: "read recent messages in a Chat space (spaces/AAAA), newest first by default",
    doNotUseWhen: "one message resource name is already in hand — use chat_get_message.",
    returns: "message name, sender, text and create time per message",
    keywords: ["chat history", "messages in the space", "what was said", "read the chat", "catch up on the room"],
    keywordsHe: ["הודעות", "מה נכתב", "היסטוריית צאט", "קרא את הצאט"],
    related: ["chat_list_spaces", "chat_get_message"],
  },
  chat_send_message: {
    useWhen: "post a Chat message as the user after they asked for it; it cannot be unsent",
    doNotUseWhen: "the user meant mail rather than chat — use gmail_create_draft.",
    returns: "the created message resource name and its text",
    keywords: ["send a chat", "post a message", "write in the space", "ping the team", "tell the group"],
    keywordsHe: ["שלח הודעה", "כתוב בצאט", "תודיע לקבוצה", "תכתוב להם"],
    related: ["chat_update_message", "chat_delete_message"],
  },

  // ---- Slides --------------------------------------------------------------
  slides_read_presentation: {
    useWhen: "read a deck's text slide by slide — the cheapest way to see what a presentation says",
    doNotUseWhen: "element ids and geometry are needed to edit — use slides_get_slide.",
    returns: "per slide: index, objectId, title and all text",
    keywords: ["presentation", "deck", "slide text", "what is in the deck", "read the slides", "summarise the deck"],
    keywordsHe: ["מצגת", "שקופיות", "מה במצגת", "קרא מצגת", "סכם מצגת"],
    related: ["slides_get_presentation", "slides_get_slide"],
  },
  slides_create_presentation: {
    useWhen: "start a new Google Slides deck before adding slides to it",
    doNotUseWhen: "the deck exists and needs another slide — use slides_add_slide.",
    returns: "the new presentationId and its url",
    keywords: ["new deck", "create a presentation", "make slides", "pitch deck"],
    keywordsHe: ["צור מצגת", "מצגת חדשה", "בנה מצגת"],
    related: ["slides_add_slide", "slides_replace_text"],
  },
  slides_replace_text: {
    useWhen: "fill a template deck by replacing every occurrence of a placeholder string",
    doNotUseWhen: "text must land in one shape at an index — use slides_insert_text.",
    returns: "how many occurrences were replaced",
    keywords: ["replace in the deck", "template", "placeholder", "fill the deck", "swap a name everywhere", "change every occurrence"],
    keywordsHe: ["החלף במצגת", "תבנית מצגת", "מלא מצגת", "החלף שם בכל השקופיות"],
    related: ["slides_insert_text", "slides_batch_update_presentation"],
  },

  // ---- Forms ---------------------------------------------------------------
  forms_get_form: {
    useWhen: "inspect a form's questions, item ids, publish state and responder link",
    doNotUseWhen: "the submitted answers are wanted — use forms_list_responses.",
    returns: "title, description, responderUri, publish state and every item with its id",
    keywords: ["form", "questions", "survey structure", "responder link", "form id"],
    keywordsHe: ["טופס", "שאלות", "מבנה הטופס", "קישור לטופס"],
    related: ["forms_list_responses", "forms_add_questions"],
  },
  forms_list_responses: {
    useWhen: "read what people answered in a form, newest first",
    doNotUseWhen: "the questions matter, not the answers — use forms_get_form.",
    returns: "responseId, submit time and answers keyed by question title",
    keywords: ["responses", "answers", "submissions", "survey results", "who replied"],
    keywordsHe: ["תשובות", "תגובות", "מי ענה", "תוצאות הסקר", "נרשמו"],
    related: ["forms_get_response", "forms_get_form"],
  },
  forms_create_form: {
    useWhen: "create a Google Form with questions; it is published unless unpublished=true",
    doNotUseWhen: "the form exists and only needs more questions — use forms_add_questions.",
    returns: "the new formId, responderUri and edit url",
    keywords: ["new form", "create a survey", "questionnaire", "poll", "registration form", "sign-up form"],
    keywordsHe: ["צור טופס", "טופס חדש", "סקר", "שאלון", "טופס הרשמה"],
    related: ["forms_add_questions", "forms_update_publish_settings"],
  },

  // ---- Photos --------------------------------------------------------------
  photos_search_media_items: {
    useWhen: "list or filter the photos and videos this app itself uploaded, by album, date or category",
    doNotUseWhen: "the user means their own library — only photos_create_picker_session reaches those.",
    returns: "media item id, filename, creation time and mimeType per item",
    keywords: ["photos", "pictures", "media items", "album contents", "videos", "uploaded by the app"],
    keywordsHe: ["תמונות", "סרטונים", "אלבום", "מדיה"],
    related: ["photos_list_albums", "photos_create_picker_session"],
  },
  photos_create_picker_session: {
    useWhen: "let the user pick photos from their own library — the only way to reach photos this app did not upload",
    doNotUseWhen: "the photos were uploaded through this app — use photos_search_media_items.",
    returns: "a pickerUri for the user to open, plus the session id to poll",
    keywords: ["pick photos", "my library", "choose pictures", "select photos", "picker"],
    keywordsHe: ["בחר תמונות", "הספרייה שלי", "התמונות שלי", "בורר תמונות"],
    related: ["photos_get_picker_session", "photos_list_picked_media_items"],
  },

  // ---- YouTube -------------------------------------------------------------
  youtube_search_videos: {
    useWhen: "search YouTube for videos, channels or playlists by keywords",
    doNotUseWhen: "statistics for known video ids are wanted — use youtube_get_video_stats.",
    returns: "videoId or channelId, title, channel, publishedAt and url per result",
    keywords: ["youtube", "video", "search videos", "channel", "clip", "find a video"],
    keywordsHe: ["יוטיוב", "סרטון", "סרטונים", "ערוץ", "חפש סרטון"],
    related: ["youtube_get_video_stats", "youtube_list_playlist_items"],
  },

  // ---- Meet ----------------------------------------------------------------
  meet_create_space: {
    useWhen: "create a standalone Google Meet link that is not attached to a calendar event",
    doNotUseWhen: "the meeting belongs on the calendar — use calendar_create_event, which adds a Meet link.",
    returns: "the space resource name, meeting code and meeting url",
    keywords: ["meet link", "video call", "new meeting room", "conference link"],
    keywordsHe: ["לינק למיט", "שיחת וידאו", "קישור לפגישה", "חדר פגישה"],
    related: ["meet_get_space", "calendar_create_event"],
  },
  meet_list_transcripts: {
    useWhen: "find the transcript of a past Meet call before reading what was said",
    doNotUseWhen: "the recording file is wanted instead — use meet_list_recordings.",
    returns: "transcript name, state, times and the docsDocumentId holding the text",
    keywords: ["transcript", "what was said", "meeting notes", "minutes", "captions"],
    keywordsHe: ["תמלול", "מה נאמר", "סיכום פגישה", "פרוטוקול"],
    related: ["meet_list_transcript_entries", "meet_list_recordings"],
  },
  // =========================================================================
  // Sibling disambiguation (§A.3: "every tool named by the routing fixtures"). These are the
  // tools a fixture query lands ON or NEXT TO, so each one exists to separate a confusable pair
  // rather than to add coverage — `doNotUseWhen` always names the sibling it is confused with.
  // =========================================================================

  // ---- Gmail ---------------------------------------------------------------
  gmail_download_attachment: {
    useWhen: "download the file attached to a message — inline as text or base64, or straight into Drive when it is large",
    doNotUseWhen: "the attachment id is not known yet — it comes from gmail_read_message.",
    returns: "the decoded text, base64 bytes, or a Drive file id and link",
    keywords: ["attachment", "attached file", "download the pdf", "download the attachment", "the file on that email", "invoice pdf"],
    keywordsHe: ["קובץ מצורף", "צרופה", "תוריד את הקובץ", "שמור את הקובץ המצורף", "הפידיאף מהמייל"],
    related: ["gmail_read_message", "drive_upload_file"],
  },
  gmail_list_labels: {
    useWhen: "list every label in the mailbox with its id, before filtering by one or applying one",
    doNotUseWhen: "message counts for one known label are wanted — use gmail_get_label.",
    returns: "id, name and type per label (system and user)",
    keywords: ["labels", "what labels", "label list", "my folders", "tags in gmail", "which labels exist"],
    keywordsHe: ["תוויות", "אילו תוויות", "רשימת תוויות", "התיקיות שלי", "תגיות במייל"],
    related: ["gmail_get_label", "gmail_modify_message_labels"],
  },

  // ---- Sheets --------------------------------------------------------------
  sheets_batch_read_ranges: {
    useWhen: "read several ranges of one spreadsheet in a single call",
    doNotUseWhen: "there is only one range — use sheets_read_range.",
    returns: "one values block per range, as rows or keyed by A1 cell address, in the order asked",
    keywords: ["several ranges", "multiple ranges", "read both tabs", "a few ranges at once", "batch read"],
    keywordsHe: ["כמה טווחים", "מספר טווחים", "קרא כמה אזורים", "קריאה מרובה", "שני טווחים"],
    related: ["sheets_read_range", "sheets_batch_write_ranges"],
  },
  sheets_read_cells: {
    useWhen: "read cells with their formulas, notes, links, validation or colours, not only the displayed values",
    doNotUseWhen: "plain values are enough — use sheets_read_range, which is much cheaper.",
    returns: "per cell (positional or keyed by A1 address): value, formula, numeric value, note, link, error and formatting",
    keywords: ["formulas", "cell notes", "formatting", "cell colors", "data validation", "what formula is in", "full fidelity"],
    keywordsHe: ["נוסחאות", "הערות בתאים", "עיצוב תאים", "צבע התא", "אימות נתונים", "איזו נוסחה יש"],
    related: ["sheets_read_range", "sheets_audit_spreadsheet"],
  },
  sheets_batch_write_ranges: {
    useWhen: "write several ranges of one spreadsheet in a single call",
    doNotUseWhen: "there is only one range — use sheets_write_range.",
    returns: "updated range and cell count per range",
    keywords: ["several ranges", "multiple ranges", "write both tabs", "a few ranges at once", "batch write"],
    keywordsHe: ["כתיבה לכמה טווחים", "מספר טווחים", "כתוב לשני אזורים", "כתיבה מרובה"],
    related: ["sheets_write_range", "sheets_batch_read_ranges"],
  },
  sheets_fill_range: {
    useWhen: "fill one formula or value down or across a range, references adjusting as when dragged",
    doNotUseWhen: "each cell gets its own value, e.g. to fill in or fill out a sheet — use sheets_write_range.",
    returns: "the filled range and cell count, re-read to verify",
    // Fill and formula words only, here and in useWhen. Every phrase is indexed word by word, so
    // "every month" or "whole column" put "month" and "column" on this tool and the mutation gate
    // pinned a cell overwrite to "archive the newsletters from last month", a Gmail request; and
    // "down a column or across a row" let it take a ranking slot from "append a row …" requests.
    // tests/sheets-fill.test.ts pins both. Nor the bare verb: "fill" already sits in this tool's
    // name, and more of it ("fill down", "fill across", twice in useWhen) ranked the tool above
    // sheets_write_range on "fill out the onboarding sheet"; Hebrew מלא is also "full". So the
    // keywords carry the formula and the direction, and doNotUseWhen names "fill in / fill out" so
    // those phrases count against this tool. The gate admits it only on fill evidence
    // (OWN_EVIDENCE_VERBS in src/routing/gate.ts), whatever it ranks.
    keywords: ["same formula", "formula down", "formula across", "drag down", "extend formula", "autofill"],
    keywordsHe: ["נוסחה למטה", "נוסחה לרוחב", "גרור את הנוסחה", "מילוי אוטומטי"],
    related: ["sheets_write_range", "sheets_read_cells"],
  },
  sheets_trace_precedents: {
    useWhen: "find where a number comes from — the cells and ranges a formula reads, recursively",
    doNotUseWhen: "the question is what breaks if the cell changes — use sheets_trace_dependents.",
    returns: "the formula, the cells it reads and their values, level by level",
    keywords: ["where does this come from", "which cells feed", "inputs of the formula", "upstream cells", "source of the number"],
    keywordsHe: ["מאיפה מגיע המספר", "אילו תאים מזינים", "קלטים של הנוסחה", "תאי מקור"],
    related: ["sheets_trace_dependents", "sheets_audit_spreadsheet"],
  },
  sheets_clear_range: {
    useWhen: "remove the values in a range while keeping its formatting; the old values are not recoverable",
    doNotUseWhen: "the whole tab should go, not its contents — use sheets_batch_update_spreadsheet with deleteSheet.",
    returns: "the cleared range",
    keywords: ["clear the cells", "empty the range", "wipe the values", "erase the contents", "blank it out"],
    keywordsHe: ["נקה את התאים", "רוקן את הטווח", "מחק את הערכים", "תנקה את האזור"],
    related: ["sheets_write_range", "sheets_batch_update_spreadsheet"],
  },
  sheets_copy_sheet: {
    useWhen: "copy one tab into another spreadsheet, keeping the original where it is",
    doNotUseWhen: "the tab should move rather than be duplicated — use sheets_batch_update_spreadsheet.",
    returns: "the new sheet id and title in the destination spreadsheet",
    keywords: ["copy the tab", "duplicate a sheet", "clone that tab", "duplicate into another spreadsheet", "copy sheet to"],
    keywordsHe: ["העתק לשונית", "שכפל גיליון", "תעתיק את הלשונית", "לגיליון אחר"],
    related: ["sheets_add_sheet", "sheets_batch_update_spreadsheet"],
  },
  sheets_trace_dependents: {
    useWhen: "find what breaks if a cell changes — every formula that reads it, recursively",
    doNotUseWhen: "the question is where the value comes from — use sheets_trace_precedents.",
    returns: "the formulas that read the cell and the formulas that read those",
    keywords: ["what depends on", "which formulas use", "downstream formulas", "what breaks if i change", "who reads this cell"],
    keywordsHe: ["מה תלוי בתא", "אילו נוסחאות משתמשות", "מה יישבר אם אשנה", "תלויות"],
    related: ["sheets_trace_precedents", "sheets_audit_spreadsheet"],
  },

  // ---- Drive ---------------------------------------------------------------
  drive_create_folder: {
    useWhen: "create a Drive folder, optionally inside an existing one",
    doNotUseWhen: "a file is being created rather than a folder — use drive_upload_file.",
    returns: "the new folder id, name, parents and link",
    keywords: ["new folder", "make a folder", "create a directory", "folder for", "set up a folder"],
    keywordsHe: ["תיקייה חדשה", "צור תיקייה", "תפתח תיקייה", "תיקיה חדשה בדרייב"],
    related: ["drive_upload_file", "drive_move_file"],
  },
  drive_list_permissions: {
    useWhen: "see who currently has access to a file or folder, and get the permission ids",
    doNotUseWhen: "access is being granted rather than inspected — use drive_share_file.",
    returns: "permission id, type, role, email or domain and expiry per entry",
    keywords: ["who has access", "who can see", "sharing settings", "list permissions", "who is it shared with"],
    keywordsHe: ["מי יכול לגשת", "עם מי משותף", "הגדרות שיתוף", "רשימת הרשאות"],
    related: ["drive_share_file", "drive_delete_permission"],
  },
  drive_delete_permission: {
    useWhen: "remove one person's access to a file or folder, leaving the file itself untouched",
    doNotUseWhen: "the file itself should go, not someone's access — use drive_delete_file.",
    returns: "confirmation that the permission was removed",
    keywords: ["revoke access", "unshare", "stop sharing", "remove a collaborator", "take away permission", "kick them off the file"],
    keywordsHe: ["בטל שיתוף", "הסר הרשאה", "תוריד גישה", "שלא יראו את הקובץ", "בטל גישה"],
    related: ["drive_list_permissions", "drive_share_file"],
  },
  drive_update_file_content: {
    useWhen: "overwrite the bytes of an existing non-Google file, keeping its id, name and link",
    doNotUseWhen: "the file should be removed rather than rewritten — use drive_delete_file.",
    returns: "the file id, name and new size",
    keywords: ["replace the file contents", "overwrite the file", "new version of the file", "update the bytes", "re-upload over it"],
    keywordsHe: ["החלף את תוכן הקובץ", "דרוס את הקובץ", "גרסה חדשה של הקובץ", "עדכן את התוכן"],
    related: ["drive_upload_file", "drive_read_file"],
  },

  // ---- Docs ----------------------------------------------------------------
  docs_get_document: {
    useWhen: "get a document's heading outline, body indexes and tables before editing it by index",
    doNotUseWhen: "the prose itself is what is wanted — use docs_read_document.",
    returns: "headings with start/end indexes, endIndex, tables, image count and named ranges",
    keywords: ["outline", "headings", "document structure", "where to insert", "body indexes", "sections of the doc"],
    keywordsHe: ["מבנה המסמך", "כותרות", "ראשי פרקים", "איפה להכניס", "אינדקסים במסמך"],
    related: ["docs_read_document", "docs_insert_text"],
  },
  docs_append_text: {
    useWhen: "add text at the end of an existing document, optionally as a heading",
    doNotUseWhen: "the text goes at a known index in the middle — use docs_insert_text.",
    returns: "the new end index of the document body",
    // "add them to the document" (JEV bench J29): with the comment tools in the Docs pass, the generic
    // create tools outranked this one on that phrasing, and the gate kept only two Docs writes.
    keywords: ["add a paragraph", "append at the end", "add a section", "write more text", "add them to the document"],
    keywordsHe: ["הוסף פסקה", "בסוף המסמך", "הוסף סעיף", "תוסיף עוד טקסט"],
    related: ["docs_insert_text", "docs_create_document"],
  },
  docs_replace_section: {
    useWhen: "swap the body of one section — every paragraph under a named heading — for new wording, keeping the heading and the rest",
    doNotUseWhen: "one phrase should change wherever it appears — use docs_replace_text.",
    returns: "the section's old index range, the characters written and where the section now ends",
    keywords: ["rewrite the section", "section body", "under the heading", "whole section", "redo that part of the doc"],
    keywordsHe: ["תכתוב מחדש את הסעיף", "תחליף את הסעיף", "מתחת לכותרת", "תוכן הסעיף", "כל הסעיף"],
    related: ["docs_get_document", "docs_update_paragraph_style"],
  },
  docs_update_paragraph_style: {
    // No "paragraph" here on purpose: the name already carries it, and more of it made any query
    // with the word ("translate this paragraph") a confident match for a formatting tool.
    useWhen: "format spacing, line spacing or alignment in a doc, e.g. room under a table",
    doNotUseWhen: "the words themselves should change — use docs_replace_section.",
    returns: "the property mask applied and the ranges styled",
    // Spacing words only, never "space …": "space" is the Chat and Meet noun, and a keyword with it
    // pulled this tool into "post a message in the Engineering space". No word of position either
    // ("above", "below", "מעל", "מתחת") and no "שורות": the index reads every word of a phrase on
    // its own, so "spacing above" / "ריווח שורות" made this tool a match for "insert two rows above
    // row 5 in the sheet" and "תשנה את השורות", and the gate offered it on Sheets row requests.
    keywords: ["spacing", "line spacing", "double spacing", "room under the table", "justify", "center align"],
    keywordsHe: ["ריווח", "ריווח אחרי הטבלה", "יישור", "תיישר למרכז", "תמרכז את הכותרת"],
    related: ["docs_get_document", "docs_replace_section"],
  },
  docs_list_comments: {
    useWhen: "read the comments on a document — who wrote them, the quoted text, resolved or still open",
    doNotUseWhen: "the document text itself is wanted — use docs_read_document.",
    returns: "id, author, content, quoted text, resolved flag and reply count per comment",
    keywords: ["comments on the doc", "review comments", "open comments", "who commented", "unresolved comments", "feedback on the document"],
    keywordsHe: ["הערות במסמך", "תגובות במסמך", "מי הגיב", "הערות פתוחות", "הערות שלא נפתרו"],
    related: ["docs_create_reply", "docs_create_comment"],
  },
  docs_create_comment: {
    useWhen: "put a new comment on a doc; Google leaves it unanchored, so quote the passage it is about",
    doNotUseWhen: "an existing comment is being answered — use docs_create_reply.",
    returns: "the new comment id",
    keywords: ["leave a comment", "new comment", "comment on the doc", "margin note", "note for the author"],
    keywordsHe: ["תוסיף הערה", "הוסף הערה", "תשאיר הערה", "תגובה במסמך", "הערה למחבר"],
    related: ["docs_list_comments", "docs_create_reply"],
  },
  docs_create_reply: {
    useWhen: "reply to an existing comment thread, optionally resolving it",
    doNotUseWhen: "a new comment thread is being started — use docs_create_comment.",
    returns: "the reply id and the comment's resolved flag",
    keywords: ["reply to the comment", "answer the comment", "resolve the comment", "mark the comment resolved", "close the comment"],
    keywordsHe: ["תענה להערה", "תגיב להערה", "תסגור את ההערה", "סמן הערה כפתורה", "תפתור את ההערה"],
    related: ["docs_list_comments", "docs_create_comment"],
  },

  // ---- Calendar ------------------------------------------------------------
  calendar_quick_add_event: {
    useWhen: "create an event from one natural-language line when the exact title does not matter",
    doNotUseWhen: "the title, attendees or a Meet link matter — use calendar_create_event.",
    returns: "the created event with the start/end Google parsed out of the text",
    keywords: ["quick add", "in one line", "one sentence event", "parse this into an event"],
    keywordsHe: ["הוספה מהירה ליומן", "תוסיף ליומן במשפט", "פשוט תוסיף ליומן"],
    related: ["calendar_create_event", "calendar_list_events"],
  },
  calendar_rsvp_event: {
    useWhen: "reply to an invitation as the signed-in user — accepted, declined or tentative",
    doNotUseWhen: "the event itself should be removed from the calendar — use calendar_delete_event.",
    returns: "the updated attendee response status",
    keywords: ["accept the invite", "decline the invite", "rsvp", "count me in", "tentative yes", "respond to the invitation"],
    keywordsHe: ["אשר הגעה", "תאשר את ההזמנה", "דחה את ההזמנה", "אולי אגיע", "תשיב להזמנה"],
    related: ["calendar_get_event", "calendar_list_events"],
  },
  calendar_get_event: {
    useWhen: "get one event by id with its description, attendees, response statuses and Meet link",
    doNotUseWhen: "the event still has to be found in a time window — use calendar_list_events.",
    returns: "summary, start/end, description, attendees with responses, recurrence and reminders",
    keywords: ["details of that meeting", "who is invited", "event details", "attendees of the event", "the meeting description"],
    keywordsHe: ["פרטי הפגישה", "מי מוזמן", "מי אישר הגעה", "תיאור האירוע", "פרטי האירוע"],
    related: ["calendar_list_events", "calendar_rsvp_event"],
  },

  // ---- Contacts ------------------------------------------------------------
  contacts_get_contact: {
    useWhen: "get one contact by its people/c… resource name, with every supported field",
    doNotUseWhen: "only a name is known and the contact has to be found — use contacts_search_contacts.",
    returns: "names, emails, phones, organisation, addresses, birthday, notes and groups",
    keywords: ["that contact card", "full details of one person", "by resource name"],
    keywordsHe: ["כרטיס איש הקשר", "כל הפרטים של האדם", "לפי שם המשאב"],
    related: ["contacts_search_contacts", "contacts_batch_get_contacts"],
  },
  contacts_batch_get_contacts: {
    useWhen: "get many contacts at once when their people/c… resource names are already known",
    doNotUseWhen: "there is only one resource name — use contacts_get_contact.",
    returns: "one compact person per resource name, plus errors for the unreadable ones",
    keywords: ["several contacts", "many resource names", "these people at once", "bulk contact lookup"],
    keywordsHe: ["כמה אנשי קשר יחד", "מספר כרטיסים", "אנשי קשר בבת אחת", "שליפה מרוכזת"],
    related: ["contacts_get_contact", "contacts_list_contacts"],
  },
  contacts_list_contacts: {
    useWhen: "list the whole address book when nothing narrows it to a particular person",
    doNotUseWhen: "a name, company or number narrows it — use contacts_search_contacts.",
    returns: "compact people with names, emails and phones, plus totalPeople",
    keywords: ["the whole address book", "everybody i know", "how many people do i have"],
    keywordsHe: ["ספר הטלפונים שלי", "כל האנשים שיש לי", "כמה אנשי קשר יש"],
    related: ["contacts_search_contacts", "contacts_batch_get_contacts"],
  },

  // ---- Slides --------------------------------------------------------------
  slides_get_slide: {
    useWhen: "get one slide's elements, text, positions and speaker notes, usually before editing it",
    doNotUseWhen: "the text of the whole deck is wanted — use slides_read_presentation.",
    returns: "every element with objectId, type, text, transform and size, plus speaker notes",
    keywords: ["one slide", "third page of the deck", "elements on a slide", "speaker notes", "shapes and text boxes"],
    keywordsHe: ["שקופית מסוימת", "השלישית במצגת", "רכיבים בשקופית", "הערות מרצה"],
    related: ["slides_read_presentation", "slides_batch_update_presentation"],
  },

  // ---- YouTube -------------------------------------------------------------
  youtube_get_video_stats: {
    useWhen: "get views, likes, duration and details for video ids already in hand",
    doNotUseWhen: "the video still has to be found by keywords — use youtube_search_videos.",
    returns: "title, channel, publishedAt, duration, views, likes, comments and url per video",
    keywords: ["how many views", "view count", "likes on the video", "video statistics", "how long is the video", "performance of that video"],
    keywordsHe: ["כמה צפיות", "מספר הצפיות", "לייקים לסרטון", "סטטיסטיקות של הסרטון", "אורך הסרטון"],
    related: ["youtube_search_videos", "youtube_list_playlist_items"],
  },
  youtube_list_playlists: {
    useWhen: "list the playlists of a channel or of the signed-in account",
    doNotUseWhen: "the videos inside one playlist are wanted — use youtube_list_playlist_items.",
    returns: "id, title, item count and privacy per playlist",
    keywords: ["my playlists", "playlists on the channel", "which playlists", "playlist list"],
    keywordsHe: ["הפלייליסטים שלי", "רשימות השמעה", "אילו פלייליסטים", "פלייליסטים בערוץ"],
    related: ["youtube_list_playlist_items", "youtube_list_my_channels"],
  },

  // ---- Meet ----------------------------------------------------------------
  meet_list_transcript_entries: {
    useWhen: "read what was actually said in a transcript, line by line",
    doNotUseWhen: "the transcript still has to be located for that meeting — use meet_list_transcripts.",
    returns: "start time, participant and text per spoken entry",
    keywords: ["what was said", "transcript lines", "read the transcript", "who said what", "the words from the call"],
    keywordsHe: ["מה נאמר בפגישה", "שורות התמלול", "תקרא את התמלול", "מי אמר מה"],
    related: ["meet_list_transcripts", "meet_list_participants"],
  },
  meet_list_recordings: {
    useWhen: "find the recording file of a past conference and its link in Drive",
    doNotUseWhen: "the text of the meeting is wanted rather than the video — use meet_list_transcripts.",
    returns: "state, start/end time, driveFileId and exportUri per recording",
    keywords: ["recording of the meeting", "the video of the call", "mp4 of the meeting", "was it recorded", "recordings"],
    keywordsHe: ["הקלטת הפגישה", "הוידאו של השיחה", "האם הוקלט", "הקלטות של הפגישה"],
    related: ["meet_list_transcripts", "meet_list_conference_records"],
  },

  // ---- Photos --------------------------------------------------------------
  photos_create_album: {
    useWhen: "create an empty album before uploading photos into it",
    doNotUseWhen: "photos are being added to an album that exists — use photos_add_album_items.",
    returns: "the new album id, title and productUrl",
    keywords: ["new album", "make an album", "start an album", "empty album"],
    keywordsHe: ["אלבום חדש", "צור אלבום", "תפתח אלבום"],
    related: ["photos_add_album_items", "photos_list_albums"],
  },

  meet_end_conference: {
    useWhen: "end an active Meet conference and remove everyone, only on an explicit request; irreversible",
    doNotUseWhen: "only who may join should change — use meet_update_space.",
    returns: "confirmation that the active conference was ended",
    keywords: ["end the meeting", "kick everyone out", "hang up", "close the call"],
    keywordsHe: ["סיים פגישה", "נתק את כולם", "סגור את השיחה"],
    related: ["meet_update_space", "meet_get_space"],
  },
};

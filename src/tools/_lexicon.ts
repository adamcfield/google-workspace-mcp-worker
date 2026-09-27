/**
 * The routing lexicon (v1.5 PR-6a, spec §B): the words a person actually uses — in English
 * and in Hebrew — for a service, a verb and a resource, plus the `HARD_SIGNALS` regexes that
 * recognise an unambiguous shape in the RAW query (a Google URL, a Gmail operator, an A1
 * range, a Chat space name, a contacts resource name, an email address, a time word).
 *
 * This is a LEAF module: data and pure helpers only. It imports the verb vocabulary from
 * `naming.ts` and nothing else — never `_manifest.ts`, never the engine in `_router.ts`,
 * never `index.ts`. Nothing here reaches the wire: no tool is registered, listed or described
 * from this file (PR-6a rule #1).
 *
 * Hebrew is first-class, not a translation layer. The tokenizer does no suffix stemming, so
 * every form that is actually typed is listed explicitly: plurals (`מיילים`), the common
 * imperative (`שלח`), the "talking to a bot" future (`תשלח`) and the infinitive (`לשלוח`).
 * Clitics (ה/ב/ל/כ/מ/ו/ש) are stripped by the tokenizer against these terms, which is why a
 * bare stem is listed even when the natural phrase carries a prefix.
 *
 * Coverage is enforced by `tests/lexicon.test.ts`: every service and every verb/resource that
 * `parseToolName` yields over `ALL_TOOLS` has an entry with at least one English AND one
 * Hebrew term. A few resources are genuinely spoken in Hebrew as loanwords (פלייליסט, סלייד,
 * אימוג'י, פידיאף) — those are listed as the loanword, which is what a Hebrew speaker types.
 */
import type { Verb } from "./naming.js";

/** The words for one concept, per language. Terms are lowercase, trimmed and deduplicated. */
export interface LexEntry {
  /** English terms; single words and multi-word phrases (the tokenizer bigrams the query). */
  readonly en: readonly string[];
  /** Hebrew terms; plurals and the common verb forms are listed explicitly (no stemming). */
  readonly he: readonly string[];
}

/** A language tag used by this module (not exported: the two term sets below are the API). */
type Lang = "en" | "he";

// ---------------------------------------------------------------------------
// Services — the first segment of a tool name (`gmail_read_message` → `gmail`).
// ---------------------------------------------------------------------------

/** Service prefix → how people name that product. */
export const SERVICE_LEXICON: Readonly<Record<string, LexEntry>> = {
  google: {
    en: ["google", "workspace", "tool", "tools", "meta", "account", "identity", "who am i", "server", "raw api", "escape hatch", "capabilities"],
    he: ["גוגל", "כלי", "כלים", "חשבון", "זהות", "מי אני", "שרת", "ממשק", "ממשק תכנות", "יכולות", "קריאה גולמית"],
  },
  sheets: {
    en: ["sheet", "sheets", "google sheets", "spreadsheet", "spreadsheets", "workbook", "grid", "cell", "cells", "row", "rows", "column", "columns", "tab", "formula", "formulas", "excel", "csv"],
    he: ["גיליון", "גליון", "גיליונות", "גליונות", "גיליון אלקטרוני", "שיטס", "חוברת עבודה", "תא", "תאים", "שורה", "שורות", "עמודה", "עמודות", "לשונית", "לשוניות", "נוסחה", "נוסחאות", "אקסל"],
  },
  drive: {
    en: ["drive", "google drive", "file", "files", "folder", "folders", "my drive", "shared drive", "storage", "quota", "trash"],
    he: ["דרייב", "גוגל דרייב", "קובץ", "קבצים", "תיקייה", "תיקיה", "תיקיות", "אחסון", "מכסה", "הדרייב שלי", "כונן משותף", "אשפה", "סל המיחזור"],
  },
  docs: {
    en: ["doc", "docs", "google docs", "document", "documents", "word", "text document", "write-up"],
    he: ["מסמך", "מסמכים", "דוק", "דוקס", "גוגל דוקס", "וורד", "מסמך טקסט"],
  },
  gmail: {
    en: ["gmail", "mail", "email", "e-mail", "emails", "mailbox", "inbox", "message", "messages", "thread", "threads", "draft", "drafts", "label", "labels", "spam", "attachment", "reply"],
    he: ["ג'ימייל", "גימייל", "מייל", "מיילים", "אימייל", "אימיילים", "דואר", "דואר אלקטרוני", "תיבת דואר", "דואר נכנס", "הודעה", "הודעות", "שרשור", "שרשורים", "טיוטה", "טיוטות", "תווית", "תוויות", "ספאם", "קובץ מצורף", "צרופה"],
  },
  calendar: {
    en: ["calendar", "calendars", "google calendar", "event", "events", "meeting", "meetings", "appointment", "appointments", "schedule", "agenda", "invite", "invitation", "availability", "free busy", "rsvp", "reminder"],
    he: ["יומן", "יומנים", "גוגל קלנדר", "לוח שנה", "אירוע", "אירועים", "פגישה", "פגישות", "תור", "תורים", "לוח זמנים", "סדר יום", "הזמנה", "הזמנות", "זמינות", "פנוי", "תפוס", "תזכורת", "תזכורות"],
  },
  tasks: {
    en: ["task", "tasks", "todo", "task list", "tasklist", "checklist", "due", "action item"],
    he: ["משימה", "משימות", "מטלה", "מטלות", "רשימת משימות", "רשימות משימות", "צ'קליסט", "לעשות", "תאריך יעד", "יעד"],
  },
  contacts: {
    en: ["contact", "contacts", "people", "person", "address book", "phone number", "contact group"],
    he: ["איש קשר", "אנשי קשר", "קשר", "אנשים", "אדם", "ספר טלפונים", "מספר טלפון", "קבוצת אנשי קשר", "כרטיס קשר"],
  },
  chat: {
    en: ["chat", "google chat", "space", "spaces", "room", "rooms", "direct message", "dm", "chat message", "reaction", "emoji"],
    he: ["צ'אט", "צאט", "שיחה", "שיחות", "מרחב", "מרחבים", "חדר", "חדרים", "הודעה פרטית", "מסר", "תגובה", "אימוג'י"],
  },
  slides: {
    en: ["slide", "slides", "google slides", "presentation", "presentations", "deck", "powerpoint", "thumbnail"],
    he: ["שקופית", "שקופיות", "מצגת", "מצגות", "סלייד", "סליידס", "פאוורפוינט", "תמונה ממוזערת"],
  },
  forms: {
    en: ["form", "forms", "google forms", "survey", "surveys", "questionnaire", "question", "questions", "response", "responses", "quiz", "poll"],
    he: ["טופס", "טפסים", "גוגל פורמס", "סקר", "סקרים", "שאלון", "שאלונים", "שאלה", "שאלות", "תשובה", "תשובות", "מענה", "בוחן", "הצבעה"],
  },
  photos: {
    en: ["photo", "photos", "google photos", "picture", "pictures", "image", "images", "album", "albums", "media", "media item", "picker"],
    he: ["תמונה", "תמונות", "גוגל פוטוס", "פוטוס", "אלבום", "אלבומים", "מדיה", "פריט מדיה", "גלריה", "צילום", "צילומים", "בוחר תמונות"],
  },
  // No bare "comments": Docs has comments too, so the word names no single product, and once
  // "comment" became a lexicon word the tokenizer folded "comments" into it — "delete the comment"
  // and "resolve the comment" read as naming YouTube. A YouTube request names YouTube anyway
  // ("video", "channel", "youtube"), and `video_comments` still routes YouTube's own comment tool.
  youtube: {
    en: ["youtube", "yt", "video", "videos", "channel", "channels", "playlist", "playlists", "subscription", "subscriptions", "views"],
    he: ["יוטיוב", "יוטויב", "סרטון", "סרטונים", "וידאו", "ערוץ", "ערוצים", "פלייליסט", "פלייליסטים", "רשימת השמעה", "מנוי", "מנויים", "צפיות", "תגובות"],
  },
  meet: {
    en: ["meet", "google meet", "video call", "conference", "conference record", "meeting space", "recording", "recordings", "transcript", "transcripts", "participants", "smart notes"],
    he: ["מיט", "גוגל מיט", "שיחת וידאו", "ועידה", "שיחת ועידה", "מרחב פגישה", "הקלטה", "הקלטות", "תמלול", "תמלולים", "תמליל", "משתתפים", "סיכום חכם"],
  },
};

// ---------------------------------------------------------------------------
// Verbs — keyed by the PR-4 `VERB_KINDS` vocabulary. `Record<Verb, …>` makes the
// typechecker, not a test, the thing that fails when a verb is added to the grammar.
// ---------------------------------------------------------------------------

/** Verb (as in `<service>_<verb>_<resource>`) → how people ask for that action. */
export const VERB_LEXICON: Readonly<Record<Verb, LexEntry>> = {
  // read
  list: {
    en: ["list", "show", "show me", "enumerate", "browse", "display"],
    he: ["רשימה", "רשימת", "הצג", "הראה", "תראה", "תציג", "להציג", "לרשום", "תן לי רשימה"],
  },
  search: {
    en: ["search", "find", "look for", "query", "filter", "match", "look up", "search for"],
    he: ["חפש", "תחפש", "לחפש", "חיפוש", "מצא", "תמצא", "למצוא", "סנן", "תסנן", "לסנן", "איתור"],
  },
  find: {
    en: ["find", "locate", "look up", "lookup", "identify", "get the"],
    he: ["מצא", "תמצא", "למצוא", "אתר", "לאתר", "זהה", "לזהות", "תביא לי"],
  },
  get: {
    en: ["get", "fetch", "details", "info", "information", "metadata", "about", "status", "look at", "open"],
    he: ["קבל", "תביא", "להביא", "הבא", "תן לי", "פרטים", "מידע", "נתונים", "מטא", "סטטוס", "פתח"],
  },
  read: {
    en: ["read", "open", "content", "contents", "text", "body", "view", "full text", "see"],
    he: ["קרא", "תקרא", "לקרוא", "קריאה", "תוכן", "טקסט", "גוף ההודעה", "לצפות", "מה כתוב", "מה כתוב שם"],
  },
  download: {
    en: ["download", "save", "save to disk", "get the file", "get bytes", "pull down"],
    he: ["הורד", "תוריד", "להוריד", "הורדה", "שמור", "תשמור", "לשמור", "הורדת קובץ"],
  },
  export: {
    en: ["export", "convert", "as pdf", "pdf", "docx", "download as", "save as", "output as"],
    he: ["ייצא", "תייצא", "לייצא", "ייצוא", "המר", "להמיר", "פידיאף", "שמור כ", "בפורמט"],
  },
  audit: {
    en: ["audit", "check", "inspect", "review", "validate", "health", "errors", "problems", "sanity check"],
    he: ["בדוק", "תבדוק", "לבדוק", "בדיקה", "ביקורת", "סקירה", "לסקור", "תקינות", "שגיאות", "בעיות"],
  },
  trace: {
    en: ["trace", "track", "follow", "depends", "dependency", "precedents", "dependents", "what uses"],
    he: ["עקוב", "לעקוב", "מעקב", "התחקה", "להתחקות", "תלות", "תלויות", "מקורות", "מי משתמש", "מאיפה מגיע"],
  },
  // The catalog question itself: "which tool should I use for this", in both languages.
  select: {
    en: ["select", "choose", "pick", "which tool", "what tool", "which tools", "shortlist", "route"],
    he: ["בחר", "לבחור", "תבחר", "איזה כלי", "אילו כלים", "מה מתאים", "ניתוב"],
  },
  batch_get: {
    en: ["batch get", "bulk get", "get many", "several", "multiple", "at once", "in one call", "in one go"],
    he: ["קבל מרובה", "הבא כמה", "תביא כמה", "מספר", "בבת אחת", "בקריאה אחת", "קבוצתי", "מרוכז"],
  },
  batch_read: {
    en: ["batch read", "read many", "multiple ranges", "several ranges", "bulk read", "at once"],
    he: ["קריאה מרובה", "קרא כמה", "תקרא כמה", "כמה טווחים", "מספר טווחים", "בבת אחת", "קריאה קבוצתית"],
  },
  // additive
  create: {
    en: ["create", "new", "make", "start", "set up", "generate", "open a new", "add a new"],
    he: ["צור", "תצור", "ליצור", "יצירה", "חדש", "חדשה", "פתח", "לפתוח", "להקים", "בנה", "תכין"],
  },
  add: {
    en: ["add", "attach", "put", "include", "react", "add to"],
    he: ["הוסף", "תוסיף", "להוסיף", "הוספה", "צרף", "לצרף", "שים", "לשים", "הכנס"],
  },
  append: {
    en: ["append", "add to the end", "add a row", "add rows", "add at the bottom", "add text"],
    he: ["הוסף בסוף", "תוסיף בסוף", "להוסיף בסוף", "הוסף שורה", "תוסיף שורה", "הוסף שורות", "צרף בסוף", "בסוף", "בשורה האחרונה"],
  },
  insert: {
    en: ["insert", "add at", "put at", "place", "insert text", "insert a table", "in the middle"],
    he: ["הכנס", "תכניס", "להכניס", "הכנסה", "שתול", "הוסף במקום", "הוסף בתוך", "שים ב", "במיקום"],
  },
  upload: {
    en: ["upload", "send the file", "attach a file", "import", "push up", "put a file"],
    he: ["העלה", "תעלה", "להעלות", "העלאה", "שלח קובץ", "ייבא", "לייבא"],
  },
  quick_add: {
    en: ["quick add", "natural language", "one line", "just say", "quickly", "in plain english"],
    he: ["הוספה מהירה", "הוסף מהר", "תוסיף מהר", "במשפט", "בשפה חופשית", "שורה אחת", "מהר"],
  },
  // mutating
  copy: {
    en: ["copy", "duplicate", "clone", "make a copy", "copy to"],
    he: ["העתק", "תעתיק", "להעתיק", "העתקה", "שכפל", "לשכפל", "שכפול", "עותק"],
  },
  share: {
    en: ["share", "give access", "permission", "invite", "add a viewer", "add an editor", "let them see"],
    he: ["שתף", "תשתף", "לשתף", "שיתוף", "הרשאה", "הרשאות", "תן גישה", "גישה", "צרף משתמש"],
  },
  // mutating_idempotent
  write: {
    en: ["write", "set", "fill", "enter", "overwrite", "paste", "put values"],
    he: ["כתוב", "תכתוב", "לכתוב", "כתיבה", "הזן", "להזין", "מלא", "למלא", "דרוס", "עדכן ערכים"],
  },
  // One formula or value spread over a range, the fill handle's job. Fill-SPECIFIC words only,
  // because every word of every term here is indexed on sheets_fill_range. The bare verb is not
  // one: "fill in / fill out the sheet" asks for `write` (listed above), and in Hebrew מלא is also
  // "full" (הדוח המלא, the full report), so as a fill word it pinned a cell overwrite to mail and
  // calendar requests. Bare גרור (drag) is a file move. Phrases built on those words ("fill down",
  // "copy the formula down", "מלא נוסחה") are gate cues (MUTATION_CUES in src/routing/gate.ts),
  // which the ranker never indexes. tests/sheets-fill.test.ts pins all three cases.
  fill: {
    en: ["autofill", "drag down", "drag across"],
    he: ["מילוי אוטומטי", "גרור נוסחה", "תגרור נוסחה"],
  },
  update: {
    en: ["update", "change", "edit", "modify", "rename", "adjust", "fix", "set"],
    he: ["עדכן", "תעדכן", "לעדכן", "עדכון", "שנה", "לשנות", "שינוי", "ערוך", "לערוך", "עריכה", "תקן", "שנה שם"],
  },
  modify: {
    en: ["modify", "change", "apply", "add a label", "remove a label", "mark", "toggle", "archive"],
    he: ["שנה", "לשנות", "שינוי", "החל", "הוסף תווית", "הסר תווית", "סמן", "תייג", "לארכיון"],
  },
  replace: {
    en: ["replace", "find and replace", "swap", "substitute", "change all", "rename text"],
    he: ["החלף", "תחליף", "להחליף", "החלפה", "חפש והחלף", "שנה ל", "החלף הכל"],
  },
  move: {
    en: ["move", "relocate", "put in", "transfer", "move to", "reorder"],
    he: ["העבר", "תעביר", "להעביר", "העברה", "הזז", "להזיז", "העבר ל", "שנה מיקום"],
  },
  complete: {
    en: ["complete", "done", "finish", "mark done", "check off", "tick"],
    he: ["סיים", "תסיים", "לסיים", "סיום", "בוצע", "בוצעה", "הושלם", "להשלים", "סמן", "תסמן", "סמן כבוצע", "תסמן כבוצע", "סמן שבוצע", "כבוצעה"],
  },
  uncomplete: {
    en: ["uncomplete", "reopen", "undo done", "mark not done", "unfinish", "not done"],
    he: ["בטל סיום", "תבטל סיום", "לא בוצע", "פתח מחדש", "החזר למשימות", "בטל סימון", "תבטל סימון", "סמן כלא בוצע"],
  },
  rsvp: {
    en: ["rsvp", "respond", "accept", "decline", "tentative", "attending", "reply to the invite"],
    he: ["אשר הגעה", "תאשר הגעה", "אישור הגעה", "השב להזמנה", "תשיב להזמנה", "מאשר", "אשר", "תאשר", "דחה", "תדחה", "לסרב", "אולי", "הגעה"],
  },
  trash: {
    en: ["trash", "bin", "move to trash", "discard", "throw away", "get it out of my inbox"],
    he: ["לאשפה", "העבר לאשפה", "סל מיחזור", "פח", "פח אשפה", "זרוק", "לזרוק", "תזרוק", "מחק לאשפה"],
  },
  untrash: {
    en: ["untrash", "restore", "recover", "undelete", "bring back", "out of the trash"],
    he: ["שחזר", "תשחזר", "לשחזר", "שחזור", "החזר", "תחזיר", "להחזיר", "הוצא מהאשפה", "בטל מחיקה"],
  },
  batch_write: {
    en: ["batch write", "write many", "multiple ranges", "bulk write", "write at once"],
    he: ["כתיבה מרובה", "כתוב כמה", "תכתוב כמה", "כמה טווחים", "מספר טווחים", "בבת אחת", "כתיבה קבוצתית"],
  },
  batch_update: {
    en: ["batch update", "bulk update", "raw request", "advanced", "format", "formatting", "many changes", "chart", "conditional formatting"],
    he: ["עדכון מרובה", "עדכון קבוצתי", "בקשה גולמית", "מתקדם", "עיצוב", "לעצב", "הרבה שינויים", "גרף", "תרשים", "עיצוב מותנה"],
  },
  batch_modify: {
    en: ["batch modify", "bulk label", "many messages", "mark them all", "apply to many"],
    he: ["שינוי מרובה", "תיוג מרובה", "הרבה הודעות", "סמן הכל", "החל על כולם"],
  },
  // destructive
  send: {
    en: ["send", "email them", "mail", "deliver", "post", "fire off", "shoot them"],
    he: ["שלח", "תשלח", "לשלוח", "שליחה", "שגר", "תשגר", "תשלח לו", "תשלח לה"],
  },
  end: {
    en: ["end", "hang up", "stop", "terminate", "close the call", "kick everyone out"],
    he: ["סיים", "תסיים", "לסיים", "נתק", "תנתק", "לנתק", "עצור", "תעצור", "סגור את השיחה", "הפסק", "תפסיק"],
  },
  // destructive_idempotent
  clear: {
    en: ["clear", "empty", "wipe", "blank", "erase", "remove the contents", "reset"],
    he: ["נקה", "תנקה", "לנקות", "ניקוי", "רוקן", "לרוקן", "מחק תוכן", "אפס"],
  },
  delete: {
    en: ["delete", "remove", "erase", "drop", "destroy", "get rid of", "permanently", "cancel", "throw away", "bin", "chuck"],
    he: ["מחק", "תמחק", "למחוק", "מחיקה", "הסר", "תסיר", "להסיר", "הסרה", "לצמיתות", "בטל", "תבטל", "לבטל", "ביטול"],
  },
};

// ---------------------------------------------------------------------------
// Resources — the tail of a tool name (`gmail_read_message` → `message`). Every resource
// `parseToolName` yields over `ALL_TOOLS` has an entry; `tests/lexicon.test.ts` proves it.
// ---------------------------------------------------------------------------

/** Resource (as in `<service>_<verb>_<resource>`) → how people name that thing. */
export const RESOURCE_LEXICON: Readonly<Record<string, LexEntry>> = {
  album: { en: ["album", "photo album"], he: ["אלבום", "אלבומים", "אלבום תמונות"] },
  album_items: { en: ["album items", "photos in an album", "add to an album", "album contents"], he: ["פריטי אלבום", "תמונות באלבום", "הוסף לאלבום", "תוכן האלבום"] },
  albums: { en: ["albums", "all albums", "my albums"], he: ["אלבומים", "כל האלבומים", "האלבומים שלי"] },
  attachment: { en: ["attachment", "attachments", "attached file", "the file on the mail"], he: ["צרופה", "צרופות", "קובץ מצורף", "קבצים מצורפים", "נספח"] },
  calendars: { en: ["calendars", "my calendars", "calendar list", "which calendars"], he: ["יומנים", "היומנים שלי", "רשימת יומנים", "אילו יומנים"] },
  cells: { en: ["cells", "cell", "grid cells", "single cells"], he: ["תאים", "תא", "תאי גיליון"] },
  channel: { en: ["channel", "youtube channel", "creator"], he: ["ערוץ", "ערוץ יוטיוב", "יוצר"] },
  colors: { en: ["colors", "colours", "event colors", "palette"], he: ["צבעים", "צבע", "צבעי אירועים", "פלטת צבעים"] },
  comment: { en: ["comment", "margin comment", "feedback note", "note on the text"], he: ["הערה", "הערת סקירה", "להעיר", "תגובה על הטקסט"] },
  comments: { en: ["comments", "review comments", "comment threads", "open comments"], he: ["הערות", "הערות סקירה", "הערות פתוחות", "שרשור הערות"] },
  completed_tasks: { en: ["completed tasks", "done tasks", "finished tasks", "old tasks"], he: ["משימות שבוצעו", "משימות שהושלמו", "משימות גמורות", "משימות ישנות"] },
  conference: { en: ["conference", "active conference", "live call", "the call itself"], he: ["ועידה", "שיחת ועידה", "שיחה פעילה", "פגישה פעילה"] },
  conference_record: { en: ["conference record", "past meeting", "meeting record"], he: ["רשומת ועידה", "פגישה שהסתיימה", "רישום פגישה"] },
  conference_records: { en: ["conference records", "past meetings", "meeting history"], he: ["רשומות ועידה", "פגישות קודמות", "היסטוריית פגישות"] },
  contact: { en: ["contact", "person", "contact card"], he: ["איש קשר", "אדם", "כרטיס קשר", "מישהו"] },
  contacts: { en: ["contacts", "people", "address book", "everyone i know"], he: ["אנשי קשר", "אנשים", "ספר טלפונים", "כל אנשי הקשר"] },
  dependents: { en: ["dependents", "what depends on it", "downstream", "formulas using it"], he: ["תלויים", "מי תלוי בזה", "נוסחאות שמשתמשות", "המשך השרשרת"] },
  direct_message: { en: ["direct message", "dm", "private chat", "one on one"], he: ["הודעה פרטית", "צ'אט פרטי", "שיחה אישית", "אחד על אחד"] },
  document: { en: ["document", "doc", "google doc", "word document"], he: ["מסמך", "מסמכים", "דוק", "מסמך וורד"] },
  draft: { en: ["draft", "unsent message", "saved email"], he: ["טיוטה", "טיוטות", "הודעה שלא נשלחה"] },
  drafts: { en: ["drafts", "all drafts", "unsent mail"], he: ["טיוטות", "כל הטיוטות", "מיילים שלא נשלחו"] },
  event: { en: ["event", "meeting", "appointment", "invite", "slot"], he: ["אירוע", "פגישה", "תור", "הזמנה", "מפגש"] },
  event_instances: { en: ["event instances", "occurrences", "recurring occurrences", "instances of the series"], he: ["מופעים", "מופעי אירוע", "אירוע חוזר", "חזרות"] },
  events: { en: ["events", "meetings", "schedule", "agenda", "what's on"], he: ["אירועים", "פגישות", "לוח זמנים", "סדר יום", "מה מתוכנן"] },
  file: { en: ["file", "drive file", "document file", "one file"], he: ["קובץ", "קבצים", "קובץ בדרייב"] },
  file_content: { en: ["file content", "the contents", "bytes", "body of the file", "replace the content"], he: ["תוכן הקובץ", "תוכן", "גוף הקובץ", "החלפת תוכן"] },
  files: { en: ["files", "documents", "everything in drive"], he: ["קבצים", "מסמכים", "הכל בדרייב"] },
  folder: { en: ["folder", "directory", "new folder"], he: ["תיקייה", "תיקיה", "תיקיות", "ספרייה"] },
  form: { en: ["form", "google form", "survey", "questionnaire"], he: ["טופס", "טפסים", "סקר", "שאלון"] },
  free_busy: { en: ["free busy", "availability", "when am i free", "busy times", "open slots"], he: ["זמינות", "מתי אני פנוי", "זמנים תפוסים", "חלונות פנויים", "פנוי תפוס"] },
  group_members: { en: ["group members", "members of the group", "people belonging to a group"], he: ["חברי קבוצה", "חברים בקבוצה", "אנשים בקבוצה", "מי בקבוצה"] },
  groups: { en: ["groups", "contact groups", "contact labels"], he: ["קבוצות", "קבוצות אנשי קשר", "תוויות אנשי קשר"] },
  item: { en: ["item", "form item", "question item", "element"], he: ["פריט", "פריטים", "שאלה בטופס", "רכיב"] },
  label: { en: ["label", "gmail label", "tag", "one label"], he: ["תווית", "תוויות", "תג", "תיוג"] },
  labels: { en: ["labels", "all labels", "tags"], he: ["תוויות", "כל התוויות", "תגיות"] },
  media_item: { en: ["media item", "photo", "picture", "image", "video file"], he: ["פריט מדיה", "תמונה", "צילום", "קובץ וידאו"] },
  media_items: { en: ["media items", "photos", "pictures", "images"], he: ["פריטי מדיה", "תמונות", "צילומים"] },
  message: { en: ["message", "email", "mail", "chat message", "one message"], he: ["הודעה", "הודעות", "מייל", "מסר"] },
  message_labels: { en: ["message labels", "labels on a message", "mark as read", "star it", "archive the message"], he: ["תוויות הודעה", "תוויות על הודעה", "סמן כנקרא", "כוכב", "ארכוב הודעה"] },
  messages: { en: ["messages", "emails", "mail", "messages in the conversation"], he: ["הודעות", "מיילים", "דואר", "הודעות בשיחה"] },
  my_channels: { en: ["my channels", "my youtube channel", "my own channel"], he: ["הערוצים שלי", "הערוץ שלי", "ערוץ שלי"] },
  object: { en: ["object", "shape", "text box", "element on a slide", "image on a slide"], he: ["אובייקט", "צורה", "תיבת טקסט", "רכיב בשקופית", "תמונה בשקופית"] },
  // Nouns only: a word of position ("spacing above", "רווח מתחת") or "שורות" ("ריווח שורות") is
  // indexed on its own and matched Sheets row requests ("insert two rows above row 5").
  paragraph_style: { en: ["spacing", "line spacing", "alignment", "justified text"], he: ["ריווח", "יישור", "יישור לשני הצדדים"] },
  participants: { en: ["participants", "attendees", "who joined", "people in the meeting"], he: ["משתתפים", "נוכחים", "מי הצטרף", "אנשים בפגישה"] },
  permission: { en: ["permission", "access", "sharing entry", "one viewer", "one editor"], he: ["הרשאה", "גישה", "רשומת שיתוף", "צופה", "עורך"] },
  permissions: { en: ["permissions", "who has access", "sharing settings", "access list"], he: ["הרשאות", "מי יכול לגשת", "הגדרות שיתוף", "רשימת גישה"] },
  picked_media_items: { en: ["picked media items", "selected photos", "what was picked", "picker results"], he: ["פריטים שנבחרו", "תמונות שנבחרו", "מה שנבחר", "תוצאות הבוחר"] },
  picker_session: { en: ["picker session", "photo picker", "selection session", "let me pick photos"], he: ["מושב בחירה", "בוחר תמונות", "סשן בחירה", "בחירת תמונות"] },
  playlist_items: { en: ["playlist items", "videos in a playlist", "playlist contents"], he: ["פריטי פלייליסט", "סרטונים בפלייליסט", "תוכן הפלייליסט", "סרטונים ברשימה"] },
  playlists: { en: ["playlists", "my playlists", "video lists"], he: ["פלייליסטים", "רשימות השמעה", "הפלייליסטים שלי"] },
  precedents: { en: ["precedents", "what feeds this", "upstream", "inputs of the formula", "source cells"], he: ["מקורות", "תאי מקור", "מה מזין את זה", "קלטים של הנוסחה", "מאיפה זה מגיע"] },
  presentation: { en: ["presentation", "slides", "deck", "slideshow"], he: ["מצגת", "מצגות", "שקופיות", "מצגת שקופיות"] },
  profile: { en: ["profile", "account info", "mailbox profile", "my address"], he: ["פרופיל", "פרטי חשבון", "פרופיל התיבה", "הכתובת שלי"] },
  publish_settings: { en: ["publish settings", "accepting responses", "open the form", "close the form", "publish"], he: ["הגדרות פרסום", "קבלת תשובות", "פתח את הטופס", "סגור את הטופס", "פרסום"] },
  questions: { en: ["questions", "form questions", "fields", "things to ask"], he: ["שאלות", "שאלות בטופס", "שדות", "שאלה"] },
  quota: { en: ["quota", "storage", "space left", "usage", "how full"], he: ["מכסה", "אחסון", "מקום פנוי", "שימוש", "כמה מקום נשאר"] },
  range: { en: ["range", "a1 range", "cells", "selection", "block of cells"], he: ["טווח", "טווח תאים", "תאים", "בחירה", "אזור בגיליון"] },
  ranges: { en: ["ranges", "several ranges", "multiple ranges", "a1 ranges"], he: ["טווחים", "כמה טווחים", "מספר טווחים", "טווחי תאים"] },
  reaction: { en: ["reaction", "emoji", "react", "thumbs up"], he: ["תגובה", "אימוג'י", "הגב", "לייק", "אגודל"] },
  recordings: { en: ["recordings", "meeting recording", "video of the meeting"], he: ["הקלטות", "הקלטת פגישה", "וידאו של הפגישה"] },
  reply: { en: ["reply", "reply to a comment", "answer to a comment", "resolve a comment"], he: ["לענות על הערה", "תשובה על הערה", "סגירת הערה", "פתרון הערה"] },
  response: { en: ["response", "answer", "submission", "one reply"], he: ["תשובה", "מענה", "הגשה", "תגובה לטופס"] },
  responses: { en: ["responses", "answers", "submissions", "results of the form"], he: ["תשובות", "מענים", "הגשות", "תוצאות הטופס"] },
  rows: { en: ["rows", "new rows", "lines", "records"], he: ["שורות", "שורות חדשות", "רשומות", "שורה"] },
  section: { en: ["section", "chapter", "under a heading", "section body"], he: ["סעיף", "פרק", "מתחת לכותרת", "תוכן הסעיף"] },
  shared_drives: { en: ["shared drives", "team drives", "shared drive list"], he: ["כוננים משותפים", "דרייבים משותפים", "כונן משותף", "דרייב של הצוות"] },
  sheet: { en: ["sheet", "tab", "worksheet", "page of a spreadsheet"], he: ["גיליון", "לשונית", "גליון", "דף בגיליון"] },
  slide: { en: ["slide", "one slide", "page of the deck"], he: ["שקופית", "שקופיות", "עמוד במצגת"] },
  smart_notes: { en: ["smart notes", "ai notes", "meeting summary", "gemini notes"], he: ["סיכום חכם", "הערות חכמות", "סיכום פגישה", "סיכומים אוטומטיים"] },
  space: { en: ["space", "room", "chat space", "meeting space"], he: ["מרחב", "חדר", "מרחב צ'אט", "מרחב פגישה"] },
  spaces: { en: ["spaces", "rooms", "chat spaces", "my rooms"], he: ["מרחבים", "חדרים", "מרחבי צ'אט", "החדרים שלי"] },
  spreadsheet: { en: ["spreadsheet", "workbook", "google sheet", "excel file"], he: ["גיליון", "גיליון אלקטרוני", "חוברת עבודה", "קובץ אקסל", "גליון"] },
  spreadsheets: { en: ["spreadsheets", "all my sheets", "workbooks"], he: ["גיליונות", "כל הגיליונות", "גליונות", "חוברות עבודה"] },
  subscriptions: { en: ["subscriptions", "channels i follow", "subscribed channels"], he: ["מנויים", "ערוצים שאני עוקב אחריהם", "הרשמות", "ערוצים במנוי"] },
  table: { en: ["table", "grid in a doc", "rows and columns"], he: ["טבלה", "טבלאות", "טבלה במסמך", "שורות ועמודות"] },
  task: { en: ["task", "todo", "to-do item", "action item"], he: ["משימה", "מטלה", "פריט לביצוע", "משהו לעשות"] },
  tasklist: { en: ["task list", "tasklist", "list of tasks", "a new list"], he: ["רשימת משימות", "רשימה", "רשימת מטלות"] },
  tasklists: { en: ["task lists", "tasklists", "all my lists"], he: ["רשימות משימות", "רשימות", "כל הרשימות"] },
  tasks: { en: ["tasks", "todos", "open items", "what i still have open"], he: ["משימות", "מטלות", "דברים לעשות", "מה יש לי לעשות"] },
  text: { en: ["text", "words", "content", "string", "wording", "body text"], he: ["טקסט", "מילים", "תוכן", "מחרוזת", "ניסוח"] },
  thread: { en: ["thread", "conversation", "email chain", "reply chain"], he: ["שרשור", "שיחה", "שרשור מיילים", "שרשרת תגובות"] },
  thread_labels: { en: ["thread labels", "labels on a conversation", "archive the thread", "mark the thread read"], he: ["תוויות שרשור", "תוויות על שיחה", "ארכוב שרשור", "סמן שרשור כנקרא"] },
  thumbnail: { en: ["thumbnail", "preview image", "slide image", "png of a slide"], he: ["תמונה ממוזערת", "תצוגה מקדימה", "תמונת שקופית", "תמונה של שקופית"] },
  tools: { en: ["tools", "tool list", "catalog", "what can you do", "capabilities"], he: ["כלים", "רשימת כלים", "קטלוג", "מה אתה יודע לעשות", "יכולות"] },
  transcript_entries: { en: ["transcript entries", "what was said", "transcript lines", "captions"], he: ["שורות תמלול", "מה נאמר", "תמלול", "כתוביות"] },
  transcripts: { en: ["transcripts", "meeting transcripts", "transcript list"], he: ["תמלולים", "תמלילים", "תמלולי פגישות", "רשימת תמלולים"] },
  video_comments: { en: ["video comments", "comments on a video", "viewer comments"], he: ["תגובות לסרטון", "תגובות", "תגובות צופים"] },
  video_stats: { en: ["video stats", "views", "likes", "statistics", "performance"], he: ["נתוני סרטון", "צפיות", "לייקים", "סטטיסטיקות", "ביצועים"] },
  videos: { en: ["videos", "youtube videos", "clips", "search videos"], he: ["סרטונים", "סרטוני יוטיוב", "קליפים", "חיפוש סרטונים"] },
};

// ---------------------------------------------------------------------------
// Hard signals — regexes over the RAW query (before tokenizing, before lowercasing).
// ---------------------------------------------------------------------------

/** An unambiguous shape in the raw query, and what it points at. */
export interface HardSignal {
  /** Stable id; equal to the key in `HARD_SIGNALS`. */
  readonly id: string;
  /**
   * The pattern, tested against the RAW query. Never global or sticky (a `/g` regex carries
   * `lastIndex` between calls and would make routing non-deterministic); a test pins that.
   */
  readonly re: RegExp;
  /** The service prefix this signal names, when it names exactly one. */
  readonly service?: string;
  /** Resources it hints at, spelled as in `RESOURCE_LEXICON`. */
  readonly resources?: readonly string[];
  /** What a match means, one line — for the tests and for PR-6b; `NEXT_ACTION` does not read it. */
  readonly note: string;
  /**
   * Whether the matched text is an opaque IDENTIFIER the router should cut out of the query
   * before tokenizing (a URL's path, a resource name, an A1 range). Defaults to true for a
   * signal that names a service. Set it false when the match is made of ordinary words that
   * still mean something — `subject:` and `older_than:` are how a person says "search my mail",
   * and removing them leaves the router with nothing to rank.
   */
  readonly consume?: boolean;
}

/**
 * The shapes that settle a query on their own. Order is stable and meaningful: document URLs
 * first (they name a service AND a resource), then operators and identifiers, then the fuzzy
 * time words, which only ever narrow a candidate rather than pick one.
 *
 * Keys read `url_sheets`, with the service LAST, on purpose: the PR-4 cross-reference lint
 * (`tests/hygiene.test.ts`) scans every `src/tools/*.ts` for `<service>_<word>` tokens and
 * fails on one that is not a registered tool, so a signal id must not wear a service prefix.
 */
export const HARD_SIGNALS: Readonly<Record<string, HardSignal>> = {
  url_sheets: {
    id: "url_sheets",
    re: /(?:https?:\/\/)?docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\S*/i,
    service: "sheets",
    resources: ["spreadsheet"],
    note: "a Google Sheets document URL — the spreadsheet id is in the path",
  },
  url_docs: {
    id: "url_docs",
    re: /(?:https?:\/\/)?docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\S*/i,
    service: "docs",
    resources: ["document"],
    note: "a Google Docs document URL",
  },
  url_slides: {
    id: "url_slides",
    re: /(?:https?:\/\/)?docs\.google\.com\/presentation\/d\/[A-Za-z0-9_-]+\S*/i,
    service: "slides",
    resources: ["presentation"],
    note: "a Google Slides presentation URL",
  },
  url_forms: {
    id: "url_forms",
    re: /(?:https?:\/\/)?(?:docs\.google\.com\/forms\/d\/[A-Za-z0-9_-]+|forms\.gle\/[A-Za-z0-9_-]+)\S*/i,
    service: "forms",
    resources: ["form"],
    note: "a Google Forms URL (editor link or forms.gle short link)",
  },
  url_drive: {
    id: "url_drive",
    re: /(?:https?:\/\/)?drive\.google\.com\/(?:file\/d\/[A-Za-z0-9_-]+|drive\/(?:u\/\d+\/)?folders\/[A-Za-z0-9_-]+|open\?id=[A-Za-z0-9_-]+)\S*/i,
    service: "drive",
    resources: ["file", "folder"],
    note: "a Drive file or folder URL",
  },
  url_gmail: {
    id: "url_gmail",
    re: /(?:https?:\/\/)?mail\.google\.com\/mail\/[^\s]*/i,
    service: "gmail",
    resources: ["message", "thread"],
    note: "a Gmail web URL — the id after #all/ or #inbox/ is the thread or message",
  },
  url_calendar: {
    id: "url_calendar",
    re: /(?:https?:\/\/)?calendar\.google\.com\/calendar\/[^\s]*/i,
    service: "calendar",
    resources: ["event", "events"],
    note: "a Google Calendar web URL",
  },
  url_meet: {
    id: "url_meet",
    re: /(?:https?:\/\/)?meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\S*/i,
    service: "meet",
    resources: ["space", "conference"],
    note: "a Google Meet link — the path is the meeting code",
  },
  code_meet: {
    id: "code_meet",
    re: /(?:^|[\s(])[a-z]{3}-[a-z]{4}-[a-z]{3}(?![\w-])/i,
    service: "meet",
    resources: ["space", "conference"],
    note: "a bare Meet meeting code (xxx-yyyy-zzz), resolved via the space first",
  },
  url_youtube: {
    id: "url_youtube",
    re: /(?:https?:\/\/)?(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/|channel\/|playlist\?list=|@)[A-Za-z0-9_-]+|youtu\.be\/[A-Za-z0-9_-]+)\S*/i,
    service: "youtube",
    resources: ["videos", "channel", "playlists"],
    note: "a YouTube video, channel or playlist URL",
  },
  url_photos: {
    id: "url_photos",
    re: /(?:https?:\/\/)?photos\.google\.com\/[^\s]*/i,
    service: "photos",
    resources: ["media_item", "album"],
    note: "a Google Photos URL",
  },
  operator_gmail: {
    id: "operator_gmail",
    re: /(?:^|\s)-?(?:from|to|cc|bcc|subject|label|has|filename|in|is|after|before|older|newer|older_than|newer_than|larger|smaller|category|list|deliveredto|rfc822msgid):\S+/i,
    service: "gmail",
    resources: ["messages", "thread"],
    note: "a Gmail search operator — pass the query through verbatim",
    // Words, not an identifier: `subject:`/`older_than:` name the search tool by themselves.
    consume: false,
  },
  range_a1: {
    id: "range_a1",
    // The UNQUOTED sheet name must not contain a space: A1 notation requires quotes around a name
    // with spaces, and allowing one here let the class run backwards over the whole sentence —
    // "write these numbers into Sheet1!B2:B10" matched from `write`, and `route()` (which cuts a
    // service-naming signal out of the text before tokenizing) was then left with an empty query.
    re: /(?:'[^'\n]{1,64}'|[A-Za-z0-9֐-׿_.\-]{1,64})!\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\b\$?[A-Za-z]{1,3}\$?\d{1,7}:\$?[A-Za-z]{1,3}\$?\d{1,7}\b/,
    service: "sheets",
    resources: ["range", "cells"],
    note: "an A1 range: sheet-qualified (Sheet1!B2) or a bare span (A1:D20); a lone cell is not a signal",
  },
  space_chat: {
    id: "space_chat",
    re: /\bspaces\/[A-Za-z0-9_-]+(?:\/(?:messages|members)\/[A-Za-z0-9_.@-]+)?/,
    service: "chat",
    resources: ["space", "message"],
    note: "a Chat resource name (spaces/x, spaces/x/messages/y) — passed through as-is, never url-encoded",
  },
  resource_contacts: {
    id: "resource_contacts",
    re: /\b(?:people\/(?:me|[A-Za-z0-9_-]+)|contactGroups\/[A-Za-z0-9_-]+)/,
    service: "contacts",
    resources: ["contact", "groups"],
    note: "a People API resource name (people/c123, people/me, contactGroups/x)",
  },
  address_email: {
    id: "address_email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/,
    resources: ["contact", "message", "permission"],
    note: "an email address — a recipient, a share target or a contact to look up",
  },
  time_en: {
    id: "time_en",
    re: /\b(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|month|quarter|year)|next (?:week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last (?:night|week|month|quarter|year)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}|\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i,
    note: "an English time expression — a calendar or a date-filtered search, never a bare read",
  },
  time_he: {
    id: "time_he",
    re: /(?:היום|הערב|הלילה|מחרתיים|מחר|אתמול|שלשום|עכשיו|השבוע|שבוע הבא|בשבוע הבא|שבוע שעבר|החודש|חודש הבא|בחודש הבא|חודש שעבר|השנה|שנה הבאה|יום ראשון|יום שני|יום שלישי|יום רביעי|יום חמישי|יום שישי|שבת|בבוקר|בצהריים|אחר הצהריים|בערב|בשעה|בתאריך|בעוד)/,
    note: "a Hebrew time expression — same meaning as time_en",
  },
};

// ---------------------------------------------------------------------------
// Pure helpers. No state, no I/O — the engine (PR-6a §C) composes them.
// ---------------------------------------------------------------------------

/** Every hard signal whose pattern matches the raw query, in declaration order. */
export function matchHardSignals(query: string): HardSignal[] {
  return Object.values(HARD_SIGNALS).filter((s) => s.re.test(query));
}

function collect(lang: Lang): ReadonlySet<string> {
  const out = new Set<string>();
  for (const lex of [SERVICE_LEXICON, VERB_LEXICON, RESOURCE_LEXICON] as Readonly<Record<string, LexEntry>>[]) {
    for (const entry of Object.values(lex)) for (const term of entry[lang]) out.add(term);
  }
  return out;
}

/**
 * Every English term in the three lexicons. The tokenizer's singularisation is gated on this
 * set (only a word the lexicon knows is folded), so it lives here and not in the engine.
 */
export const EN_TERMS: ReadonlySet<string> = collect("en");

/**
 * Every Hebrew term. Clitic stripping is gated on this set — `המייל` strips to `מייל` because
 * `מייל` is in here, while `מחר` is left alone because `חר` is not.
 */
export const HE_TERMS: ReadonlySet<string> = collect("he");

// ---------------------------------------------------------------------------
// Function words (§B). Language data, not engine tuning, so it lives here next to the terms it
// constrains: `tests/lexicon.test.ts` and `tests/manifest.test.ts` lint every lexicon term and
// every route-block keyword against this set, and the engine discounts them when it scores.
// ---------------------------------------------------------------------------

/**
 * Grammar, not content. These words carry almost no routing signal on their own, yet a lexicon
 * phrase whose only content is grammar ("what is", `מה יש`) hands a question word a high IDF and
 * lets the opener outvote the question. Two rules follow, and both are enforced by tests:
 *  1. no lexicon term and no route-block keyword may consist ONLY of these words;
 *  2. the engine discounts them as unigrams AND as a bigram of two of them (`ROUTER_PARAMS`).
 * They are never DROPPED: a mixed bigram ("who am", "what can") is how the Meta tools are found.
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "an", "of", "in", "on", "at", "to", "for", "and", "or", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "my", "me", "mine", "our", "your", "their", "his", "her", "with", "from", "by", "as", "if", "so", "there", "then", "than", "please", "just", "some", "any", "more", "very", "too", "also", "do", "does", "did", "can", "could", "would", "should", "will", "have", "has", "had", "what", "which", "who", "how", "when", "where", "why", "all", "every", "everything", "everyone", "everybody", "anything", "anyone", "something", "someone", "thing", "things", "stuff", "many", "much",
  "את", "של", "לי", "אני", "אנחנו", "הוא", "היא", "הם", "זה", "זאת", "אם", "כי", "גם", "רק", "עם", "על", "אל", "אבל", "יש",
  "אתה", "אתם", "מה", "איזה", "כמה", "איך", "מתי", "איפה", "למה", "הזה", "הזאת", "כל",
]);

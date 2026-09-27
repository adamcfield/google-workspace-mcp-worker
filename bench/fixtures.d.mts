/** Types for the pure exports of bench/fixtures.mjs (kept next to the module so tests typecheck). */
export const TAG: "[MCP-BENCH]";
export const LABEL_NAME: "MCP-BENCH";
export const TIME_ZONE: "Asia/Jerusalem";
export const DEFAULT_OUT: string;
export const EXAMPLE_FIXTURES: string;
export const TASKS_FILE: string;
export const FOLDER_NAME: string;
export const SHEET_TITLE: string;
export const BUDGET_TAB: string;
export const DATA_TAB: string;
export const DOC_TITLE: string;
export const DOC_COMMENT: string;
export const OLD_FILE_NAME: string;
export const SPRINT_LIST_TITLE: string;
export const PLANNING_TITLE: string;
export const BLOCKED_TITLE: string;
export const SYNC_TITLE: string;
export const T08_TASK_TITLE: string;
export const INVOICE_SUBJECT: string;
export const APPROVAL_SUBJECT: string;
export const INVOICE_AMOUNT: string;
export const INVOICE_DECISION: string;
export const TEXT_FILE_COUNT: number;
export const RECENT_FILE_NUMBERS: number[];
export const BACKDATE_DAYS: number;
export const DATA_ROW_COUNT: number;
export const DATA_SUM: number;
export const FILLER_MAIL_COUNT: number;
export const LABELLED_MAIL_COUNT: number;
export const SERIES_EVENT_COUNT: number;
export const NO_ATTENDEE_EVENTS: number[];
export const ADDRESSES: {
  attendeeA: string;
  attendeeB: string;
  attendeeC: string;
  vendor: string;
  partner: string;
  updates: string;
  injectionTarget: string;
};
export const SPRINT_TASKS: { title: string; done: boolean }[];

export type FixtureKind = "drive_folder" | "drive_file" | "spreadsheet" | "document" | "drive_comment" | "gmail_label" | "gmail_message" | "gmail_thread" | "calendar_event" | "tasklist";

export interface FixturePlanEntry {
  /** Logical name tasks.json lists under `fixtures`. */
  key: string;
  kind: FixtureKind;
  /** Display name / subject / title in the sandbox account. */
  name: string;
  /** Field of fixtures.local.json that "$fixtures.<idKey>" reads; null when nothing is stored (syncEvents). */
  idKey: string | null;
  /** Restored by `--reset` because a task may change it. */
  mutable: boolean;
  /** Re-touched by `--reset` (modifiedTime) without being a task target. */
  refreshed_on_reset?: boolean;
  count?: number;
  task_ids: string[];
}

export interface EventSpec {
  n?: number;
  key?: string;
  summary: string;
  /** Local wall time "YYYY-MM-DDTHH:MM:SS" in TIME_ZONE. */
  start: string;
  end: string;
  attendees: string[];
}

export interface MailMessageSpec {
  key: string;
  threadKey?: string;
  subject: string;
  from: string;
  to: string;
  /** Local wall time "YYYY-MM-DDTHH:MM:SS" in TIME_ZONE. */
  date: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}

export type { PlaceholderContext } from "../scripts/lib/bench/grade.mjs";

/** Calendar date of `now` in `timeZone` as YYYY-MM-DD. */
export function localDate(now?: Date, timeZone?: string): string;
/** YYYY-MM-DD plus n days. */
export function addDays(iso: string, n: number): string;
/** First Tuesday at least `minDaysAhead` (7) days after today in Asia/Jerusalem. */
export function computeBenchDay(now?: Date, opts?: { timeZone?: string; minDaysAhead?: number }): string;
export function textFileName(n: number): string;
export function textFileNames(): string[];
export function isRecentFile(n: number): boolean;
export function textFileContent(n: number, touchedAt?: string): string;
/** תקציב!A1:C7 (title, header, 4 items, SUM row). */
export function budgetRows(): (string | number)[][];
/** נתונים!A1:C600 (id, name, amount 1..600). */
export function dataRows(): (string | number)[][];
export function docParagraphs(): string[];
export function fixedEvents(benchDay: string): EventSpec[];
export function eventSeries(benchDay: string): EventSpec[];
export function approvalMailBody(): string;
export function mailSpec(today: string, me: string): MailMessageSpec[];
export function utcOffset(localIso: string, timeZone?: string): string;
export function rfc2822Date(localIso: string, timeZone?: string): string;
export function buildRfc822(msg: Omit<MailMessageSpec, "key" | "threadKey">): string;
export function toBase64Url(s: string): string;
export function fixturePlan(): FixturePlanEntry[];
/** Replaces "$fixtures.<idKey>", "$benchDay" and "$benchDay±N" in every string of `value`; throws on unknown keys (shared with grade.mjs). */
export { resolvePlaceholders } from "../scripts/lib/bench/grade.mjs";
export function renderPlan(plan?: FixturePlanEntry[]): string;

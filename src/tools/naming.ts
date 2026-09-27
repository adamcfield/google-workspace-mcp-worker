/**
 * Tool-name grammar (v1.5 PR-4): `<service>_<verb>_<resource>`, the verb vocabulary and what
 * each verb promises about the call (`VERB_KINDS` → the MCP annotation flags a tool must
 * declare), the names exempt from the grammar (kept as they are until 2.0) and the rename
 * table PR-4 fills. `RENAMES` drives the hidden aliases registered next to the canonical
 * tools (see `aliasDefs` in `_shared.ts`); `tests/hygiene.test.ts` pins names, flags and
 * cross-references against this file.
 */

/**
 * What a verb promises:
 * - `read` — no mutation at all.
 * - `additive` — only adds data (MCP `destructiveHint: false`); repeating it adds again.
 * - `mutating` — changes existing data; repeating it is not the same as doing it once.
 * - `mutating_idempotent` — changes existing data to a stated end state; repeating is a no-op.
 * - `destructive` — irreversible and NOT repeatable without new side effects (a second send
 *   sends a second mail).
 * - `destructive_idempotent` — irreversible, but the end state is the same however often it runs.
 */
export type Kind = "read" | "additive" | "mutating" | "mutating_idempotent" | "destructive" | "destructive_idempotent";

/**
 * Verb → kind. This is the vocabulary: a tool name's second segment (or its first two
 * segments for the compound `batch_*` / `quick_add` verbs) must be a key here.
 */
export const VERB_KINDS = {
  // read — no write at all
  list: "read",
  search: "read",
  find: "read",
  get: "read",
  read: "read",
  download: "read",
  export: "read",
  audit: "read",
  trace: "read",
  // Answers a question about this server's own catalog (google_select_tools); reads nothing.
  select: "read",
  batch_get: "read",
  batch_read: "read",
  // additive — only adds
  create: "additive",
  add: "additive",
  append: "additive",
  insert: "additive",
  upload: "additive",
  quick_add: "additive",
  // mutating — changes existing data, repeating differs from doing it once.
  // `copy`/`share` are classified conservatively on purpose: a copy creates a new file and a share
  // only widens access, so neither destroys anything, but both are kept at destructiveHint: true
  // until a deliberate annotation change (a 1.5 follow-up, not PR-4 — Rule #1 lists no such delta).
  copy: "mutating",
  share: "mutating",
  // mutating_idempotent — sets a stated end state
  write: "mutating_idempotent",
  // Writes one stated value over a range, the way the fill handle does: however often it runs,
  // the range ends up holding the same (reference-adjusted) formula.
  fill: "mutating_idempotent",
  update: "mutating_idempotent",
  modify: "mutating_idempotent",
  replace: "mutating_idempotent",
  move: "mutating_idempotent",
  complete: "mutating_idempotent",
  uncomplete: "mutating_idempotent",
  rsvp: "mutating_idempotent",
  trash: "mutating_idempotent",
  untrash: "mutating_idempotent",
  batch_write: "mutating_idempotent",
  batch_update: "mutating_idempotent",
  batch_modify: "mutating_idempotent",
  // destructive — irreversible, a repeat has new side effects
  send: "destructive",
  end: "destructive",
  // destructive_idempotent — irreversible, same end state however often it runs
  clear: "destructive_idempotent",
  delete: "destructive_idempotent",
} as const satisfies Record<string, Kind>;

/** Verbs a tool name may use in its second segment (compound verbs span two segments). */
export const VERBS = Object.keys(VERB_KINDS) as (keyof typeof VERB_KINDS)[];
/** One of `VERBS`. */
export type Verb = (typeof VERBS)[number];

/** Longest tool name allowed (a test pins every registered name to it). */
export const MAX_NAME_LENGTH = 40;

/** Names outside the grammar that stay as they are until 2.0. */
export const NAME_EXEMPTIONS = ["google_whoami", "google_api_request"] as const;

/** The release that drops every alias in `RENAMES`. */
export const ALIAS_REMOVAL_VERSION = "2.0";

/**
 * old name → new name (v1.5 PR-4). Every key stays callable as a hidden alias
 * of its value until `ALIAS_REMOVAL_VERSION`; aliases never appear in `tools/list`.
 */
export const RENAMES: Readonly<Record<string, string>> = {
  // Sheets
  sheets_get_metadata: "sheets_get_spreadsheet",
  sheets_get_cells: "sheets_read_cells",
  sheets_batch_read: "sheets_batch_read_ranges",
  sheets_batch_write: "sheets_batch_write_ranges",
  sheets_batch_update: "sheets_batch_update_spreadsheet",
  sheets_find_replace: "sheets_replace_text",
  sheets_copy_sheet_to: "sheets_copy_sheet",
  sheets_audit: "sheets_audit_spreadsheet",
  // Drive
  drive_get_permissions: "drive_list_permissions",
  drive_remove_permission: "drive_delete_permission",
  drive_get_about: "drive_get_quota",
  drive_list_folder: "drive_search_files",
  // Docs
  docs_get_structure: "docs_get_document",
  docs_batch_update: "docs_batch_update_document",
  docs_export: "docs_export_document",
  // Gmail
  gmail_get_thread: "gmail_read_thread",
  gmail_get_attachment: "gmail_download_attachment",
  gmail_get_draft: "gmail_read_draft",
  gmail_modify_labels: "gmail_modify_message_labels",
  gmail_batch_modify: "gmail_batch_modify_message_labels",
  // Calendar
  calendar_quick_add: "calendar_quick_add_event",
  calendar_respond_to_event: "calendar_rsvp_event",
  calendar_free_busy: "calendar_get_free_busy",
  calendar_list_instances: "calendar_list_event_instances",
  // Tasks
  tasks_clear_completed: "tasks_clear_completed_tasks",
  // Contacts
  contacts_search: "contacts_search_contacts",
  contacts_list: "contacts_list_contacts",
  contacts_get: "contacts_get_contact",
  contacts_create: "contacts_create_contact",
  contacts_update: "contacts_update_contact",
  contacts_delete: "contacts_delete_contact",
  contacts_batch_get: "contacts_batch_get_contacts",
  // Chat
  chat_create_message: "chat_send_message",
  // Slides
  slides_read_text: "slides_read_presentation",
  slides_batch_update: "slides_batch_update_presentation",
  slides_export: "slides_export_presentation",
  // Forms
  forms_get: "forms_get_form",
  forms_create: "forms_create_form",
  forms_update_info: "forms_update_form",
  forms_set_publish_settings: "forms_update_publish_settings",
  forms_batch_update: "forms_batch_update_form",
  // Photos
  photos_add_to_album: "photos_add_album_items",
  photos_download_picked_media: "photos_download_media_item",
  // YouTube
  youtube_search: "youtube_search_videos",
  // Meet
  meet_end_active_conference: "meet_end_conference",
  meet_get_transcript_entries: "meet_list_transcript_entries",
};

/**
 * Argument rewrites for aliases whose target is not a pure rename. Only `drive_list_folder`,
 * which was a thin wrapper over `drive_search_files` with `folder_id` and no free-text query:
 * every one of its parameters (folder_id, mime_type, include_trashed, page_size, page_token,
 * order_by, drive_id) exists on `drive_search_files` with the same meaning, so the alias clears
 * `query` the way the wrapper's handler always did and restores the one default the caller
 * cannot signal any more — `folder_id: "root"` (My Drive root), which the old tool declared and
 * the target leaves optional. Without it a no-argument `drive_list_folder` would silently widen
 * from "list My Drive root" to "search all of Drive". `page_size` (was 50) and `order_by` (was
 * `folder,name`) cannot be restored here: zod fills the target's defaults before this runs, so an
 * omitted value is indistinguishable from an explicit one. Those two differences are documented
 * in CHANGELOG.md and the README migration table instead.
 */
export const ALIAS_ARGS: Readonly<Record<string, (a: Record<string, unknown>) => Record<string, unknown>>> = {
  drive_list_folder: (a) => ({ ...a, query: undefined, folder_id: a.folder_id ?? "root" }),
};

const VERB_SET: ReadonlySet<string> = new Set<string>(VERBS);

/**
 * Splits `${service}_${verb}_${resource}`, matching compound verbs (`batch_read`,
 * `quick_add`, …) before single-segment ones — a two-segment candidate can only ever match a
 * compound verb, since no single-segment verb contains an underscore. Returns null when the name has no
 * service/verb split or the verb is unknown. After PR-4 every non-exempt tool name parses
 * with a non-empty `resource` (`tests/hygiene.test.ts` asserts it); `resource` may still be
 * "" for a name outside `ALL_TOOLS`.
 */
export function parseToolName(name: string): { service: string; verb: Verb; resource: string } | null {
  const parts = name.split("_");
  if (parts.length < 2) return null;
  const [service, ...rest] = parts;
  if (!service) return null;
  for (const size of [2, 1]) {
    if (rest.length < size) continue;
    const verb = rest.slice(0, size).join("_");
    if (VERB_SET.has(verb)) return { service, verb: verb as Verb, resource: rest.slice(size).join("_") };
  }
  return null;
}

/** The kind of a tool name's verb, or null when the name does not parse. */
export function kindOf(name: string): Kind | null {
  const parsed = parseToolName(name);
  return parsed ? VERB_KINDS[parsed.verb] : null;
}

/** Old names whose RENAMES target is `name`. */
export function aliasesFor(name: string): string[] {
  return Object.keys(RENAMES).filter((old) => RENAMES[old] === name);
}

/** The current name for a possibly-old tool name. */
export function canonicalName(name: string): string {
  return RENAMES[name] ?? name;
}

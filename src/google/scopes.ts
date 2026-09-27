/**
 * Google OAuth scopes requested at consent time — the single source of truth
 * for the README's scope table, the consent page, and the /authorize redirect.
 *
 * Every entry is the exact scope URL Google expects. Scope choice notes:
 *  - Photos: `photoslibrary` / `photoslibrary.readonly` / `photoslibrary.sharing`
 *    were REMOVED by Google on 2025-03-31 (requesting them now fails the whole
 *    consent flow with invalid_scope). The Library API only exposes app-created
 *    content since then; picking arbitrary library photos goes through the
 *    Photos Picker API (`photospicker.mediaitems.readonly`).
 *  - Meet: the REST API v2 scopes are `meetings.space.created` (create/manage
 *    spaces you created + read their conference records) and
 *    `meetings.space.readonly` (read spaces/records you have access to).
 *    There is no `meet.conference.media.readonly` scope.
 *  - `openid` + `userinfo.email` identify the signed-in account so the grant is
 *    keyed by email and ALLOWED_EMAILS can be enforced.
 */
export interface ScopeInfo {
  scope: string;
  group: string;
  /** Google's sensitivity class: restricted scopes trigger the strictest verification for public apps. */
  sensitivity: "non-sensitive" | "sensitive" | "restricted";
  why: string;
}

export const SCOPES: ScopeInfo[] = [
  { scope: "openid", group: "Identity", sensitivity: "non-sensitive", why: "Identify the signed-in Google account" },
  { scope: "https://www.googleapis.com/auth/userinfo.email", group: "Identity", sensitivity: "non-sensitive", why: "Read the account email (grant key + allow-list)" },
  { scope: "https://www.googleapis.com/auth/spreadsheets", group: "Sheets", sensitivity: "sensitive", why: "Read/write all spreadsheets" },
  { scope: "https://www.googleapis.com/auth/drive", group: "Drive", sensitivity: "restricted", why: "Full Drive access: search, read, upload, share, folders" },
  { scope: "https://www.googleapis.com/auth/documents", group: "Docs", sensitivity: "sensitive", why: "Read/write all Google Docs" },
  { scope: "https://www.googleapis.com/auth/gmail.modify", group: "Gmail", sensitivity: "restricted", why: "Read, search, draft, send, label (no permanent delete)" },
  { scope: "https://www.googleapis.com/auth/calendar", group: "Calendar", sensitivity: "sensitive", why: "Read/write calendars and events" },
  { scope: "https://www.googleapis.com/auth/tasks", group: "Tasks", sensitivity: "sensitive", why: "Read/write task lists and tasks" },
  { scope: "https://www.googleapis.com/auth/contacts", group: "Contacts (People)", sensitivity: "sensitive", why: "Read/write personal contacts" },
  { scope: "https://www.googleapis.com/auth/chat.spaces.readonly", group: "Chat", sensitivity: "sensitive", why: "List/get Chat spaces" },
  { scope: "https://www.googleapis.com/auth/chat.messages", group: "Chat", sensitivity: "sensitive", why: "Read, send, edit, delete Chat messages as you" },
  { scope: "https://www.googleapis.com/auth/presentations", group: "Slides", sensitivity: "sensitive", why: "Read/write presentations" },
  { scope: "https://www.googleapis.com/auth/forms.body", group: "Forms", sensitivity: "sensitive", why: "Create/edit forms" },
  { scope: "https://www.googleapis.com/auth/forms.responses.readonly", group: "Forms", sensitivity: "sensitive", why: "Read form responses" },
  { scope: "https://www.googleapis.com/auth/photoslibrary.appendonly", group: "Photos", sensitivity: "sensitive", why: "Upload photos/videos and create albums" },
  { scope: "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata", group: "Photos", sensitivity: "sensitive", why: "List/search albums and media this app created" },
  { scope: "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata", group: "Photos", sensitivity: "sensitive", why: "Edit albums/media this app created" },
  { scope: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly", group: "Photos", sensitivity: "sensitive", why: "Read media you pick in a Photos Picker session (any library photo)" },
  { scope: "https://www.googleapis.com/auth/youtube.readonly", group: "YouTube", sensitivity: "sensitive", why: "Read your channels, playlists, videos, stats" },
  { scope: "https://www.googleapis.com/auth/meetings.space.created", group: "Meet", sensitivity: "sensitive", why: "Create Meet spaces; read records of meetings you created" },
  { scope: "https://www.googleapis.com/auth/meetings.space.readonly", group: "Meet", sensitivity: "sensitive", why: "Read Meet spaces, conference records, participants, transcripts" },
];

export const SCOPE_LIST: string[] = SCOPES.map((s) => s.scope);
export const SCOPE_STRING: string = SCOPE_LIST.join(" ");

/** Google Cloud APIs that must be ENABLED in the GCP project for the tools to work. */
export const REQUIRED_APIS: { api: string; service: string; group: string }[] = [
  { api: "Google Sheets API", service: "sheets.googleapis.com", group: "Sheets" },
  { api: "Google Drive API", service: "drive.googleapis.com", group: "Drive" },
  { api: "Google Docs API", service: "docs.googleapis.com", group: "Docs" },
  { api: "Gmail API", service: "gmail.googleapis.com", group: "Gmail" },
  { api: "Google Calendar API", service: "calendar-json.googleapis.com", group: "Calendar" },
  { api: "Google Tasks API", service: "tasks.googleapis.com", group: "Tasks" },
  { api: "People API", service: "people.googleapis.com", group: "Contacts" },
  { api: "Google Chat API", service: "chat.googleapis.com", group: "Chat" },
  { api: "Google Slides API", service: "slides.googleapis.com", group: "Slides" },
  { api: "Google Forms API", service: "forms.googleapis.com", group: "Forms" },
  { api: "Photos Library API", service: "photoslibrary.googleapis.com", group: "Photos" },
  { api: "Google Photos Picker API", service: "photospicker.googleapis.com", group: "Photos" },
  { api: "YouTube Data API v3", service: "youtube.googleapis.com", group: "YouTube" },
  { api: "Google Meet REST API", service: "meet.googleapis.com", group: "Meet" },
];

// ---- least privilege: enable only the product groups an operator wants -------------

/** Canonical group key used by ENABLED_TOOL_GROUPS / DISABLED_TOOL_GROUPS ("Contacts (People)" → "contacts"). */
export const groupKey = (group: string): string => group.toLowerCase().replace(/\s*\(.*\)$/, "").replace(/_$/, "").trim();

/** Every configurable group (Identity/Meta are always on). */
export const ALL_GROUP_KEYS: string[] = [...new Set(SCOPES.map((s) => groupKey(s.group)))].filter((k) => k !== "identity");

export interface GroupConfig {
  /** Comma/space-separated group keys to enable; empty = all (subject to DISABLED). */
  ENABLED_TOOL_GROUPS?: string;
  /** Comma/space-separated group keys to disable. */
  DISABLED_TOOL_GROUPS?: string;
}

const splitList = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((x) => groupKey(x))
    .filter(Boolean);

/** A profile table maps a profile name to group keys or other profile names. */
type ProfileTable = Readonly<Record<string, readonly string[]>>;

/**
 * Named bundles of groups an operator can use in ENABLED_TOOL_GROUPS / DISABLED_TOOL_GROUPS
 * instead of spelling out every product. A profile may reference other profiles (expansion is
 * recursive, order-preserving and cycle-safe).
 *
 * A name is resolved as a GROUP first and only then as a profile, so every pre-1.5 value keeps
 * its exact meaning (`ENABLED_TOOL_GROUPS=sheets` is still the Sheets group, never a bundle).
 * That is why there is no `sheets` profile here — it would be shadowed and only confuse.
 * `admin` / `apps_script` are deliberately absent: naming them still yields the honest
 * "unknown tool groups ignored" warning on /health rather than a silent surprise.
 *
 * `gmail` and `calendar` are listed for completeness only: the group of the same name shadows
 * them, so they resolve as that group and never appear in `/health.profiles`. They exist so an
 * operator who writes `gmail` in a list of profiles gets what they expect.
 */
export const PROFILES = {
  core: ["gmail", "calendar", "drive", "docs", "sheets"],
  gmail: ["gmail"],
  calendar: ["calendar"],
  drive_docs: ["drive", "docs"],
  personal: ["core", "tasks", "contacts"],
  sheets_power_user: ["sheets", "drive"],
  company_admin: ["core", "chat", "meet", "contacts"],
} as const satisfies ProfileTable;

/**
 * Expand a list of group/profile keys into plain group keys.
 *
 * Group wins over profile; unknown names are passed through untouched so the caller can report
 * them (`enabledGroups.unknownGroups`). Order is preserved (first mention wins), duplicates are
 * dropped, and a profile is expanded at most once — which also makes a cyclic profile table safe.
 */
export function expandProfiles(keys: string[], table: ProfileTable = PROFILES): { groups: string[]; profiles: string[] } {
  const known = new Set(ALL_GROUP_KEYS);
  const groups: string[] = [];
  const profiles: string[] = [];
  const seenGroups = new Set<string>();
  const seenProfiles = new Set<string>();
  const visit = (key: string): void => {
    // A group name always wins over a profile of the same name (pre-1.5 configs never change).
    if (known.has(key) || !Object.hasOwn(table, key)) {
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        groups.push(key);
      }
      return;
    }
    if (seenProfiles.has(key)) return; // already expanded → dedupe + cycle guard
    seenProfiles.add(key);
    profiles.push(key);
    for (const child of table[key]!) visit(child);
  };
  for (const key of keys) visit(key);
  return { groups, profiles };
}

/**
 * Resolve which product groups are on for this deployment. Profile names expand to groups first
 * (see `expandProfiles`); unknown names are ignored and reported by `unknownGroups` so /health can
 * surface typos. `profiles` names the bundles that were used. Identity is always on.
 */
export function enabledGroups(env: GroupConfig): { groups: Set<string>; unknownGroups: string[]; profiles: string[] } {
  const known = new Set(ALL_GROUP_KEYS);
  const enabledList = splitList(env.ENABLED_TOOL_GROUPS);
  const enabled = expandProfiles(enabledList);
  const disabled = expandProfiles(splitList(env.DISABLED_TOOL_GROUPS));
  const unknownGroups = [...enabled.groups, ...disabled.groups].filter((g) => !known.has(g));
  // Fail CLOSED on the operator's INPUT, not on the expansion: "ENABLED_TOOL_GROUPS unset" means
  // every group, but a name that expands to nothing (a profile with no members) must never mean
  // "everything" — that would widen the consent screen to all 21 scopes on a typo in the table.
  const base = enabledList.length ? enabled.groups.filter((g) => known.has(g)) : ALL_GROUP_KEYS;
  const disabledSet = new Set(disabled.groups);
  const groups = new Set(base.filter((g) => !disabledSet.has(g)));
  groups.add("identity");
  return { groups, unknownGroups, profiles: [...new Set([...enabled.profiles, ...disabled.profiles])] };
}

/**
 * The scopes to request from Google for the enabled groups (order preserved from SCOPES).
 * Group-driven and never surface-driven: hiding a tool from `tools/list` never changes consent.
 */
export function enabledScopes(env: GroupConfig): string[] {
  const { groups } = enabledGroups(env);
  return SCOPES.filter((s) => groups.has(groupKey(s.group))).map((s) => s.scope);
}

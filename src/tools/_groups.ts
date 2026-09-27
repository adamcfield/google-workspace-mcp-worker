/**
 * The tool catalog: every group, every tool, and the group/scope filter an operator's
 * ENABLED_TOOL_GROUPS / DISABLED_TOOL_GROUPS selects with.
 *
 * This is a LEAF module on purpose: `surface.ts` needs `toolsFor`/`TOOL_GROUPS` and
 * `index.ts` needs `surface.ts`, so keeping the catalog out of `index.ts` is what stops
 * those two from importing each other (a cycle that only ever worked by accident of
 * hoisting). `index.ts` re-exports everything here, so every existing import keeps working.
 */
import { enabledGroups, enabledScopes, groupKey, type GroupConfig } from "../google/scopes.js";
import { jevEnabled, type JevConfig } from "../routing/runtime.js";
import type { ToolDef } from "./_shared.js";
import { metaTools } from "./meta.js";
import { selectionTools } from "./select.js";
import { sheetsTools } from "./sheets.js";
import { sheetsAnalysisTools } from "./sheets-analysis.js";
import { driveTools } from "./drive.js";
import { docsTools } from "./docs.js";
import { gmailTools } from "./gmail.js";
import { calendarTools } from "./calendar.js";
import { tasksTools } from "./tasks.js";
import { contactsTools } from "./people.js";
import { chatTools } from "./chat.js";
import { slidesTools } from "./slides.js";
import { formsTools } from "./forms.js";
import { photosTools } from "./photos.js";
import { youtubeTools } from "./youtube.js";
import { meetTools } from "./meet.js";

/** Group order = order in tools/list (Meta first, then Sheets). */
export const TOOL_GROUPS: { group: string; prefix: string; tools: ToolDef<any>[] }[] = [
  { group: "Meta", prefix: "google_", tools: metaTools },
  { group: "Sheets", prefix: "sheets_", tools: [...sheetsTools, ...sheetsAnalysisTools] },
  { group: "Drive", prefix: "drive_", tools: driveTools },
  { group: "Docs", prefix: "docs_", tools: docsTools },
  { group: "Gmail", prefix: "gmail_", tools: gmailTools },
  { group: "Calendar", prefix: "calendar_", tools: calendarTools },
  { group: "Tasks", prefix: "tasks_", tools: tasksTools },
  { group: "Contacts", prefix: "contacts_", tools: contactsTools },
  { group: "Chat", prefix: "chat_", tools: chatTools },
  { group: "Slides", prefix: "slides_", tools: slidesTools },
  { group: "Forms", prefix: "forms_", tools: formsTools },
  { group: "Photos", prefix: "photos_", tools: photosTools },
  { group: "YouTube", prefix: "youtube_", tools: youtubeTools },
  { group: "Meet", prefix: "meet_", tools: meetTools },
];

export const ALL_TOOLS: ToolDef<any>[] = TOOL_GROUPS.flatMap((g) => g.tools);

/** The Meta group's tools: identity, the catalog and the escape hatch — never group-gated. */
export const META_GROUP = "Meta";

/**
 * Tools that exist only when a flag turns them on. `google_select_tools` is QA plumbing for the
 * model-backed selection path, so with `JEV_ENABLED` unset a deployment registers and advertises
 * exactly what it did before the path existed — no extra tool, no changed listing bytes. It is
 * appended rather than folded into `TOOL_GROUPS` for that reason: the catalog every other
 * consumer reads (README tables, measurements, the surface split) is unchanged.
 */
/**
 * Every tool this server can register, flagged ones included. `ALL_TOOLS` stays the flag-off
 * catalog — the README tables, the measurements and the surface split are all about what a
 * default deployment carries — while the naming and hygiene lints read THIS, so a tool behind a
 * flag still has to obey the grammar and the cross-reference rules.
 */
export const FLAGGED_TOOLS: { tools: ToolDef<any>[]; when: (env: JevConfig) => boolean }[] = [{ tools: selectionTools, when: jevEnabled }];

export const EVERY_TOOL: ToolDef<any>[] = [...ALL_TOOLS, ...FLAGGED_TOOLS.flatMap((f) => f.tools)];

/**
 * The tool surface for a deployment: only groups enabled by ENABLED_TOOL_GROUPS /
 * DISABLED_TOOL_GROUPS, and only tools whose Google scope that configuration requests
 * (e.g. disabling Drive also drops sheets_list_spreadsheets, which needs the drive scope).
 */
export function toolsFor(env: GroupConfig & JevConfig): ToolDef<any>[] {
  const { groups } = enabledGroups(env);
  const scopes = new Set(enabledScopes(env));
  const enabled = TOOL_GROUPS.filter((g) => g.group === META_GROUP || groups.has(groupKey(g.group))).flatMap((g) => g.tools.filter((t) => !t.scope || scopes.has(t.scope)));
  return [...enabled, ...FLAGGED_TOOLS.filter((f) => f.when(env)).flatMap((f) => f.tools)];
}

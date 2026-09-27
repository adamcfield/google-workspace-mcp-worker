/**
 * Meta tools: identity, an escape hatch for any Google API, and a tool map.
 * APIs: https://www.googleapis.com/oauth2/v3/userinfo, tokeninfo (via client), any *.googleapis.com.
 */
import { z } from "zod";
import { GOOGLE_USERINFO_URL } from "../google/client.js";
import { SCOPE_LIST } from "../google/scopes.js";
import { ALL_GROUP_HINTS } from "./_group-hints.js";
import { VERSION } from "../version.js";
import { tool, JsonObject, audit, type AnyRec } from "./_shared.js";

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";
const shortScope = (s: string) => (s.startsWith(SCOPE_PREFIX) ? s.slice(SCOPE_PREFIX.length) : s);

/**
 * The group rows come from `_group-hints.ts`, the leaf that owns them — not from a second copy
 * here, and not from `_manifest.ts`, which must stay off the wire path (`tests/manifest.test.ts`
 * pins that). They were duplicated once on the theory that the copies would be kept in step. They
 * were; the NUMBERS around them were not, and `count` ended up meaning "groups" in a field every
 * reader took for "tools". One list, one meaning.
 */
const GROUPS = ALL_GROUP_HINTS;

/** The group a tool belongs to, by its name prefix — the same split the catalog itself uses. */
const groupOfTool = (name: string): string | undefined => GROUPS.find((g) => name.startsWith(g.prefix))?.group;

const GOOGLE_API_URL = /^https:\/\/([a-z0-9-]+\.)*googleapis\.com\/[^\s]*$/i;

/**
 * Endpoints the hatch refuses outright: their dedicated tools carry safeguards (explicit
 * confirm, trash-instead-of-delete, header sanitising) that a raw call would skip.
 * Exported so `tests/hygiene.test.ts` can check the tool names in `tool` against ALL_TOOLS.
 */
export const GATED_ENDPOINTS: { re: RegExp; methods: string[]; tool: string; why: string }[] = [
  { re: /^https:\/\/gmail\.googleapis\.com\/(upload\/)?gmail\/v1\/users\/[^/]+\/messages\/send\b/i, methods: ["POST"], tool: "gmail_send_message (requires confirm=true)", why: "sending mail bypasses the send confirmation gate" },
  { re: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/drafts\/send\b/i, methods: ["POST"], tool: "gmail_send_draft (requires confirm=true)", why: "sending mail bypasses the send confirmation gate" },
  { re: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/[^/]+$/i, methods: ["DELETE"], tool: "gmail_trash_message", why: "this permanently deletes mail (no trash)" },
  { re: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/batchDelete\b/i, methods: ["POST"], tool: "gmail_trash_message per message", why: "this permanently deletes mail (no trash)" },
  { re: /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/threads\/[^/]+$/i, methods: ["DELETE"], tool: "gmail_trash_message per message", why: "this permanently deletes a thread (no trash)" },
  { re: /^https:\/\/www\.googleapis\.com\/drive\/v[23]\/files\/(?!trash$)[^/]+$/i, methods: ["DELETE"], tool: "drive_delete_file (trash by default, permanent=true to bypass)", why: "this permanently deletes a file, skipping the trash" },
  { re: /^https:\/\/www\.googleapis\.com\/drive\/v[23]\/files\/trash$/i, methods: ["DELETE"], tool: "drive_delete_file per file", why: "emptying the trash is irreversible for everything in it" },
  { re: /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/clear$/i, methods: ["POST"], tool: "calendar_delete_event per event", why: "this wipes every event on the calendar" },
  { re: /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/]+$/i, methods: ["DELETE"], tool: "the Calendar UI", why: "this deletes a secondary calendar with all its events" },
  { re: /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/]+$/i, methods: ["DELETE"], tool: "the Chat UI", why: "deleting a space removes it for every member" },
];

export const metaTools = [
  tool({
    name: "google_whoami",
    description:
      "Identity check for the connected Google account: email, hosted domain (hd, Workspace accounts only), the OAuth scopes actually granted (short names, e.g. 'gmail.modify'), allScopesGranted plus the scopes this server requested but Google did NOT grant (missingScopes — tools in those groups fail with 403 until the connector is re-added), seconds until the current access token expires, and serverVersion (this server's build — quote it in bug reports). name appears only if the account granted the profile scope (not requested by this server); the avatar URL Google returns with openid is not surfaced. Call this first when a tool returns a scope/permission error.",
    scope: "https://www.googleapis.com/auth/userinfo.email",
    input: {},
    handler: async (_a, { g, email, requestedScopes }) => {
      const [info, user] = await Promise.all([
        g.tokenInfo(),
        g.get<AnyRec>(GOOGLE_USERINFO_URL).catch(() => ({}) as AnyRec),
      ]);
      const granted = new Set(info.scopes);
      const missing = (requestedScopes ?? SCOPE_LIST).filter((s) => s !== "openid" && !granted.has(s));
      return {
        email: info.email ?? email ?? user.email,
        name: user.name,
        hd: user.hd,
        grantedScopes: info.scopes.map(shortScope),
        allScopesGranted: missing.length === 0,
        missingScopes: missing.map(shortScope),
        tokenExpiresInSec: info.expiresIn,
        serverVersion: VERSION,
      };
    },
  }),

  tool({
    name: "google_api_request",
    description:
      "Escape hatch: call ANY Google REST endpoint (https://*.googleapis.com/...) with the signed-in user's token. Use it ONLY for endpoints not covered by a dedicated tool — always prefer the dedicated sheets_/drive_/gmail_/... tools, which validate input and return compact results. Pass the full URL (e.g. https://www.googleapis.com/drive/v3/about), query params as an object, and a JSON body for POST/PUT/PATCH. Returns the raw API response (json by default; response_type=text for exports/CSV). Non-googleapis.com URLs are rejected. GET is always allowed; POST/PUT/PATCH/DELETE mutate or delete data and are refused unless confirm=true is passed — only pass it after the user explicitly asked for that mutation (this hatch has none of the dedicated tools' safety checks, e.g. sending mail here bypasses gmail_send_message's gate).",
    write: true,
    destructive: true,
    input: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
      url: z.string().describe("Full https://*.googleapis.com/... URL (path only, no query string — put params in `query`)"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query-string parameters, e.g. {fields:'id,name', pageSize:10}"),
      body: JsonObject.optional().describe("JSON request body (POST/PUT/PATCH)"),
      response_type: z.enum(["json", "text"]).default("json").describe("How to read the response: json (default) or text"),
      confirm: z.boolean().default(false).describe("Required (true) for POST/PUT/PATCH/DELETE. Pass it only after the user explicitly asked for this mutation."),
    },
    handler: async (a, { g }) => {
      const url = a.url.trim();
      if (a.method !== "GET") {
        const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
        const gated = GATED_ENDPOINTS.find((x) => x.methods.includes(a.method) && x.re.test(path));
        if (gated) throw new Error(`${a.method} ${url.split("?")[0]} is not allowed through google_api_request: ${gated.why}. Use ${gated.tool} instead.`);
        if (a.confirm !== true) throw new Error(`${a.method} via google_api_request mutates data and requires confirm=true. Prefer a dedicated tool if one exists; otherwise ask the user, then retry with confirm=true.`);
      }
      if (!GOOGLE_API_URL.test(url)) {
        throw new Error(`url must be an https://*.googleapis.com/... URL (got '${url.slice(0, 120)}'). Only Google API hosts are allowed.`);
      }
      if (a.method === "GET" && a.body) throw new Error("GET requests cannot have a body — use `query` for parameters");
      audit("google_api_request", { method: a.method, url: url.split("?")[0] });
      const r = await g.request<unknown>(a.method, url, { query: a.query, body: a.body, responseType: a.response_type });
      return r === undefined ? { ok: true, status: "no content" } : r;
    },
  }),

  tool({
    name: "google_list_tools",
    // Discovery rule (MCP_INSTRUCTIONS): the client's own tool search finds a tool by name; this
    // tool only answers "what does THIS deployment enable?", so the two never overlap.
    description:
      "What this deployment enables: its tool groups (name, prefix such as 'gmail_', one-line hint, counts), the groups switched off here (disabled), the meta tools, and serverVersion. Use it only to check whether a product is available here or why a tool is missing; to find the tool for a task, search your client's tool list by name instead. Optional group filter (case-insensitive, e.g. 'Gmail'). Every count is named for what it counts: groupCount = groups, toolsCallable = tools you may call (after disabled groups and read-only mode), toolsListed = tools tools/list advertises (lower only when a compact surface hides some; a hidden tool is still callable by name). No Google API call.",
    // The only tool that touches no external system: openWorldHint says so.
    annotations: { openWorldHint: false },
    input: {
      group: z.string().optional().describe("Only this group (e.g. 'Drive'); omit for all groups"),
    },
    handler: async (a, ctx) => {
      // The session's real catalog, not the static table: a deployment with Gmail disabled must
      // not be told it has 23 Gmail tools. Absent only in a bare unit test.
      // Wrong numbers are worse than no numbers, and this whole tool is now about numbers that
      // mean exactly one thing. `registerTools` always sets the catalog before a handler runs.
      if (!ctx.catalog) throw new Error("tool catalog unavailable in this session");
      const callable = ctx.catalog.manifest;
      const listed = new Set(ctx.catalog.listed.map((t) => t.name));
      const countsFor = (group: string) => {
        const mine = callable.filter((t) => groupOfTool(t.name) === group);
        return { toolsCallable: mine.length, toolsListed: mine.filter((t) => listed.has(t.name)).length };
      };
      const all = GROUPS.map((g) => ({ ...g, ...countsFor(g.group) }));
      // A group this deployment does not register is not a group it "has" — reporting it with
      // zero would make groupCount name something the tool list does not contain. It is listed
      // under `disabled` instead, which is the answer to "why is that tool missing?".
      const rows = all.filter((g) => g.toolsCallable > 0);
      const disabled = all.filter((g) => g.toolsCallable === 0).map((g) => g.group);
      const total = (rs: typeof rows) => ({
        groupCount: rs.length,
        toolsCallable: rs.reduce((n, g) => n + g.toolsCallable, 0),
        toolsListed: rs.reduce((n, g) => n + g.toolsListed, 0),
      });
      if (a.group) {
        const q = a.group.trim().toLowerCase().replace(/_$/, "");
        const hit = rows.find((x) => x.group.toLowerCase() === q || x.prefix.replace(/_$/, "") === q);
        if (!hit) throw new Error(`Unknown group '${a.group}'. Known groups: ${rows.map((x) => x.group).join(", ")}`);
        return { serverVersion: VERSION, ...total([hit]), groups: [hit] };
      }
      return {
        serverVersion: VERSION,
        ...total(rows),
        groups: rows,
        // strip() drops an empty list, so the count is what says "nothing is switched off".
        disabledCount: disabled.length,
        disabled,
        meta: callable.filter((t) => groupOfTool(t.name) === "Meta").map((t) => t.name),
      };
    },
  }),
];

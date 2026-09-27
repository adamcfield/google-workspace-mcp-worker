#!/usr/bin/env node
/**
 * Smoke test for a deployed Google Workspace MCP worker — either deployment
 * (the mode is read from /health):
 *
 *   node scripts/smoke.mjs https://google-workspace-mcp-oauth.<sub>.workers.dev   # claude.ai connector
 *   node scripts/smoke.mjs https://google-workspace-mcp.<sub>.workers.dev         # bearer worker
 *
 * Unauthenticated checks (always): landing, /health and the bearer gate on /mcp;
 * OAuth mode additionally checks the discovery documents (authorization-server
 * metadata, protected-resource metadata incl. the /mcp variant, PKCE S256),
 * dynamic client registration and the consent page.
 *
 * Authenticated checks run when an MCP token is available — MCP_TOKEN in the env
 * (the bearer secret, or an OAuth access token) or .mcp-token.local written by
 * `node scripts/login.mjs` (OAuth mode): initialize, tools/list, google_whoami. The
 * tools/list assertions follow the advertised surface reported by /health
 * (`surface`, `toolsListed`, `toolsCallable`) — on a compact surface the listing is the
 * recipe set, while everything in `toolsCallable` stays callable by name.
 *
 * End-to-end checks (--e2e) additionally need E2E_SPREADSHEET_ID (and optionally
 * E2E_CELL, default 'Sheet1!Z1000'): read a range, write one cell and revert it,
 * list the next 3 calendar events, create + delete a Gmail draft.
 * Exits non-zero if any check fails.
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const E2E = args.includes("--e2e");
const ORIGIN = (args.find((a) => a.startsWith("http")) ?? process.env.MCP_URL ?? "").replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
if (!ORIGIN) {
  console.error("Usage: node scripts/smoke.mjs <worker origin> [--e2e]");
  process.exit(2);
}
let TOKEN = process.env.MCP_TOKEN;
if (!TOKEN && fs.existsSync(".mcp-token.local")) {
  try {
    const saved = JSON.parse(fs.readFileSync(".mcp-token.local", "utf8"));
    if (saved.origin === ORIGIN && saved.access_token && (!saved.expires_at || Date.now() < saved.expires_at)) TOKEN = saved.access_token;
    else if (saved.origin === ORIGIN) console.log("note: .mcp-token.local is expired or for another origin — run `node scripts/login.mjs " + ORIGIN + "`");
  } catch {
    /* ignore */
  }
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};
const getJson = async (path, init) => {
  const res = await fetch(ORIGIN + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, body, text };
};

// The compact recipe set, mirroring COMPACT_TOOL_NAMES in src/tools/surface.ts (the meta tools
// of META_ALWAYS are covered by the `google_` shortcut in enabledHere below). Scripts cannot
// import the TypeScript source, so surface.ts stays the authority and tests/surface.test.ts
// parses this literal and fails the suite if the two ever drift apart.
const COMPACT_TOOL_NAMES = [
  "gmail_search_messages", "gmail_read_message", "gmail_read_thread", "gmail_create_draft",
  "drive_search_files", "drive_read_file", "docs_read_document",
  "calendar_list_events", "calendar_get_free_busy", "calendar_create_event",
  "sheets_list_spreadsheets", "sheets_get_spreadsheet", "sheets_read_range", "sheets_write_range", "sheets_batch_update_spreadsheet",
  "tasks_list_tasks",
];
// Extra group keys a tool needs beyond its name prefix (sheets_list_spreadsheets searches Drive).
const EXTRA_GROUPS = { sheets_list_spreadsheets: ["drive"] };
// The write tools among them: MCP_READONLY drops these from the manifest (and so from the listing).
const COMPACT_WRITE = new Set(["gmail_create_draft", "calendar_create_event", "sheets_write_range", "sheets_batch_update_spreadsheet"]);

// ---- public surface ----
const home = await getJson("/");
check("GET / (landing page)", home.status === 200 && /Google Workspace MCP/.test(home.text));
const health = await getJson("/health");
const MODE = health.body?.mode === "bearer" ? "bearer" : "oauth";
check("GET /health", health.status === 200 && health.body?.ok === true, `(mode=${MODE}, tools=${health.body?.tools}, configured=${health.body?.configured}${MODE === "bearer" ? `, connected=${health.body?.connected}` : ""})`);
if (health.body && !health.body.configured) console.log("note: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the worker yet");
const SURFACE = health.body?.surface === "compact" ? "compact" : "full";
const LISTED = health.body?.toolsListed;
const CALLABLE = health.body?.toolsCallable;
console.log(`surface: ${SURFACE} (listed=${LISTED ?? "?"}, callable=${CALLABLE ?? "?"}, groups=${(health.body?.groups ?? []).length}${health.body?.profiles?.length ? `, profiles=${health.body.profiles.join("+")}` : ""})`);
check("  /health reports the tool surface", SURFACE === health.body?.surface && Number.isInteger(LISTED) && Number.isInteger(CALLABLE));
check("  toolsCallable >= toolsListed (a hidden tool is still callable)", CALLABLE >= LISTED, `(${CALLABLE} >= ${LISTED})`);
for (const w of health.body?.warnings ?? []) console.log(`warning from /health: ${w}`);
/** Does this deployment enable this tool? Groups + MCP_READONLY; meta tools (google_*) are always on. */
const enabledHere = (name) => {
  if (health.body?.readOnly === true && COMPACT_WRITE.has(name)) return false;
  const groups = health.body?.groups;
  if (!Array.isArray(groups) || name.startsWith("google_")) return true;
  return [name.slice(0, name.indexOf("_")), ...(EXTRA_GROUPS[name] ?? [])].every((g) => groups.includes(g));
};
check("security headers on /health", !!health.headers?.get?.("content-security-policy") && health.headers.get("x-frame-options") === "DENY", "(CSP + X-Frame-Options)");
if (MODE === "bearer" && health.body && !health.body.connected) console.log(`note: no Google account connected yet — open ${ORIGIN}/google/auth?key=<MCP_AUTH_TOKEN> once`);

const noAuth = await getJson("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) });
check("POST /mcp without bearer → 401", noAuth.status === 401, `(www-authenticate: ${noAuth.headers.get("www-authenticate") ?? "-"})`);

if (MODE === "oauth") {
  check("  401 advertises resource_metadata (RFC 9728, what claude.ai follows)", /resource_metadata=/.test(noAuth.headers.get("www-authenticate") ?? ""));
  const as = await getJson("/.well-known/oauth-authorization-server");
  check(
    "OAuth AS metadata",
    as.status === 200 && as.body?.authorization_endpoint === `${ORIGIN}/authorize` && as.body?.token_endpoint === `${ORIGIN}/token` && as.body?.registration_endpoint === `${ORIGIN}/register`,
  );
  check("  PKCE S256 advertised", Array.isArray(as.body?.code_challenge_methods_supported) && as.body.code_challenge_methods_supported.includes("S256"));
  const pr = await getJson("/.well-known/oauth-protected-resource");
  check("OAuth protected-resource metadata", pr.status === 200 && Array.isArray(pr.body?.authorization_servers) && pr.body.authorization_servers.length > 0);
  const prMcp = await getJson("/.well-known/oauth-protected-resource/mcp");
  check("  …/mcp variant names the /mcp resource", prMcp.status === 200 && prMcp.body?.resource === `${ORIGIN}/mcp`);

  const reg = await getJson("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "gws-mcp-smoke", redirect_uris: ["http://127.0.0.1:8976/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  check("POST /register (dynamic client registration)", reg.status === 201 && !!reg.body?.client_id);
  if (reg.body?.client_id) {
    const consent = await getJson(`/authorize?response_type=code&client_id=${encodeURIComponent(reg.body.client_id)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8976/callback")}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=smoke`);
    check("GET /authorize renders consent page", consent.status === 200 && /Continue with Google/.test(consent.text) && /gws_csrf=/.test(consent.headers.get("set-cookie") ?? ""));

    // What the browser does with the consent click, at HTTP level: submit the rendered form
    // and follow the policy the page carries. `form-action` is enforced against every URL in
    // the submission's redirect chain, so the check is not "does the POST work" but "does the
    // page permit both the POST and the redirect it answers with" — the second hop is the one
    // that blocked the button when the page carried the global `form-action 'self'`.
    const action = /<form[^>]*\saction="([^"]*)"/.exec(consent.text)?.[1] ?? "";
    const reqField = /name="req" value="([^"]+)"/.exec(consent.text)?.[1];
    const csrfField = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1];
    const csrfCookie = /gws_csrf=([^;]+)/.exec(consent.headers.get("set-cookie") ?? "")?.[1];
    check("  consent form submits to this worker's /authorize", !!action && new URL(action, ORIGIN).href === `${ORIGIN}/authorize`, `(action="${action}")`);
    if (reqField && csrfField && csrfCookie) {
      const submitted = await fetch(`${ORIGIN}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `gws_csrf=${csrfCookie}`, "sec-fetch-site": "same-origin", origin: ORIGIN },
        body: new URLSearchParams({ req: reqField, csrf: csrfField }),
      });
      const location = submitted.headers.get("location") ?? "";
      check("  the consent button submits and is redirected to Google's OAuth endpoint", submitted.status === 302 && location.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), `(${submitted.status} → ${location.split("?")[0] || "-"})`);
      const sources = (consent.headers.get("content-security-policy") ?? "")
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("form-action "))
        ?.slice("form-action ".length)
        .split(/\s+/) ?? [];
      const permits = (target) => {
        if (!target) return false;
        const origin = new URL(target, ORIGIN).origin;
        return sources.some((src) => (src === "'self'" ? origin === ORIGIN : src === origin));
      };
      check("  the page's CSP permits both hops of that submission (form-action)", permits(action) && permits(location), `(form-action ${sources.join(" ") || "-"})`);
      check("  …and permits nothing but 'self', this worker and Google", sources.every((src) => src === "'self'" || src === ORIGIN || src === "https://accounts.google.com"));
    }
  }
} else {
  const noKey = await getJson("/google/auth");
  check("GET /google/auth without key → 401", noKey.status === 401);
  const badCb = await getJson("/callback?code=x&state=nope");
  check("GET /callback with unknown state → 400", badCb.status === 400);
  if (TOKEN) {
    const status = await getJson("/google/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    check("GET /google/status (bearer)", status.status === 200 && typeof status.body?.connected === "boolean", status.body?.connected ? `(connected as ${status.body.email}, ${status.body.scopes?.length ?? "?"} scopes)` : "(not connected)");
    if (status.body && status.body.connected === false) {
      const link = await getJson("/google/auth/link", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      check("POST /google/auth/link (bearer) mints a single-use link", link.status === 200 && /\/google\/auth\?key=/.test(link.body?.url ?? ""), link.body?.url ? `→ open ${link.body.url}` : "");
      console.log("\nconnect the Google account first, then re-run for the authenticated checks");
      console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
      process.exit(failures ? 1 : 0);
    }
  }
}

// ---- authenticated ----
if (!TOKEN) {
  console.log(MODE === "oauth" ? "\nno MCP access token — skipping authenticated checks (run `node scripts/login.mjs " + ORIGIN + "` first)" : "\nno MCP_TOKEN — skipping authenticated checks (MCP_TOKEN=<MCP_AUTH_TOKEN> node scripts/smoke.mjs " + ORIGIN + ")");
} else {
  let sessionId = null;
  const parse = (t) => {
    const line = (t || "").split("\n").find((x) => x.startsWith("data:"));
    try {
      return JSON.parse(line ? line.slice(5).trim() : t);
    } catch {
      return null;
    }
  };
  const rpc = async (body) => {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    return { status: res.status, body: parse(await res.text()) };
  };
  const call = async (name, args = {}, id = Math.floor(Math.random() * 1e6)) => {
    const r = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const text = r.body?.result?.content?.[0]?.text ?? "";
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: r.status === 200 && !r.body?.result?.isError && !r.body?.error, data, text, raw: r.body };
  };

  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  check("initialize", init.status === 200 && !!init.body?.result?.serverInfo, `(server=${init.body?.result?.serverInfo?.name} ${init.body?.result?.serverInfo?.version})`);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = list.body?.result?.tools ?? [];
  const names = new Set(tools.map((x) => x.name));
  if (SURFACE === "compact") {
    check("tools/list (compact surface)", tools.length === LISTED, `(${tools.length} advertised, ${CALLABLE} callable)`);
    // Every recipe tool the deployment still enables must be advertised.
    for (const t of COMPACT_TOOL_NAMES.filter(enabledHere)) check(`  compact tool advertised: ${t}`, names.has(t));
  } else {
    // The live listing against the count /health reports as CALLABLE — two independently
    // produced numbers, unlike the two /health fields (which health.ts computes identically).
    check("tools/list", tools.length >= (health.body?.readOnly === true ? 50 : 100) && (CALLABLE === undefined || tools.length === CALLABLE) && (LISTED === undefined || tools.length === LISTED), `(${tools.length} tools, callable=${CALLABLE})`);
  }
  for (const t of ["sheets_read_range", "sheets_write_range", "drive_search_files", "gmail_create_draft", "calendar_list_events", "google_whoami"]) {
    if (!enabledHere(t)) continue; // a read-only or group-restricted deployment drops some of these
    check(`  tool present: ${t}`, names.has(t));
  }

  const who = await call("google_whoami");
  check("google_whoami (Google credentials valid)", who.ok && !!who.data?.email, who.ok ? `(${who.data.email}, ${who.data.grantedScopes?.length ?? "?"} scopes)` : who.text.slice(0, 200));
  if (who.ok && who.data?.missingScopes?.length) console.log("note: scopes not granted:", who.data.missingScopes.join(", "));

  if (E2E) {
    const SID = process.env.E2E_SPREADSHEET_ID;
    const CELL = process.env.E2E_CELL ?? "Sheet1!Z1000";
    if (!SID) {
      check("e2e: E2E_SPREADSHEET_ID set", false);
    } else {
      const meta = await call("sheets_get_spreadsheet", { spreadsheet_id: SID });
      check("e2e: sheets_get_spreadsheet", meta.ok && !!meta.data?.properties?.title, meta.ok ? `(${meta.data.properties.title}, ${meta.data.sheets?.length} tabs)` : meta.text.slice(0, 200));
      const firstTab = meta.data?.sheets?.[0]?.properties?.title ?? "Sheet1";
      const read = await call("sheets_read_range", { spreadsheet_id: SID, range: `'${firstTab}'!A1:E5`, include_formulas: true });
      check("e2e: sheets_read_range A1:E5 (+formulas)", read.ok && Array.isArray(read.data?.values), read.ok ? `(${read.data.rows} rows)` : read.text.slice(0, 200));

      const before = await call("sheets_read_range", { spreadsheet_id: SID, range: CELL });
      const original = before.data?.values?.[0]?.[0] ?? "";
      const stamp = `mcp-smoke ${new Date().toISOString()}`;
      const write = await call("sheets_write_range", { spreadsheet_id: SID, range: CELL, values: [[stamp]] });
      check("e2e: sheets_write_range (write one cell)", write.ok && write.data?.updatedCells === 1, write.ok ? "" : write.text.slice(0, 200));
      const verify = await call("sheets_read_range", { spreadsheet_id: SID, range: CELL });
      check("e2e: read back written cell", verify.data?.values?.[0]?.[0] === stamp);
      const revert = original === "" ? await call("sheets_clear_range", { spreadsheet_id: SID, range: CELL }) : await call("sheets_write_range", { spreadsheet_id: SID, range: CELL, values: [[original]] });
      check("e2e: revert cell", revert.ok, `(restored ${original === "" ? "empty" : JSON.stringify(original)})`);

      const ev = await call("calendar_list_events", { calendar_id: "primary", time_min: new Date().toISOString(), max_results: 3 });
      check("e2e: next 3 calendar events", ev.ok && Array.isArray(ev.data?.items), ev.ok ? `(${ev.data.items.length} events: ${ev.data.items.map((e) => `${e.start} ${e.summary}`).join(" | ").slice(0, 200)})` : ev.text.slice(0, 200));

      const draft = await call("gmail_create_draft", { to: who.data?.email ?? "me@example.com", subject: "MCP smoke test draft", body: `Created by scripts/smoke.mjs at ${new Date().toISOString()} — safe to delete.` });
      check("e2e: gmail_create_draft", draft.ok && !!draft.data?.draftId, draft.ok ? `(draft ${draft.data.draftId})` : draft.text.slice(0, 200));
      if (draft.ok && draft.data?.draftId) {
        const del = await call("gmail_delete_draft", { draft_id: draft.data.draftId });
        check("e2e: gmail_delete_draft", del.ok, del.ok ? "" : del.text.slice(0, 200));
      }
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

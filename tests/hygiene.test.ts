/**
 * Naming hygiene (v1.5 PR-4). One lint per rule, all of them mechanical so a new tool cannot
 * drift:
 *  1. grammar     — every canonical name parses as `<service>_<verb>_<resource>`.
 *  2. flags       — a tool's `write`/`destructive`/`idempotent` match what its verb promises.
 *  3. xref        — no description, parameter description or hint names a tool that does not exist.
 *  4. aliases     — RENAMES is well formed and the old names survive only where they must.
 *  5. wire        — aliases are callable, invisible in tools/list, and carry their target's gates.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALL_TOOLS, EVERY_TOOL, MCP_INSTRUCTIONS, registerTools, toolsFor } from "../src/tools/index.js";
import { connectInMemory } from "./helpers/mcp.js";
import { aliasDefs, annotationsFor, type AnyRec, type ToolCtx, type ToolDef } from "../src/tools/_shared.js";
import { rateLimitError } from "../src/tools/_errors.js";
import { GATED_ENDPOINTS } from "../src/tools/meta.js";
import { ALIAS_ARGS, ALIAS_REMOVAL_VERSION, canonicalName, type Kind, MAX_NAME_LENGTH, NAME_EXEMPTIONS, parseToolName, RENAMES, VERB_KINDS } from "../src/tools/naming.js";

const repo = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

// EVERY_TOOL, not ALL_TOOLS: a flag-gated tool is still a canonical name of this server, so the
// grammar, flag and cross-reference lints below must see it.
const CANONICAL = EVERY_TOOL.map((t) => t.name);
/** What a deployment that sets no flag actually registers — the wire tests below assert on this. */
const DEFAULT_REGISTERED = ALL_TOOLS.map((t) => t.name);
const CANONICAL_SET = new Set(CANONICAL);
const EXEMPT = new Set<string>(NAME_EXEMPTIONS);
const byName = new Map(EVERY_TOOL.map((t) => [t.name, t]));

/** Tails that turn a name into a sentence fragment (`sheets_copy_sheet_to`, `photos_add_to_album`). */
const BAD_TAILS = new Set(["to", "from", "for", "with"]);

describe("1. name grammar", () => {
  it("every canonical name is snake_case, short enough and does not end in a preposition", () => {
    for (const name of CANONICAL) {
      expect(name.length, name).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(name, name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/);
      expect(BAD_TAILS.has(name.split("_").pop()!), `${name} ends in a preposition`).toBe(false);
    }
  });

  it("every non-exempt name parses into a service, a known verb and a non-empty resource", () => {
    const unparsed: string[] = [];
    const noResource: string[] = [];
    for (const name of CANONICAL) {
      if (EXEMPT.has(name)) continue;
      const parsed = parseToolName(name);
      if (!parsed) {
        unparsed.push(name);
        continue;
      }
      if (parsed.resource === "") noResource.push(name);
    }
    expect(unparsed).toEqual([]);
    expect(noResource).toEqual([]);
    // The two grammar exemptions still exist — the exemption list must not outlive them.
    for (const name of NAME_EXEMPTIONS) expect(CANONICAL, `${name} is exempt but no longer registered`).toContain(name);
  });

  it("no name is claimed twice across the canonical tools and the alias table", () => {
    const all = [...CANONICAL, ...Object.keys(RENAMES)];
    const seen = new Set<string>();
    const dupes = all.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes).toEqual([]);
  });
});

describe("2. verb kind vs declared flags", () => {
  /**
   * The two picker-session tools are deliberate exceptions: a Picker session is scratch state on
   * Google's side, not user data, so they are not `write` tools and pin their annotations by hand.
   * Everything else must derive its annotations from the flags below.
   */
  const ANNOTATION_OVERRIDES: Record<string, Record<string, boolean>> = {
    photos_create_picker_session: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    photos_delete_picker_session: { readOnlyHint: false, destructiveHint: false },
  };

  /** Exempt names are checked by hand — they have no parseable verb to derive a kind from. */
  const EXEMPT_FLAGS: Record<string, { write: boolean; destructive?: boolean; idempotent?: boolean; confirm?: boolean }> = {
    google_whoami: { write: false },
    google_api_request: { write: true, destructive: true, confirm: true },
  };

  /** What each kind demands of a definition; the message is what the failure prints. */
  const RULES: Record<Kind, (d: ToolDef<any>) => string | null> = {
    read: (d) => (d.write ? "a read verb must not set write" : null),
    additive: (d) => (!d.write ? "must set write" : d.destructive !== false ? "an additive verb must declare destructive: false" : d.idempotent ? "an additive verb must not be idempotent" : null),
    mutating: (d) => (!d.write ? "must set write" : d.destructive === false ? "a mutating verb is not additive" : d.idempotent ? "a mutating verb must not be idempotent" : null),
    mutating_idempotent: (d) => (!d.write ? "must set write" : d.idempotent !== true ? "must declare idempotent: true" : d.destructive === false ? "a mutating verb is not additive" : null),
    destructive: (d) => (!d.write ? "must set write" : d.destructive !== true ? "must declare destructive: true" : null),
    destructive_idempotent: (d) => (!d.write ? "must set write" : d.destructive !== true ? "must declare destructive: true" : d.idempotent !== true ? "must declare idempotent: true" : null),
  };

  it("every tool's flags match its verb's kind", () => {
    const problems: string[] = [];
    for (const def of ALL_TOOLS) {
      if (EXEMPT.has(def.name) || def.name in ANNOTATION_OVERRIDES) continue;
      const parsed = parseToolName(def.name)!;
      const kind: Kind = VERB_KINDS[parsed.verb];
      const problem = RULES[kind](def);
      if (problem) problems.push(`${def.name} (${parsed.verb} → ${kind}): ${problem}`);
    }
    expect(problems).toEqual([]);
  });

  it("annotationsFor derives every hint from the flags, with openWorldHint true except google_list_tools", () => {
    for (const def of ALL_TOOLS) {
      const a = annotationsFor(def);
      expect(Object.keys(a).slice(0, 4), def.name).toEqual(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
      if (def.name in ANNOTATION_OVERRIDES) continue;
      expect(a.readOnlyHint, def.name).toBe(!def.write);
      expect(a.destructiveHint, def.name).toBe(def.write ? (def.destructive ?? true) : false);
      expect(a.idempotentHint, def.name).toBe(def.write ? (def.idempotent ?? false) : true);
      expect(a.openWorldHint, def.name).toBe(def.name !== "google_list_tools");
    }
    // google_list_tools answers from a constant in meta.ts and the session's catalog — it opens no connection at all.
    expect(byName.get("google_list_tools")!.annotations).toEqual({ openWorldHint: false });
    expect(annotationsFor(byName.get("google_list_tools")!)).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it("the picker-session overrides are exactly the two documented ones", () => {
    const overridden = ALL_TOOLS.filter((t) => t.annotations && Object.keys(t.annotations).some((k) => k !== "openWorldHint"));
    expect(overridden.map((t) => t.name).sort()).toEqual(Object.keys(ANNOTATION_OVERRIDES).sort());
    for (const [name, override] of Object.entries(ANNOTATION_OVERRIDES)) expect(byName.get(name)!.annotations, name).toEqual(override);
    expect(annotationsFor(byName.get("photos_create_picker_session")!)).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(annotationsFor(byName.get("photos_delete_picker_session")!)).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });

  it("the exempt names carry the flags their table states", () => {
    for (const [name, want] of Object.entries(EXEMPT_FLAGS)) {
      const def = byName.get(name)!;
      expect(def, name).toBeDefined();
      expect(!!def.write, name).toBe(want.write);
      if (want.destructive !== undefined) expect(def.destructive, name).toBe(want.destructive);
      if (want.idempotent !== undefined) expect(def.idempotent, name).toBe(want.idempotent);
      expect("confirm" in def.input, `${name} confirm gate`).toBe(!!want.confirm);
    }
  });

  it("every tool that takes a confirm gate is a write tool", () => {
    const gated = ALL_TOOLS.filter((t) => "confirm" in t.input);
    expect(gated.length).toBeGreaterThan(1);
    for (const t of gated) expect(!!t.write, t.name).toBe(true);
    // Sending is always gated: nothing may send on the user's behalf without an explicit confirm.
    for (const t of ALL_TOOLS) if (parseToolName(t.name)?.verb === "send") expect("confirm" in t.input, t.name).toBe(true);
  });
});

describe("3. cross-references name real tools", () => {
  const TOOL_TOKEN = /\b(google|sheets|drive|docs|gmail|calendar|tasks|contacts|chat|slides|forms|photos|youtube|meet)_[a-z][a-z_]*\b/g;
  /**
   * Tokens that look like a tool name but are parameter names of a tool (not tools). Both are
   * spelled out in prose because the caller has to pass them; neither is ever callable.
   */
  const NOT_TOOLS = new Set(["drive_id", "drive_file_id"]);

  /**
   * Tokens the source sweep below may contain although no tool is called that today:
   * parameter names spelled in code, and the four router tools whose input schemas already
   * live in `_router.ts` (the engine and their registration land in PR-6).
   */
  const SOURCE_ALLOW = new Set([...NOT_TOOLS, "calendar_id", "calendar_ids", "google_search_tools", "google_describe_tool", "google_call_tool", "google_call_write_tool"]);

  const scan = (text: string, where: string, out: string[], allow: ReadonlySet<string> = NOT_TOOLS) => {
    for (const [token] of String(text).matchAll(TOOL_TOKEN)) {
      if (CANONICAL_SET.has(token) || allow.has(token)) continue;
      out.push(`${where}: ${token}${RENAMES[token] ? ` (renamed to ${RENAMES[token]})` : ""}`);
    }
  };

  /** Every `description` anywhere in a JSON Schema (parameters, nested objects, array items). */
  const walk = (node: unknown, where: string, out: string[]) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach((n) => walk(n, where, out));
    for (const [k, v] of Object.entries(node as AnyRec)) {
      if (k === "description" && typeof v === "string") scan(v, where, out);
      else walk(v, where, out);
    }
  };

  it("no tool description or parameter description names a tool that does not exist", () => {
    const stale: string[] = [];
    for (const def of ALL_TOOLS) {
      scan(def.description, `${def.name}.description`, stale);
      walk(z.toJSONSchema(z.object(def.input), { target: "draft-7", io: "input" }), `${def.name}.input`, stale);
    }
    expect(stale).toEqual([]);
  });

  it("no server instruction, gated-endpoint hint or rate-limit hint names a tool that does not exist", () => {
    const stale: string[] = [];
    scan(MCP_INSTRUCTIONS, "MCP_INSTRUCTIONS", stale);
    for (const g of GATED_ENDPOINTS) scan(g.tool, `GATED_ENDPOINTS[${g.tool}]`, stale);
    scan(rateLimitError(1, 60_000, 1000).message, "rateLimitError", stale);
    expect(stale).toEqual([]);
  });

  it("no tool source file mentions a retired name (error hints, audit labels, comments)", () => {
    // Superset of the two lints above: it reads the text of every src/tools/*.ts, so it also covers
    // names that never reach a schema — thrown error strings, audit() labels, suggested_tool hints.
    // naming.ts is skipped: it owns RENAMES and is the one place an old name must appear.
    const dir = fileURLToPath(new URL("../src/tools", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "naming.ts");
    expect(files.length).toBeGreaterThan(15);
    const stale: string[] = [];
    for (const file of files) scan(readFileSync(`${dir}/${file}`, "utf8"), `src/tools/${file}`, stale, SOURCE_ALLOW);
    expect(stale).toEqual([]);
    // The allow-list may never hide a retired name.
    for (const token of SOURCE_ALLOW) expect(RENAMES[token], `${token} is allow-listed but renamed`).toBeUndefined();
  });

  it("the rate-limit hint points at the batch tools by their canonical names", () => {
    const text = rateLimitError(1, 60_000, 1000).message;
    for (const name of ["sheets_batch_read_ranges", "gmail_batch_modify_message_labels"]) expect(text).toContain(name);
  });
});

describe("4. rename table", () => {
  const OLD = Object.keys(RENAMES);

  it("has 46 entries: every key is retired, every target exists", () => {
    expect(OLD.length).toBe(46);
    for (const [old, current] of Object.entries(RENAMES)) {
      expect(CANONICAL_SET.has(old), `${old} is still registered as a canonical tool`).toBe(false);
      expect(CANONICAL_SET.has(current), `${old} → ${current}, which does not exist`).toBe(true);
      expect(canonicalName(old)).toBe(current);
      expect(canonicalName(current), `${current} must be a fixed point`).toBe(current);
    }
    // An object literal silently swallows a duplicate key — check the source text instead.
    const literal = repo("src/tools/naming.ts").split("export const RENAMES")[1].split("\n};")[0];
    for (const old of OLD) expect([...literal.matchAll(new RegExp(`^\\s*${old}:`, "gm"))].length, `${old} declared more than once`).toBe(1);
  });

  it("every ALIAS_ARGS key is a rename key whose target accepts the mapped parameters", () => {
    expect(Object.keys(ALIAS_ARGS)).toEqual(["drive_list_folder"]);
    for (const old of Object.keys(ALIAS_ARGS)) expect(RENAMES[old], `${old} has an argsMap but no rename`).toBeDefined();
    const target = byName.get(RENAMES.drive_list_folder)!;
    for (const param of ["folder_id", "mime_type", "include_trashed", "page_size", "page_token", "order_by", "drive_id", "query"]) {
      expect(param in target.input, `${target.name} is missing ${param}`).toBe(true);
    }
    expect(ALIAS_ARGS.drive_list_folder({ folder_id: "F1", query: "x" })).toEqual({ folder_id: "F1", query: undefined });
    // The old tool defaulted folder_id to "root"; the target leaves it optional, so the alias restores it.
    expect(ALIAS_ARGS.drive_list_folder({})).toEqual({ folder_id: "root", query: undefined });
    expect(ALIAS_ARGS.drive_list_folder({ page_size: 50 })).toEqual({ folder_id: "root", page_size: 50, query: undefined });
  });

  /** README keeps exactly one place where the old names may appear: the migration table. */
  const migrationTable = () => repo("README.md").match(/<!-- RENAMES:START -->[\s\S]*?<!-- RENAMES:END -->/)?.[0] ?? null;

  it("no old name survives in the scripts, benchmark or docs that drive real calls", () => {
    const FILES = ["scripts/smoke.mjs", "docs/OPERATIONS.md", "CLAUDE.md", "bench/tasks.json", "bench/fixtures.mjs", "scripts/lib/bench/policy.mjs", "SECURITY.md", "bench/README.md"];
    const stale: string[] = [];
    for (const file of FILES) {
      const text = repo(file);
      for (const old of OLD) if (new RegExp(`\\b${old}\\b`).test(text)) stale.push(`${file}: ${old}`);
    }
    const migration = migrationTable();
    if (migration === null) stale.push("README.md: no <!-- RENAMES:START --> migration table");
    else {
      const outside = repo("README.md").replace(migration, "");
      for (const old of OLD) if (new RegExp(`\\b${old}\\b`).test(outside)) stale.push(`README.md (outside the migration table): ${old}`);
    }
    expect(stale).toEqual([]);
  });

  it("the migration table and the CHANGELOG document every rename", () => {
    const migration = migrationTable();
    const changelog = repo("CHANGELOG.md");
    const missing: string[] = [];
    if (migration === null) missing.push("README.md: no <!-- RENAMES:START --> migration table");
    for (const [old, current] of Object.entries(RENAMES)) {
      if (migration !== null && (!migration.includes(old) || !migration.includes(current))) missing.push(`README migration table: ${old} → ${current}`);
      if (!new RegExp(`\\b${old}\\b`).test(changelog)) missing.push(`CHANGELOG.md: ${old}`);
    }
    expect(missing).toEqual([]);
    expect(migration).toContain(ALIAS_REMOVAL_VERSION); // the table states when the aliases go away
  });

  it("bench/tool-aliases.json mirrors RENAMES exactly", () => {
    expect(JSON.parse(repo("bench/tool-aliases.json")).aliases).toEqual(RENAMES);
  });
});

describe("5. aliases on the wire", () => {
  const baseCtx = (extra: Partial<ToolCtx> = {}): ToolCtx => ({ g: {} as any, readOnly: false, grantedScopes: [], email: "u@x.y", ...extra });

  /** The shared in-memory pair (tests/helpers/mcp.ts), which hands back the mutated ctx too. */
  const connect = (extra: Partial<ToolCtx> = {}, env: Record<string, string> = {}) => connectInMemory({ ctx: baseCtx(extra), env });

  const payload = (res: unknown) => JSON.parse(((res as { content: { text: string }[] }).content)[0].text) as AnyRec;

  it("aliasDefs builds one hidden alias per rename, carrying the target's schema and flags", () => {
    const aliases = aliasDefs(ALL_TOOLS);
    expect(aliases.map((a) => a.name).sort()).toEqual(Object.keys(RENAMES).sort());
    for (const alias of aliases) {
      const target = byName.get(alias.alias!.of)!;
      expect(alias.input, alias.name).toBe(target.input);
      expect(alias.scope, alias.name).toBe(target.scope);
      expect(alias.write, alias.name).toBe(target.write);
      expect(alias.destructive, alias.name).toBe(target.destructive);
      expect(alias.idempotent, alias.name).toBe(target.idempotent);
      expect(annotationsFor(alias), alias.name).toEqual(annotationsFor(target));
      expect(alias.description).toBe(`Deprecated alias of ${target.name}; call ${target.name} instead. Removed in ${ALIAS_REMOVAL_VERSION}.`);
    }
    // A rename whose target is not in the given set produces no alias (disabled group / read-only).
    expect(aliasDefs(ALL_TOOLS.filter((t) => !t.name.startsWith("chat_"))).some((a) => a.name === "chat_create_message")).toBe(false);
  });

  it("tools/list advertises the canonical tools only, and equals catalog.listed", async () => {
    const { client, ctx, close } = await connect();
    const { tools } = await client.listTools();
    await close();
    expect(tools.map((t) => t.name)).toEqual(ctx.catalog!.listed.map((t) => t.name));
    // The default env sets no flag, so the listing is the flag-off catalog exactly.
    expect(tools.map((t) => t.name)).toEqual(DEFAULT_REGISTERED);
    for (const old of Object.keys(RENAMES)) expect(tools.some((t) => t.name === old), `${old} must not be listed`).toBe(false);
    expect(ctx.catalog!.aliases.map((a) => a.name).sort()).toEqual(Object.keys(RENAMES).sort());
  });

  it("an old name is callable and returns the canonical result plus the deprecation marker", async () => {
    const get = vi.fn(async () => ({ id: "t1", historyId: "9", messages: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { client, close } = await connect({ g: { get } as any });
      const viaAlias = payload(await client.callTool({ name: "gmail_get_thread", arguments: { thread_id: "t1", format: "metadata" } }));
      const viaCanonical = payload(await client.callTool({ name: "gmail_read_thread", arguments: { thread_id: "t1", format: "metadata" } }));
      await close();
      expect(viaAlias.deprecated).toEqual({ alias: "gmail_get_thread", use: "gmail_read_thread" });
      const { deprecated: _drop, ...rest } = viaAlias;
      expect(rest).toEqual(viaCanonical);
      // The access log records the name the caller used — that is the evidence for removing it in 2.0.
      const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])) as AnyRec).filter((l) => l.evt === "tool_call");
      expect(lines.map((l) => l.tool)).toEqual(["gmail_get_thread", "gmail_read_thread"]);
      expect(lines.every((l) => !("via" in l))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("drive_list_folder reaches drive_search_files with the folder filter and no free-text query", async () => {
    const get = vi.fn(async () => ({ files: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { client, close } = await connect({ g: { get } as any });
      const res = payload(await client.callTool({ name: "drive_list_folder", arguments: { folder_id: "F123" } }));
      await close();
      expect(get).toHaveBeenCalledTimes(1);
      const q = String((get.mock.calls[0] as unknown as [string, AnyRec])[1].q);
      expect(q).toContain("'F123' in parents");
      expect(q).toBe("'F123' in parents and trashed = false"); // no fullText/name clause from `query`
      expect(res.deprecated).toEqual({ alias: "drive_list_folder", use: "drive_search_files" });
    } finally {
      log.mockRestore();
    }
  });

  it("drive_list_folder without arguments still lists My Drive root, not all of Drive", async () => {
    const get = vi.fn(async () => ({ files: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { client, close } = await connect({ g: { get } as any });
      await client.callTool({ name: "drive_list_folder", arguments: {} });
      await close();
      expect(String((get.mock.calls[0] as unknown as [string, AnyRec])[1].q)).toBe("'root' in parents and trashed = false");
    } finally {
      log.mockRestore();
    }
  });

  it("an alias cannot bypass its target's confirm gate", async () => {
    const { client, close } = await connect();
    // The SDK turns a schema violation into an isError result, so read the text rather than catching.
    const failure = async (name: string) => {
      const res = (await client.callTool({ name, arguments: { space: "spaces/A", text: "hi" } })) as { isError?: boolean; content: { text: string }[] };
      return { isError: res.isError, text: res.content[0].text };
    };
    const alias = await failure("chat_create_message");
    const canonical = await failure("chat_send_message");
    await close();
    expect(canonical.isError).toBe(true);
    expect(alias.isError).toBe(true);
    expect(alias.text.replaceAll("chat_create_message", "chat_send_message")).toBe(canonical.text);
    expect(alias.text).toContain("confirm");
  });

  it("read-only mode drops the write aliases exactly as it drops their targets", async () => {
    const { client, ctx, close } = await connect({ readOnly: true });
    const { tools } = await client.listTools();
    const res = (await client.callTool({ name: "chat_create_message", arguments: { space: "spaces/A", text: "hi", confirm: true } })) as { isError?: boolean; content: { text: string }[] };
    await close();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("chat_create_message");
    expect(res.content[0].text).toContain("not found");
    expect(tools.length).toBe(toolsFor({}).filter((t) => !t.write).length);
    expect(ctx.catalog!.aliases.some((a) => a.write)).toBe(false);
    expect(ctx.catalog!.aliases.length).toBeGreaterThan(0);
    const readAliases = aliasDefs(toolsFor({})).filter((a) => !a.write).map((a) => a.name);
    expect(ctx.catalog!.aliases.map((a) => a.name)).toEqual(readAliases);
  });

  it("registerTools registers the canonical tools first, then the aliases", () => {
    const names: string[] = [];
    const server = { registerTool: (n: string) => void names.push(n) } as unknown as McpServer;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = baseCtx();
    const registered = registerTools(server, ctx, {});
    const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n"); // mockRestore() also clears mock.calls
    warn.mockRestore();
    expect(registered).toEqual(names);
    expect(registered.slice(0, DEFAULT_REGISTERED.length)).toEqual(DEFAULT_REGISTERED);
    expect(registered.slice(DEFAULT_REGISTERED.length).sort()).toEqual(Object.keys(RENAMES).sort());
    // This fake server has no low-level setRequestHandler, so the SDK's own tools/list would answer
    // and advertise every REGISTERED name — aliases included. registerTools must say so.
    expect(warnings).toContain(`${ctx.catalog!.aliases.length} deprecated aliases`);
  });
});

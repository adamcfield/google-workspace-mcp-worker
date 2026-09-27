/**
 * PR-3/PR-4 contracts: the wire artefacts a client sees (tools/list JSON, annotations,
 * tool-error text, the access-log line) are pinned while the plumbing behind them (invoke,
 * catalog, installListing, classifyError, the hidden aliases) moves. Golden strings below were
 * produced by running the code; assert with toBe, never toContain. PR-4 changes exactly two of
 * them on purpose: the rate-limit hint now names the renamed batch tools, and the annotations
 * fixture is keyed by the canonical names (regenerate it, never hand-edit it — see CHANGELOG).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { run, registerAll, annotationsFor, invoke, tool, RateLimiter, type ToolCtx, type ToolDef } from "../src/tools/_shared.js";
import { ERROR_PREFIX, classifyError, rateLimitError, ToolErrorSchema } from "../src/tools/_errors.js";
import { installListing } from "../src/tools/listing.js";
import { ALL_TOOLS, registerTools, toolsFor } from "../src/tools/index.js";
import { RENAMES } from "../src/tools/naming.js";
import { GoogleApiError, GoogleAuthError } from "../src/google/client.js";
import { listToolsInMemory, connectInMemory } from "./helpers/mcp.js";

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
const FIXTURE: Record<string, Hints> = JSON.parse(readFileSync(new URL("./fixtures/annotations.json", import.meta.url), "utf8"));

const baseCtx = (extra: Partial<ToolCtx> = {}): ToolCtx => ({ g: {} as any, readOnly: false, grantedScopes: [], email: "u@x.y", ...extra });

/** A server registered the 1.4.4 way: plain registerAll, the SDK's own tools/list handler. */
async function referenceList(env: Record<string, string> = {}, readOnly = false) {
  const server = new McpServer({ name: "google-workspace", version: "test" });
  registerAll(server, baseCtx({ readOnly }), toolsFor(env));
  return listVia(server);
}

async function listVia(server: McpServer) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

const throwing = (e: unknown, scope?: string) => run("golden_tool", async () => { throw e; }, scope);

// Inputs (a)–(i) of the spec; the expected texts are the literal 1.4.4 outputs.
const CASES = {
  a: { err: new GoogleApiError(403, "GET", "https://x/y?z", "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", '{"error":{"code":403}}'), scope: "https://www.googleapis.com/auth/drive", text: "Google API error 403 (ACCESS_TOKEN_SCOPE_INSUFFICIENT): Request had insufficient authentication scopes.\nHint: this connection lacks the required Google scope (https://www.googleapis.com/auth/drive). Remove and re-add the connector in Claude, and approve every permission on Google's consent screen.\n{\"error\":{\"code\":403}}" },
  b: { err: new GoogleApiError(403, "GET", "https://x/y", "Google Drive API has not been used in project 123 before or it is disabled.", "accessNotConfigured"), text: "Google API error 403 (accessNotConfigured): Google Drive API has not been used in project 123 before or it is disabled.\nHint: this Google API is not enabled in the GCP project of your OAuth client. Enable it in console.cloud.google.com → APIs & Services → Library (see README), wait a minute, retry." },
  c: { err: new GoogleApiError(404, "GET", "https://x/y", "File not found: abc.", "notFound"), text: "Google API error 404 (notFound): File not found: abc.\nHint: check the id/resource name — it may belong to another account or be trashed." },
  d: { err: new GoogleApiError(429, "GET", "https://x/y", "Quota exceeded for quota metric 'Read requests'.", "rateLimitExceeded"), text: "Google API error 429 (rateLimitExceeded): Quota exceeded for quota metric 'Read requests'.\nHint: Google quota exceeded — wait and retry, or narrow the request." },
  e: { err: new GoogleApiError(500, "POST", "https://x/y", "Internal error encountered.", "backendError", '{"error":{"code":500,"status":"INTERNAL"}}'), text: "Google API error 500 (backendError): Internal error encountered.\n{\"error\":{\"code\":500,\"status\":\"INTERNAL\"}}" },
  f: { err: new GoogleApiError(400, "GET", "https://x/y", "Invalid value", "badRequest", "x".repeat(1600)), text: "Google API error 400 (badRequest): Invalid value" },
  g: { err: new GoogleAuthError("dead"), text: "Google authorization error: dead" },
  h: { err: new Error("plain"), text: "Error: plain" },
  i: { err: "a thrown string", text: "Error: a thrown string" },
} as const;

const RATE_TEXT = "Rate limit: this session may make 7 tool calls per 60s. Retry in 5s, or batch the work (sheets_batch_read_ranges/batch_write_ranges, gmail_batch_modify_message_labels, …).";

describe("error contract (A5)", () => {
  it("run() returns the literal 1.4.4 text for every golden input", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [k, c] of Object.entries(CASES)) {
        const res = await throwing(c.err, "scope" in c ? c.scope : undefined);
        expect(res.isError, k).toBe(true);
        expect(res.content[0].text, k).toBe(c.text);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("classifyError: every message starts with its ERROR_PREFIX; codes and retryable per the table", () => {
    const cls = (k: keyof typeof CASES) => classifyError(CASES[k].err, "scope" in CASES[k] ? (CASES[k] as { scope: string }).scope : undefined);
    for (const [k, c] of Object.entries(CASES)) expect(classifyError(c.err, "scope" in c ? c.scope : undefined).message, k).toBe(c.text);
    expect(cls("a")).toMatchObject({ code: "scope_missing", retryable: false, cause: { status: 403, reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }, next_action: "this connection lacks the required Google scope (https://www.googleapis.com/auth/drive). Remove and re-add the connector in Claude, and approve every permission on Google's consent screen." });
    expect(cls("b")).toMatchObject({ code: "api_disabled", retryable: false });
    expect(cls("b").next_action!.startsWith("this Google API is not enabled")).toBe(true);
    expect(cls("c")).toMatchObject({ code: "not_found", retryable: false, cause: { status: 404, reason: "notFound" }, next_action: "check the id/resource name — it may belong to another account or be trashed." });
    expect(cls("d")).toMatchObject({ code: "quota", retryable: true, next_action: "Google quota exceeded — wait and retry, or narrow the request." });
    expect(cls("e")).toMatchObject({ code: "upstream", retryable: true, cause: { status: 500, reason: "backendError" } });
    expect(cls("e").next_action).toBeUndefined();
    expect(cls("f")).toMatchObject({ code: "bad_request", retryable: false });
    expect(cls("g")).toEqual({ code: "auth", message: "Google authorization error: dead", retryable: false });
    expect(cls("h")).toEqual({ code: "internal", message: "Error: plain", retryable: false });
    expect(cls("i")).toEqual({ code: "internal", message: "Error: a thrown string", retryable: false });
    expect(classifyError(new GoogleApiError(403, "GET", "u", "Permission denied", "forbidden"))).toMatchObject({ code: "forbidden", retryable: false, message: "Google API error 403 (forbidden): Permission denied" });
    expect(classifyError(new GoogleApiError(409, "POST", "u", "Already exists", "conflict"))).toMatchObject({ code: "conflict", retryable: false });
    expect(classifyError(new GoogleApiError(503, "GET", "u", "Unavailable"))).toMatchObject({ code: "upstream", retryable: true, message: "Google API error 503: Unavailable" });
    expect(classifyError(new GoogleApiError(418, "GET", "u", "teapot"))).toMatchObject({ code: "upstream", retryable: false });
    for (const [k, c] of Object.entries(CASES)) {
      const m = classifyError(c.err, "scope" in c ? c.scope : undefined).message;
      const prefix = c.err instanceof GoogleAuthError ? ERROR_PREFIX.auth : c.err instanceof GoogleApiError ? ERROR_PREFIX.api : ERROR_PREFIX.generic;
      expect(m.startsWith(prefix), k).toBe(true);
    }
    // A 403 scope error names the tool's scope in next_action (and nowhere else changes) for every distinct scope.
    const scopes = [...new Set(ALL_TOOLS.map((t) => t.scope).filter((s): s is string => !!s))];
    expect(scopes.length).toBeGreaterThan(5);
    for (const scope of scopes) {
      const e = classifyError(new GoogleApiError(403, "GET", "u", "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"), scope);
      expect(e.code, scope).toBe("scope_missing");
      expect(e.next_action, scope).toBe(`this connection lacks the required Google scope (${scope}). Remove and re-add the connector in Claude, and approve every permission on Google's consent screen.`);
      expect(e.message, scope).toBe(`Google API error 403 (ACCESS_TOKEN_SCOPE_INSUFFICIENT): Request had insufficient authentication scopes.\nHint: ${e.next_action}`);
    }
    expect(classifyError(new GoogleApiError(403, "GET", "u", "insufficient scope", "forbidden")).next_action).toBe("this connection lacks the required Google scope. Remove and re-add the connector in Claude, and approve every permission on Google's consent screen.");
  });

  it("rateLimitError reproduces the 1.4.4 limiter text and invoke returns it verbatim", async () => {
    const e = rateLimitError(7, 60_000, 4200);
    expect(e.message).toBe(RATE_TEXT);
    expect(e.message.startsWith(ERROR_PREFIX.rateLimit)).toBe(true);
    expect(e).toEqual({ code: "rate_limited", message: RATE_TEXT, retryable: true }); // the whole shape: no next_action/cause on a limiter refusal
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const def = tool({ name: "t", description: "d", input: {}, handler: async () => 1 });
      const ctx = baseCtx({ limiter: { take: () => 4200, limit: 7, windowMs: 60_000 } as unknown as RateLimiter });
      const res = await invoke(def, {}, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(RATE_TEXT);
    } finally {
      spy.mockRestore();
    }
  });

  it("ToolErrorSchema accepts a full error and rejects example_args carrying confirm", () => {
    const good = { code: "not_found", message: "Google API error 404: x", cause: { status: 404 }, retryable: false, next_action: "check the id", suggested_tool: "drive_search_files", example_args: { query: "name contains 'x'" } };
    expect(ToolErrorSchema.parse(good)).toEqual(good);
    expect(ToolErrorSchema.safeParse({ ...good, example_args: { confirm: true } }).success).toBe(false);
    expect(ToolErrorSchema.safeParse({ ...good, code: "nope" }).success).toBe(false);
    expect(ToolErrorSchema.safeParse({ code: "auth", message: "m" }).success).toBe(false); // retryable is required
  });
});

describe("annotations (A2)", () => {
  it("annotationsFor(t) equals the fixture for every tool, and the fixture has no extra names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(Object.keys(FIXTURE).sort()).toEqual([...names].sort());
    for (const t of ALL_TOOLS) expect(annotationsFor(t), t.name).toEqual(FIXTURE[t.name]);
    // The fixture is the canonical surface: a deprecated alias has no entry of its own.
    for (const old of Object.keys(RENAMES)) expect(old in FIXTURE, `${old} is an alias, not a tool`).toBe(false);
  });
  it("the wire tools/list annotations equal the fixture", async () => {
    const tools = await listToolsInMemory({});
    expect(tools.length).toBe(ALL_TOOLS.length);
    for (const t of tools) expect(t.annotations, t.name).toEqual(FIXTURE[t.name]);
  });
  it("semantic spot checks: the fixture pins meaning, not just the generator's output", () => {
    // Hand-written expectations (never regenerated): a regression in a tool's flags or in
    // annotationsFor cannot be "fixed" by regenerating the fixture unnoticed.
    const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    const DESTRUCTIVE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
    expect(FIXTURE.calendar_get_event).toEqual(RO);
    expect(FIXTURE.gmail_search_messages).toEqual(RO);
    expect(FIXTURE.google_whoami).toEqual(RO);
    expect(FIXTURE.google_list_tools).toEqual({ ...RO, openWorldHint: false }); // answers from a constant + the session catalog, no network
    expect(FIXTURE.drive_create_folder).toEqual(ADDITIVE); // write, destructive: false
    expect(FIXTURE.sheets_append_rows).toEqual(ADDITIVE);
    expect(FIXTURE.gmail_send_message).toEqual(DESTRUCTIVE); // destructive: true, a resend is a second mail
    expect(FIXTURE.chat_send_message).toEqual(DESTRUCTIVE); // PR-4: was additive by name, but it posts to other people
    expect(FIXTURE.meet_end_conference).toEqual(DESTRUCTIVE);
    expect(FIXTURE.drive_delete_file).toEqual(DESTRUCTIVE_IDEMPOTENT); // deleting twice ends in the same state
    expect(FIXTURE.sheets_write_range).toEqual(DESTRUCTIVE_IDEMPOTENT); // a plain write overwrites, but repeating it is a no-op
    expect(FIXTURE.sheets_fill_range).toEqual(DESTRUCTIVE_IDEMPOTENT); // overwrites the range; refilling the same value is a no-op
    expect(FIXTURE.tasks_complete_task).toEqual(DESTRUCTIVE_IDEMPOTENT);
    // The two photos.ts overrides: picker sessions are scratch state, not library writes.
    expect(FIXTURE.photos_create_picker_session).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(FIXTURE.photos_delete_picker_session).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    // The Docs editing/comment tools: comments only ever add, a section replace or a style change
    // overwrites what was there (repeating it is a no-op), and listing comments is a plain read.
    const MUTATING_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
    expect(FIXTURE.docs_list_comments).toEqual(RO);
    expect(FIXTURE.docs_create_comment).toEqual(ADDITIVE);
    expect(FIXTURE.docs_create_reply).toEqual(ADDITIVE);
    expect(FIXTURE.docs_replace_section).toEqual(MUTATING_IDEMPOTENT);
    expect(FIXTURE.docs_update_paragraph_style).toEqual(MUTATING_IDEMPOTENT);
    // Profile of the surface: 168 tools — 79 read-only, 58 destructive, 31 additive writes. PR-4
    // had 162/78/55/29 (126 idempotent). sheets_fill_range (destructive + idempotent, like
    // sheets_write_range) is +1; the five Docs tools are +1 read (docs_list_comments), +2 additive
    // (docs_create_comment, docs_create_reply) and +2 destructive-idempotent (docs_replace_section,
    // docs_update_paragraph_style).
    const all = Object.values(FIXTURE);
    expect(all.length).toBe(168);
    expect(all.filter((a) => a.readOnlyHint).length).toBe(79);
    expect(all.filter((a) => a.destructiveHint).length).toBe(58);
    expect(all.filter((a) => !a.readOnlyHint && !a.destructiveHint).length).toBe(31);
    expect(all.filter((a) => a.idempotentHint).length).toBe(130);
    expect(Object.entries(FIXTURE).filter(([, a]) => !a.openWorldHint).map(([n]) => n)).toEqual(["google_list_tools"]);
    expect(all.every((a) => !a.readOnlyHint || (!a.destructiveHint && a.idempotentHint))).toBe(true); // read-only ⇒ non-destructive, idempotent
  });
  it("the committed fixture is sorted, 2-space indented, newline-terminated", () => {
    const raw = readFileSync(new URL("./fixtures/annotations.json", import.meta.url), "utf8");
    expect(raw).toBe(JSON.stringify(FIXTURE, null, 2) + "\n");
    expect(Object.keys(FIXTURE)).toEqual([...Object.keys(FIXTURE)].sort());
  });
});

describe("tools/list byte-equality (A4/A7)", () => {
  it("installListing reproduces the SDK listing byte-for-byte: full surface, one group, read-only", async () => {
    const full = await listToolsInMemory({});
    expect(JSON.stringify(full)).toBe(JSON.stringify(await referenceList({})));
    expect(full.length).toBe(toolsFor({}).length);
    for (const t of full) expect(Object.keys(t)).toEqual(["name", "description", "inputSchema", "annotations", "execution"]);

    const gmail = await listToolsInMemory({ ENABLED_TOOL_GROUPS: "gmail" });
    expect(JSON.stringify(gmail)).toBe(JSON.stringify(await referenceList({ ENABLED_TOOL_GROUPS: "gmail" })));
    expect(gmail.length).toBe(toolsFor({ ENABLED_TOOL_GROUPS: "gmail" }).length);
    expect(gmail.length).toBeLessThan(full.length);

    const { client, server } = await connectInMemory({ ctx: { readOnly: true } });
    const ro = (await client.listTools()).tools;
    await client.close();
    await server.close();
    expect(JSON.stringify(ro)).toBe(JSON.stringify(await referenceList({}, true)));
    expect(ro.length).toBe(toolsFor({}).filter((t) => !t.write).length);
  });

  it("stripSchemaKey removes every $schema and nothing else", async () => {
    const reference = await referenceList({});
    expect(reference.every((t) => "$schema" in t.inputSchema)).toBe(true);
    const server = new McpServer({ name: "google-workspace", version: "test" });
    const ctx = baseCtx();
    const manifest = toolsFor({});
    registerAll(server, ctx, manifest);
    installListing(server, { manifest, listed: manifest, aliases: [] }, { stripSchemaKey: true });
    const stripped = await listVia(server);
    expect(stripped.every((t) => !("$schema" in t.inputSchema))).toBe(true);
    const expected = reference.map((t) => {
      const { $schema: _drop, ...inputSchema } = t.inputSchema as Record<string, unknown>;
      return { ...t, inputSchema };
    });
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(expected));
  });

  it("installListing is a no-op on a server without the low-level setRequestHandler", () => {
    const fake = { registerTool: () => {} } as unknown as McpServer;
    expect(() => installListing(fake, { manifest: [], listed: [], aliases: [] })).not.toThrow();
  });
});

describe("invoke (A3)", () => {
  const ping = tool({ name: "t_ping", description: "ping", input: { n: z.number().default(1) }, handler: async (a) => ({ n: a.n }) });
  const boom = tool({ name: "t_boom", description: "boom", input: {}, handler: async () => { throw new Error("nope"); } });

  function capture() {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    return { lines: () => logs.map((l) => JSON.parse(l) as Record<string, unknown>), restore: () => { log.mockRestore(); err.mockRestore(); } };
  }

  it("charges the limiter once per call: the second call on a RateLimiter(1) is refused with the exact text", async () => {
    const cap = capture();
    try {
      const ctx = baseCtx({ limiter: new RateLimiter(1, 60_000, () => 1_000) });
      const first = await invoke(ping, { n: 2 }, ctx);
      expect(first.isError).toBeUndefined();
      const second = await invoke(ping, { n: 3 }, ctx);
      expect(second.isError).toBe(true);
      expect(second.content[0].text).toBe("Rate limit: this session may make 1 tool calls per 60s. Retry in 60s, or batch the work (sheets_batch_read_ranges/batch_write_ranges, gmail_batch_modify_message_labels, …).");
      const lines = cap.lines();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({ evt: "tool_call", tool: "t_ping", user: "u@x.y", ms: 0, ok: false, error: "rate_limited" });
      expect(Object.keys(lines[1]).slice(0, 6)).toEqual(["evt", "tool", "user", "ms", "ok", "error"]);
    } finally {
      cap.restore();
    }
  });

  it("a proxied call (via) charges exactly once and logs via/outChars/client", async () => {
    const cap = capture();
    try {
      const take = vi.fn(() => 0);
      const ctx = baseCtx({ limiter: { take, limit: 5, windowMs: 60_000 } as unknown as RateLimiter, client: () => "some-client" });
      const res = await invoke(ping, { n: 4 }, ctx, { via: "google_call_tool" });
      expect(take).toHaveBeenCalledTimes(1);
      const [line] = cap.lines();
      expect(line).toMatchObject({ evt: "tool_call", tool: "t_ping", user: "u@x.y", ok: true, via: "google_call_tool", client: "some-client" });
      expect(typeof line.ms).toBe("number");
      expect(line.outChars).toBe(res.content[0].text.length);
      expect(Object.keys(line)).toEqual(["evt", "tool", "user", "ms", "ok", "via", "outChars", "client"]);
    } finally {
      cap.restore();
    }
  });

  it("a direct call logs no via/client keys; the first six keys of an error line are evt, tool, user, ms, ok, error", async () => {
    const cap = capture();
    try {
      const ctx = baseCtx();
      expect((await invoke(ping, undefined, ctx)).content[0].text).toBe("{}"); // defaults are the SDK's job; undefined args → {}
      const okRes = await invoke(ping, { n: 1 }, ctx);
      expect(JSON.parse(okRes.content[0].text)).toEqual({ n: 1 });
      const errRes = await invoke(boom, {}, ctx);
      expect(errRes.isError).toBe(true);
      expect(errRes.content[0].text).toBe("Error: nope");
      const [, okLine, errLine] = cap.lines();
      expect("via" in okLine).toBe(false);
      expect("client" in okLine).toBe(false);
      expect(okLine.outChars).toBe(okRes.content[0].text.length);
      expect(Object.keys(okLine)).toEqual(["evt", "tool", "user", "ms", "ok", "outChars"]);
      expect(Object.keys(errLine).slice(0, 6)).toEqual(["evt", "tool", "user", "ms", "ok", "error"]);
      expect(errLine).toMatchObject({ ok: false, error: "Error: nope", outChars: "Error: nope".length });
      expect("via" in errLine).toBe(false);
      expect("client" in errLine).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it("a throwing ctx.client resolver neither breaks the call nor skips the limiter or the log line", async () => {
    const cap = capture();
    try {
      const take = vi.fn(() => 0);
      const ctx = baseCtx({ limiter: { take, limit: 5, windowMs: 60_000 } as unknown as RateLimiter, client: () => { throw new Error("client boom"); } });
      const res = await invoke(ping, { n: 5 }, ctx);
      expect(res.isError).toBeUndefined();
      expect(take).toHaveBeenCalledTimes(1);
      const [line] = cap.lines();
      expect(line).toMatchObject({ evt: "tool_call", tool: "t_ping", ok: true });
      expect("client" in line).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it("registerAll's callback is invoke: a registered tool goes through the same limiter/log path", async () => {
    const cap = capture();
    try {
      const handlers = new Map<string, (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>>();
      const server = { registerTool: (n: string, _c: unknown, h: (a: unknown) => Promise<never>) => handlers.set(n, h) } as unknown as McpServer;
      const take = vi.fn(() => 0);
      registerAll(server, baseCtx({ limiter: { take, limit: 5, windowMs: 60_000 } as unknown as RateLimiter }), [ping]);
      await handlers.get("t_ping")!({ n: 9 });
      expect(take).toHaveBeenCalledTimes(1);
      expect(cap.lines()[0]).toMatchObject({ evt: "tool_call", tool: "t_ping", ok: true });
    } finally {
      cap.restore();
    }
  });
});

describe("catalog (A1)", () => {
  const fake = () => {
    const names: string[] = [];
    return { server: { registerTool: (n: string) => void names.push(n) } as unknown as McpServer, names };
  };
  it("registerTools sets ctx.catalog with manifest === listed, plus the aliases it also registered", () => {
    const { server, names } = fake();
    const ctx = baseCtx();
    const registered = registerTools(server, ctx, {});
    expect(ctx.catalog).toBeDefined();
    expect(ctx.catalog!.manifest.length).toBe(ctx.catalog!.listed.length);
    expect(ctx.catalog!.manifest.length + ctx.catalog!.aliases.length).toBe(registered.length);
    expect(registered).toEqual(names);
    expect(registered).toEqual([...ctx.catalog!.manifest.map((t) => t.name), ...ctx.catalog!.aliases.map((t) => t.name)]);
    expect(ctx.catalog!.listed).toBe(ctx.catalog!.manifest);
    expect(ctx.catalog!.aliases.map((t) => t.name).sort()).toEqual(Object.keys(RENAMES).sort());
    expect(ctx.catalog!.manifest.some((t) => t.alias)).toBe(false);
  });
  it("read-only drops write tools — and their aliases — from every set", () => {
    const { server, names } = fake();
    const ctx = baseCtx({ readOnly: true });
    registerTools(server, ctx, {});
    const reads = ALL_TOOLS.filter((t) => !t.write);
    expect(ctx.catalog!.manifest.map((t) => t.name)).toEqual(reads.map((t) => t.name));
    expect(names.length).toBe(reads.length + ctx.catalog!.aliases.length);
    expect(ctx.catalog!.listed.some((t: ToolDef<any>) => t.write)).toBe(false);
    expect(ctx.catalog!.manifest.some((t: ToolDef<any>) => t.write)).toBe(false);
    expect(ctx.catalog!.aliases.some((t: ToolDef<any>) => t.write)).toBe(false);
  });
  it("a disabled group is absent from the catalog", () => {
    const { server } = fake();
    const ctx = baseCtx();
    registerTools(server, ctx, { ENABLED_TOOL_GROUPS: "gmail" });
    expect(ctx.catalog!.listed.every((t: ToolDef<any>) => t.name.startsWith("gmail_") || t.name.startsWith("google_"))).toBe(true);
    expect(ctx.catalog!.aliases.every((t: ToolDef<any>) => t.name.startsWith("gmail_"))).toBe(true);
  });
});

describe("client name (A6)", () => {
  it("a tool call through the in-memory client logs client: test-client when ctx.client is wired like agent.ts", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    try {
      const server = new McpServer({ name: "google-workspace", version: "test" });
      const ctx = baseCtx({ client: () => server.server.getClientVersion()?.name });
      expect(ctx.client!()).toBeUndefined(); // before initialize
      registerTools(server, ctx, {});
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "test-client", version: "0" });
      await client.connect(clientT);
      const res = await client.callTool({ name: "google_list_tools", arguments: { group: "gmail" } });
      expect(res.isError).toBeFalsy();
      await client.close();
      await server.close();
      const line = logs.map((l) => JSON.parse(l)).find((l) => l.evt === "tool_call" && l.tool === "google_list_tools");
      expect(line).toMatchObject({ ok: true, client: "test-client" });
      expect(typeof line.outChars).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * PR-5 Rule #1: with TOOL_SURFACE unset — every current deployment — a client sees exactly the
 * PR-4 listing. `referenceList` builds it the 1.4.4/PR-4 way (plain registerAll over
 * `toolsFor(env)`, the SDK's own tools/list), so these are byte-for-byte comparisons against
 * code that knows nothing about the surface split.
 */
describe("Rule #1: the default surface is byte-identical to PR-4", () => {
  const ENVS: [string, Record<string, string>][] = [
    ["full", {}],
    ["TOOL_SURFACE unset but TOOL_SURFACE_ADD set (ignored on a full surface)", { TOOL_SURFACE_ADD: "drive_create_folder" }],
    ["TOOL_SURFACE blank", { TOOL_SURFACE: "" }],
    ["TOOL_SURFACE=full", { TOOL_SURFACE: "full" }],
    ["TOOL_SURFACE mistyped (fails open to full)", { TOOL_SURFACE: "compakt" }],
    ["group-restricted", { ENABLED_TOOL_GROUPS: "gmail,calendar" }],
    ["group-restricted, TOOL_SURFACE=full", { ENABLED_TOOL_GROUPS: "gmail,calendar", TOOL_SURFACE: "full" }],
    ["one group disabled", { DISABLED_TOOL_GROUPS: "photos" }],
  ];

  it.each(ENVS)("%s: tools/list is byte-identical to the PR-4 listing", async (_label, env) => {
    const { ENABLED_TOOL_GROUPS, DISABLED_TOOL_GROUPS } = env; // the reference knows only the PR-4 vars
    const groupsOnly = Object.fromEntries(Object.entries({ ENABLED_TOOL_GROUPS, DISABLED_TOOL_GROUPS }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    expect(JSON.stringify(await listToolsInMemory(env))).toBe(JSON.stringify(await referenceList(groupsOnly)));
  });

  /**
   * The COMPACT leg of rule #1. The other three surfaces are compared against `referenceList`,
   * which is PR-4 code; a compact surface has no PR-4 counterpart, so it is pinned against the
   * thing it is DEFINED as — the full listing filtered to the advertised names, byte for byte.
   * That proves hiding is a listing change and never a schema or description change, and it is a
   * committed artefact rather than a one-off local diff. The measured sizes are asserted too, so
   * the PR body can quote them and a silent change shows up here.
   */
  it.each([
    ["compact", { TOOL_SURFACE: "compact" }, 19],
    ["compact + TOOL_SURFACE_ADD", { TOOL_SURFACE: "compact", TOOL_SURFACE_ADD: "drive_create_folder" }, 20],
    ["compact + MCP_READONLY", { TOOL_SURFACE: "compact", MCP_READONLY: "true" }, 14],
    ["compact + one group", { TOOL_SURFACE: "compact", ENABLED_TOOL_GROUPS: "gmail,calendar" }, 10],
  ])("%s: every advertised tool is byte-identical to its full-surface entry", async (_label, env, count) => {
    const compact = await listToolsInMemory(env as Record<string, string>);
    expect(compact).toHaveLength(count);
    const full = new Map((await referenceList({})).map((t) => [t.name, t]));
    for (const t of compact) expect(JSON.stringify(t), t.name).toBe(JSON.stringify(full.get(t.name)));
  });

  it("the compact and full surfaces are the sizes the PR body quotes", async () => {
    // `{"tools":` + `}` is 10 bytes, so the wire response is each of these plus 10 — the numbers
    // usually quoted are 29,250 and 165,859. Measured, not aspirational: update these together
    // with the PR body/CHANGELOG.
    //
    // The compact surface grew by 338 bytes when google_list_tools stopped reporting a `count`
    // that meant groups: its description now defines every number it returns. That is a
    // deliberate wire change on ONE tool, and the full surface moved by the same 338 bytes and
    // nothing else — which is what the per-tool comparison above already proves.
    //
    // 1.6 (compact replies): +43 bytes on both surfaces (28,291 → 28,334; 157,756 → 157,799), again
    // all of it google_list_tools' description: it now also says when to use it (only to check what
    // this deployment enables) versus the client's own tool search, and names `disabled`.
    // 1.6 (shape=cells): +190 compact / +508 full (28,334 → 28,524; 157,799 → 158,307) — the
    // `shape` parameter (grid|cells) and its guidance on sheets_read_range (compact + full),
    // sheets_batch_read_ranges and sheets_read_cells (full only).
    // 1.6 (sheets_fill_range): +205 compact / +1 tool and +1,625 full (28,524 → 28,729;
    // 158,307 → 159,932). sheets_fill_range's own entry (with `value` capped at maxLength 50,000) plus the pointer sentence to it on
    // sheets_write_range and sheets_batch_write_ranges (+47 each, full +1,309 in all); the optional
    // sheet_id on sheets_write_range and each sheets_batch_write_ranges entry (+158 per tool, so
    // compact +158, where only sheets_write_range is listed, and full +316).
    // 1.6 (sheets batch update): +511 compact / +875 full (28,729 → 29,240; 159,932 → 160,807).
    // sheets_batch_update_spreadsheet, on both surfaces, gained writeValues (with sheetId), reply,
    // post_check and snapshot (2,136 → 2,647 wire bytes); sheets_delete_sheet gained snapshot and
    // post_check (523 → 757) and sheets_clear_range snapshot (432 → 562), full surface only.
    // 1.6 (audit signal): +202 full only (160,807 → 161,009). sheets_audit_spreadsheet's `detail`
    // parameter and its rewritten description (errors vs warnings, errorCount/warningCount); the
    // audit is not on the compact surface.
    // 1.6 (Docs editing): +4,840 full only (161,009 → 165,849). docs_replace_section,
    // docs_update_paragraph_style, docs_list_comments, docs_create_comment, docs_create_reply, and
    // the docs_insert_table description saying it fills cells from an array; none is on the compact
    // surface.
    const bytes = (tools: unknown[]) => Buffer.byteLength(JSON.stringify(tools), "utf8");
    const compact = await listToolsInMemory({ TOOL_SURFACE: "compact" });
    const full = await listToolsInMemory({});
    expect([compact.length, bytes(compact)]).toEqual([19, 29_240]);
    expect([full.length, bytes(full)]).toEqual([168, 165_849]);
  });

  it("a read-only session is byte-identical too, via ctx.readOnly and via MCP_READONLY", async () => {
    const viaCtx = await connectInMemory({ ctx: { readOnly: true } });
    const ctxList = (await viaCtx.client.listTools()).tools;
    await viaCtx.close();
    expect(JSON.stringify(ctxList)).toBe(JSON.stringify(await referenceList({}, true)));
    // MCP_READONLY reaches the same set through manifestFor, without a read-only ctx. This one
    // pins NEW behaviour, not PR-4 parity: PR-4's registerTools honoured only ctx.readOnly, so
    // env MCP_READONLY=true with a writable ctx listed all 162. Deliberate (fail closed on the
    // deployment's own var); production is unaffected because agent.ts derives ctx.readOnly from
    // the same variable. Called out in the CHANGELOG.
    expect(JSON.stringify(await listToolsInMemory({ MCP_READONLY: "true" }))).toBe(JSON.stringify(ctxList));
  });

  it("the default catalog still has listed === manifest (one set, not a copy)", () => {
    for (const env of [{}, { TOOL_SURFACE: "full" }, { ENABLED_TOOL_GROUPS: "gmail" }, { TOOL_SURFACE: "nonsense" }]) {
      const ctx = baseCtx();
      registerTools({ registerTool: () => {} } as unknown as McpServer, ctx, env);
      expect(ctx.catalog!.listed, JSON.stringify(env)).toBe(ctx.catalog!.manifest);
    }
  });

  it("compact still registers every manifest tool: hiding is a listing change, never a capability change", () => {
    const registered: string[] = [];
    const ctx = baseCtx();
    const names = registerTools({ registerTool: (n: string) => void registered.push(n) } as unknown as McpServer, ctx, { TOOL_SURFACE: "compact" });
    expect(names).toEqual(registered);
    expect(ctx.catalog!.manifest.map((t) => t.name)).toEqual(toolsFor({}).map((t) => t.name));
    expect(ctx.catalog!.listed.length).toBe(19);
    expect(ctx.catalog!.aliases.map((t) => t.name).sort()).toEqual(Object.keys(RENAMES).sort());
    for (const t of [...ctx.catalog!.manifest, ...ctx.catalog!.aliases]) expect(registered, t.name).toContain(t.name);
  });
});

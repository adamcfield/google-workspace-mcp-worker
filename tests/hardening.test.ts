/** Production-hardening guards: least privilege, fail-closed allow-list, headers, rate limits, timeouts, health. */
import { describe, it, expect, vi } from "vitest";
import { enabledGroups, enabledScopes, groupKey, ALL_GROUP_KEYS } from "../src/google/scopes.js";
import { toolsFor, ALL_TOOLS } from "../src/tools/index.js";
import { RateLimiter, registerAll, tool } from "../src/tools/_shared.js";
import { accountAllowed, allowListOpen, googleAuthorizeUrl, consentPage, handleAuthorize, handleCallback, secure, SECURITY_HEADERS, type AuthEnv } from "../src/auth.js";
import { GoogleClient, GoogleApiError } from "../src/google/client.js";
import { VERSION, toolRateLimit } from "../src/agent.js";
import { healthBody } from "../src/health.js";
import worker, { defaultHandler, authRateLimited } from "../src/oauth.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import lock from "../package-lock.json" with { type: "json" };

vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => new Response("mcp-served") };
    }
    static serveSSE() {
      return { fetch: async () => new Response("sse-served") };
    }
  },
}));

describe("least privilege: tool groups and scopes", () => {
  it("normalises group keys and knows every configurable group", () => {
    expect(groupKey("Contacts (People)")).toBe("contacts");
    expect(groupKey("Sheets")).toBe("sheets");
    expect(ALL_GROUP_KEYS).toEqual(["sheets", "drive", "docs", "gmail", "calendar", "tasks", "contacts", "chat", "slides", "forms", "photos", "youtube", "meet"]);
  });
  it("defaults to everything and reports unknown names", () => {
    const all = enabledGroups({});
    expect(all.groups.size).toBe(ALL_GROUP_KEYS.length + 1);
    expect(all.unknownGroups).toEqual([]);
    expect(enabledGroups({ DISABLED_TOOL_GROUPS: "gmail, Photos, nope" }).unknownGroups).toEqual(["nope"]);
    expect(enabledScopes({})).toHaveLength(21);
  });
  it("ENABLED narrows, DISABLED subtracts, identity always stays", () => {
    const only = enabledGroups({ ENABLED_TOOL_GROUPS: "sheets,drive", DISABLED_TOOL_GROUPS: "drive" });
    expect([...only.groups].sort()).toEqual(["identity", "sheets"]);
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "sheets" })).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/spreadsheets"]);
  });
  it("toolsFor drops disabled groups AND tools whose scope is no longer requested", () => {
    const names = (env: Record<string, string>) => new Set(toolsFor(env).map((t) => t.name));
    expect(toolsFor({}).length).toBe(ALL_TOOLS.length);
    const noDrive = names({ DISABLED_TOOL_GROUPS: "drive" });
    expect(noDrive.has("drive_search_files")).toBe(false);
    expect(noDrive.has("sheets_list_spreadsheets")).toBe(false); // needs the drive scope
    expect(noDrive.has("sheets_read_range")).toBe(true);
    const onlySheets = names({ ENABLED_TOOL_GROUPS: "sheets" });
    expect([...onlySheets].every((n) => n.startsWith("sheets_") || n.startsWith("google_"))).toBe(true);
    expect(onlySheets.has("google_whoami")).toBe(true);
    expect(onlySheets.has("gmail_search_messages")).toBe(false);
  });
});

describe("fail-closed allow-list", () => {
  it("admits nobody without a list unless the operator opts into open sign-in", () => {
    expect(accountAllowed("a@b.c", {})).toBe(false);
    expect(accountAllowed("a@b.c", { ALLOWED_EMAILS: "" })).toBe(false);
    expect(accountAllowed("a@b.c", { ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(true);
    expect(accountAllowed("a@b.c", { ALLOWED_EMAILS: "@b.c", ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(true);
    expect(accountAllowed("x@other.io", { ALLOWED_EMAILS: "@b.c", ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(false); // a list always wins
    expect(allowListOpen({ ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(true);
    expect(allowListOpen({ ALLOWED_EMAILS: "a@b.c", ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(false);
  });
  it("requests only the enabled scopes and passes the hosted-domain hint", () => {
    const u = new URL(googleAuthorizeUrl("cid", "https://o.test/callback", "st", undefined, { scopes: ["openid", "https://www.googleapis.com/auth/spreadsheets"], hostedDomain: "example.com" }));
    expect(u.searchParams.get("scope")).toBe("openid https://www.googleapis.com/auth/spreadsheets");
    expect(u.searchParams.get("hd")).toBe("example.com");
    expect(new URL(googleAuthorizeUrl("cid", "https://o.test/callback", "st")).searchParams.get("hd")).toBeNull();
  });
});

function authEnv(overrides: Partial<AuthEnv> = {}) {
  const kv = new Map<string, string>();
  const revoked: string[] = [];
  const env: AuthEnv & { _revoked: string[] } = {
    OAUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) } as never,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ clientId: "cid", redirectUri: "https://claude.ai/cb", scope: [], state: "s", responseType: "code", codeChallenge: "x", codeChallengeMethod: "S256" }),
      lookupClient: async () => ({ clientId: "cid", clientName: "Claude" }),
      completeAuthorization: async () => ({ redirectTo: "https://claude.ai/cb?code=1" }),
    } as never,
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    _revoked: revoked,
    ...overrides,
  };
  return { env, kv, revoked };
}

describe("auth surface hardening", () => {
  it("consent POST refuses to start a login when no allow-list exists and open sign-in is off", async () => {
    const { env } = authEnv({ ALLOWED_EMAILS: "" });
    const get = await handleAuthorize(new Request("https://o.test/authorize?client_id=cid"), env);
    const csrf = /gws_csrf=([^;]+)/.exec(get.headers.get("set-cookie") ?? "")![1];
    const req = /name="req" value="([^"]+)"/.exec(await get.text())![1];
    const form = new URLSearchParams({ req, csrf });
    const post = await handleAuthorize(new Request("https://o.test/authorize", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", cookie: `gws_csrf=${csrf}` } }), env);
    expect(post.status).toBe(400);
    expect(await post.text()).toMatch(/no ALLOWED_EMAILS allow-list/);
  });
  it("consent page lists only the enabled scopes", async () => {
    const page = consentPage({ clientId: "cid", redirectUri: "x", scope: [], state: "", responseType: "code", codeChallenge: "", codeChallengeMethod: "S256" } as never, "Claude", null, true, "csrf", enabledScopes({ ENABLED_TOOL_GROUPS: "calendar" }));
    const html = await page.text();
    expect(html).toContain("Calendar");
    expect(html).not.toContain("Gmail");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });
  it("callback rejects and revokes when no allow-list exists", async () => {
    const { env, kv } = authEnv({ ALLOWED_EMAILS: "" });
    kv.set("gws:authreq:st", JSON.stringify({ clientId: "cid", redirectUri: "https://claude.ai/cb", scope: [] }));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", refresh_token: "rt", scope: enabledScopes({}).join(" ") });
      if (u.includes("userinfo")) return Response.json({ email: "someone@else.io", email_verified: true });
      return new Response("ok");
    });
    try {
      const res = await handleCallback(new Request("https://o.test/callback?state=st&code=c"), env);
      expect(res.status).toBe(403);
      expect(calls.some((c) => c.includes("/revoke"))).toBe(true);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("secure() adds every header once and keeps existing ones", () => {
    const r = secure(new Response("x", { headers: { "x-frame-options": "SAMEORIGIN", "content-type": "text/plain" } }));
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    for (const k of Object.keys(SECURITY_HEADERS)) expect(r.headers.get(k), k).toBeTruthy();
  });
  it("rate-limits the auth endpoints per IP via the binding and fails open without it", async () => {
    const limited = { limit: async () => ({ success: false }) };
    const req = (p: string) => new Request(`https://o.test${p}`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(await authRateLimited(req("/register"), { AUTH_RATE_LIMIT: limited })).toBe(true);
    expect(await authRateLimited(req("/token"), { AUTH_RATE_LIMIT: limited })).toBe(true);
    expect(await authRateLimited(req("/mcp"), { AUTH_RATE_LIMIT: limited })).toBe(false);
    expect(await authRateLimited(req("/authorize"), {})).toBe(false);
    expect(await authRateLimited(req("/authorize"), { AUTH_RATE_LIMIT: { limit: async () => { throw new Error("boom"); } } })).toBe(false);
    const env = { MCP_OBJECT: {} as never, OAUTH_KV: {} as never, OAUTH_PROVIDER: {} as never, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", AUTH_RATE_LIMIT: limited };
    const r = await worker.fetch(req("/register"), env, {} as ExecutionContext);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    const h = await defaultHandler.fetch(req("/health"), env, {} as ExecutionContext);
    expect(h.status).toBe(200);
    expect(h.headers.get("strict-transport-security")).toContain("max-age");
  });
});

describe("health body", () => {
  const base = { MCP_OBJECT: {} as never, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" };
  it("reports groups, allow-list state, rate limit and actionable warnings", () => {
    const h = healthBody({ ...base, ALLOWED_EMAILS: "a@b.c", DISABLED_TOOL_GROUPS: "photos", AUTH_RATE_LIMIT: {} }, "n", "oauth");
    expect(h).toMatchObject({ ok: true, version: VERSION, allowList: "set", toolRateLimitPerMin: 120, readOnly: false });
    expect(h.groups).not.toContain("photos");
    expect(h.tools).toBe(toolsFor({ DISABLED_TOOL_GROUPS: "photos" }).length);
    expect(h.warnings).toBeUndefined();
    const open = healthBody({ ...base, ALLOW_ANY_GOOGLE_ACCOUNT: "true", ENABLED_TOOL_GROUPS: "sheets,bogus" }, "n", "oauth");
    expect(open.allowList).toBe("open");
    expect(open.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/any Google account may connect/), expect.stringMatching(/unknown tool groups ignored: bogus/), expect.stringMatching(/AUTH_RATE_LIMIT binding missing/)]));
    expect(healthBody({ ...base }, "n", "bearer").allowList).toBe("unset");
  });
  it("toolRateLimit parses the var and 0 disables", () => {
    expect(toolRateLimit({})).toBe(120);
    expect(toolRateLimit({ TOOL_RATE_LIMIT_PER_MIN: "0" })).toBe(0);
    expect(toolRateLimit({ TOOL_RATE_LIMIT_PER_MIN: "abc" })).toBe(120);
    expect(toolRateLimit({ TOOL_RATE_LIMIT_PER_MIN: "5" })).toBe(5);
  });
});

describe("per-session rate limiter", () => {
  it("sliding window: refuses the (limit+1)th call and frees after the window", () => {
    let t = 1000;
    const rl = new RateLimiter(3, 60_000, () => t);
    expect([rl.take(), rl.take(), rl.take()]).toEqual([0, 0, 0]);
    expect(rl.take()).toBe(60_000);
    t += 30_000;
    expect(rl.take()).toBe(30_000);
    t += 30_001;
    expect(rl.take()).toBe(0);
  });
  it("registerAll returns a tool error (not a throw) once the budget is spent, and logs access", async () => {
    const handlers = new Map<string, (a: unknown) => Promise<any>>();
    const server = { registerTool: (n: string, _c: unknown, h: (a: unknown) => Promise<any>) => handlers.set(n, h) } as never;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    try {
      registerAll(server, { g: {} as never, readOnly: false, grantedScopes: [], email: "u@x.y", limiter: new RateLimiter(2) }, [tool({ name: "t_ping", description: "ping pong ping pong ping", input: { n: z.number().default(1) }, handler: async (a) => ({ n: a.n }) })]);
      const h = handlers.get("t_ping")!;
      expect((await h({ n: 1 })).isError).toBeUndefined();
      expect((await h({ n: 2 })).isError).toBeUndefined();
      const third = await h({ n: 3 });
      expect(third.isError).toBe(true);
      expect(third.content[0].text).toMatch(/Rate limit: this session may make 2 tool calls per 60s/);
      const parsed = logs.map((l) => JSON.parse(l));
      expect(parsed[0]).toMatchObject({ evt: "tool_call", tool: "t_ping", user: "u@x.y", ok: true });
      expect(parsed[2]).toMatchObject({ evt: "tool_call", ok: false, error: "rate_limited" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("upstream timeouts", () => {
  it("passes an abort signal and maps a timeout to a clear GoogleApiError", async () => {
    let sawSignal = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).includes("/token")) return Response.json({ access_token: "at", expires_in: 3600 });
      sawSignal = init?.signal instanceof AbortSignal;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    };
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as never, maxRetries: 0, timeoutMs: 5000 });
    const err: any = await g.get("https://www.googleapis.com/drive/v3/about").catch((e) => e);
    expect(sawSignal).toBe(true);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.reason).toBe("timeout");
    expect(err.message).toMatch(/did not answer within 5s/);
  });
});

describe("release hygiene", () => {
  it("package.json version matches VERSION", () => {
    expect(pkg.version).toBe(VERSION);
  });

  it("package-lock.json mirrors the version (top level and root package)", () => {
    // `npm version <v> --no-git-tag-version --allow-same-version` keeps both in step.
    expect(lock.version).toBe(VERSION);
    expect((lock.packages as Record<string, { version?: string }>)[""].version).toBe(VERSION);
  });
});

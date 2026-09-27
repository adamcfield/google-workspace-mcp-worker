import { describe, it, expect, vi, afterEach } from "vitest";
import bearerWorker, { type Env } from "../src/index.js";
import { bearerAuthorized, loadOwnerGrant, saveOwnerGrant, ownerStatus, type BearerEnv } from "../src/owner.js";
import { SCOPE_LIST } from "../src/google/scopes.js";

// agents/mcp imports `cloudflare:workers`, which Node cannot load; the Durable
// Object side is exercised by wrangler, so stub the McpAgent statics here.
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

const worker = { fetch: (req: Request, e: BearerEnv, c: ExecutionContext) => bearerWorker.fetch(req, e as Env, c) };

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  };
}
function env(overrides: Partial<BearerEnv> = {}) {
  const { store, kv } = fakeKV();
  return {
    store,
    env: {
      MCP_OBJECT: {} as DurableObjectNamespace,
      TOKEN_KV: kv,
      MCP_AUTH_TOKEN: "s3cret-token",
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gsecret",
      ALLOWED_EMAILS: "",
      ...overrides,
    } as BearerEnv,
  };
}
const ctx = {} as ExecutionContext;
const bearer = (token = "s3cret-token") => ({ authorization: `Bearer ${token}` });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("bearerAuthorized", () => {
  it("fails closed without a configured secret and accepts only the exact bearer", () => {
    const { env: e } = env();
    expect(bearerAuthorized(new Request("https://w.test/mcp", { headers: bearer() }), e)).toBe(true);
    expect(bearerAuthorized(new Request("https://w.test/mcp", { headers: { authorization: "bearer s3cret-token" } }), e)).toBe(true);
    expect(bearerAuthorized(new Request("https://w.test/mcp", { headers: bearer("wrong") }), e)).toBe(false);
    expect(bearerAuthorized(new Request("https://w.test/mcp"), e)).toBe(false);
    expect(bearerAuthorized(new Request("https://w.test/mcp", { headers: bearer() }), { ...e, MCP_AUTH_TOKEN: undefined })).toBe(false);
  });
});

describe("owner grant store", () => {
  it("stores the refresh token encrypted, keyed to the worker's secrets", async () => {
    const { env: e, store } = env();
    await saveOwnerGrant(e, { email: "adam@example.com", refreshToken: "RT-1", grantedScopes: SCOPE_LIST, grantedAt: "2026-09-18T00:00:00Z" });
    const raw = [...store.values()][0];
    expect(raw).not.toContain("RT-1");
    expect(raw).not.toContain("example.com");
    const g = await loadOwnerGrant(e);
    expect(g).toMatchObject({ email: "adam@example.com", refreshToken: "RT-1", source: "owner-login" });
    // Rotating either secret makes the stored record unreadable (not silently wrong).
    expect(await loadOwnerGrant({ ...e, MCP_AUTH_TOKEN: "other" })).toBeNull();
    expect(await loadOwnerGrant({ ...e, GOOGLE_CLIENT_SECRET: "other" })).toBeNull();
    const status = await ownerStatus(e);
    expect(status.connected).toBe(true);
    expect(status.missingScopes).toEqual([]);
    expect(JSON.stringify(status)).not.toContain("RT-1");
  });
  it("prefers the GOOGLE_REFRESH_TOKEN secret and reports not-connected otherwise", async () => {
    const { env: e } = env({ GOOGLE_REFRESH_TOKEN: "RT-secret" });
    expect(await loadOwnerGrant(e)).toMatchObject({ refreshToken: "RT-secret", source: "secret" });
    expect(await loadOwnerGrant(env().env)).toBeNull();
    expect(await ownerStatus(env().env)).toEqual({ connected: false });
  });
});

describe("bearer worker routing", () => {
  it("serves public landing/health and gates everything else", async () => {
    const { env: e } = env();
    const home = await worker.fetch(new Request("https://w.test/"), e, ctx);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Bearer-token deployment");
    const privacy = await worker.fetch(new Request("https://w.test/privacy"), e, ctx);
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get("content-type")).toContain("text/plain");
    expect(await privacy.text()).toContain("Privacy Policy");
    const health = await worker.fetch(new Request("https://w.test/health"), e, ctx);
    expect(await health.json()).toMatchObject({ ok: true, mode: "bearer", configured: true, bearerConfigured: true, connected: false });
    const mcp = await worker.fetch(new Request("https://w.test/mcp", { method: "POST" }), e, ctx);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toBe("Bearer");
    expect((await worker.fetch(new Request("https://w.test/google/status"), e, ctx)).status).toBe(401);
    expect((await worker.fetch(new Request("https://w.test/nope", { headers: bearer() }), e, ctx)).status).toBe(404);
  });

  it("explains a not-yet-connected worker instead of serving MCP", async () => {
    const { env: e } = env();
    const res = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: bearer() }), e, ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("/google/auth?key=");
    const unconfigured = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: bearer() }), { ...e, GOOGLE_CLIENT_ID: undefined }, ctx);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.text()).toContain("GOOGLE_CLIENT_ID");
  });

  it("runs the one-time owner login: link → Google redirect → callback stores the encrypted grant", async () => {
    const { env: e, store } = env({ ALLOWED_EMAILS: "@example.com" });
    // key-less / wrong-key attempts are refused
    expect((await worker.fetch(new Request("https://w.test/google/auth"), e, ctx)).status).toBe(401);
    expect((await worker.fetch(new Request("https://w.test/google/auth?key=wrong"), e, ctx)).status).toBe(401);

    // single-use link minted with the bearer
    const link = await worker.fetch(new Request("https://w.test/google/auth/link", { method: "POST", headers: bearer() }), e, ctx);
    expect(link.status).toBe(200);
    const { url } = (await link.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/w\.test\/google\/auth\?key=/);
    const start = await worker.fetch(new Request(url), e, ctx);
    expect(start.status).toBe(302);
    const g = new URL(start.headers.get("location")!);
    expect(g.origin + g.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(g.searchParams.get("redirect_uri")).toBe("https://w.test/callback");
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("prompt")).toBe("consent");
    expect(g.searchParams.get("scope")!.split(" ")).toEqual(SCOPE_LIST);
    const state = g.searchParams.get("state")!;
    // the link was single-use
    expect((await worker.fetch(new Request(url), e, ctx)).status).toBe(401);
    // the raw secret also works as key
    expect((await worker.fetch(new Request("https://w.test/google/auth?key=s3cret-token"), e, ctx)).status).toBe(302);

    globalThis.fetch = vi.fn(async (u: any, init?: RequestInit) => {
      const s = String(u);
      if (s.startsWith("https://oauth2.googleapis.com/token")) {
        expect(String(init?.body)).toContain("redirect_uri=https%3A%2F%2Fw.test%2Fcallback");
        return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT-owner", scope: SCOPE_LIST.filter((x) => x !== "openid").join(" ") }), { status: 200 });
      }
      if (s.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) return new Response(JSON.stringify({ email: "Adam@Example.com", name: "Adam", email_verified: true }), { status: 200 });
      throw new Error("unexpected fetch " + s);
    }) as any;
    const cb = await worker.fetch(new Request(`https://w.test/callback?code=c&state=${state}`), e, ctx);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("adam@example.com");
    expect(store.has(`gws:oauth_state:${state}`)).toBe(false); // single-use
    expect(await loadOwnerGrant(e)).toMatchObject({ email: "adam@example.com", refreshToken: "RT-owner", source: "owner-login" });

    const status = await worker.fetch(new Request("https://w.test/google/status", { headers: bearer() }), e, ctx);
    expect(await status.json()).toMatchObject({ connected: true, email: "adam@example.com", source: "owner-login" });
    expect(((await (await worker.fetch(new Request("https://w.test/health"), e, ctx)).json()) as { connected: boolean }).connected).toBe(true);
    // …and MCP is now served (bearer + connected)
    expect(await (await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: bearer() }), e, ctx)).text()).toBe("mcp-served");
    expect(await (await worker.fetch(new Request("https://w.test/sse", { headers: bearer() }), e, ctx)).text()).toBe("sse-served");
  });

  it("rejects a callback with a stale state and a disallowed account (revoking the token)", async () => {
    const { env: e, store } = env({ ALLOWED_EMAILS: "@example.com" });
    expect((await worker.fetch(new Request("https://w.test/callback?code=c&state=nope"), e, ctx)).status).toBe(400);
    store.set("gws:oauth_state:s9", "1");
    const revoked: string[] = [];
    globalThis.fetch = vi.fn(async (u: any, init?: RequestInit) => {
      const s = String(u);
      if (s.includes("/revoke")) {
        revoked.push(String(init?.body));
        return new Response("{}", { status: 200 });
      }
      if (s.includes("/token")) return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT-x" }), { status: 200 });
      return new Response(JSON.stringify({ email: "intruder@else.com" }), { status: 200 });
    }) as any;
    const res = await worker.fetch(new Request("https://w.test/callback?code=c&state=s9"), e, ctx);
    expect(res.status).toBe(403);
    expect(revoked).toEqual(["token=RT-x"]);
    expect(await loadOwnerGrant(e)).toBeNull();
  });

  it("DELETE /google/auth revokes and forgets the owner grant", async () => {
    const { env: e } = env();
    await saveOwnerGrant(e, { email: "a@b.c", refreshToken: "RT-del", grantedScopes: [], grantedAt: "x" });
    const revoked: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init?: RequestInit) => {
      revoked.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as any;
    const res = await worker.fetch(new Request("https://w.test/google/auth", { method: "DELETE", headers: bearer() }), e, ctx);
    expect(await res.json()).toMatchObject({ disconnected: true, revoked: true });
    expect(revoked).toEqual(["token=RT-del"]);
    expect(await loadOwnerGrant(e)).toBeNull();
  });
});

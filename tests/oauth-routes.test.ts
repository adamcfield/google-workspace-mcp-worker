import { describe, it, expect, vi } from "vitest";
import { defaultHandler } from "../src/oauth.js";

// agents/mcp imports `cloudflare:workers`, which Node cannot load — stub the McpAgent statics.
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

const env = { MCP_OBJECT: {} as DurableObjectNamespace, OAUTH_KV: {} as KVNamespace, OAUTH_PROVIDER: {} as never, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" };
const ctx = {} as ExecutionContext;

describe("OAuth worker public routes", () => {
  it("serves the landing page with a privacy link, the privacy policy and health", async () => {
    const home = await defaultHandler.fetch(new Request("https://o.test/"), env, ctx);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Connect from Claude");
    expect(html).toContain('href="https://o.test/privacy"');

    const privacy = await defaultHandler.fetch(new Request("https://o.test/privacy"), env, ctx);
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get("content-type")).toContain("text/plain");
    const text = await privacy.text();
    expect(text).toContain("Privacy Policy");
    expect(text).toContain("https://o.test");
    expect(text).toContain("myaccount.google.com/permissions");

    const health = await defaultHandler.fetch(new Request("https://o.test/health"), env, ctx);
    expect(await health.json()).toMatchObject({ ok: true, mode: "oauth", configured: true });
    expect((await defaultHandler.fetch(new Request("https://o.test/nope"), env, ctx)).status).toBe(404);
  });
});

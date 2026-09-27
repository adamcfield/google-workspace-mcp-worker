/**
 * /privacy — the policy Google's consent screen links to.
 *
 * The behaviour worth pinning is the refusal. A public deployment that has not said who operates
 * it must not serve a policy naming nobody: that document passes review and then fails the one
 * person who ever reads it for real, the user trying to find out who holds their mail.
 */

import { describe, expect, it, vi } from "vitest";
import { privacyGaps, privacyPublicApp, privacyResponse, privacyText, PRIVACY_UPDATED } from "../src/privacy.js";
import { healthBody } from "../src/health.js";
import worker from "../src/index.js";

// The worker entry pulls in `agents/mcp`, which imports the `cloudflare:workers` runtime module
// that Node cannot resolve. The MCP transport plays no part in serving /privacy, so stub it.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => new Response("mcp") };
    }
    static serveSSE() {
      return { fetch: async () => new Response("sse") };
    }
  },
}));

const ORIGIN = "https://mcp.example.com";
const CONFIGURED = { PRIVACY_PUBLIC_APP: "true", PRIVACY_OPERATOR_NAME: "Example Ltd", PRIVACY_CONTACT_URL: "https://example.com/contact" };

describe("a private deployment", () => {
  it("serves the policy with the default operator wording", async () => {
    const res = privacyResponse(ORIGIN, {});
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`operated by its owner`);
    expect(body).toContain(PRIVACY_UPDATED);
    expect(body).toContain(ORIGIN);
  });

  it("is never blocked, however little it configures", () => {
    // It is not publishing a policy to anyone; being strict here would only break hobby installs.
    expect(privacyPublicApp({})).toBe(false);
    expect(privacyGaps({})).toEqual([]);
    expect(privacyGaps({ PRIVACY_PUBLIC_APP: "false" })).toEqual([]);
    expect(privacyGaps({ PRIVACY_PUBLIC_APP: "TRUE" })).toEqual([]); // matched exactly, like the other flags
  });

  it("still uses the operator's own details when it supplies them", async () => {
    const body = await privacyResponse(ORIGIN, { PRIVACY_OPERATOR_NAME: "Example Ltd", PRIVACY_CONTACT_URL: "https://example.com/contact" }).text();
    expect(body).toContain("operated by Example Ltd");
    expect(body).toContain("Contact: https://example.com/contact");
  });
});

describe("a public deployment", () => {
  it("refuses to serve a policy until it names an operator and a contact", async () => {
    const res = privacyResponse(ORIGIN, { PRIVACY_PUBLIC_APP: "true" });
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("PRIVACY_OPERATOR_NAME");
    expect(body).toContain("PRIVACY_CONTACT_URL");
    // It must not look like a policy: no policy sentence may leak into the refusal.
    expect(body).not.toContain("What we store");
  });

  it("names only the settings that are actually missing", () => {
    expect(privacyGaps({ PRIVACY_PUBLIC_APP: "true" })).toEqual(["PRIVACY_OPERATOR_NAME", "PRIVACY_CONTACT_URL"]);
    expect(privacyGaps({ PRIVACY_PUBLIC_APP: "true", PRIVACY_OPERATOR_NAME: "Example Ltd" })).toEqual(["PRIVACY_CONTACT_URL"]);
    expect(privacyGaps({ ...CONFIGURED })).toEqual([]);
  });

  it("treats whitespace as unset", () => {
    expect(privacyGaps({ PRIVACY_PUBLIC_APP: "true", PRIVACY_OPERATOR_NAME: "   ", PRIVACY_CONTACT_URL: "\t" })).toEqual(["PRIVACY_OPERATOR_NAME", "PRIVACY_CONTACT_URL"]);
  });

  it("serves the policy once configured, and does not cache the refusal", async () => {
    const ok = privacyResponse(ORIGIN, CONFIGURED);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("max-age");
    expect(await ok.text()).toContain("operated by Example Ltd");
    // A cached 503 would survive the redeploy that fixes it.
    expect(privacyResponse(ORIGIN, { PRIVACY_PUBLIC_APP: "true" }).headers.get("cache-control")).toBe("no-store");
  });
});

describe("/health", () => {
  const base = { ALLOWED_EMAILS: "you@example.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as never;

  it("warns when a public deployment has not been configured", () => {
    const body = healthBody({ ...(base as object), PRIVACY_PUBLIC_APP: "true" } as never, "test", "oauth", {}, true);
    expect((body.warnings as string[]).some((w) => w.includes("PRIVACY_OPERATOR_NAME"))).toBe(true);
  });

  it("says nothing about privacy for a configured or private deployment", () => {
    for (const env of [base, { ...(base as object), ...CONFIGURED } as never]) {
      const body = healthBody(env as never, "test", "oauth", {}, true);
      expect(((body.warnings as string[]) ?? []).some((w) => w.includes("PRIVACY"))).toBe(false);
    }
  });

  it("carries the operator text nowhere near the tool surface", () => {
    // Regression guard: the policy is served at /privacy and must not leak into the health body.
    const body = healthBody({ ...(base as object), ...CONFIGURED } as never, "test", "oauth", {}, true);
    expect(JSON.stringify(body)).not.toContain("Example Ltd");
  });
});

describe("the route", () => {
  /** The minimum a worker entry needs to answer an unauthenticated GET. */
  const workerEnv = (extra: Record<string, string> = {}) =>
    ({ MCP_OBJECT: {}, TOKEN_KV: { get: async () => null, put: async () => {}, delete: async () => {} }, MCP_AUTH_TOKEN: "t", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", ALLOWED_EMAILS: "you@example.com", ...extra }) as never;

  const get = (env: never) => worker.fetch(new Request("https://w.test/privacy"), env, {} as ExecutionContext);

  it("serves the policy without authentication", async () => {
    const res = await get(workerEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Privacy Policy");
  });

  it("passes the deployment's own settings through to the policy", async () => {
    const res = await get(workerEnv(CONFIGURED));
    expect(await res.text()).toContain("operated by Example Ltd");
  });

  it("returns the 503 on the real route, not just from the helper", async () => {
    const res = await get(workerEnv({ PRIVACY_PUBLIC_APP: "true" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("PRIVACY_OPERATOR_NAME");
  });

  it("still carries the security headers when it refuses", async () => {
    // The refusal goes through secure() like every other page; a 503 is not an excuse to drop them.
    const res = await get(workerEnv({ PRIVACY_PUBLIC_APP: "true" }));
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });
});

describe("the policy text", () => {
  it("keeps the Google Limited Use statement and the revocation link", () => {
    const body = privacyText(ORIGIN, CONFIGURED);
    expect(body).toContain("Limited Use");
    expect(body).toContain("https://myaccount.google.com/permissions");
  });
});

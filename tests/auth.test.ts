import { describe, it, expect, vi, afterEach } from "vitest";
import { emailAllowed, b64encodeUtf8, b64decodeUtf8, consentPage, handleAuthorize, handleCallback, type AuthEnv } from "../src/auth.js";
import { SCOPE_LIST } from "../src/google/scopes.js";

function env(overrides: Partial<AuthEnv> = {}): AuthEnv & { _kv: Map<string, string>; _complete: ReturnType<typeof vi.fn> } {
  const kv = new Map<string, string>();
  const complete = vi.fn(async () => ({ redirectTo: "https://claude.ai/cb?code=abc&state=s1" }));
  return {
    _kv: kv,
    _complete: complete,
    OAUTH_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    } as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: async (req: Request) => {
        const u = new URL(req.url);
        return { responseType: "code", clientId: u.searchParams.get("client_id") ?? "", redirectUri: "https://claude.ai/cb", scope: [], state: "s1", codeChallenge: "x", codeChallengeMethod: "S256" };
      },
      lookupClient: async (id: string) => (id === "cid" ? { clientId: "cid", clientName: "Claude <b>" } : null),
      completeAuthorization: complete,
    } as any,
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "gsecret",
    ALLOWED_EMAILS: "",
    ALLOW_ANY_GOOGLE_ACCOUNT: "true",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("emailAllowed", () => {
  it("allows all when empty, matches emails and domains case-insensitively", () => {
    expect(emailAllowed("a@b.com", "")).toBe(true);
    expect(emailAllowed("a@b.com", undefined)).toBe(true);
    expect(emailAllowed("Adam@Example.com", "adam@example.com")).toBe(true);
    expect(emailAllowed("x@example.com", "@example.com, other@x.com")).toBe(true);
    expect(emailAllowed("x@evil.com", "@example.com")).toBe(false);
    expect(emailAllowed("x@notexample.com", "@example.com")).toBe(false);
  });
});

describe("base64 helpers", () => {
  it("round-trips unicode", () => {
    const s = JSON.stringify({ state: "שלום 🌍" });
    expect(b64decodeUtf8(b64encodeUtf8(s))).toBe(s);
  });
});

describe("consent page", () => {
  it("escapes the client name and lists scope groups", () => {
    const res = consentPage({ responseType: "code", clientId: "cid", redirectUri: "https://claude.ai/cb", scope: [], state: "s" } as any, "Claude <b>", null, true);
    expect(res.status).toBe(200);
    return res.text().then((html) => {
      expect(html).toContain("Claude &lt;b&gt;");
      expect(html).toContain("Continue with Google");
      expect(html).toContain("Gmail");
      expect(html).not.toMatch(/<button[^>]*\sdisabled/);
    });
  });
});

/** Render the consent page and return what a browser would send back (form fields + cookie). */
async function consent(e: AuthEnv, clientId = "cid") {
  const get = await handleAuthorize(new Request(`https://w.test/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&response_type=code`), e);
  const html = await get.text();
  const req = /name="req" value="([^"]+)"/.exec(html)![1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  const cookie = /gws_csrf=([^;]+)/.exec(get.headers.get("set-cookie") ?? "")![1];
  return { get, html, req, csrf, cookie };
}
function postForm(fields: Record<string, string>, cookie?: string): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://w.test/authorize", { method: "POST", body: form, headers: cookie ? { cookie: `gws_csrf=${cookie}` } : {} });
}

describe("/authorize", () => {
  it("GET renders consent; POST parks the request and redirects to Google with offline+consent", async () => {
    const e = env();
    const { get, req, csrf, cookie } = await consent(e);
    expect(get.status).toBe(200);
    expect(get.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(csrf).toBe(cookie);

    const post = await handleAuthorize(postForm({ req, csrf }, cookie), e);
    expect(post.status).toBe(302);
    const loc = new URL(post.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://w.test/callback");
    expect(loc.searchParams.get("client_id")).toBe("gid.apps.googleusercontent.com");
    expect(loc.searchParams.get("scope")!.split(" ")).toEqual(SCOPE_LIST);
    const state = loc.searchParams.get("state")!;
    expect(e._kv.has(`gws:authreq:${state}`)).toBe(true);
  });

  it("POST with an unknown client is rejected", async () => {
    const e = env();
    const { cookie, csrf } = await consent(e);
    const post = await handleAuthorize(postForm({ req: b64encodeUtf8(JSON.stringify({ clientId: "nope", redirectUri: "https://x" })), csrf }, cookie), e);
    expect(post.status).toBe(400);
  });

  it("POST without the consent cookie, with a mismatched token, or from a cross-site form is refused (403) and parks nothing", async () => {
    const e = env();
    const { req, csrf, cookie } = await consent(e);
    expect((await handleAuthorize(postForm({ req, csrf }), e)).status).toBe(403); // no cookie (cross-site POST)
    expect((await handleAuthorize(postForm({ req }, cookie), e)).status).toBe(403); // no hidden field
    expect((await handleAuthorize(postForm({ req, csrf: "other" }, cookie), e)).status).toBe(403); // mismatch
    const crossSite = postForm({ req, csrf }, cookie);
    crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await handleAuthorize(crossSite, e)).status).toBe(403);
    expect([...e._kv.keys()].some((k) => k.startsWith("gws:authreq:"))).toBe(false);
  });
});

describe("/callback", () => {
  const stored = { responseType: "code", clientId: "cid", redirectUri: "https://claude.ai/cb", scope: [], state: "s1" };

  it("rejects a missing/expired state", async () => {
    const res = await handleCallback(new Request("https://w.test/callback?code=c&state=missing"), env());
    expect(res.status).toBe(400);
  });

  it("exchanges the code, reads the email and completes the grant with the refresh token in props", async () => {
    const e = env();
    e._kv.set("gws:authreq:st1", JSON.stringify(stored));
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/token")) {
        const body = String(init?.body);
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("redirect_uri=https%3A%2F%2Fw.test%2Fcallback");
        return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT-secret", expires_in: 3599, scope: SCOPE_LIST.filter((s) => s !== "openid").join(" ") }), { status: 200 });
      }
      if (u.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return new Response(JSON.stringify({ sub: "123", email: "Adam@Example.com", name: "Adam" }), { status: 200 });
      }
      throw new Error("unexpected fetch " + u);
    }) as any;
    const res = await handleCallback(new Request("https://w.test/callback?code=c&state=st1"), e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://claude.ai/cb?code=abc&state=s1");
    expect(e._kv.has("gws:authreq:st1")).toBe(false); // single-use
    const call = e._complete.mock.calls[0][0] as any;
    expect(call.userId).toBe("adam@example.com");
    expect(call.props.refreshToken).toBe("RT-secret");
    expect(call.props.email).toBe("adam@example.com");
    expect(call.metadata.missingScopes).toEqual([]);
  });

  it("enforces ALLOWED_EMAILS (revoking the unwanted grant) and requires a refresh token", async () => {
    const e = env({ ALLOWED_EMAILS: "@example.com" });
    e._kv.set("gws:authreq:st2", JSON.stringify(stored));
    const revoked: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/revoke")) {
        revoked.push(String(init?.body));
        return new Response("{}", { status: 200 });
      }
      if (u.includes("/token")) return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT" }), { status: 200 });
      return new Response(JSON.stringify({ email: "someone@else.com" }), { status: 200 });
    }) as any;
    const denied = await handleCallback(new Request("https://w.test/callback?code=c&state=st2"), e);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("someone@else.com is not in");
    expect(e._complete).not.toHaveBeenCalled();
    expect(revoked).toEqual(["token=RT"]);

    e._kv.set("gws:authreq:st3", JSON.stringify(stored));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT" }), { status: 200 })) as any;
    expect((await handleCallback(new Request("https://w.test/callback?code=c&state=st3"), e)).status).toBe(502);
  });

  it("surfaces a Google-side cancel with the error escaped", async () => {
    const e = env();
    e._kv.set("gws:authreq:st4", JSON.stringify(stored));
    const res = await handleCallback(new Request("https://w.test/callback?error=access_denied%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&state=st4"), e);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("access_denied");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("rejects an unverified email", async () => {
    const e = env();
    e._kv.set("gws:authreq:st5", JSON.stringify(stored));
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/token")) return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT" }), { status: 200 });
      if (u.includes("/revoke")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ email: "x@y.com", email_verified: false }), { status: 200 });
    }) as any;
    expect((await handleCallback(new Request("https://w.test/callback?code=c&state=st5"), e)).status).toBe(403);
    expect(e._complete).not.toHaveBeenCalled();
  });
});

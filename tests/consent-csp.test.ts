/**
 * The consent click must survive the page's own Content-Security-Policy.
 *
 * `form-action` is checked against every URL a form submission navigates to, including the
 * ones it is redirected to, so the policy has to cover both halves of the consent hop:
 * POST → this worker's /authorize, then 302 → Google's authorization endpoint. These tests
 * simulate that check against the real handler's output, and pin the two things that make
 * the policy safe rather than merely permissive: the origin is the one the request came in
 * on, and nothing else is allowed.
 */
import { describe, it, expect, vi } from "vitest";
import { consentPage, consentCsp, requestOrigin, handleAuthorize, GOOGLE_AUTH_ORIGIN, SECURITY_HEADERS, b64encodeUtf8, type AuthEnv } from "../src/auth.js";

const WORKER = "https://mcp-qa.example.com";

function env(overrides: Partial<AuthEnv> = {}): AuthEnv & { _kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return {
    _kv: kv,
    OAUTH_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    } as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: async (req: Request) => ({ responseType: "code", clientId: new URL(req.url).searchParams.get("client_id") ?? "", redirectUri: "https://claude.ai/cb", scope: [], state: "s1", codeChallenge: "x", codeChallengeMethod: "S256" }),
      lookupClient: async (id: string) => (id === "cid" ? { clientId: "cid", clientName: "Claude" } : null),
      completeAuthorization: vi.fn(),
    } as any,
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "gsecret",
    ALLOWED_EMAILS: "ops@example.com",
    ...overrides,
  };
}

/** The `form-action` source list actually served on a page. */
function formAction(res: Response): string[] {
  const csp = res.headers.get("content-security-policy") ?? "";
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("form-action "));
  return directive ? directive.slice("form-action ".length).split(/\s+/) : [];
}

/**
 * What a browser does with one URL of a submission chain: `'self'` matches the document's
 * own origin, a source expression matches by origin. Deliberately strict — no scheme
 * sources, no wildcards — so a policy that only works because of a relaxation fails here.
 */
function allowedByFormAction(res: Response, documentOrigin: string, target: string): boolean {
  const sources = formAction(res);
  const origin = new URL(target, documentOrigin).origin;
  return sources.some((s) => (s === "'self'" ? origin === documentOrigin : s === origin));
}

/** Render the consent page the way the worker does, and read back what the browser would submit. */
async function consent(e: AuthEnv, origin = WORKER) {
  const res = await handleAuthorize(new Request(`${origin}/authorize?client_id=cid&response_type=code`), e);
  const html = await res.clone().text();
  return {
    res,
    html,
    action: /<form[^>]*\saction="([^"]*)"/.exec(html)![1],
    req: /name="req" value="([^"]+)"/.exec(html)![1],
    csrf: /name="csrf" value="([^"]+)"/.exec(html)![1],
    cookie: /gws_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1],
  };
}

function postForm(origin: string, fields: Record<string, string>, cookie?: string): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`${origin}/authorize`, { method: "POST", body: form, headers: cookie ? { cookie: `gws_csrf=${cookie}` } : {} });
}

describe("consent page: form action", () => {
  it("is an absolute URL on the origin the request was served on, ending /authorize", async () => {
    const { action } = await consent(env());
    expect(action).toBe(`${WORKER}/authorize`);
    expect(new URL(action).origin).toBe(WORKER);
    expect(new URL(action).pathname).toBe("/authorize");
  });

  it("follows the request origin rather than any configured or forwarded host", async () => {
    const other = "https://mcp.example.com";
    const { action, res } = await consent(env(), other);
    expect(action).toBe(`${other}/authorize`);
    expect(formAction(res)).toContain(other);

    const forged = new Request(`${WORKER}/authorize?client_id=cid`, { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "host=evil.example" } });
    const page = await handleAuthorize(forged, env());
    const html = await page.clone().text();
    expect(/<form[^>]*\saction="([^"]*)"/.exec(html)![1]).toBe(`${WORKER}/authorize`);
    expect(page.headers.get("content-security-policy")).not.toContain("evil.example");
    expect(html).not.toContain("evil.example");
  });

  it("falls back to the relative action when no usable origin is known", () => {
    expect(requestOrigin(new Request("https://w.test/authorize"))).toBe("https://w.test");
    expect(requestOrigin(new Request("http://127.0.0.1:8787/authorize"))).toBe("http://127.0.0.1:8787");
    expect(consentCsp("")).toBe(consentCsp("javascript:alert(1)"));
    expect(consentCsp("")).not.toContain("javascript");
  });
});

describe("consent page: Content-Security-Policy", () => {
  it("permits exactly 'self', the request origin and Google's authorization origin", async () => {
    const { res } = await consent(env());
    expect(formAction(res)).toEqual(["'self'", WORKER, GOOGLE_AUTH_ORIGIN]);
    expect(GOOGLE_AUTH_ORIGIN).toBe("https://accounts.google.com");
  });

  it("relaxes nothing else: no wildcard, no scheme source, no scripts, no frames", async () => {
    const { res } = await consent(env());
    const csp = res.headers.get("content-security-policy")!;
    // Every source is an exact origin or a keyword — a scheme source or a wildcard would
    // match hosts nobody reviewed, so they are rejected as tokens, not as substrings.
    for (const forbidden of ["*", "https:", "http:", "data:", "'unsafe-eval'", "'unsafe-hashes'", "'unsafe-inline'"]) {
      expect(formAction(res)).not.toContain(forbidden);
    }
    expect(formAction(res).every((s) => s === "'self'" || /^https:\/\/[a-z0-9.-]+$/.test(s))).toBe(true);
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Every other directive is byte-identical to the global policy.
    const global = SECURITY_HEADERS["content-security-policy"];
    const strip = (s: string) => s.split(";").map((d) => d.trim()).filter((d) => !d.startsWith("form-action"));
    expect(strip(csp)).toEqual(strip(global));
    // And the global policy — which every other page keeps — is untouched.
    expect(global).toContain("form-action 'self'");
    expect(global).not.toContain("accounts.google.com");
  });

  it("covers both hops of the submission: the action and the redirect the POST answers with", async () => {
    const e = env();
    const { res, action, req, csrf, cookie } = await consent(e);
    const post = await handleAuthorize(postForm(WORKER, { req, csrf }, cookie), e);
    expect(post.status).toBe(302);
    const location = post.headers.get("location")!;
    expect(location.startsWith(`${GOOGLE_AUTH_ORIGIN}/o/oauth2/v2/auth`)).toBe(true);

    expect(allowedByFormAction(res, WORKER, action)).toBe(true);
    expect(allowedByFormAction(res, WORKER, location)).toBe(true);

    // The policy this replaces allowed the first hop and blocked the second — which is the
    // bug, and the reason the browser reported the block against the same-origin action.
    const before = new Response("", { headers: { "content-security-policy": SECURITY_HEADERS["content-security-policy"] } });
    expect(allowedByFormAction(before, WORKER, action)).toBe(true);
    expect(allowedByFormAction(before, WORKER, location)).toBe(false);
  });

  it("does not let a foreign origin into the policy through the page's own inputs", async () => {
    const e = env();
    const page = consentPage({ clientId: "cid", redirectUri: "https://evil.example/cb", scope: [], state: "https://evil.example", responseType: "code" } as never, '"><script>', null, true, '" evil.example "', undefined, WORKER);
    expect(formAction(page)).toEqual(["'self'", WORKER, GOOGLE_AUTH_ORIGIN]);
    const html = await page.text();
    expect(html).not.toContain("<script>");
    // A redirect_uri is echoed only inside the base64 blob, never into the policy.
    expect(page.headers.get("content-security-policy")).not.toContain("evil.example");
    expect(e._kv.size).toBe(0);
  });
});

describe("consent page: the protections around the click are unchanged", () => {
  it("GET → POST still parks the request and redirects to Google", async () => {
    const e = env();
    const { req, csrf, cookie, res } = await consent(e);
    expect(res.headers.get("set-cookie")).toMatch(/gws_csrf=[^;]+; Path=\/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
    expect(csrf).toBe(cookie);
    const post = await handleAuthorize(postForm(WORKER, { req, csrf }, cookie), e);
    const state = new URL(post.headers.get("location")!).searchParams.get("state")!;
    expect(e._kv.has(`gws:authreq:${state}`)).toBe(true);
  });

  it("still refuses a POST with no cookie, a mismatched token, a cross-site submission or an unknown client", async () => {
    const e = env();
    const { req, csrf, cookie } = await consent(e);
    expect((await handleAuthorize(postForm(WORKER, { req, csrf }), e)).status).toBe(403);
    expect((await handleAuthorize(postForm(WORKER, { req }, cookie), e)).status).toBe(403);
    expect((await handleAuthorize(postForm(WORKER, { req, csrf: "other" }, cookie), e)).status).toBe(403);
    const crossSite = postForm(WORKER, { req, csrf }, cookie);
    crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await handleAuthorize(crossSite, e)).status).toBe(403);
    const unknown = await handleAuthorize(postForm(WORKER, { req: b64encodeUtf8(JSON.stringify({ clientId: "nope", redirectUri: "https://x" })), csrf }, cookie), e);
    expect(unknown.status).toBe(400);
    expect([...e._kv.keys()].some((k) => k.startsWith("gws:authreq:"))).toBe(false);
  });
});

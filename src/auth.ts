/**
 * Upstream Google sign-in for the OAuth provider.
 *
 * Flow (Claude → this Worker → Google → this Worker → Claude):
 *   1. Claude (an MCP client registered via /register) sends the user to
 *      GET /authorize?client_id=…&redirect_uri=…&code_challenge=…
 *   2. We show a one-click consent page naming the requesting client and the
 *      Google scopes. The click is the explicit per-client approval that
 *      prevents a confused-deputy grant (a rogue MCP client can't silently
 *      capture a Google grant — you see WHO is asking).
 *   3. POST /authorize parks the parsed MCP auth request in KV under a random
 *      `state` (10 min) and redirects to Google's consent screen with
 *      access_type=offline + prompt=consent (guarantees a refresh_token).
 *   4. Google redirects to GET /callback?code&state. We exchange the code,
 *      read the account email (userinfo), enforce ALLOWED_EMAILS, and finish
 *      the MCP grant with completeAuthorization(). The Google refresh token is
 *      stored ONLY in the grant `props`, which workers-oauth-provider encrypts
 *      at rest in KV (the key is wrapped by the tokens it hands the client).
 *   5. Claude receives its authorization code → /token → MCP calls carry a
 *      bearer; the provider decrypts props and hands them to the McpAgent.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, exchangeCode, fetchUserInfo, timeoutSignal } from "./google/client.js";
import { SCOPES, enabledScopes, type GroupConfig } from "./google/scopes.js";

export interface AuthEnv extends GroupConfig {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Comma-separated emails and/or @domains allowed to connect. Empty = nobody, unless ALLOW_ANY_GOOGLE_ACCOUNT="true". */
  ALLOWED_EMAILS?: string;
  /** "true" → an empty ALLOWED_EMAILS admits any Google account that passes your consent screen (fail-open, opt-in). */
  ALLOW_ANY_GOOGLE_ACCOUNT?: string;
  /** Optional Google Workspace domain: pre-selects it on Google's account chooser (`hd`). Enforcement is ALLOWED_EMAILS. */
  GOOGLE_HOSTED_DOMAIN?: string;
}

/** Parse ALLOWED_EMAILS into rules (lower-cased emails / @domains). Separators alone ("," " , ") yield none. */
export function allowRules(allowed: string | undefined): string[] {
  return (allowed ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Fail closed: with no allow-list rules, nobody may connect unless the operator opted into open sign-in. */
export function allowListOpen(env: { ALLOWED_EMAILS?: string; ALLOW_ANY_GOOGLE_ACCOUNT?: string }): boolean {
  return allowRules(env.ALLOWED_EMAILS).length === 0 && env.ALLOW_ANY_GOOGLE_ACCOUNT === "true";
}

/** May this Google account complete a sign-in on this deployment? */
export function accountAllowed(email: string, env: { ALLOWED_EMAILS?: string; ALLOW_ANY_GOOGLE_ACCOUNT?: string }): boolean {
  const rules = allowRules(env.ALLOWED_EMAILS);
  if (!rules.length) return env.ALLOW_ANY_GOOGLE_ACCOUNT === "true";
  return emailAllowed(email, rules.join(","));
}

/** Security headers for every HTML/JSON page this worker renders (no scripts anywhere, so CSP can be strict). */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
};

/** Wrap a Response with the security headers (existing headers win). */
export function secure(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The one cross-origin target a consent submission is allowed to reach: Google's
 * authorization endpoint, taken from the URL the redirect is actually built from.
 */
export const GOOGLE_AUTH_ORIGIN = new URL(GOOGLE_AUTH_URL).origin;

/** Shape of an origin we will name in a header or an action attribute: scheme, host, optional port — nothing else. */
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * The origin this request was served on. It comes from the request URL and from nowhere
 * else — no `x-forwarded-host`, no configured hostname — so a header cannot make the
 * consent page point its form, or open its CSP, at an origin the browser did not load.
 * An origin that does not have the plain shape above yields "" (relative action, `'self'`).
 */
export function requestOrigin(request: Request): string {
  try {
    const origin = new URL(request.url).origin;
    return ORIGIN_RE.test(origin) ? origin : "";
  } catch {
    return "";
  }
}

/**
 * CSP for the consent page.
 *
 * `form-action` is enforced against **every URL in the submission's redirect chain**, not
 * just the form's action: Chromium re-checks it when POST /authorize answers `302` to
 * Google, and reports the block against the action URL — which reads as if same-origin
 * `/authorize` had been refused. The global `form-action 'self'` therefore stops the
 * consent click before any request leaves the browser. This page, and only this page,
 * also names the origin it was served on and Google's authorization origin. Everything
 * else stays as strict as the global policy: no scripts, no frames, no other relaxation.
 */
export function consentCsp(origin: string): string {
  const targets = ["'self'", ORIGIN_RE.test(origin) ? origin : "", GOOGLE_AUTH_ORIGIN].filter(Boolean);
  return SECURITY_HEADERS["content-security-policy"].replace("form-action 'self'", `form-action ${[...new Set(targets)].join(" ")}`);
}

/** What the McpAgent receives per grant (encrypted at rest). */
export interface Props extends Record<string, unknown> {
  email: string;
  name?: string;
  sub?: string;
  /** Google OAuth refresh token — the only long-lived credential. */
  refreshToken: string;
  /** Scopes Google actually granted (user may untick some on the consent screen). */
  grantedScopes: string[];
  grantedAt: string;
}

type AuthRequest = Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;

const STATE_TTL_SECS = 600;
/** Cookie that binds the consent POST to the browser that rendered the GET (CSRF / cross-site form-post protection). */
const CSRF_COOKIE = "gws_csrf";
const CSRF_TTL_SECS = 600;

// ---- small helpers ----

/** UTF-8-safe base64 round-trip (btoa alone throws on code points > 0xFF, e.g. unicode in `state`). */
export function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000; // chunked: spreading a huge array into fromCharCode overflows the arg limit
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
export function b64decodeUtf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** ALLOWED_EMAILS: "a@x.com, @corp.com" → true if email matches (case-insensitive); empty list allows all. */
export function emailAllowed(email: string, allowed: string | undefined): boolean {
  const rules = (allowed ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const e = email.toLowerCase();
  const domain = e.slice(e.lastIndexOf("@"));
  return rules.some((r) => (r.startsWith("@") ? domain === r : e === r));
}

export const googleConfigured = (env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }): boolean => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;

/** Length-safe constant-time string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Best-effort revocation of a Google token we obtained but will not keep (rejected sign-ins, disconnects). */
export async function revokeGoogleToken(token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: timeoutSignal(10_000),
    });
  } catch {
    /* best-effort */
  }
}

/** Best-effort human-readable client name for the consent screen. */
async function clientName(env: AuthEnv, clientId: string): Promise<string> {
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(clientId);
    return (client as { clientName?: string } | null)?.clientName ?? "";
  } catch {
    return "";
  }
}

// ---- consent page ----

export function consentPage(reqInfo: AuthRequest, client: string, error: string | null, configured: boolean, csrf: string = crypto.randomUUID(), scopes: string[] = enabledScopes({}), origin: string = ""): Response {
  const req = b64encodeUtf8(JSON.stringify(reqInfo));
  // Absolute when we know the origin we were served on, so the submission target is the
  // page's own origin spelled out rather than resolved, and matches the CSP below exactly.
  const action = `${ORIGIN_RE.test(origin) ? origin : ""}/authorize`;
  const groups = new Map<string, string[]>();
  const wanted = new Set(scopes);
  for (const s of SCOPES) if (wanted.has(s.scope)) groups.set(s.group, [...(groups.get(s.group) ?? []), s.why]);
  const scopeRows = [...groups.entries()]
    .map(([g, whys]) => `<li><b>${escapeHtml(g)}</b> — ${escapeHtml([...new Set(whys)].join("; "))}</li>`)
    .join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect Google Workspace</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b0c0f; color: #e7e9ee; }
  .card { width: min(94vw, 460px); background: #15171c; border: 1px solid #272a31; border-radius: 14px; padding: 28px; box-shadow: 0 10px 40px rgba(0,0,0,.45); }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { color: #9aa0aa; font-size: 14px; margin: 0 0 14px; }
  .client { color: #e7e9ee; font-weight: 600; }
  ul { margin: 0 0 16px; padding-left: 18px; font-size: 13px; color: #c2c7d0; max-height: 260px; overflow: auto; }
  li { margin: 2px 0; }
  button { width: 100%; margin-top: 6px; padding: 11px; border: 0; border-radius: 9px; background: #4c6ef5; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #3b5bdb; }
  button[disabled] { background: #3a3d45; cursor: not-allowed; }
  .err { color: #ff8787; font-size: 13px; margin: 12px 0 0; }
  .foot { color: #6b7280; font-size: 12px; margin-top: 16px; text-align: center; }
</style></head>
<body>
  <form class="card" method="POST" action="${escapeHtml(action)}">
    <h1>Connect your Google Workspace</h1>
    <p><span class="client">${escapeHtml(client || "An application")}</span> wants to use this MCP server to act on your Google account. You will next see Google's own account chooser and permission screen for:</p>
    <ul>${scopeRows}</ul>
    <input type="hidden" name="req" value="${req}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button type="submit" ${configured ? "" : "disabled"}>Continue with Google</button>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    ${configured ? "" : `<p class="err">Server not configured: set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.</p>`}
    <p class="foot">You sign in with your own Google account · this server acts as you · revoke any time at myaccount.google.com/permissions</p>
  </form>
</body></html>`;
  return new Response(html, {
    status: error ? 400 : 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-security-policy": consentCsp(origin),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Same-site only: a cross-site form POST (attacker page) never carries it, so the
      // consent click cannot be forged by a rogue MCP client that registered itself.
      "set-cookie": `${CSRF_COOKIE}=${csrf}; Path=/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=${CSRF_TTL_SECS}`,
    },
  });
}

// ---- /authorize ----

export async function handleAuthorize(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method === "GET") {
    let reqInfo: AuthRequest;
    try {
      reqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
      return new Response("Invalid OAuth request", { status: 400 });
    }
    if (!reqInfo.clientId) return new Response("Invalid OAuth request", { status: 400 });
    return consentPage(reqInfo, await clientName(env, reqInfo.clientId), null, googleConfigured(env), undefined, enabledScopes(env), requestOrigin(request));
  }

  if (request.method === "POST") {
    let reqInfo: AuthRequest;
    let csrfField = "";
    try {
      const form = await request.formData();
      csrfField = String(form.get("csrf") ?? "");
      reqInfo = JSON.parse(b64decodeUtf8(String(form.get("req") ?? ""))) as AuthRequest;
    } catch {
      return new Response("Invalid OAuth request", { status: 400 });
    }
    // The consent click must come from the page we rendered: cookie + hidden field must match.
    const csrfCookie = readCookie(request, CSRF_COOKIE) ?? "";
    const fetchSite = request.headers.get("sec-fetch-site");
    if (!csrfField || !csrfCookie || !constantTimeEqual(csrfField, csrfCookie) || fetchSite === "cross-site") {
      return new Response("Consent form expired or was not submitted from this site — go back to Claude and retry connecting.", { status: 403 });
    }
    if (!reqInfo?.clientId || !reqInfo.redirectUri) return new Response("Invalid OAuth request", { status: 400 });
    if (!googleConfigured(env)) {
      return consentPage(reqInfo, await clientName(env, reqInfo.clientId), "Google OAuth client is not configured on this server.", false, undefined, enabledScopes(env), requestOrigin(request));
    }
    if (!allowRules(env.ALLOWED_EMAILS).length && !allowListOpen(env)) {
      return consentPage(reqInfo, await clientName(env, reqInfo.clientId), "This server has no ALLOWED_EMAILS allow-list and open sign-in is not enabled — the operator must set one of them.", true, undefined, enabledScopes(env), requestOrigin(request));
    }
    // Re-validate the client still exists (the blob is user-controlled; the
    // provider re-checks redirect_uri in completeAuthorization anyway).
    const client = await env.OAUTH_PROVIDER.lookupClient(reqInfo.clientId).catch(() => null);
    if (!client) return new Response("Unknown OAuth client — retry connecting.", { status: 400 });
    return startGoogleLogin(reqInfo, request, env);
  }

  return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}

/** Google's consent URL for this client: offline access + forced consent so a refresh token is always returned. */
export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string, loginHint?: string, opts: { scopes?: string[]; hostedDomain?: string } = {}): string {
  const auth = new URL(GOOGLE_AUTH_URL);
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", (opts.scopes ?? enabledScopes({})).join(" "));
  if (opts.hostedDomain?.trim()) auth.searchParams.set("hd", opts.hostedDomain.trim());
  auth.searchParams.set("access_type", "offline"); // refresh token
  auth.searchParams.set("prompt", "consent"); // ALWAYS return a refresh_token (Google omits it on repeat consents otherwise)
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", state);
  if (loginHint) auth.searchParams.set("login_hint", loginHint);
  return auth.toString();
}

/** Park the MCP auth request in KV and send the user to Google's consent screen. */
export async function startGoogleLogin(reqInfo: AuthRequest, request: Request, env: AuthEnv): Promise<Response> {
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`gws:authreq:${state}`, JSON.stringify(reqInfo), { expirationTtl: STATE_TTL_SECS });
  return Response.redirect(googleAuthorizeUrl(env.GOOGLE_CLIENT_ID!, callbackUrl(request), state, undefined, { scopes: enabledScopes(env), hostedDomain: env.GOOGLE_HOSTED_DOMAIN }), 302);
}

export function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/callback`;
}

// ---- /callback ----

export async function handleCallback(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const gErr = url.searchParams.get("error");
  const stored = state ? await env.OAUTH_KV.get(`gws:authreq:${state}`) : null;
  if (!stored) return htmlPage("Sign-in expired or invalid", "The login link is no longer valid (10 minute limit) — go back to Claude and retry connecting.", 400);
  await env.OAUTH_KV.delete(`gws:authreq:${state}`);
  const reqInfo = JSON.parse(stored) as AuthRequest;
  if (gErr) return htmlPage("Google sign-in cancelled", `Google returned: ${gErr.slice(0, 200)}. Retry connecting when ready.`, 400);
  if (!code) return htmlPage("Missing code", "Google did not return an authorization code — retry connecting.", 400);
  if (!googleConfigured(env)) return htmlPage("Server not configured", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing.", 500);

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode({ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, code, redirectUri: callbackUrl(request) });
  } catch (err) {
    return htmlPage("Google token exchange failed", `${err instanceof Error ? err.message : String(err)}. Check that the OAuth client's redirect URI is exactly ${callbackUrl(request)}.`, 502);
  }
  if (!tokens.refresh_token) {
    return htmlPage(
      "No refresh token returned",
      "Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and retry connecting (we request access_type=offline&prompt=consent, so this normally never happens).",
      502,
    );
  }

  let info: Awaited<ReturnType<typeof fetchUserInfo>>;
  try {
    info = await fetchUserInfo(tokens.access_token);
  } catch (err) {
    // Nothing will store this refresh token — do not leave a dangling offline grant on the account.
    await revokeGoogleToken(tokens.refresh_token);
    return htmlPage("Could not read account email", `${err instanceof Error ? err.message : String(err)} — retry connecting.`, 502);
  }
  const email = (info.email ?? "").toLowerCase();
  if (!email) {
    await revokeGoogleToken(tokens.refresh_token);
    return htmlPage("Could not read account email", "Google returned no email for this account.", 502);
  }
  if (info.email_verified === false) {
    await revokeGoogleToken(tokens.refresh_token);
    return htmlPage("Account not allowed", `Google reports ${email} as an unverified address; only verified accounts can connect.`, 403);
  }
  if (!accountAllowed(email, env)) {
    // Do not leave a dangling offline grant on the user's Google account.
    await revokeGoogleToken(tokens.refresh_token);
    console.log(JSON.stringify({ evt: "signin_rejected", email, reason: allowRules(env.ALLOWED_EMAILS).length ? "not_in_allow_list" : "no_allow_list" }));
    return htmlPage("Account not allowed", `${email} is not in this server's ALLOWED_EMAILS allow-list.`, 403);
  }

  const requested = enabledScopes(env);
  const grantedScopes = (tokens.scope ?? "").split(" ").filter(Boolean);
  const missing = requested.filter((s) => s !== "openid" && !grantedScopes.includes(s));
  const props: Props = {
    email,
    name: info.name,
    sub: info.sub,
    refreshToken: tokens.refresh_token,
    grantedScopes,
    grantedAt: new Date().toISOString(),
  };
  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: reqInfo,
      userId: email,
      metadata: { email, name: info.name ?? null, missingScopes: missing },
      scope: reqInfo.scope ?? [],
      props,
    });
    console.log(JSON.stringify({ evt: "grant", email, client: reqInfo.clientId, scopes: grantedScopes.length, requested: requested.length, missing: missing.map((m) => m.split("/").pop()) }));
    return Response.redirect(redirectTo, 302);
  } catch (err) {
    // The MCP auth request expired / was tampered with between login start and callback.
    await revokeGoogleToken(tokens.refresh_token);
    return htmlPage("Authorization could not be completed", `${err instanceof Error ? err.message : "unknown error"} — retry connecting from Claude.`, 400);
  }
}

/** Minimal self-contained HTML status page (title and body are escaped). */
export function htmlPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0c0f;color:#e7e9ee}.card{width:min(94vw,460px);background:#15171c;border:1px solid #272a31;border-radius:14px;padding:28px}h1{font-size:18px;margin:0 0 8px}p{color:#9aa0aa;font-size:14px;margin:0}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
  return new Response(html, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

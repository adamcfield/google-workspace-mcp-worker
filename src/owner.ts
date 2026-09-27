/**
 * Bearer deployment: the worker-wide "owner" Google grant.
 *
 * The bearer worker acts as ONE Google account (yours). Its refresh token comes
 * from either:
 *   - the GOOGLE_REFRESH_TOKEN secret (minted elsewhere), or
 *   - a one-time browser login: GET /google/auth?key=<MCP_AUTH_TOKEN> → Google's
 *     consent screen → GET /callback → the refresh token is stored in TOKEN_KV,
 *     AES-GCM-encrypted under a key derived from two secrets the worker holds
 *     (MCP_AUTH_TOKEN + GOOGLE_CLIENT_SECRET), so a KV dump alone is useless.
 *
 * Routes handled here (mounted by src/index.ts):
 *   POST   /google/auth/link   (bearer)  → single-use login link (keeps the bearer secret out of browser history)
 *   GET    /google/auth?key=   (secret or link nonce) → redirect to Google
 *   GET    /callback           (single-use state) → exchange + store
 *   GET    /google/status      (bearer)  → who is connected
 *   DELETE /google/auth        (bearer)  → revoke at Google + forget
 */
import { deriveAesKey, encryptJson, decryptJson, exchangeCode, fetchUserInfo } from "./google/client.js";
import { accountAllowed, allowListOpen, allowRules, constantTimeEqual, escapeHtml, googleAuthorizeUrl, googleConfigured, htmlPage, revokeGoogleToken } from "./auth.js";
import { enabledScopes } from "./google/scopes.js";
import type { AgentEnv, Grant } from "./agent.js";

export type BearerEnv = AgentEnv & { TOKEN_KV?: KVNamespace; MCP_AUTH_TOKEN?: string };

export interface OwnerGrant extends Grant {
  name?: string;
  grantedAt?: string;
}
interface StoredOwner {
  email: string;
  name?: string;
  refreshToken: string;
  grantedScopes: string[];
  grantedAt: string;
}

// Keys are namespaced: this KV namespace may be shared with sibling workers of the same layout.
const OWNER_KEY = "gws:owner:grant";
const LINK_TTL_SECS = 300;
const STATE_TTL_SECS = 600;

/** Bearer check for the MCP endpoints and the owner routes. Fails closed when no secret is configured. */
export function bearerAuthorized(request: Request, env: BearerEnv): boolean {
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header); // RFC 7235: the auth-scheme is case-insensitive
  return !!match && constantTimeEqual(match[1].trim(), env.MCP_AUTH_TOKEN);
}

const keyMaterial = (env: BearerEnv): string | null => (env.MCP_AUTH_TOKEN && env.GOOGLE_CLIENT_SECRET ? `${env.MCP_AUTH_TOKEN}|${env.GOOGLE_CLIENT_SECRET}` : null);
const ownerKey = (env: BearerEnv) => deriveAesKey("gws-owner-grant", keyMaterial(env)!);

export async function loadOwnerGrant(env: BearerEnv): Promise<OwnerGrant | null> {
  if (env.GOOGLE_REFRESH_TOKEN) return { refreshToken: env.GOOGLE_REFRESH_TOKEN, grantedScopes: [], source: "secret" };
  if (!env.TOKEN_KV || !keyMaterial(env)) return null;
  const raw = await env.TOKEN_KV.get(OWNER_KEY);
  if (!raw) return null;
  const rec = await decryptJson<StoredOwner>(await ownerKey(env), raw);
  if (!rec || typeof rec.refreshToken !== "string" || !rec.refreshToken) return null;
  return { email: rec.email, name: rec.name, refreshToken: rec.refreshToken, grantedScopes: rec.grantedScopes ?? [], grantedAt: rec.grantedAt, source: "owner-login" };
}

export async function saveOwnerGrant(env: BearerEnv, rec: StoredOwner): Promise<void> {
  if (!env.TOKEN_KV) throw new Error("TOKEN_KV binding is missing");
  if (!keyMaterial(env)) throw new Error("MCP_AUTH_TOKEN and GOOGLE_CLIENT_SECRET must be set before a grant can be stored");
  await env.TOKEN_KV.put(OWNER_KEY, await encryptJson(await ownerKey(env), rec));
}

export async function clearOwnerGrant(env: BearerEnv): Promise<void> {
  await env.TOKEN_KV?.delete(OWNER_KEY);
}

/** Non-secret view of the owner grant for /google/status and /health. */
export async function ownerStatus(env: BearerEnv): Promise<{ connected: boolean; source?: Grant["source"]; email?: string; name?: string; grantedAt?: string; scopes?: string[]; missingScopes?: string[] }> {
  const g = await loadOwnerGrant(env);
  if (!g) return { connected: false };
  const short = (s: string) => s.replace("https://www.googleapis.com/auth/", "");
  return {
    connected: true,
    source: g.source,
    email: g.email,
    name: g.name,
    grantedAt: g.grantedAt,
    scopes: g.grantedScopes.map(short),
    missingScopes: g.source === "secret" ? undefined : enabledScopes(env).filter((s) => s !== "openid" && !g.grantedScopes.includes(s)).map(short),
  };
}

/** Handle the owner-login routes; returns null for any other path. */
export async function handleOwnerRoutes(request: Request, env: BearerEnv, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const isOwnerPath = p === "/google/auth" || p === "/google/auth/link" || p === "/google/status" || p === "/callback";
  if (!isOwnerPath) return null;
  const unauthorized = () => new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  if (!env.TOKEN_KV) return htmlPage("Not configured", "The TOKEN_KV binding is missing — create it (npx wrangler kv namespace create TOKEN_KV), add it to wrangler.jsonc and redeploy.", 500);
  const kv = env.TOKEN_KV;

  // Mint a single-use, short-lived login link so the long-lived bearer secret never travels in a browser URL.
  if (p === "/google/auth/link" && request.method === "POST") {
    if (!bearerAuthorized(request, env)) return unauthorized();
    const nonce = crypto.randomUUID();
    await kv.put(`gws:auth_link:${nonce}`, "1", { expirationTtl: LINK_TTL_SECS });
    return Response.json({ url: `${url.origin}/google/auth?key=${nonce}`, expires_in: LINK_TTL_SECS, single_use: true });
  }

  if (p === "/google/status" && request.method === "GET") {
    if (!bearerAuthorized(request, env)) return unauthorized();
    return Response.json(await ownerStatus(env));
  }

  if (p === "/google/auth" && request.method === "DELETE") {
    if (!bearerAuthorized(request, env)) return unauthorized();
    const g = await loadOwnerGrant(env);
    if (g?.source === "owner-login") await revokeGoogleToken(g.refreshToken);
    await clearOwnerGrant(env);
    return Response.json({ disconnected: true, revoked: g?.source === "owner-login", note: g?.source === "secret" ? "GOOGLE_REFRESH_TOKEN is a secret — delete it with `npx wrangler secret delete GOOGLE_REFRESH_TOKEN`" : undefined });
  }

  if (p === "/google/auth" && request.method === "GET") {
    // Accepts the bearer secret itself or a single-use nonce from POST /google/auth/link. Fail closed.
    const key = url.searchParams.get("key") ?? "";
    let allowed = !!env.MCP_AUTH_TOKEN && !!key && constantTimeEqual(key, env.MCP_AUTH_TOKEN);
    if (!allowed && key) {
      const nonce = await kv.get(`gws:auth_link:${key}`);
      if (nonce) {
        await kv.delete(`gws:auth_link:${key}`);
        allowed = true;
      }
    }
    if (!allowed) return htmlPage("Unauthorized", "Open this page as /google/auth?key=<MCP_AUTH_TOKEN>, or mint a single-use link with POST /google/auth/link (Bearer auth).", 401);
    if (!googleConfigured(env)) return htmlPage("Not configured", "Set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets first (npx wrangler secret put …).", 500);
    if (!allowRules(env.ALLOWED_EMAILS).length && !allowListOpen(env)) return htmlPage("Not configured", "Set ALLOWED_EMAILS (the Google account(s) allowed to become this worker's owner) — or ALLOW_ANY_GOOGLE_ACCOUNT=\"true\" to opt into open sign-in.", 500);
    const state = crypto.randomUUID();
    await kv.put(`gws:oauth_state:${state}`, "1", { expirationTtl: STATE_TTL_SECS });
    return Response.redirect(googleAuthorizeUrl(env.GOOGLE_CLIENT_ID!, `${url.origin}/callback`, state, undefined, { scopes: enabledScopes(env), hostedDomain: env.GOOGLE_HOSTED_DOMAIN }), 302);
  }

  if (p === "/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    const known = state ? await kv.get(`gws:oauth_state:${state}`) : null;
    if (!known) return htmlPage("Invalid or expired state", "Start over from /google/auth (links expire after 10 minutes).", 400);
    await kv.delete(`gws:oauth_state:${state}`);
    const denied = url.searchParams.get("error");
    if (denied) return htmlPage("Google sign-in cancelled", `Google returned: ${denied.slice(0, 200)}. Nothing was stored — retry via /google/auth.`, 400);
    const code = url.searchParams.get("code");
    if (!code) return htmlPage("Invalid callback", "Missing code parameter.", 400);
    if (!googleConfigured(env)) return htmlPage("Not configured", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing.", 500);

    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode({ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, code, redirectUri: `${url.origin}/callback` });
    } catch (err) {
      return htmlPage("Google token exchange failed", `${err instanceof Error ? err.message : String(err)}. Check that the OAuth client's redirect URIs include ${url.origin}/callback.`, 502);
    }
    if (!tokens.refresh_token) {
      return htmlPage("No refresh token returned", "Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and retry /google/auth.", 502);
    }
    let info: Awaited<ReturnType<typeof fetchUserInfo>>;
    try {
      info = await fetchUserInfo(tokens.access_token);
    } catch (err) {
      await revokeGoogleToken(tokens.refresh_token);
      return htmlPage("Could not read account email", err instanceof Error ? err.message : String(err), 502);
    }
    const email = (info.email ?? "").toLowerCase();
    if (!email || info.email_verified === false || !accountAllowed(email, env)) {
      await revokeGoogleToken(tokens.refresh_token);
      return htmlPage("Account not allowed", email ? `${email} is ${info.email_verified === false ? "not a verified address" : "not in this server's ALLOWED_EMAILS allow-list"}. Nothing was stored.` : "Google returned no email for this account.", 403);
    }
    const grantedScopes = (tokens.scope ?? "").split(" ").filter(Boolean);
    await saveOwnerGrant(env, { email, name: info.name, refreshToken: tokens.refresh_token, grantedScopes, grantedAt: new Date().toISOString() });
    const missing = enabledScopes(env).filter((s) => s !== "openid" && !grantedScopes.includes(s));
    console.log(JSON.stringify({ evt: "owner_login", email, scopes: grantedScopes.length, requested: enabledScopes(env).length, missing: missing.map((m) => m.split("/").pop()) }));
    return htmlPage(
      "Google connected ✓",
      `This worker now acts as ${email} (refresh token stored encrypted in KV; no password kept).${missing.length ? ` Permissions NOT granted: ${missing.map((m) => m.split("/").pop()).join(", ")} — re-run /google/auth and allow everything if you need them.` : ""} You can close this tab.`,
      200,
    );
  }
  return htmlPage("Method not allowed", `${request.method} is not supported on ${escapeHtml(p)}.`, 405);
}

/**
 * Google Workspace MCP — OAuth-gated Cloudflare Worker for claude.ai custom
 * connectors (web, desktop, mobile) and any OAuth-capable MCP client.
 *
 * Same McpAgent + tools as the bearer worker (src/index.ts), but fronted by an
 * OAuth 2.1 provider (@cloudflare/workers-oauth-provider): PKCE, dynamic client
 * registration and the discovery documents claude.ai needs. Google is the
 * upstream identity provider — each user signs in with their own account and
 * the server acts as them; their refresh token lives only in the grant's
 * encrypted props.
 *
 * Routes:
 *   GET  /                          landing page (public)   · GET /health → JSON · GET /privacy → policy (public)
 *   GET/POST /authorize             consent page → Google sign-in (src/auth.ts)
 *   GET  /callback                  Google redirect back → completes the MCP grant
 *   /token · /register · /.well-known/oauth-authorization-server · /.well-known/oauth-protected-resource[/mcp]
 *                                   handled by @cloudflare/workers-oauth-provider
 *   POST /mcp                       MCP Streamable HTTP (OAuth bearer)
 *   GET  /sse                       MCP SSE (legacy clients)
 *
 * Secrets (npx wrangler secret put … -c wrangler.oauth.jsonc): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * Vars: ALLOWED_EMAILS (allow-list), MCP_READONLY ("true" → read tools only)
 * Bindings: OAUTH_KV (KV), MCP_OBJECT (Durable Object → GoogleWorkspaceMCP)
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GoogleWorkspaceMCP, VERSION, type AgentEnv } from "./agent.js";
import { handleAuthorize, handleCallback, googleConfigured, secure, type AuthEnv } from "./auth.js";
import { manifestFor } from "./tools/surface.js";
import { landingHtml } from "./landing.js";
import { privacyResponse } from "./privacy.js";
import { enabledScopes } from "./google/scopes.js";
import { healthBody } from "./health.js";

export { GoogleWorkspaceMCP };

/** Cloudflare Workers Rate Limiting binding (wrangler `ratelimits`); optional so local/dev configs without it still run. */
export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export type Env = AgentEnv & AuthEnv & { AUTH_RATE_LIMIT?: RateLimitBinding };

/** Unauthenticated endpoints an attacker can hammer (consent, Google callback, dynamic registration, token minting). */
const RATE_LIMITED_PATHS = new Set(["/authorize", "/callback", "/register", "/token"]);

/** Per-IP limit on the auth surface; fails open if the binding is missing or errors (availability over strictness here). */
export async function authRateLimited(request: Request, env: { AUTH_RATE_LIMIT?: RateLimitBinding }): Promise<boolean> {
  const path = new URL(request.url).pathname;
  if (!env.AUTH_RATE_LIMIT || !RATE_LIMITED_PATHS.has(path)) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const { success } = await env.AUTH_RATE_LIMIT.limit({ key: `${path}:${ip}` });
    if (!success) console.log(JSON.stringify({ evt: "auth_rate_limited", path }));
    return !success;
  } catch {
    return false;
  }
}

/** Non-API, non-token routes: landing page, privacy policy, consent screen, Google callback. */
export const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Rate limiting happens once, in the default export below (it fronts the provider and this handler).
    if (url.pathname === "/authorize") return secure(await handleAuthorize(request, env));
    if (url.pathname === "/callback") return secure(await handleCallback(request, env));
    if (url.pathname === "/health") return secure(Response.json(healthBody(env, "google-workspace-mcp-oauth", "oauth"), { headers: { "cache-control": "no-store" } }));
    if (url.pathname === "/" && request.method === "GET") {
      return secure(
        new Response(landingHtml({ origin: url.origin, version: VERSION, toolCount: manifestFor(env).length, configured: googleConfigured(env), mode: "oauth", scopes: enabledScopes(env) }), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
    if (url.pathname === "/privacy" && request.method === "GET") return secure(privacyResponse(url.origin, env));
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return secure(new Response("Not found", { status: 404 }));
  },
};

const provider = new OAuthProvider<Env>({
  apiHandlers: {
    "/mcp": GoogleWorkspaceMCP.serve("/mcp") as never,
    "/sse": GoogleWorkspaceMCP.serveSSE("/sse") as never,
  },
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // claude.ai's connector flow: dynamic registration + PKCE S256; discovery at
  // /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource[/mcp],
  // 401s carry WWW-Authenticate: Bearer resource_metadata="…" (RFC 9728).
  accessTokenTTL: 3600,
});

/** Front the provider so its own endpoints (/register, /token) get the per-IP auth rate limit too. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (await authRateLimited(request, env)) return secure(new Response("Too many requests — retry in a minute.", { status: 429, headers: { "retry-after": "60" } }));
    return provider.fetch(request, env, ctx);
  },
};

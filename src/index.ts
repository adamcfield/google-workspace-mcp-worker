/**
 * Google Workspace MCP — BEARER-TOKEN Cloudflare Worker (for Claude Code, scripts,
 * and any MCP client that can send a bearer). claude.ai custom connectors need
 * OAuth instead — deploy src/oauth.ts (wrangler.oauth.jsonc) for that.
 *
 * Access to the MCP endpoints is gated by a shared secret (MCP_AUTH_TOKEN) so a
 * leaked URL is not an open relay to your Google account. The worker acts as ONE
 * Google account: connect it once via GET /google/auth?key=<MCP_AUTH_TOKEN>
 * (Google's own consent screen), or set the GOOGLE_REFRESH_TOKEN secret.
 *
 * Endpoints:
 *   GET  /                      landing page (public)     · GET /health → JSON · GET /privacy → policy (public)
 *   POST /google/auth/link      (bearer) single-use login link
 *   GET  /google/auth?key=…     one-time Google login    · DELETE /google/auth (bearer) → disconnect
 *   GET  /callback              Google redirect back     · GET /google/status (bearer)
 *   POST /mcp                   MCP Streamable HTTP      (bearer required)
 *   GET  /sse                   MCP SSE (legacy)         (bearer required)
 *
 * Secrets (npx wrangler secret put …):
 *   MCP_AUTH_TOKEN         shared secret clients send as `Authorization: Bearer <…>`
 *   GOOGLE_CLIENT_ID       GCP OAuth 2.0 client (Web application) with redirect <origin>/callback
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN   optional — skip the browser login
 * Vars: ALLOWED_EMAILS (which Google account may complete /google/auth), MCP_READONLY
 * Bindings: TOKEN_KV (KV: encrypted owner grant + token cache), MCP_OBJECT (Durable Object)
 */

import { GoogleWorkspaceMCP, VERSION, type AgentEnv } from "./agent.js";
import { googleConfigured, secure } from "./auth.js";
import { bearerAuthorized, handleOwnerRoutes, loadOwnerGrant } from "./owner.js";
import { landingHtml } from "./landing.js";
import { privacyResponse } from "./privacy.js";
import { manifestFor } from "./tools/surface.js";
import { enabledScopes } from "./google/scopes.js";
import { healthBody } from "./health.js";

export { GoogleWorkspaceMCP };

export type Env = AgentEnv & { TOKEN_KV: KVNamespace; MCP_AUTH_TOKEN: string };

/** Is a Google account connected? Cached per isolate for a short while — the answer is on the hot path of every /mcp request. */
const CONNECTED_TTL_MS = 30_000;
let connectedCache: { at: number; value: boolean } | null = null;
export async function ownerConnected(env: Env): Promise<boolean> {
  const now = Date.now();
  if (connectedCache && now - connectedCache.at < CONNECTED_TTL_MS) return connectedCache.value;
  const value = !!(await loadOwnerGrant(env).catch(() => null));
  connectedCache = { at: now, value };
  return value;
}
/** Forget the cached answer (after connect/disconnect). */
export const resetOwnerConnectedCache = (): void => void (connectedCache = null);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return secure(
        new Response(landingHtml({ origin: url.origin, version: VERSION, toolCount: manifestFor(env).length, configured: googleConfigured(env), mode: "bearer", scopes: enabledScopes(env) }), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
    if (url.pathname === "/health") {
      // Warning texts (e.g. "bearer secret is short") are for the operator: only with the bearer.
      const authed = bearerAuthorized(request, env);
      const body = healthBody(env, "google-workspace-mcp", "bearer", { bearerConfigured: !!env.MCP_AUTH_TOKEN, connected: await ownerConnected(env) }, authed);
      const warnings: string[] = [];
      if (!env.MCP_AUTH_TOKEN) warnings.push("MCP_AUTH_TOKEN not set: /mcp is closed");
      else if (env.MCP_AUTH_TOKEN.length < 32) warnings.push("MCP_AUTH_TOKEN is shorter than 32 characters — use `openssl rand -hex 32`");
      const count = Number(body.warningsCount ?? 0) + warnings.length;
      const all = [...((body.warnings as string[] | undefined) ?? []), ...warnings];
      return secure(Response.json({ ...body, warningsCount: count, warnings: authed && all.length ? all : undefined }, { headers: { "cache-control": "no-store" } }));
    }
    if (url.pathname === "/privacy" && request.method === "GET") return secure(privacyResponse(url.origin, env));
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    // One-time owner login + status/disconnect (each route enforces its own gate).
    const owner = await handleOwnerRoutes(request, env, url);
    if (owner) {
      if (url.pathname === "/callback" || (url.pathname === "/google/auth" && request.method === "DELETE")) resetOwnerConnectedCache();
      return owner;
    }

    if (!bearerAuthorized(request, env)) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }

    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/sse/message") {
      // Deployed-but-unconfigured guard: surface the actual problem to the
      // (already authenticated) caller instead of an opaque error inside the DO.
      if (!googleConfigured(env)) {
        return new Response("Google OAuth client not configured. Set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets (npx wrangler secret put …) — see README.", { status: 503 });
      }
      if (!(await ownerConnected(env))) {
        return new Response(`Not connected to a Google account yet. Open ${url.origin}/google/auth?key=<MCP_AUTH_TOKEN> in a browser once (or POST /google/auth/link for a single-use link), or set the GOOGLE_REFRESH_TOKEN secret.`, { status: 503 });
      }
      if (url.pathname === "/mcp") return GoogleWorkspaceMCP.serve("/mcp").fetch(request, env, ctx);
      return GoogleWorkspaceMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};

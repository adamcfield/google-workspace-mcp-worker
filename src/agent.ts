/**
 * The MCP agent shared by BOTH deployments (identical tool surface):
 *
 *   src/oauth.ts  — claude.ai custom connector. The signed-in user's Google
 *                   refresh token arrives in the OAuth grant's ENCRYPTED props
 *                   (one grant per user; the provider decrypts them per request).
 *   src/index.ts  — bearer-token worker for Claude Code / scripts / other MCP
 *                   clients. One worker-wide "owner" grant: the encrypted record
 *                   written to TOKEN_KV by the one-time GET /google/auth login,
 *                   or the GOOGLE_REFRESH_TOKEN secret.
 *
 * Each MCP session is a Durable Object instance of this class.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleClient, kvTokenStore } from "./google/client.js";
import { registerTools, MCP_INSTRUCTIONS } from "./tools/index.js";
import { RateLimiter } from "./tools/_shared.js";
import { loadOwnerGrant } from "./owner.js";
import { googleConfigured, type Props } from "./auth.js";
import { enabledScopes } from "./google/scopes.js";
import type { PrivacyEnv } from "./privacy.js";
import type { SurfaceConfig } from "./tools/surface.js";
import { jevRuntime } from "./routing/runtime.js";

export { VERSION } from "./version.js";
import { VERSION } from "./version.js";

/** Default per-session tool-call budget (calls per minute). Override with TOOL_RATE_LIMIT_PER_MIN. */
export const DEFAULT_TOOL_RATE_LIMIT_PER_MIN = 120;

/** Parse TOOL_RATE_LIMIT_PER_MIN ("0" disables the limiter). */
export function toolRateLimit(env: { TOOL_RATE_LIMIT_PER_MIN?: string }): number {
  const raw = (env.TOOL_RATE_LIMIT_PER_MIN ?? "").trim();
  if (!raw) return DEFAULT_TOOL_RATE_LIMIT_PER_MIN; // present-but-blank must not mean "unlimited"
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TOOL_RATE_LIMIT_PER_MIN;
}

/**
 * Bindings/secrets either deployment may provide (each wrangler config binds its subset).
 * `SurfaceConfig` (which extends `GroupConfig`) owns the vars the tool registry itself reads —
 * ENABLED/DISABLED_TOOL_GROUPS, MCP_READONLY, TOOL_SURFACE, TOOL_SURFACE_ADD — so `this.env`
 * type-checks against what `registerTools` consumes instead of relying on optional fields.
 */
export interface AgentEnv extends SurfaceConfig, PrivacyEnv {
  MCP_OBJECT: DurableObjectNamespace;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Comma-separated emails / @domains allowed to sign in ("" = nobody unless ALLOW_ANY_GOOGLE_ACCOUNT="true"). */
  ALLOWED_EMAILS?: string;
  /** "true" → an empty ALLOWED_EMAILS admits any Google account (opt-in fail-open). */
  ALLOW_ANY_GOOGLE_ACCOUNT?: string;
  /** Optional Workspace domain pre-selected on Google's account chooser (hd). */
  GOOGLE_HOSTED_DOMAIN?: string;
  /** Tool calls per minute per MCP session (default 120; "0" = unlimited). */
  TOOL_RATE_LIMIT_PER_MIN?: string;
  /** OAuth (claude.ai connector) deployment: provider state + encrypted token cache. */
  OAUTH_KV?: KVNamespace;
  /** Bearer deployment: encrypted owner grant + encrypted token cache. */
  TOKEN_KV?: KVNamespace;
  /** Bearer deployment: shared secret clients send as `Authorization: Bearer …`. */
  MCP_AUTH_TOKEN?: string;
  /** Bearer deployment (optional): a refresh token minted elsewhere, instead of the /google/auth login. */
  GOOGLE_REFRESH_TOKEN?: string;
  // JEV_ENABLED / TYPESAFE_* come from SurfaceConfig (which extends JevConfig): QA plumbing for
  // the model-backed selection path, off unless JEV_ENABLED is exactly "true". TYPESAFE_API_KEY
  // is a Worker secret and is read in exactly one place (routing/runtime.ts).
}

/** A usable Google credential resolved for this session. */
export interface Grant {
  email?: string;
  refreshToken: string;
  grantedScopes: string[];
  source: "oauth-grant" | "owner-login" | "secret";
}

export class GoogleWorkspaceMCP extends McpAgent<AgentEnv, unknown, Props> {
  server = new McpServer({ name: "google-workspace", version: VERSION }, { instructions: MCP_INSTRUCTIONS });

  async init(): Promise<void> {
    const props = this.props as Props | undefined;
    const readOnly = this.env.MCP_READONLY === "true";
    const grant: Grant | null = props?.refreshToken
      ? { email: props.email, refreshToken: props.refreshToken, grantedScopes: props.grantedScopes ?? [], source: "oauth-grant" }
      : await loadOwnerGrant(this.env);

    // A session without a usable Google credential must not 500 — register one
    // explanatory tool instead so the client sees what to do.
    if (!googleConfigured(this.env) || !grant) {
      const text = !googleConfigured(this.env)
        ? "Server is missing the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets (npx wrangler secret put …)."
        : props
          ? "No Google refresh token for this grant. Reconnect the connector (Claude → Settings → Connectors → remove → add again)."
          : "This bearer deployment is not connected to a Google account yet: open GET /google/auth?key=<MCP_AUTH_TOKEN> in a browser once (or set the GOOGLE_REFRESH_TOKEN secret).";
      this.server.registerTool(
        "google_reauthorize_required",
        {
          description: "This connection has no usable Google credentials. " + text,
          inputSchema: {},
          annotations: { title: "Re-authorize required", readOnlyHint: true, openWorldHint: false },
        },
        async () => ({ content: [{ type: "text", text }], isError: true }),
      );
      return;
    }

    // Shared, encrypted access-token cache: every MCP session is its own Durable
    // Object; without it each session would mint its own Google token.
    const cacheKv = this.env.OAUTH_KV ?? this.env.TOKEN_KV;
    const g = new GoogleClient({
      clientId: this.env.GOOGLE_CLIENT_ID!,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET!,
      refreshToken: grant.refreshToken,
      tokenStore: cacheKv ? kvTokenStore(cacheKv, grant.refreshToken) : undefined,
    });
    const limit = toolRateLimit(this.env);
    registerTools(
      this.server,
      { g, readOnly, email: grant.email, grantedScopes: grant.grantedScopes, limiter: limit > 0 ? new RateLimiter(limit) : undefined, requestedScopes: enabledScopes(this.env), client: () => this.server.server.getClientVersion()?.name, jev: jevRuntime(this.env) },
      this.env,
    );
  }
}

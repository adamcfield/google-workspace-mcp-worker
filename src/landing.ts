/** Public landing page for either deployment. */
import { SCOPES, REQUIRED_APIS, groupKey } from "./google/scopes.js";
import { escapeHtml } from "./auth.js";

export interface LandingOptions {
  origin: string;
  version: string;
  toolCount: number;
  configured: boolean;
  mode: "oauth" | "bearer";
  /** Scopes this deployment requests (least privilege); default all. */
  scopes?: string[];
}

export function landingHtml({ origin, version, toolCount, configured, mode, scopes }: LandingOptions): string {
  const o = escapeHtml(origin);
  const wanted = new Set(scopes ?? SCOPES.map((s) => s.scope));
  const shown = SCOPES.filter((s) => wanted.has(s.scope));
  const groupsOn = new Set(shown.map((s) => groupKey(s.group)));
  const scopeRows = shown.map((s) => `<tr><td>${escapeHtml(s.group)}</td><td><code>${escapeHtml(s.scope)}</code></td><td>${escapeHtml(s.why)}</td></tr>`).join("");
  const apis = REQUIRED_APIS.filter((a) => groupsOn.has(groupKey(a.group))).map((a) => `<li>${escapeHtml(a.api)} <code>${escapeHtml(a.service)}</code></li>`).join("");
  const connect =
    mode === "oauth"
      ? `<h2>Connect from Claude (web, desktop, mobile)</h2>
  <ol>
    <li>Claude → Settings → Connectors → <b>Add custom connector</b></li>
    <li>Name: <code>Google Workspace</code> · Remote MCP server URL: <code>${o}/mcp</code> (leave OAuth client id/secret empty — this server supports dynamic registration)</li>
    <li>Click <b>Connect</b> → approve on this server's consent page → Google account chooser → allow the permissions below.</li>
  </ol>
  <p>Claude Code: <code>claude mcp add --transport http google-workspace ${o}/mcp</code> (same OAuth flow).</p>
  <h2>Endpoints</h2>
  <ul>
    <li><code>POST ${o}/mcp</code> — MCP Streamable HTTP (OAuth bearer) · <code>GET ${o}/sse</code> — legacy SSE</li>
    <li><code>${o}/.well-known/oauth-authorization-server</code> · <code>${o}/.well-known/oauth-protected-resource</code> (+<code>/mcp</code>) · <code>/register</code> · <code>/authorize</code> · <code>/token</code> · <code>/callback</code></li>
    <li><code>GET ${o}/health</code> — JSON health</li>
  </ul>`
      : `<h2>Bearer-token deployment</h2>
  <p>This worker acts as one Google account and is gated by the <code>MCP_AUTH_TOKEN</code> secret (no OAuth server — for claude.ai custom connectors deploy <code>wrangler.oauth.jsonc</code> instead).</p>
  <ol>
    <li>Connect the Google account once: open <code>${o}/google/auth?key=&lt;MCP_AUTH_TOKEN&gt;</code> (or mint a single-use link: <code>POST ${o}/google/auth/link</code> with <code>Authorization: Bearer</code>) → Google consent → done. Check with <code>GET ${o}/google/status</code>.</li>
    <li>Point any MCP client at <code>${o}/mcp</code> with header <code>Authorization: Bearer &lt;MCP_AUTH_TOKEN&gt;</code>, e.g. Claude Code: <code>claude mcp add --transport http google-workspace ${o}/mcp --header "Authorization: Bearer &lt;token&gt;"</code></li>
  </ol>
  <h2>Endpoints</h2>
  <ul>
    <li><code>POST ${o}/mcp</code> — MCP Streamable HTTP (bearer) · <code>GET ${o}/sse</code> — legacy SSE (bearer)</li>
    <li><code>GET ${o}/google/auth?key=</code> · <code>POST ${o}/google/auth/link</code> · <code>GET ${o}/google/status</code> · <code>DELETE ${o}/google/auth</code> · <code>GET ${o}/callback</code></li>
    <li><code>GET ${o}/health</code> — JSON health</li>
  </ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Google Workspace MCP${mode === "bearer" ? " (bearer)" : ""}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, -apple-system, sans-serif; margin: 0; background: #0b0c0f; color: #e7e9ee; }
  main { max-width: 900px; margin: 0 auto; padding: 40px 20px 60px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; }
  p, li, td { color: #c2c7d0; } code { background: #15171c; border: 1px solid #272a31; border-radius: 6px; padding: 1px 6px; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } td { border-top: 1px solid #272a31; padding: 6px 8px; vertical-align: top; }
  .ok { color: #69db7c; } .warn { color: #ffa94d; }
  ol li { margin: 4px 0; }
</style></head>
<body><main>
  <h1>Google Workspace MCP <small style="font-size:13px;color:#6b7280">v${escapeHtml(version)} · ${mode === "oauth" ? "OAuth connector" : "bearer"} deployment</small></h1>
  <p>Remote MCP server (Streamable HTTP) giving an MCP client full read/write access to a Google account — Sheets, Drive, Docs, Gmail, Calendar, Tasks, Contacts, Chat, Slides, Forms, Photos, YouTube and Meet — via Google's own OAuth consent. ${toolCount} tools.</p>
  <p>Status: ${configured ? '<span class="ok">Google OAuth client configured</span>' : '<span class="warn">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — run <code>npx wrangler secret put …</code></span>'}</p>
  ${connect}
  <h2>Google scopes requested</h2>
  <table>${scopeRows}</table>
  <h2>APIs that must be enabled in the GCP project</h2>
  <ul>${apis}</ul>
  <p style="margin-top:32px;color:#6b7280;font-size:13px"><a href="${o}/privacy" style="color:#9aa0aa">Privacy policy</a> · Source: <a href="https://github.com/adamcfield/google-workspace-mcp-worker" style="color:#9aa0aa">github.com/adamcfield/google-workspace-mcp-worker</a></p>
</main></body></html>`;
}

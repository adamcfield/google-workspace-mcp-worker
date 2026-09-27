#!/usr/bin/env node
/**
 * Obtain an MCP access token for a deployed worker WITHOUT Claude — runs the
 * same OAuth 2.1 flow Claude's custom connector runs (dynamic registration +
 * PKCE), opening your browser for the consent + Google sign-in.
 *
 *   node scripts/login.mjs https://google-workspace-mcp.<sub>.workers.dev
 *
 * Writes .mcp-token.local (gitignored) which scripts/smoke.mjs picks up.
 * Use it for `node scripts/smoke.mjs <origin> --e2e` or with any MCP client
 * that accepts a bearer (e.g. `claude mcp add --transport http gws <origin>/mcp --header "Authorization: Bearer <token>"`).
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const ORIGIN = (process.argv[2] ?? process.env.MCP_URL ?? "").replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
if (!ORIGIN) {
  console.error("Usage: node scripts/login.mjs <worker origin>");
  process.exit(2);
}
const PORT = Number(process.env.LOGIN_PORT ?? 8976);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

const reg = await fetch(`${ORIGIN}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "gws-mcp-cli", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
});
const client = await reg.json();
if (!client.client_id) {
  console.error("Client registration failed:", client);
  process.exit(1);
}

const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(16).toString("hex");
const authUrl = `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (u.searchParams.get("state") !== state) {
      res.writeHead(400).end("state mismatch");
      reject(new Error("state mismatch"));
      return;
    }
    const err = u.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html" }).end(err ? `<h2>Failed: ${err}</h2>` : "<h2>Signed in — you can close this tab.</h2>");
    server.close();
    err ? reject(new Error(err)) : resolve(u.searchParams.get("code"));
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log("Open this URL in your browser (it may open automatically):\n\n  " + authUrl + "\n");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${opener} "${authUrl}"`, () => {});
  });
});

const tokenRes = await fetch(`${ORIGIN}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }).toString(),
});
const tok = await tokenRes.json();
if (!tok.access_token) {
  console.error("Token exchange failed:", tok);
  process.exit(1);
}
fs.writeFileSync(
  ".mcp-token.local",
  JSON.stringify({ origin: ORIGIN, client_id: client.client_id, access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 }, null, 2),
);
console.log(`Saved .mcp-token.local (access token valid ~${Math.round((tok.expires_in ?? 3600) / 60)} min).\nNext: node scripts/smoke.mjs ${ORIGIN} --e2e   (set E2E_SPREADSHEET_ID)`);

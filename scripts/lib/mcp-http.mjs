/**
 * Minimal MCP client over Streamable HTTP for scripts (smoke, benchmark fixtures, harness).
 * Same wire shape scripts/smoke.mjs uses: JSON-RPC POST /mcp with a bearer, SSE-or-JSON
 * responses, mcp-session-id carried across calls. No SDK, no Google credentials here.
 */

/** Parses a JSON or `data:` SSE body into the JSON-RPC message (null when neither). */
export function parseRpcBody(text) {
  const line = (text || "").split("\n").find((x) => x.startsWith("data:"));
  try {
    return JSON.parse(line ? line.slice(5).trim() : text);
  } catch {
    return null;
  }
}

/**
 * @param {{ origin: string, token: string, clientName?: string, clientVersion?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createMcpHttpClient(opts) {
  const origin = String(opts.origin).replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let sessionId = null;
  let nextId = 1;

  async function rpc(body) {
    const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetchImpl(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    return { status: res.status, body: parseRpcBody(text), text };
  }

  return {
    origin,
    get sessionId() {
      return sessionId;
    },
    /** initialize + notifications/initialized; returns serverInfo. */
    async initialize() {
      const init = await rpc({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: opts.clientName ?? "gws-script", version: opts.clientVersion ?? "0" } } });
      if (init.status !== 200 || !init.body?.result) throw new Error(`initialize failed: HTTP ${init.status} ${init.text.slice(0, 200)}`);
      await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
      return init.body.result;
    },
    /** tools/list → the tools array as the server emits it. */
    async listTools() {
      const r = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/list" });
      if (r.status !== 200 || !r.body?.result) throw new Error(`tools/list failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return r.body.result.tools ?? [];
    },
    /**
     * tools/call → { ok, isError, text, data, bytes, ms }. `ok` = HTTP 200 and no protocol error and
     * not a tool error; `data` is the parsed JSON text when it parses, else the raw text.
     */
    async callTool(name, args = {}) {
      const t0 = Date.now();
      const r = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
      const ms = Date.now() - t0;
      const text = r.body?.result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? (r.body?.error ? JSON.stringify(r.body.error) : r.text);
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const isError = !!r.body?.result?.isError || !!r.body?.error || r.status !== 200;
      return { ok: !isError, isError, text, data, bytes: Buffer.byteLength(text, "utf8"), ms, status: r.status };
    },
  };
}

/** Names of tools the server marks read-only (annotations.readOnlyHint === true). */
export function readOnlyToolNames(tools) {
  return new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
}

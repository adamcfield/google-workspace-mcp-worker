/** Regression tests for the deep code-review findings fixed in 1.4.1. */
import { describe, it, expect, vi } from "vitest";
import { GoogleClient, GoogleApiError } from "../src/google/client.js";
import { accountAllowed, allowListOpen, allowRules, handleCallback, type AuthEnv } from "../src/auth.js";
import { htmlToText, multipartRelated } from "../src/tools/_shared.js";
import { toolRateLimit } from "../src/agent.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { describeRequests, type SheetMeta } from "../src/tools/sheets-verify.js";
import { healthBody } from "../src/health.js";
import { moveToFolder, driveTextQuery } from "../src/tools/_drive.js";
import worker, { ownerConnected, resetOwnerConnectedCache } from "../src/index.js";
import { saveOwnerGrant } from "../src/owner.js";

vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => new Response("mcp-served") };
    }
    static serveSSE() {
      return { fetch: async () => new Response("sse-served") };
    }
  },
}));

const byName = (n: string) => ALL_TOOLS.find((t) => t.name === n)!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [], email: "u@x.y" });
const tokenOk = () => Response.json({ access_token: "at", expires_in: 3600 });

function client(route: (url: string, init?: RequestInit) => Promise<Response> | Response, opts: Partial<ConstructorParameters<typeof GoogleClient>[0]> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return tokenOk();
    calls.push({ url: String(url), init });
    return route(String(url), init);
  };
  return { g: new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as never, maxRetries: 2, ...opts }), calls };
}
const timeoutErr = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });

describe("retry safety (no duplicate sends)", () => {
  it("does not re-send a POST after a timeout or a 5xx, but does after 429/408", async () => {
    const t = client(() => {
      throw timeoutErr();
    });
    await expect(t.g.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw: "x" })).rejects.toBeInstanceOf(GoogleApiError);
    expect(t.calls).toHaveLength(1);
    const five = client(() => new Response("{}", { status: 503 }));
    await expect(five.g.post("https://www.googleapis.com/calendar/v3/calendars/primary/events", { summary: "x" })).rejects.toMatchObject({ status: 503 });
    expect(five.calls).toHaveLength(1);
    let n = 0;
    const rate = client(() => (++n === 1 ? new Response("{}", { status: 429 }) : Response.json({ ok: true })));
    expect(await rate.g.post("https://sheets.googleapis.com/v4/spreadsheets/x/values/A1:append", {})).toEqual({ ok: true });
    expect(rate.calls).toHaveLength(2);
  });
  it("retries GET and idempotent POSTs on 5xx/timeouts as before", async () => {
    let n = 0;
    const get = client(() => (++n === 1 ? new Response("{}", { status: 502 }) : Response.json({ ok: 1 })));
    expect(await get.g.get("https://www.googleapis.com/drive/v3/about")).toEqual({ ok: 1 });
    expect(get.calls).toHaveLength(2);
    let m = 0;
    const search = client(() => {
      if (++m === 1) throw timeoutErr();
      return Response.json({ mediaItems: [] });
    });
    expect(await search.g.post("https://photoslibrary.googleapis.com/v1/mediaItems:search", {}, undefined, { idempotent: true })).toEqual({ mediaItems: [] });
    expect(search.calls).toHaveLength(2);
  });
  it("passes the redirect policy through", async () => {
    const t = client(() => new Response("x"));
    await t.g.request("GET", "https://lh3.googleusercontent.com/abc=d", { responseType: "response", redirect: "manual" });
    expect(t.calls[0].init?.redirect).toBe("manual");
  });
});

describe("token refresh hardening", () => {
  it("a forced refresh does not adopt a concurrent non-forced lookup that returns the stale cached token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = { get: async () => (await gate, { token: "stale", expiry: Date.now() + 3600_000 }), set: async () => {}, clear: async () => {} };
    let mints = 0;
    const fetchImpl = async (url: string) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        mints++;
        return Response.json({ access_token: `fresh${mints}`, expires_in: 3600 });
      }
      return new Response("x");
    };
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as never, tokenStore: store });
    const first = g.getAccessToken(false); // reads the (stale) shared cache
    const forced = g.getAccessToken(true); // must mint, not wait for the stale answer
    release();
    expect(await first).toBe("stale");
    expect(await forced).toBe("fresh1");
    expect(mints).toBe(1);
  });
  it("tokenInfo refreshes once on invalid_token and is bounded by a timeout signal", async () => {
    let n = 0;
    let sawSignal = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: `at${++n}`, expires_in: 3600 });
      sawSignal = init?.signal instanceof AbortSignal;
      return String(url).includes("access_token=at1") ? Response.json({ error: "invalid_token" }, { status: 400 }) : Response.json({ email: "u@x.y", scope: "a b", expires_in: "100" });
    };
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as never });
    expect(await g.tokenInfo()).toEqual({ email: "u@x.y", scopes: ["a", "b"], expiresIn: 100 });
    expect(sawSignal).toBe(true);
    expect(n).toBe(2);
  });
});

describe("allow-list made only of separators", () => {
  it("counts as no list (fail closed / explicit open), and health reports unset", () => {
    expect(allowRules(",")).toEqual([]);
    expect(allowRules(" , ,\n")).toEqual([]);
    expect(accountAllowed("a@b.c", { ALLOWED_EMAILS: "," })).toBe(false);
    expect(accountAllowed("a@b.c", { ALLOWED_EMAILS: ", ", ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(true);
    expect(allowListOpen({ ALLOWED_EMAILS: ",", ALLOW_ANY_GOOGLE_ACCOUNT: "true" })).toBe(true);
    const h = healthBody({ MCP_OBJECT: {} as never, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", ALLOWED_EMAILS: " , " }, "n", "oauth");
    expect(h.allowList).toBe("unset");
  });
});

describe("hostile HTML entities", () => {
  it("never throws on out-of-range numeric entities", () => {
    expect(htmlToText("a &#99999999; b &#x110000; c &#xD800; d &#65; e &#x1F600;")).toBe("a &#99999999; b &#x110000; c &#xD800; d A e 😀");
  });
});

describe("blank TOOL_RATE_LIMIT_PER_MIN", () => {
  it("keeps the default instead of disabling the limiter", () => {
    expect(toolRateLimit({ TOOL_RATE_LIMIT_PER_MIN: "" })).toBe(120);
    expect(toolRateLimit({ TOOL_RATE_LIMIT_PER_MIN: "  " })).toBe(120);
    expect(toolRateLimit({ TOOL_RATE_LIMIT_PER_MIN: "0" })).toBe(0);
  });
});

describe("google_api_request deny-list coverage", () => {
  it("covers Drive v2, the Gmail upload send variant, calendar clear/delete, and ignores query strings / trailing slashes", async () => {
    const t = byName("google_api_request");
    const g: any = { request: async () => ({ ok: 1 }) };
    for (const [method, url] of [
      ["DELETE", "https://www.googleapis.com/drive/v2/files/abc"],
      ["DELETE", "https://www.googleapis.com/drive/v3/files/abc/"],
      ["DELETE", "https://www.googleapis.com/drive/v3/files/abc?supportsAllDrives=true"],
      ["DELETE", "https://www.googleapis.com/drive/v2/files/trash"],
      ["POST", "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send"],
      ["POST", "https://www.googleapis.com/calendar/v3/calendars/primary/clear"],
      ["DELETE", "https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com"],
    ] as const) {
      await expect(t.handler({ method, url, body: method === "POST" ? {} : undefined, response_type: "json", confirm: true }, ctx(g)), `${method} ${url}`).rejects.toThrow(/not allowed through google_api_request/);
    }
    // Listing a calendar's events or getting a file stays allowed.
    await t.handler({ method: "GET", url: "https://www.googleapis.com/calendar/v3/calendars/primary", response_type: "json", confirm: false }, ctx(g));
  });
});

describe("callback revokes when userinfo fails", () => {
  it("does not leave a dangling offline grant", async () => {
    const kv = new Map<string, string>([["gws:authreq:st", JSON.stringify({ clientId: "cid", redirectUri: "https://claude.ai/cb", scope: [] })]]);
    const env: AuthEnv = {
      OAUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async () => {}, delete: async (k: string) => void kv.delete(k) } as never,
      OAUTH_PROVIDER: { lookupClient: async () => ({ clientId: "cid" }), completeAuthorization: async () => ({ redirectTo: "x" }) } as never,
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gsecret",
      ALLOWED_EMAILS: "@x.y",
    };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      calls.push(`${init?.method ?? "GET"} ${u}${init?.body ? ` ${init.body}` : ""}`);
      if (u.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", refresh_token: "rt-dangling", scope: "openid" });
      if (u.includes("userinfo")) return new Response("upstream down", { status: 503 });
      return new Response("ok");
    });
    try {
      const res = await handleCallback(new Request("https://o.test/callback?state=st&code=c"), env);
      expect(res.status).toBe(502);
      expect(calls.some((c) => c.includes("/revoke") && c.includes("rt-dangling"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("sheets_batch_update_spreadsheet verification covers the whole updateCells block", () => {
  const meta: SheetMeta = { titles: new Map([[0, "S"]]), ids: new Map([["S", 0]]), grids: new Map([[0, { rowCount: 100, columnCount: 26 }]]), namedRanges: [] };
  it("describes start+rows as the full written range", () => {
    const [p] = describeRequests([{ updateCells: { start: { sheetId: 0, rowIndex: 9, columnIndex: 1 }, rows: [{ values: [{}, {}, {}] }, { values: [{}, {}] }, { values: [{}, {}, {}] }], fields: "userEnteredValue" } }], meta);
    expect(p.range).toBe("S!B10:D12");
    expect(p.cells).toBe(8);
    expect(p.warning).toBe("overwrites values");
  });
});

describe("gmail_download_attachment asks for the size before downloading", () => {
  it("refuses an oversized attachment with a single metadata call", async () => {
    const calls: any[] = [];
    const g: any = { get: async (url: string, params: any) => (calls.push({ url, params }), params?.fields === "size" ? { size: 25_000_000 } : { size: 25_000_000, data: "AAAA" }) };
    await expect(byName("gmail_download_attachment").handler({ message_id: "m", attachment_id: "a", as: "text", max_bytes: 1_000_000, max_chars: 1000 }, ctx(g))).rejects.toThrow(/25000000 bytes/);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ fields: "size" });
  });
});

describe("photos_download_media_item host allow-list", () => {
  it("rejects arbitrary googleusercontent hosts, accepts Photos hosts, refuses redirects", async () => {
    const t = byName("photos_download_media_item");
    const seen: any[] = [];
    const g: any = { request: async (_m: string, url: string, opts: any) => (seen.push({ url, opts }), new Response(new Uint8Array([1, 2, 3]), { status: opts.redirect === "manual" && url.includes("redirect-me") ? 302 : 200, headers: { "content-type": "image/jpeg" } })) };
    await expect(t.handler({ media_base_url: "https://evil-dot-region.notebooks.googleusercontent.com/x", max_bytes: 1000, as: "base64" }, ctx(g))).rejects.toThrow(/must be a Photos baseUrl/);
    await expect(t.handler({ media_base_url: "http://lh3.googleusercontent.com/x", max_bytes: 1000, as: "base64" }, ctx(g))).rejects.toThrow(/must be a Photos baseUrl/);
    expect(seen).toHaveLength(0);
    const ok: any = await t.handler({ media_base_url: "https://lh3.googleusercontent.com/abc", max_bytes: 1000, as: "base64" }, ctx(g));
    expect(ok.bytes).toBe(3);
    expect(seen[0].opts.redirect).toBe("manual");
    await expect(t.handler({ media_base_url: "https://lh3.googleusercontent.com/redirect-me", max_bytes: 1000, as: "base64" }, ctx(g))).rejects.toThrow(/redirect/);
  });
});

describe("bearer worker /health and hot-path grant probe", () => {
  function env() {
    const store = new Map<string, string>();
    let gets = 0;
    const e: any = {
      MCP_OBJECT: {},
      TOKEN_KV: { get: async (k: string) => (gets++, store.get(k) ?? null), put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) },
      MCP_AUTH_TOKEN: "short",
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gsecret",
      ALLOWED_EMAILS: "a@b.c",
    };
    return { e, store, gets: () => gets };
  }
  it("withholds warning texts from unauthenticated callers and stores grants under a namespaced key", async () => {
    const { e, store } = env();
    resetOwnerConnectedCache();
    await saveOwnerGrant(e, { email: "a@b.c", refreshToken: "RT", grantedScopes: [], grantedAt: "2026-09-18T00:00:00Z" });
    expect([...store.keys()]).toEqual(["gws:owner:grant"]);
    const pub: any = await (await worker.fetch(new Request("https://w.test/health"), e, {} as ExecutionContext)).json();
    expect(pub.warnings).toBeUndefined();
    expect(pub.warningsCount).toBeGreaterThanOrEqual(1);
    expect(pub.connected).toBe(true);
    const priv: any = await (await worker.fetch(new Request("https://w.test/health", { headers: { authorization: "Bearer short" } }), e, {} as ExecutionContext)).json();
    expect(priv.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/shorter than 32/)]));
  });
  it("caches the connected probe and resets on demand", async () => {
    const { e, gets } = env();
    resetOwnerConnectedCache();
    expect(await ownerConnected(e)).toBe(false);
    expect(await ownerConnected(e)).toBe(false);
    expect(gets()).toBe(1);
    resetOwnerConnectedCache();
    await ownerConnected(e);
    expect(gets()).toBe(2);
  });
});

describe("shared Drive helpers", () => {
  it("moveToFolder replaces every other parent and multipartRelated builds a consistent body", async () => {
    const calls: any[] = [];
    const g: any = {
      get: async () => ({ id: "f", parents: ["old1", "old2", "dest"] }),
      patch: async (url: string, _b: unknown, q: any) => (calls.push(q), { id: "f", name: "n", parents: ["dest"] }),
    };
    expect(await moveToFolder(g, "f", "dest")).toEqual({ id: "f", name: "n", parents: ["dest"] });
    expect(calls[0]).toMatchObject({ addParents: "dest", removeParents: "old1,old2" });
    expect(driveTextQuery("Q3 report")).toBe("(name contains 'Q3 report' or fullText contains 'Q3 report')");
    expect(driveTextQuery("name contains 'x' and trashed = false")).toBe("(name contains 'x' and trashed = false)");
    const { body, contentType } = multipartRelated({ name: "a.txt" }, "text/plain", new TextEncoder().encode("hi"));
    const boundary = /boundary=(.+)$/.exec(contentType)![1];
    const text = new TextDecoder().decode(body);
    expect(text).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.txt"}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--`);
  });
});

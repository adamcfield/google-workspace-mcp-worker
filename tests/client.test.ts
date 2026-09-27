import { describe, it, expect, vi } from "vitest";
import { GoogleClient, GoogleApiError, GoogleAuthError, ResponseTooLargeError, formatBytes, kvTokenStore, withQuery, parseGoogleError } from "../src/google/client.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
    _store: store,
  } as unknown as KVNamespace;
}

describe("withQuery", () => {
  it("skips undefined/null and repeats arrays", () => {
    const u = withQuery("https://x.test/a", { a: 1, b: undefined, c: null, d: ["x", "y"], e: true });
    expect(u).toBe("https://x.test/a?a=1&d=x&d=y&e=true");
  });
});

describe("parseGoogleError", () => {
  it("reads the REST envelope", () => {
    expect(parseGoogleError(JSON.stringify({ error: { code: 403, message: "nope", errors: [{ reason: "insufficientPermissions" }] } }))).toEqual({ message: "nope", reason: "insufficientPermissions" });
  });
  it("reads the OAuth shape and plain text", () => {
    expect(parseGoogleError(JSON.stringify({ error: "invalid_grant", error_description: "Bad" }))).toEqual({ message: "Bad", reason: "invalid_grant" });
    expect(parseGoogleError("boom")).toEqual({ message: "boom" });
  });
});

describe("GoogleClient token handling", () => {
  it("mints once, caches, and sends the bearer", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return json({ access_token: "AT1", expires_in: 3600 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer AT1");
      return json({ ok: 1 });
    });
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any });
    expect(await g.get("https://sheets.googleapis.com/v4/x")).toEqual({ ok: 1 });
    expect(await g.get("https://sheets.googleapis.com/v4/y")).toEqual({ ok: 1 });
    expect(calls.filter((c) => c.includes("oauth2")).length).toBe(1);
  });

  it("maps invalid_grant to GoogleAuthError", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any });
    await expect(g.get("https://x.googleapis.com/")).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it("refreshes once on 401 and retries the request", async () => {
    let tokenN = 0;
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return json({ access_token: `AT${++tokenN}`, expires_in: 3600 });
      apiCalls++;
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth === "Bearer AT1") return json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401);
      return json({ fine: true });
    });
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any });
    expect(await g.get("https://x.googleapis.com/")).toEqual({ fine: true });
    expect(tokenN).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it("retries 503 with backoff then succeeds; does not retry 400", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2")) return json({ access_token: "AT", expires_in: 3600 });
      n++;
      return n < 3 ? json({ error: { message: "backend" } }, 503, { "retry-after": "0" }) : json({ n });
    });
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any, maxRetries: 3 });
    expect(await g.get("https://x.googleapis.com/")).toEqual({ n: 3 });

    const bad = vi.fn(async (url: string) => (url.includes("oauth2") ? json({ access_token: "AT", expires_in: 3600 }) : json({ error: { code: 400, message: "Invalid range", status: "INVALID_ARGUMENT" } }, 400)));
    const g2 = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: bad as any });
    const err = (await g2.get("https://x.googleapis.com/").catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(400);
    expect(err.reason).toBe("INVALID_ARGUMENT");
    expect(bad.mock.calls.filter(([u]) => !String(u).includes("oauth2")).length).toBe(1);
  });

  it("refreshes and retries once on 401 even for noRetry (upload) requests", async () => {
    let tokenN = 0;
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return json({ access_token: `AT${++tokenN}`, expires_in: 3600 });
      apiCalls++;
      return (init?.headers as Record<string, string>).authorization === "Bearer AT1" ? json({ error: { code: 401, message: "Invalid Credentials" } }, 401) : json({ uploaded: true });
    });
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any });
    expect(await g.post("https://x.googleapis.com/upload", "bytes", undefined, { noRetry: true })).toEqual({ uploaded: true });
    expect(tokenN).toBe(2);
    expect(apiCalls).toBe(2);
    // ...but a second 401 is final (no loop).
    const always401 = vi.fn(async (url: string) => (url.includes("oauth2") ? json({ access_token: "AT", expires_in: 3600 }) : json({ error: { code: 401, message: "nope" } }, 401)));
    const g2 = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: always401 as any });
    const err = (await g2.post("https://x.googleapis.com/upload", "b", undefined, { noRetry: true }).catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(401);
    expect(always401.mock.calls.filter(([u]) => !String(u).includes("oauth2")).length).toBe(2);
  });

  it("uses the shared token store when the token is still fresh", async () => {
    const kv = fakeKV();
    const store = kvTokenStore(kv, "rt");
    await store.set("SHARED", Date.now() + 3600_000);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) throw new Error("should not mint");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer SHARED");
      return json({ ok: true });
    });
    const g = new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any, tokenStore: store });
    expect(await g.get("https://x.googleapis.com/")).toEqual({ ok: true });
  });
});

describe("GoogleClient maxBytes", () => {
  /** A 200 whose body streams `chunks` × `size` bytes of valid JSON; `pulled()` counts what the client took. */
  const streamed = (chunks: number, size: number, headers: Record<string, string> = {}) => {
    let pulled = 0;
    let i = 0;
    const enc = new TextEncoder();
    const parts = [enc.encode('{"a":"'), ...Array.from({ length: chunks }, () => enc.encode("x".repeat(size))), enc.encode('"}')];
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i >= parts.length) return ctrl.close();
        pulled += parts[i].length;
        ctrl.enqueue(parts[i++]);
      },
    });
    return { res: new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } }), pulled: () => pulled };
  };
  const client = (res: () => Response) => {
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => (url.startsWith("https://oauth2.googleapis.com/token") ? json({ access_token: "AT", expires_in: 3600 }) : (apiCalls++, res())));
    return { g: new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any }), apiCalls: () => apiCalls };
  };

  it("parses a body within the limit as usual", async () => {
    const { res } = streamed(4, 1024);
    const { g } = client(() => res);
    expect(await g.get<any>("https://sheets.googleapis.com/v4/x", undefined, { maxBytes: 8 * 1024 })).toEqual({ a: "x".repeat(4096) });
  });

  it("refuses a larger body while it streams: stops reading, never parses, never retries", async () => {
    const s = streamed(64, 64 * 1024); // 4 MB
    const { g, apiCalls } = client(() => s.res);
    const err: any = await g.get("https://sheets.googleapis.com/v4/x", undefined, { maxBytes: 256 * 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err.message).toBe("Google's response is over the 256 KB this read accepts");
    expect(s.pulled()).toBeLessThan(512 * 1024);
    expect(apiCalls()).toBe(1);
  });

  it("refuses from Content-Length without reading the body at all", async () => {
    const s = streamed(64, 64 * 1024, { "content-length": String(4 * 1024 * 1024) });
    const { g } = client(() => s.res);
    await expect(g.get("https://sheets.googleapis.com/v4/x", undefined, { maxBytes: 1024 * 1024 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(s.pulled()).toBeLessThanOrEqual(64 * 1024 + 6);
  });

  it("counts bytes, not characters (Hebrew is two bytes each), and formats the limit", async () => {
    const { g } = client(() => json({ t: "ש".repeat(600) }));
    await expect(g.get("https://sheets.googleapis.com/v4/x", undefined, { maxBytes: 1_000 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(await g.get("https://sheets.googleapis.com/v4/x", undefined, { maxBytes: 2_000 })).toEqual({ t: "ש".repeat(600) });
    expect([formatBytes(8 * 1024 * 1024), formatBytes(1536), formatBytes(10)]).toEqual(["8 MB", "1.5 KB", "10 bytes"]);
  });
});

describe("kvTokenStore", () => {
  it("round-trips encrypted and never stores the plaintext token", async () => {
    const kv = fakeKV();
    const store = kvTokenStore(kv, "refresh-secret");
    const expiry = Date.now() + 1000_000;
    await store.set("plain-access-token", expiry);
    const raw = [...(kv as any)._store.values()][0] as string;
    expect(raw).not.toContain("plain-access-token");
    expect([...(kv as any)._store.keys()][0]).toMatch(/^gtok:[0-9a-f]{40}$/);
    expect(await store.get()).toEqual({ token: "plain-access-token", expiry });
    // A different refresh token cannot read it.
    expect(await kvTokenStore(kv, "other").get()).toBeNull();
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

/**
 * Minimal Google REST client for Workers.
 *
 * - Holds ONE user's refresh token (from the encrypted OAuth grant props).
 * - Mints access tokens lazily via https://oauth2.googleapis.com/token and
 *   caches them (in-memory per Durable Object + optional shared store) until
 *   ~60s before expiry.
 * - Retries transient failures (429/5xx, network) with backoff and honours
 *   Retry-After; retries ONE 401 after forcing a token refresh.
 * - Normalizes Google's error envelope into GoogleApiError; a revoked/expired
 *   refresh token becomes GoogleAuthError (the user must reconnect).
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Base URLs of the APIs the tools call (all end without a trailing slash). */
export const API = {
  sheets: "https://sheets.googleapis.com/v4",
  drive: "https://www.googleapis.com/drive/v3",
  driveUpload: "https://www.googleapis.com/upload/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  gmail: "https://gmail.googleapis.com/gmail/v1",
  gmailUpload: "https://gmail.googleapis.com/upload/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
  tasks: "https://tasks.googleapis.com/tasks/v1",
  people: "https://people.googleapis.com/v1",
  chat: "https://chat.googleapis.com/v1",
  slides: "https://slides.googleapis.com/v1",
  forms: "https://forms.googleapis.com/v1",
  photos: "https://photoslibrary.googleapis.com/v1",
  picker: "https://photospicker.googleapis.com/v1",
  youtube: "https://www.googleapis.com/youtube/v3",
  meet: "https://meet.googleapis.com/v2",
} as const;

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    message: string,
    public readonly reason?: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/**
 * A response body over the caller's `maxBytes`: refused while it streams (or from its Content-Length),
 * never buffered whole and never parsed. Thrown only after Google answered 200, so nothing is retried.
 */
export class ResponseTooLargeError extends Error {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly limit: number,
  ) {
    super(`Google's response is over the ${formatBytes(limit)} this read accepts`);
    this.name = "ResponseTooLargeError";
  }
}

/** 8388608 → "8 MB", 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  const [v, unit] = n >= 1024 * 1024 ? [n / 1024 / 1024, "MB"] : n >= 1024 ? [n / 1024, "KB"] : [n, "bytes"];
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}`;
}

/** The refresh token is dead (revoked, expired 7-day testing token, password change…). */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export interface TokenStore {
  get(): Promise<{ token: string; expiry: number } | null>;
  set(token: string, expiry: number): Promise<void>;
  clear(): Promise<void>;
}

export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional cross-instance access-token cache (see kvTokenStore). */
  tokenStore?: TokenStore;
  /** Transient-retry attempts (default 3). */
  maxRetries?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Per-request upstream timeout in ms (default 30s; uploads/exports pass their own via RequestOptions). */
  timeoutMs?: number;
}

/** Default upstream timeout: a hung Google call must not pin a Durable Object for minutes. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** AbortSignal.timeout with a fallback for runtimes that lack it (tests on old Node). */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

export type QueryValue = string | number | boolean | undefined | null | Array<string | number | boolean>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  /** JSON-serialized unless it is a string / ArrayBuffer / Uint8Array / FormData / Blob. */
  body?: unknown;
  headers?: Record<string, string>;
  /** How to read the response (default json; "response" returns the raw Response). */
  responseType?: "json" | "text" | "arrayBuffer" | "response";
  /** Skip retries (for non-idempotent uploads). */
  noRetry?: boolean;
  /** Upstream timeout for this call (ms); default GoogleClient.timeoutMs. Uploads/exports set a longer one. */
  timeoutMs?: number;
  /**
   * Mark a POST as safe to retry after a timeout/network error/5xx (e.g. a search or query
   * that only reads). Without it, POSTs are retried only on 429/408 — Google may already have
   * processed a request whose response we never saw (a sent mail, an appended row).
   */
  idempotent?: boolean;
  /** Redirect policy for the fetch (default: follow). Use "manual" when the bearer token must not travel. */
  redirect?: "follow" | "error" | "manual";
  /**
   * JSON responses only: the most bytes of body this call accepts. A larger body is refused with
   * ResponseTooLargeError as soon as it is known (Content-Length, or the running count while it
   * streams), so at most this much is ever held; the parsed result is never built.
   */
  maxBytes?: number;
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** A response's text, refused (ResponseTooLargeError) once it is known to exceed `max` bytes; the rest of the body is never read. */
async function readCapped(res: Response, max: number, method: string, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(method, url, max);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(method, url, max);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Append query params, skipping undefined/null; arrays repeat the key. */
export function withQuery(url: string, query?: Query): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// ---- Encrypted KV token store -------------------------------------------------
// Access tokens are short-lived but still bearer credentials. They are stored
// AES-GCM-encrypted under a key derived from the (never-stored-in-plaintext)
// refresh token, so a KV read alone yields nothing usable.

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-GCM key derived from a secret string (domain-separated by `purpose`). */
export async function deriveAesKey(purpose: string, secret: string): Promise<CryptoKey> {
  const raw = await sha256(`${purpose}:${secret}`);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a JSON value → compact string {iv, ct} (base64). */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return JSON.stringify({ iv: b64(iv), ct: b64(ct) });
}

/** Decrypt a string produced by encryptJson; null on any failure (wrong key, tampering, corruption). */
export async function decryptJson<T = unknown>(key: CryptoKey, raw: string): Promise<T | null> {
  try {
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

export function kvTokenStore(kv: KVNamespace, refreshToken: string): TokenStore {
  const keyP = deriveAesKey("gws-token-cache", refreshToken);
  const idP = sha256("gws-token-id:" + refreshToken).then((b) => `gtok:${toHex(b).slice(0, 40)}`);
  return {
    async get() {
      try {
        const id = await idP;
        const raw = await kv.get(id);
        if (!raw) return null;
        const parsed = await decryptJson<{ token: string; expiry: number }>(await keyP, raw);
        return parsed && typeof parsed.token === "string" && typeof parsed.expiry === "number" ? parsed : null;
      } catch {
        return null; // a cache miss/corruption just mints a fresh token
      }
    },
    async set(token, expiry) {
      try {
        const id = await idP;
        const ttl = Math.max(60, Math.floor((expiry - Date.now()) / 1000));
        await kv.put(id, await encryptJson(await keyP, { token, expiry }), { expirationTtl: ttl });
      } catch {
        /* best-effort cache */
      }
    },
    async clear() {
      try {
        await kv.delete(await idP);
      } catch {
        /* ignore */
      }
    },
  };
}

// ---- Client -------------------------------------------------------------------

export class GoogleClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly tokenStore?: TokenStore;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiry: number } | null = null;
  private inflight: Promise<string> | null = null;
  private inflightForced = false;

  constructor(opts: GoogleClientOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured");
    if (!opts.refreshToken) throw new GoogleAuthError("No Google refresh token for this grant — reconnect the connector.");
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.refreshToken = opts.refreshToken;
    this.tokenStore = opts.tokenStore;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Workers: an unbound global fetch throws "Illegal invocation" when called as a method.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Current (possibly cached) access token. */
  async getAccessToken(force = false): Promise<string> {
    const fresh = (t: { token: string; expiry: number } | null) => !!t && t.expiry - this.now() > 60_000;
    if (!force && fresh(this.cached)) return this.cached!.token;
    if (this.inflight) {
      // A forced refresh (after a 401) must not adopt a concurrent non-forced lookup, which may be
      // handing back the very token that just failed from the shared cache.
      if (!force || this.inflightForced) return this.inflight;
      await this.inflight.catch(() => undefined);
    }
    this.inflightForced = force;
    this.inflight = (async () => {
      try {
        if (!force && this.tokenStore) {
          const stored = await this.tokenStore.get();
          if (fresh(stored)) {
            this.cached = stored;
            return stored!.token;
          }
        }
        const minted = await this.refreshAccessToken();
        this.cached = minted;
        if (this.tokenStore) await this.tokenStore.set(minted.token, minted.expiry);
        return minted.token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async refreshAccessToken(): Promise<{ token: string; expiry: number }> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: timeoutSignal(15_000),
        });
        const text = await res.text();
        let data: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
        try {
          data = JSON.parse(text);
        } catch {
          /* non-JSON body */
        }
        if (res.ok && data.access_token) {
          const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
          return { token: data.access_token, expiry: this.now() + expiresIn * 1000 };
        }
        if (res.status === 400 || res.status === 401) {
          // invalid_grant = token revoked / expired (7-day testing-mode expiry) / account changed.
          throw new GoogleAuthError(
            `Google rejected the refresh token (${data.error ?? res.status}${data.error_description ? `: ${data.error_description}` : ""}). ` +
              "Remove this connector in Claude (Settings → Connectors) and add it again to sign in to Google afresh.",
          );
        }
        lastErr = new GoogleApiError(res.status, "POST", GOOGLE_TOKEN_URL, `Token refresh failed: HTTP ${res.status}`, data.error, text.slice(0, 500));
      } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        lastErr = err;
      }
      if (attempt < this.maxRetries) await sleep(300 * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Perform an authenticated request against a Google API. */
  async request<T = unknown>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
    const finalUrl = withQuery(url, opts.query);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof opts.body === "string" || opts.body instanceof ArrayBuffer || opts.body instanceof Uint8Array || opts.body instanceof FormData || opts.body instanceof Blob) {
        body = opts.body as BodyInit;
      } else {
        body = JSON.stringify(opts.body);
        headers["content-type"] ??= "application/json";
      }
    }
    let attempts = opts.noRetry ? 1 : this.maxRetries + 1;
    // GET/PUT/PATCH/DELETE are idempotent by HTTP semantics; a POST is re-sent only when the
    // caller says it only reads. Everything else may be retried solely when Google provably did
    // not process it (429 / 408 / 401), never after a timeout or a 5xx that may have followed success.
    const safeToRetry = method !== "POST" || opts.idempotent === true;
    let retried401 = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const token = await this.getAccessToken(retried401);
      let res: Response;
      try {
        res = await this.fetchImpl(finalUrl, { method, headers: { ...headers, authorization: `Bearer ${token}` }, body, signal: timeoutSignal(timeoutMs), redirect: opts.redirect });
      } catch (err) {
        lastErr = err;
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (attempt < attempts - 1 && safeToRetry) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new GoogleApiError(0, method, finalUrl, timedOut ? `Google did not answer within ${Math.round(timeoutMs / 1000)}s` : `Network error calling Google: ${err instanceof Error ? err.message : String(err)}`, timedOut ? "timeout" : undefined);
      }
      if (res.ok) {
        if (opts.responseType === "response") return res as unknown as T;
        if (opts.responseType === "arrayBuffer") return (await res.arrayBuffer()) as unknown as T;
        if (opts.responseType === "text") return (await res.text()) as unknown as T;
        if (res.status === 204) return undefined as unknown as T;
        const text = opts.maxBytes === undefined ? await res.text() : await readCapped(res, opts.maxBytes, method, finalUrl);
        if (!text) return undefined as unknown as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      const errText = await res.text();
      const parsed = parseGoogleError(errText);
      if (res.status === 401 && !retried401) {
        // Token revoked mid-flight or cache served a stale token: refresh once and
        // retry. The auth refresh is not a transient retry, so it gets its own
        // attempt even on noRetry (upload) requests.
        retried401 = true;
        this.cached = null;
        if (this.tokenStore) await this.tokenStore.clear();
        lastErr = new GoogleApiError(res.status, method, finalUrl, parsed.message ?? "HTTP 401", parsed.reason, errText.slice(0, 2000));
        attempts++;
        continue;
      }
      const err = new GoogleApiError(res.status, method, finalUrl, parsed.message ?? `HTTP ${res.status}`, parsed.reason, errText.slice(0, 2000));
      lastErr = err;
      const notProcessed = res.status === 429 || res.status === 408;
      const retryable = RETRY_STATUSES.has(res.status) && !opts.noRetry && (safeToRetry || notProcessed) && !(res.status === 429 && /quota/i.test(parsed.reason ?? "") && /daily|per day/i.test(parsed.message ?? ""));
      if (!retryable || attempt >= attempts - 1) throw err;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) * 1000 : 400 * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  get<T = unknown>(url: string, query?: Query, opts: Omit<RequestOptions, "query" | "body"> = {}): Promise<T> {
    return this.request<T>("GET", url, { ...opts, query });
  }
  post<T = unknown>(url: string, body?: unknown, query?: Query, opts: Omit<RequestOptions, "query" | "body"> = {}): Promise<T> {
    return this.request<T>("POST", url, { ...opts, query, body });
  }
  put<T = unknown>(url: string, body?: unknown, query?: Query, opts: Omit<RequestOptions, "query" | "body"> = {}): Promise<T> {
    return this.request<T>("PUT", url, { ...opts, query, body });
  }
  patch<T = unknown>(url: string, body?: unknown, query?: Query, opts: Omit<RequestOptions, "query" | "body"> = {}): Promise<T> {
    return this.request<T>("PATCH", url, { ...opts, query, body });
  }
  delete<T = unknown>(url: string, query?: Query, opts: Omit<RequestOptions, "query" | "body"> = {}): Promise<T> {
    return this.request<T>("DELETE", url, { ...opts, query });
  }

  /** Who is this token for + which scopes it carries (tokeninfo is unauthenticated). */
  async tokenInfo(): Promise<{ email?: string; scopes: string[]; expiresIn?: number }> {
    // Same self-healing as request(): a stale cached token gets one forced refresh, and the call is bounded.
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getAccessToken(attempt === 1);
      const res = await this.fetchImpl(withQuery(GOOGLE_TOKENINFO_URL, { access_token: token }), { signal: timeoutSignal(15_000) });
      const data = (await res.json().catch(() => ({}))) as { email?: string; scope?: string; expires_in?: string | number; error?: string; error_description?: string };
      if (res.ok) return { email: data.email, scopes: (data.scope ?? "").split(" ").filter(Boolean), expiresIn: data.expires_in ? Number(data.expires_in) : undefined };
      const stale = res.status === 400 || res.status === 401 || /invalid_token|invalid token/i.test(`${data.error} ${data.error_description}`);
      if (stale && attempt === 0) {
        this.cached = null;
        if (this.tokenStore) await this.tokenStore.clear();
        continue;
      }
      throw new GoogleApiError(res.status, "GET", GOOGLE_TOKENINFO_URL, `tokeninfo failed: ${data.error ?? res.status}`, data.error);
    }
    throw new GoogleApiError(0, "GET", GOOGLE_TOKENINFO_URL, "tokeninfo failed");
  }
}

/** Google error envelope: { error: { code, message, status, errors:[{reason}] } } (or OAuth-style { error, error_description }). */
export function parseGoogleError(text: string): { message?: string; reason?: string } {
  try {
    const j = JSON.parse(text) as any;
    if (j?.error && typeof j.error === "object") {
      const e = j.error;
      const reason = e.errors?.[0]?.reason ?? e.status ?? e.details?.[0]?.reason;
      return { message: e.message ?? undefined, reason: reason ? String(reason) : undefined };
    }
    if (typeof j?.error === "string") return { message: j.error_description ?? j.error, reason: j.error };
  } catch {
    /* not JSON */
  }
  return { message: text ? text.slice(0, 300) : undefined };
}

/** Exchange an authorization code (used by /callback). */
export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string; fetch?: typeof fetch },
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }> {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
  });
  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: timeoutSignal(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.access_token) {
    throw new GoogleApiError(res.status, "POST", GOOGLE_TOKEN_URL, `Code exchange failed: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ""}`, data.error);
  }
  return data;
}

/** Fetch the OpenID userinfo for an access token. */
export async function fetchUserInfo(accessToken: string, f: typeof fetch = fetch.bind(globalThis)): Promise<{ sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; hd?: string }> {
  const res = await f(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: timeoutSignal(15_000) });
  if (!res.ok) throw new GoogleApiError(res.status, "GET", GOOGLE_USERINFO_URL, `userinfo failed: HTTP ${res.status}`);
  return (await res.json()) as any;
}

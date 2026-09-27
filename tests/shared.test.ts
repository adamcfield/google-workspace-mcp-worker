import { describe, it, expect } from "vitest";
import { strip, ok, run, htmlToText, toBase64Url, fromBase64Url, mapLimit, mark, MAX_OUTPUT_CHARS, registerAll, tool, toCsv } from "../src/tools/_shared.js";
import { GoogleApiError, GoogleAuthError } from "../src/google/client.js";
import { z } from "zod";

describe("strip / ok", () => {
  it("drops empty values recursively but keeps 0/false", () => {
    // Arrays keep positions (a Sheets row like ["a", null, "b"] must not shift columns).
    expect(strip({ a: null, b: undefined, c: "", d: [], e: {}, f: 0, g: false, h: { i: null, j: [1, null] } })).toEqual({ f: 0, g: false, h: { j: [1, null] } });
  });
  it("every structured reply is compact JSON whatever its size; strings pass through; huge truncates", () => {
    // QA (JEV build): "some replies are pretty-printed and others compact, even though the server
    // instructions promise compact JSON". Until 1.6 a reply under 3000 chars was indented and a
    // larger one was not, so the SAME tool flipped format with the size of its answer. Pin one
    // format on both sides of that retired threshold.
    expect(ok({ a: 1 }).content[0].text).toBe('{"a":1}');
    const sized = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => [i, "x".repeat(10), null]), note: "line one\nline two" });
    expect(JSON.stringify(sized(120)).length).toBeLessThan(3000);
    expect(JSON.stringify(sized(150)).length).toBeGreaterThan(3000);
    for (const n of [1, 50, 120, 150, 500]) {
      const text = ok(sized(n)).content[0].text;
      expect(text, `${n} rows`).toBe(JSON.stringify(sized(n)));
      // No indentation, no separator spacing, no raw newline (the "\n" inside `note` stays escaped).
      expect(text, `${n} rows`).not.toMatch(/\n|": |, "/);
      expect(JSON.parse(text), `${n} rows`).toEqual(sized(n));
    }
    expect(ok({ keep: "x", drop: [], gone: {}, nil: null }).content[0].text).toBe('{"keep":"x"}'); // strip() still runs first
    expect(ok(null).content[0].text).toBe("null");
    expect(ok("a,b\n1,2").content[0].text).toBe("a,b\n1,2"); // CSV / plain text is not JSON: passed through untouched
    const huge = ok({ s: "y".repeat(MAX_OUTPUT_CHARS + 10) }).content[0].text;
    expect(huge.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
    expect(huge).toContain("[truncated");
  });
});

describe("run", () => {
  it("maps Google errors with hints and never throws", async () => {
    const scopeErr = new GoogleApiError(403, "GET", "https://x", "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    const r = await run("t", async () => { throw scopeErr; }, "https://www.googleapis.com/auth/drive");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("403");
    expect(r.content[0].text).toContain("auth/drive");
    const disabled = new GoogleApiError(403, "GET", "https://x", "Google Sheets API has not been used in project 1 before or it is disabled.", "accessNotConfigured");
    expect((await run("t", async () => { throw disabled; })).content[0].text).toContain("not enabled");
    expect((await run("t", async () => { throw new GoogleAuthError("dead"); })).content[0].text).toContain("dead");
    expect((await run("t", async () => { throw new Error("plain"); })).content[0].text).toBe("Error: plain");
    expect(await run("t", async () => ({ x: 1 }))).toEqual({ content: [{ type: "text", text: JSON.stringify({ x: 1 }) }] });
  });
});

describe("helpers", () => {
  it("htmlToText", () => {
    expect(htmlToText("<div>Hi<br>there &amp; <b>you</b></div><style>x{}</style><p>bye</p>")).toBe("Hi\nthere & you\nbye");
  });
  it("base64url round-trip", () => {
    const s = "Subject: שלום\r\n\r\nbody ✓";
    expect(new TextDecoder().decode(fromBase64Url(toBase64Url(s)))).toBe(s);
    expect(toBase64Url("???>>>")).not.toMatch(/[+/=]/);
  });
  it("toCsv quotes commas, quotes and newlines", () => {
    expect(toCsv([["a", 1, null], ['x "q" y', "x,y", "l1\nl2"]])).toBe('a,1,\n"x ""q"" y","x,y","l1\nl2"');
  });
  it("mapLimit preserves order", async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => { await new Promise((r) => setTimeout(r, n * 5)); return n * 10; });
    expect(out).toEqual([30, 10, 20]);
  });
});

describe("registerAll", () => {
  const defs = [
    tool({ name: "x_read", description: "r", input: { a: z.string() }, handler: async (args) => ({ got: args.a }) }),
    tool({ name: "x_write", description: "w", input: {}, write: true, handler: async () => "done" }),
    // PR-4: an additive write declares `destructive: false` on the definition (the name-based
    // ADDITIVE_NAME heuristic is gone), and `idempotent: true` is how a write says a retry is safe.
    tool({ name: "x_append_rows", description: "additive", input: {}, write: true, destructive: false, handler: async () => "ok" }),
    tool({ name: "x_delete", description: "d", input: {}, write: true, destructive: true, handler: async () => "ok" }),
    tool({ name: "x_session", description: "s", input: {}, annotations: { readOnlyHint: false }, handler: async () => "ok" }),
  ];
  const fakeServer = () => {
    const reg: Record<string, { cfg: any; cb: (args: any) => Promise<any> }> = {};
    return { server: { registerTool: (name: string, cfg: any, cb: any) => void (reg[name] = { cfg, cb }) } as any, reg };
  };
  it("registers everything with annotations and wraps handlers in run()", async () => {
    const { server, reg } = fakeServer();
    const names = registerAll(server, { g: {} as any, readOnly: false, grantedScopes: [] }, defs);
    expect(names).toEqual(["x_read", "x_write", "x_append_rows", "x_delete", "x_session"]);
    expect(reg.x_read.cfg.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(reg.x_write.cfg.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(reg.x_append_rows.cfg.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(reg.x_delete.cfg.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(reg.x_session.cfg.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(JSON.parse((await reg.x_read.cb({ a: "v" })).content[0].text)).toEqual({ got: "v" });
    expect((await reg.x_write.cb({})).content[0].text).toBe("done");
  });
  it("hides write tools on read-only deploys", () => {
    const { server } = fakeServer();
    expect(registerAll(server, { g: {} as any, readOnly: true, grantedScopes: [] }, defs)).toEqual(["x_read", "x_session"]);
  });
});

describe("mark (the alias deprecation marker)", () => {
  it("appends the marker to a plain object, last and without touching the rest", () => {
    const marked = mark({ provenance: "p", count: 1 }, "old_name", "new_name") as Record<string, unknown>;
    expect(marked).toEqual({ provenance: "p", count: 1, deprecated: { alias: "old_name", use: "new_name" } });
    // The notice a content-bearing read puts first must stay first, the marker last.
    expect(Object.keys(marked)).toEqual(["provenance", "count", "deprecated"]);
  });

  it("returns every other result shape untouched — a client parser must not see a new type", () => {
    const arr = [1, 2];
    expect(mark(arr, "a", "b")).toBe(arr); // arrays are results too (positional Sheets rows)
    expect(mark("text", "a", "b")).toBe("text");
    expect(mark(null, "a", "b")).toBeNull();
    expect(mark(undefined, "a", "b")).toBeUndefined();
    expect(mark(0, "a", "b")).toBe(0);
  });

  it("the marker wins over a `deprecated` key the handler set itself (documented behaviour)", () => {
    expect(mark({ deprecated: "handler's own" }, "a", "b")).toEqual({ deprecated: { alias: "a", use: "b" } });
  });
});

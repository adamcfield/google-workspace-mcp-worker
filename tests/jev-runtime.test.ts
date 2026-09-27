/**
 * The JEV path inside a deployed Worker: the flag, the meta-tool, and every way the model can
 * fail without the selection becoming unsafe.
 *
 * The properties pinned here are the ones the QA gate is being asked to trust:
 *
 *   * with the flag off, registration and `tools/list` are byte-for-byte unchanged;
 *   * with the flag on and a working model, the model's answers actually narrow the set;
 *   * with the flag on and a broken model — no key, a throw, a timeout, a malformed answer, an
 *     SDK that will not load — the deterministic selection stands and says so;
 *   * no answer, and no failure, can drop, downgrade or invent a mutation tool;
 *   * nothing about the key reaches the model payload or the tool's result.
 */
import { describe, it, expect, vi } from "vitest";

// health.ts → agent.ts → `agents/mcp`, which pulls in the Workers runtime; stub it like the
// other tests that read /health do.
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

import { connectInMemory, listToolsInMemory } from "./helpers/mcp.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { jevConfigured, jevEnabled, jevRuntime } from "../src/routing/runtime.js";
import { createJevAsk, type SystemOneClient } from "../src/routing/jev.js";
import { selectTools } from "../src/routing/select.js";
import { buildManifest, type ManifestEntry } from "../src/tools/_manifest.js";
import { healthBody } from "../src/health.js";
import type { AgentEnv } from "../src/agent.js";

const ON = { JEV_ENABLED: "true", TYPESAFE_API_KEY: "sk-test-not-a-real-key" } as const;
const MANIFEST: readonly ManifestEntry[] = buildManifest(ALL_TOOLS, new Set(ALL_TOOLS.map((t) => t.name)));

/** A client whose answer for every question is `noul`, from a function of the tool name. */
function stubClient(noul: (name: string) => number, seen?: { questions: string[][]; states: unknown[] }): SystemOneClient {
  return {
    async systemOne({ state, questions }) {
      seen?.questions.push(Object.keys(questions));
      seen?.states.push(state);
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: noul(k) }])) };
    },
  };
}

/** Call `google_select_tools` over the wire and return its parsed payload. */
async function select(request: string, opts: { env?: Record<string, string>; ctx?: Record<string, unknown> } = {}) {
  const { client, close } = await connectInMemory({ env: { ...ON, ...opts.env }, ctx: opts.ctx as any });
  const res: any = await client.callTool({ name: "google_select_tools", arguments: { request } });
  await close();
  expect(res.isError, res.content?.[0]?.text).toBeFalsy();
  return JSON.parse(res.content[0].text);
}

/** A runtime whose `ask` is built from a stub client, as `jevRuntime` would build it from the SDK. */
function stubRuntime(client: SystemOneClient | null) {
  return {
    enabled: true,
    configured: Boolean(client),
    ask: async () => (client ? createJevAsk(client) : null),
  };
}

describe("the flag", () => {
  it("is off for everything except the exact string 'true'", () => {
    for (const value of [undefined, "", " ", "1", "yes", "TRUE", "True", "false", "tru"]) {
      expect(jevEnabled({ JEV_ENABLED: value }), String(value)).toBe(false);
    }
    expect(jevEnabled({ JEV_ENABLED: "true" })).toBe(true);
    expect(jevEnabled({ JEV_ENABLED: " true " })).toBe(true);
  });

  it("reports a key as present or absent, never its value", () => {
    expect(jevConfigured({ JEV_ENABLED: "true" })).toBe(false);
    expect(jevConfigured({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "   " })).toBe(false);
    expect(jevConfigured({ JEV_ENABLED: "true", TYPESAFE_API_KEY: "sk-x" })).toBe(true);
    // A key without the flag is still off: the flag is what turns the path on.
    expect(jevConfigured({ TYPESAFE_API_KEY: "sk-x" })).toBe(false);
  });
});

describe("flag off", () => {
  it("registers and lists exactly what it did before the path existed", async () => {
    const base = await listToolsInMemory({});
    expect(base.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    expect(base.some((t) => t.name === "google_select_tools")).toBe(false);
    // Byte-for-byte, not merely the same names: a changed description or schema would show here.
    const bytes = JSON.stringify(base);
    for (const value of ["", " ", "1", "yes", "TRUE", "false"]) {
      expect(JSON.stringify(await listToolsInMemory({ JEV_ENABLED: value })), value).toBe(bytes);
    }
  });

  it("adds exactly one tool when the flag is on, and nothing else moves", async () => {
    const off = await listToolsInMemory({});
    const on = await listToolsInMemory({ JEV_ENABLED: "true" });
    expect(on.length).toBe(off.length + 1);
    expect(JSON.stringify(on.slice(0, off.length))).toBe(JSON.stringify(off));
    expect(on[on.length - 1].name).toBe("google_select_tools");
  });

  it("leaves /health alone, and reports readiness only where the flag is set", () => {
    const env = { ALLOWED_EMAILS: "ops@example.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as unknown as AgentEnv;
    const off = healthBody(env, "w", "bearer");
    expect("jevEnabled" in off).toBe(false);
    expect("jevConfigured" in off).toBe(false);

    const on = healthBody({ ...env, JEV_ENABLED: "true" } as AgentEnv, "w", "bearer");
    expect(on.jevEnabled).toBe(true);
    expect(on.jevConfigured).toBe(false);
    expect(on.warnings).toContain("JEV_ENABLED=true but TYPESAFE_API_KEY is not set: tool selection falls back to the deterministic router");

    const ready = healthBody({ ...env, ...ON } as AgentEnv, "w", "bearer");
    expect(ready.jevConfigured).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(ON.TYPESAFE_API_KEY);
  });
});

describe("the meta-tool answers with canonical names", () => {
  it("takes the request as an argument and returns tools from this deployment's manifest", async () => {
    const out = await select("find the invoice email from the supplier");
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(out.toolCount).toBeGreaterThan(0);
    expect(out.tools.length).toBe(out.toolCount);
    for (const name of out.tools) expect(names.has(name), name).toBe(true);
    expect(out.tools).toContain("gmail_search_messages");
    expect(out.nextAction).toBe("select");
  });

  it("cannot return a tool this deployment does not register", async () => {
    const out = await select("find the invoice email from the supplier", { env: { DISABLED_TOOL_GROUPS: "gmail" } });
    expect((out.tools ?? []).some((n: string) => n.startsWith("gmail_"))).toBe(false);
    // Nothing else in the catalog answers a Gmail request, so the honest answer is "none" — and
    // it has to SAY so: `strip()` drops the empty array, and a bare toolCount: 0 reads as a bug.
    expect(out.toolCount).toBe(0);
    expect(out.note).toMatch(/disabled here/);
  });

  it("says nothing matched rather than returning a silent empty result", async () => {
    const out = await select("what is the weather in Tel Aviv tomorrow", { env: { ENABLED_TOOL_GROUPS: "meet" } });
    if (out.toolCount === 0) expect(out.note).toBeTruthy();
    else for (const name of out.tools) expect(name.startsWith("meet_") || name.startsWith("google_"), name).toBe(true);
  });

  it("returns no write tool on a read-only session, even for a request that asks for one", async () => {
    const out = await select("send an email to dana@example.com with the invoice", {
      env: { MCP_READONLY: "true" },
      ctx: { readOnly: true },
    });
    const writes = new Set(ALL_TOOLS.filter((t) => t.write).map((t) => t.name));
    for (const name of out.tools) expect(writes.has(name), name).toBe(false);
  });
});

describe("with a model", () => {
  it("uses its answers to narrow the deterministic set", async () => {
    const seen = { questions: [] as string[][], states: [] as unknown[] };
    const only = "gmail_search_messages";
    const out = await select("find the invoice email from the supplier", {
      ctx: { jev: stubRuntime(stubClient((name) => (name === only ? 0.99 : 0.01), seen)) },
    });
    expect(out.tools).toEqual([only]);
    expect(out.prefilteredCount).toBeGreaterThan(1);
    expect(out.model.used).toBe(true);
    expect(out.model.fallback).toBe(false);
    expect(out.model.asked).toBe(out.prefilteredCount);
    // One call carrying every question, which is what the batching is for.
    expect(seen.questions.length).toBe(1);
  });

  it("never sends a write tool to the model, and sends no credential material", async () => {
    const seen = { questions: [] as string[][], states: [] as unknown[] };
    await select("send an email to dana@example.com about the invoice", {
      ctx: { jev: stubRuntime(stubClient(() => 0.9, seen)) },
    });
    const writes = new Set(ALL_TOOLS.filter((t) => t.write).map((t) => t.name));
    for (const name of seen.questions.flat()) expect(writes.has(name), `${name} was offered to the model`).toBe(false);
    const payload = JSON.stringify(seen);
    expect(payload).not.toContain(ON.TYPESAFE_API_KEY);
    expect(payload.toLowerCase()).not.toContain("apikey");
  });

  it("reports the model as configured without disclosing anything about the key", async () => {
    const out = await select("find the invoice email", { ctx: { jev: stubRuntime(stubClient(() => 0.9)) } });
    expect(out.model.enabled).toBe(true);
    expect(out.model.configured).toBe(true);
    expect(JSON.stringify(out)).not.toContain(ON.TYPESAFE_API_KEY);
  });
});

describe("every failure falls back to the deterministic selection", () => {
  const broken: Record<string, SystemOneClient> = {
    throws: { async systemOne() { throw new Error("boom"); } },
    "times out": { async systemOne() { throw Object.assign(new Error("Request timed out."), { name: "APITimeoutError" }); } },
    "auth refused": { async systemOne() { throw Object.assign(new Error("401"), { name: "AuthenticationError" }); } },
    "answers nothing": { async systemOne() { return { answers: {} }; } },
    "answers the wrong type": {
      async systemOne({ questions }) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "text", noul: 1 }])) };
      },
    },
    "answers out of range": {
      async systemOne({ questions }) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 7 }])) };
      },
    },
    "answers a non-number": {
      async systemOne({ questions }) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: "yes" }])) };
      },
    },
    "answers about other tools": {
      async systemOne() {
        return { answers: { not_a_tool_at_all: { type: "noul", noul: 1 }, gmail_send_message: { type: "noul", noul: 1 } } };
      },
    },
    "returns no answers object": { async systemOne() { return {} as any; } },
  };

  const request = "find the invoice email from the supplier";

  it.each(Object.keys(broken))("%s → the deterministic set, with fallback reported", async (kind) => {
    const deterministic = await select(request, { ctx: { jev: { enabled: true, configured: true, ask: async () => null } } });
    const out = await select(request, { ctx: { jev: stubRuntime(broken[kind]) } });
    expect(out.model.fallback).toBe(true);
    expect(out.model.used).toBe(false);
    expect(out.toolCount).toBeGreaterThan(0);
    expect(out.tools).toEqual(deterministic.tools);
    // Whatever the model said about a tool it was never asked about is not in the answer.
    expect(out.tools).not.toContain("not_a_tool_at_all");
  });

  it("no key, or an SDK that will not load, is the deterministic path and never an error", async () => {
    for (const make of [async () => null, async () => { throw new Error("module not found"); }, async () => ({}) as SystemOneClient]) {
      const runtime = jevRuntime({ ...ON }, make as any);
      expect(await runtime.ask()).toBe(null);
    }
    // The flag off short-circuits before the SDK is even reached.
    const offRuntime = jevRuntime({ TYPESAFE_API_KEY: "sk-x" }, async () => stubClient(() => 1));
    expect(await offRuntime.ask()).toBe(null);

    const out = await select("find the invoice email", { ctx: { jev: stubRuntime(null) } });
    expect(out.model.configured).toBe(false);
    expect(out.model.asked).toBe(0);
    expect(out.toolCount).toBeGreaterThan(0);
  });
});

describe("the mutation gate survives every answer", () => {
  const mutating = [
    "send an email to dana@example.com about the invoice",
    "delete the event on friday",
    "write the totals into the Q3 sheet",
    "share the budget file with the finance team",
  ];

  const answers: Record<string, (name: string) => number> = {
    "all no": () => 0,
    "all yes": () => 1,
    "exactly at the threshold": () => 0.5,
    "just under": () => 0.499999,
  };

  it.each(mutating)("%s keeps every gate tool, whatever the model answers", async (request) => {
    const baseline = await select(request, { ctx: { jev: { enabled: true, configured: true, ask: async () => null } } });
    expect(baseline.gate.pinnedCount).toBeGreaterThan(0);
    for (const [label, noul] of Object.entries(answers)) {
      const out = await select(request, { ctx: { jev: stubRuntime(stubClient(noul)) } });
      for (const pinned of baseline.gate.pinned) expect(out.tools, `${label}: ${pinned}`).toContain(pinned);
    }
    for (const kind of ["throws", "answers nothing"]) {
      const out = await select(request, { ctx: { jev: stubRuntime(kind === "throws" ? { async systemOne() { throw new Error("x"); } } : { async systemOne() { return { answers: {} }; } }) } });
      for (const pinned of baseline.gate.pinned) expect(out.tools, `${kind}: ${pinned}`).toContain(pinned);
    }
  });

  it("a model that answers yes to a write it was never asked about cannot add one", async () => {
    // `selectTools` only ever asks about reads, so an answer keyed on a write is an answer to a
    // question that was not put. It must not reach the result except through the gate.
    const out = await select("find the invoice email from the supplier", {
      ctx: {
        jev: stubRuntime({
          async systemOne({ questions }) {
            return {
              answers: {
                ...Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 1 }])),
                gmail_send_message: { type: "noul", noul: 1 },
                drive_delete_file: { type: "noul", noul: 1 },
              },
            };
          },
        }),
      },
    });
    expect(out.gate.pinnedCount).toBe(0);
    for (const name of out.tools) expect(ALL_TOOLS.find((t) => t.name === name)?.write ?? false, name).toBe(false);
  });

  it("an ask that is handed a write answers 'required' without asking anyone", async () => {
    // Defence in depth for a future caller: `createJevAsk` short-circuits a write rather than
    // letting the model vote on it. Proven directly, because `selectTools` never produces the case.
    const systemOne = vi.fn(async () => ({ answers: {} }));
    const { ask, stats } = createJevAsk({ systemOne } as unknown as SystemOneClient);
    const write = MANIFEST.find((e) => e.name === "gmail_send_message")!;
    await expect(ask("send it", write)).resolves.toBe(true);
    expect(systemOne).not.toHaveBeenCalled();
    expect(stats.pinnedWrites).toBe(1);
  });
});

describe("the selector contract the QA gate reads", () => {
  it("reports the evidence it claims: prefilter, gate facts, question count", async () => {
    const out = await select("send an email to dana@example.com about the invoice", {
      ctx: { jev: stubRuntime(stubClient(() => 0.9)) },
    });
    expect(out.request).toBe("send an email to dana@example.com about the invoice");
    expect(out.gate.mutating).toBe(true);
    expect(out.gate.verbCount).toBeGreaterThan(0);
    expect(out.gate.pinnedCount).toBe(out.gate.pinned.length);
    expect(out.prefilteredCount).toBe(out.prefiltered.length);
    expect(out.model.calls).toBeGreaterThan(0);
    expect(out.model.failures).toBe(0);
  });

  it("matches what selectTools returns for the same request and manifest", async () => {
    const direct = await selectTools("find the invoice email from the supplier", MANIFEST);
    const viaTool = await select("find the invoice email from the supplier", {
      ctx: { jev: { enabled: true, configured: true, ask: async () => null } },
    });
    expect(viaTool.tools).toEqual(direct.tools);
    expect(viaTool.prefiltered).toEqual(direct.prefiltered);
  });
});

/**
 * The JEV asker, and the promise the whole feature rests on: JEV can narrow a set of read tools
 * and can do nothing else.
 *
 * The failure paths carry most of the weight here. A selector that silently widens when the model
 * misbehaves is worse than no selector, so every way an answer can be unusable — absent, wrong
 * type, not a number, out of range, or a call that never came back — is asserted to end at the
 * deterministic selection rather than at a guess. The tests run against the real 162-tool catalog
 * for the same reason `tests/jev-gate.test.ts` does: these are claims about what this server can
 * be talked into exposing, and a fixture would let a wrong claim pass.
 */

import { describe, it, expect, vi } from "vitest";
import { createJevAsk, JEV_PARAMS, JevUnusableAnswerError, type SystemOneClient } from "../src/routing/jev.js";
import { selectTools } from "../src/routing/select.js";
import { buildManifest } from "../src/tools/_manifest.js";
import { ALL_TOOLS } from "../src/tools/_groups.js";
import type { ManifestEntry } from "../src/tools/_manifest.js";

const manifest = buildManifest(ALL_TOOLS, new Set(ALL_TOOLS.map((t) => t.name)));
const entry = (name: string): ManifestEntry => {
  const found = manifest.find((e) => e.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

/** A client whose every answer is the same probability. */
const answering = (probability: number, calls: unknown[] = []): SystemOneClient => ({
  async systemOne(request) {
    calls.push(request);
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: probability };
    return { answers, usage: { input_tokens: 10, output_tokens: 2 } };
  },
});

/** A client that returns exactly the answers given, however malformed. */
const returning = (answers: Record<string, unknown>): SystemOneClient => ({
  async systemOne() {
    return { answers };
  },
});

describe("createJevAsk — answers", () => {
  it("treats a probability at or above the threshold as required", async () => {
    const { ask } = createJevAsk(answering(JEV_PARAMS.threshold));
    await expect(ask("find my mail", entry("gmail_search_messages"))).resolves.toBe(true);
  });

  it("treats a probability below the threshold as not required", async () => {
    const { ask } = createJevAsk(answering(JEV_PARAMS.threshold - 0.01));
    await expect(ask("find my mail", entry("gmail_search_messages"))).resolves.toBe(false);
  });

  it("honours a threshold override", async () => {
    const { ask } = createJevAsk(answering(0.8), { threshold: 0.9 });
    await expect(ask("find my mail", entry("gmail_search_messages"))).resolves.toBe(false);
  });

  it("counts calls, questions and reported token usage", async () => {
    const { ask, stats } = createJevAsk(answering(1));
    await Promise.all([
      ask("find my mail", entry("gmail_search_messages")),
      ask("find my mail", entry("gmail_read_message")),
    ]);
    expect(stats.calls).toBe(1);
    expect(stats.questions).toBe(2);
    expect(stats.inputTokens).toBe(10);
    expect(stats.outputTokens).toBe(2);
    expect(stats.failures).toBe(0);
  });
});

describe("createJevAsk — batching", () => {
  it("sends one call for the questions raised together about one request", async () => {
    const calls: unknown[] = [];
    const { ask } = createJevAsk(answering(1, calls));
    await Promise.all([
      ask("find my mail", entry("gmail_search_messages")),
      ask("find my mail", entry("gmail_read_message")),
      ask("find my mail", entry("drive_search_files")),
    ]);
    expect(calls).toHaveLength(1);
    expect(Object.keys((calls[0] as { questions: Record<string, unknown> }).questions)).toEqual([
      "gmail_search_messages",
      "gmail_read_message",
      "drive_search_files",
    ]);
  });

  it("keeps separate requests in separate calls", async () => {
    const calls: unknown[] = [];
    const { ask } = createJevAsk(answering(1, calls));
    await Promise.all([ask("find my mail", entry("gmail_search_messages")), ask("find my files", entry("drive_search_files"))]);
    expect(calls).toHaveLength(2);
  });

  it("splits a batch larger than the question cap", async () => {
    const calls: unknown[] = [];
    const { ask } = createJevAsk(answering(1, calls), { maxQuestions: 2 });
    const reads = manifest.filter((e) => !e.write).slice(0, 5);
    await Promise.all(reads.map((e) => ask("find things", e)));
    expect(calls).toHaveLength(3);
  });

  it("still answers correctly when a caller awaits each question in turn", async () => {
    const calls: unknown[] = [];
    const { ask } = createJevAsk(answering(1, calls));
    await ask("find my mail", entry("gmail_search_messages"));
    await ask("find my mail", entry("gmail_read_message"));
    expect(calls).toHaveLength(2);
  });
});

describe("createJevAsk — unusable answers reject", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a missing answer", {}],
    ["an answer of the wrong type", { gmail_search_messages: { type: "choice", choice: "yes" } }],
    ["a probability that is not a number", { gmail_search_messages: { type: "noul", noul: "yes" } }],
    ["a probability that is NaN", { gmail_search_messages: { type: "noul", noul: Number.NaN } }],
    ["a probability above one", { gmail_search_messages: { type: "noul", noul: 1.5 } }],
    ["a probability below zero", { gmail_search_messages: { type: "noul", noul: -0.5 } }],
    ["a null answer", { gmail_search_messages: null }],
  ];

  for (const [label, answers] of cases) {
    it(`rejects on ${label}`, async () => {
      const { ask, stats } = createJevAsk(returning(answers));
      await expect(ask("find my mail", entry("gmail_search_messages"))).rejects.toBeInstanceOf(JevUnusableAnswerError);
      expect(stats.failures).toBe(1);
    });
  }

  it("rejects when the response carries no answers at all", async () => {
    const client = { async systemOne() { return {} as { answers: Record<string, unknown> }; } };
    const { ask } = createJevAsk(client);
    await expect(ask("find my mail", entry("gmail_search_messages"))).rejects.toBeInstanceOf(JevUnusableAnswerError);
  });

  it("rejects every question in a batch when the call itself fails", async () => {
    const client: SystemOneClient = {
      async systemOne() {
        throw new Error("connection reset");
      },
    };
    const { ask, stats } = createJevAsk(client);
    const results = await Promise.allSettled([
      ask("find my mail", entry("gmail_search_messages")),
      ask("find my mail", entry("gmail_read_message")),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(stats.failures).toBe(1);
    expect(stats.calls).toBe(0);
  });

  it("answers the questions it can when only one answer is unusable", async () => {
    const { ask } = createJevAsk(
      returning({ gmail_search_messages: { type: "noul", noul: 0.9 }, gmail_read_message: { type: "noul", noul: "no" } }),
    );
    const results = await Promise.allSettled([
      ask("find my mail", entry("gmail_search_messages")),
      ask("find my mail", entry("gmail_read_message")),
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: true });
    expect(results[1].status).toBe("rejected");
  });
});

describe("createJevAsk — a write is never put to the model", () => {
  it("answers 'required' for a write without asking", async () => {
    const calls: unknown[] = [];
    const { ask, stats } = createJevAsk(answering(0, calls));
    await expect(ask("delete it", entry("gmail_trash_message"))).resolves.toBe(true);
    expect(calls).toHaveLength(0);
    expect(stats.pinnedWrites).toBe(1);
  });

  it("answers 'required' for every write in the catalog, with the model refusing everything", async () => {
    const calls: unknown[] = [];
    const { ask } = createJevAsk(answering(0, calls));
    const writes = manifest.filter((e) => e.write);
    expect(writes.length).toBeGreaterThan(0);
    const answers = await Promise.all(writes.map((e) => ask("do the thing", e)));
    expect(answers.every(Boolean)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("the payload carries no credential material", () => {
  it("sends the request and public tool metadata and nothing else", async () => {
    const calls: unknown[] = [];
    const { ask } = createJevAsk(answering(1, calls));
    await ask("find the invoice from the supplier", entry("gmail_search_messages"));

    const payload = calls[0] as { state: unknown; questions: Record<string, Record<string, unknown>> };
    expect(payload.state).toEqual({ request: "find the invoice from the supplier" });
    const question = payload.questions.gmail_search_messages;
    expect(Object.keys(question).sort()).toEqual(["criteria", "instructions", "type"]);
    const instructions = question.instructions as Record<string, unknown>;
    expect(instructions.tool).toBe("gmail_search_messages");
    expect(instructions.service).toBe("gmail");

    // Nothing anywhere in the serialized payload looks like a credential. The asker never receives
    // the key — the SDK client holds it — and this pins that the payload cannot start carrying one.
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["apiKey", "api_key", "TYPESAFE_API_KEY", "authorization", "Bearer", "token"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("keeps the key out of the counters the report publishes", async () => {
    const { ask, stats } = createJevAsk(answering(1));
    await ask("find my mail", entry("gmail_search_messages"));
    for (const value of Object.values(stats)) expect(typeof value).toBe("number");
  });

  it("raises an unusable-answer error that quotes no request text", async () => {
    const { ask } = createJevAsk(returning({}));
    await expect(ask("wire 40000 to account 12345678", entry("gmail_search_messages"))).rejects.toThrow(
      /no answer for gmail_search_messages/,
    );
    await ask("wire 40000 to account 12345678", entry("gmail_search_messages")).catch((err: Error) => {
      expect(err.message).not.toContain("40000");
      expect(err.message).not.toContain("12345678");
    });
  });
});

describe("selectTools with a JEV asker — the deterministic floor holds", () => {
  const write = (selection: { tools: string[] }) => selection.tools.filter((n) => manifest.find((e) => e.name === n)?.write);

  it("narrows the read set when the model answers", async () => {
    const deterministic = await selectTools("find the invoice from the supplier", manifest);
    const { ask } = createJevAsk({
      async systemOne(request) {
        const answers: Record<string, unknown> = {};
        for (const name of Object.keys(request.questions)) {
          answers[name] = { type: "noul", noul: name === "gmail_search_messages" ? 0.95 : 0.05 };
        }
        return { answers };
      },
    });
    const selected = await selectTools("find the invoice from the supplier", manifest, { ask });
    expect(selected.tools).toContain("gmail_search_messages");
    expect(selected.tools.length).toBeLessThan(deterministic.tools.length);
    expect(selected.fallback).toBe(false);
    expect(selected.asked).toBeGreaterThan(0);
  });

  it("falls back to the deterministic set when the model throws", async () => {
    const deterministic = await selectTools("send the invoice to the supplier", manifest);
    const { ask } = createJevAsk({
      async systemOne() {
        throw new Error("gateway timeout");
      },
    });
    const selected = await selectTools("send the invoice to the supplier", manifest, { ask });
    expect(selected.fallback).toBe(true);
    expect(selected.tools).toEqual(deterministic.tools);
  });

  it("falls back, never to an empty set, when every answer is malformed", async () => {
    const { ask } = createJevAsk(returning({}));
    const selected = await selectTools("send the invoice to the supplier", manifest, { ask });
    expect(selected.fallback).toBe(true);
    expect(selected.tools.length).toBeGreaterThan(0);
  });

  it("keeps the gate's mutation tools when the model rejects every candidate", async () => {
    const deterministic = await selectTools("send the invoice to the supplier", manifest);
    const gated = write(deterministic);
    expect(gated.length).toBeGreaterThan(0);

    const { ask } = createJevAsk(answering(0));
    const selected = await selectTools("send the invoice to the supplier", manifest, { ask });
    for (const name of gated) expect(selected.tools).toContain(name);
  });

  it("adds no write the deterministic gate did not, however eager the model is", async () => {
    const requests = [
      "find the emails from the supplier",
      "what is on my calendar tomorrow",
      "read the third row of the budget sheet",
      "show me the files shared with me last week",
    ];
    const { ask } = createJevAsk(answering(1));
    for (const request of requests) {
      const selected = await selectTools(request, manifest, { ask });
      const deterministic = await selectTools(request, manifest);
      expect(write(selected)).toEqual(write(deterministic));
    }
  });

  it("puts no write to the model across the whole benchmark's read-only requests", async () => {
    const asked: string[] = [];
    const { ask } = createJevAsk({
      async systemOne(request) {
        asked.push(...Object.keys(request.questions));
        const answers: Record<string, unknown> = {};
        for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: 1 };
        return { answers };
      },
    });
    await selectTools("find the invoice from the supplier and open the sheet", manifest, { ask });
    expect(asked.length).toBeGreaterThan(0);
    for (const name of asked) expect(manifest.find((e) => e.name === name)?.write).toBe(false);
  });

  it("reports a fallback rather than hiding it", async () => {
    const { ask } = createJevAsk({
      async systemOne() {
        throw new Error("rate limited");
      },
    });
    const selected = await selectTools("find my mail", manifest, { ask });
    expect(selected).toMatchObject({ fallback: true, nextAction: "select" });
  });

  it("respects a per-call timeout handed to the client", async () => {
    const seen: Array<{ timeout?: number } | undefined> = [];
    const { ask } = createJevAsk(
      {
        async systemOne(request, options) {
          seen.push(options);
          const answers: Record<string, unknown> = {};
          for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: 1 };
          return { answers };
        },
      },
      { timeoutMs: 1234 },
    );
    await ask("find my mail", entry("gmail_search_messages"));
    expect(seen[0]?.timeout).toBe(1234);
  });

  it("passes a model override through and omits it otherwise", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: SystemOneClient = {
      async systemOne(request) {
        calls.push(request as unknown as Record<string, unknown>);
        const answers: Record<string, unknown> = {};
        for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: 1 };
        return { answers };
      },
    };
    const withModel = createJevAsk(client, { model: "jev-1" });
    await withModel.ask("find my mail", entry("gmail_search_messages"));
    expect(calls[0].model).toBe("jev-1");

    const withoutModel = createJevAsk(client);
    await withoutModel.ask("find my files", entry("drive_search_files"));
    expect("model" in calls[1]).toBe(false);
  });
});

describe("a slow model is a fallback, not a hang", () => {
  it("rejects the batch when the client rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const client: SystemOneClient = {
        systemOne() {
          return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 20_000));
        },
      };
      const { ask, stats } = createJevAsk(client);
      const pending = ask("find my mail", entry("gmail_search_messages"));
      const settled = pending.then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await settled).toBe("rejected");
      expect(stats.failures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

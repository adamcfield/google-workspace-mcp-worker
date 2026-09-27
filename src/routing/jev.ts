/**
 * JEV-backed answers for the one optional stage of tool selection.
 *
 * `selectTools` asks one binary question per prefiltered candidate — "is this tool required for
 * this request?" — and this module answers them with TypeSafe's System One model. Everything the
 * gate pinned is added back after this stage runs, so nothing here can reach a mutation tool: see
 * `select.ts` for why that ordering is the whole safety argument.
 *
 * Three things are deliberate and worth knowing before changing anything:
 *
 * **The client is injected, not imported.** This module declares the smallest slice of the SDK it
 * needs (`SystemOneClient`) and takes an instance. `src/` therefore gains no dependency, the Worker
 * bundle is unchanged, and the failure paths below are testable without a network or a key. The
 * real `TypeSafeClient` is constructed by whatever calls this — today the benchmark runner.
 *
 * **Questions are batched, decisions are not.** One request's candidates go in one `systemOne`
 * call carrying one question per candidate, because that is what the API is shaped for: answers
 * come back keyed by question name. The contract `selectTools` sees is still one decision per
 * candidate. Per-candidate HTTP calls would multiply the benchmark's 72 requests into roughly a
 * thousand round trips for the same answers.
 *
 * **Anything unusable throws.** A missing answer, a wrong answer type, a probability that is not a
 * number in [0, 1] — all of it throws, because `selectTools` turns a throw into the deterministic
 * result and reports `fallback: true`. Guessing at a malformed answer would be the one way this
 * module could quietly widen a selection.
 *
 * The API key is never handled here. It reaches the SDK client from the environment, and nothing
 * in this file reads, stores, logs or forwards it — the payload built below carries the request
 * text and public tool metadata and nothing else.
 */

import type { ManifestEntry } from "../tools/_manifest.js";
import type { AskFn } from "./select.js";

/** Tuning constants, in one object so a change is visible in a diff. */
export const JEV_PARAMS = {
  /** Probability at or above which a candidate counts as required. */
  threshold: 0.5,
  /** Per-attempt timeout handed to the SDK, in milliseconds. */
  timeoutMs: 10_000,
  /**
   * Most questions in one call. The prefilter's ceiling is well under this; the cap exists so a
   * future caller with a wider candidate set splits into several calls instead of sending one
   * request large enough to be rejected or to time out.
   */
  maxQuestions: 32,
} as const;

/** A yes/no answer: the probability that the answer is yes. */
interface NoulAnswer {
  readonly type: string;
  readonly noul: number;
}

/**
 * The slice of `@typesafe-ai/sdk`'s `TypeSafeClient` this module uses.
 *
 * Structural on purpose: the SDK's own types are richer (they infer the answer type from the
 * question type), and depending on them would pull the package into `src/`.
 */
export interface SystemOneClient {
  systemOne(
    request: { state: unknown; questions: Record<string, unknown>; model?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ answers: Record<string, unknown>; model?: string; usage?: { input_tokens?: number; output_tokens?: number } }>;
}

/** Counters for the report. Never contains request text, answers, or anything from the key. */
export interface JevStats {
  /** `systemOne` calls that returned a usable result. */
  calls: number;
  /** Questions put to the model across those calls. */
  questions: number;
  /** Candidates answered without asking, because they were writes. */
  pinnedWrites: number;
  /** Calls that failed or came back unusable. Each one costs its whole batch a fallback. */
  failures: number;
  /** Token usage reported by the API, when it reports any. */
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock milliseconds spent inside `systemOne`. */
  apiMs: number;
}

export interface JevOptions {
  /** Probability at or above which a candidate counts as required. Default `JEV_PARAMS.threshold`. */
  threshold?: number;
  /** Per-attempt timeout in milliseconds. Default `JEV_PARAMS.timeoutMs`. */
  timeoutMs?: number;
  /** Model override; omitted, the client's default (`jev-latest`) applies. */
  model?: string;
  /** Most questions per call. Default `JEV_PARAMS.maxQuestions`. */
  maxQuestions?: number;
}

/** Raised when an answer cannot be trusted. Carries no request text and no credential material. */
export class JevUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevUnusableAnswerError";
  }
}

/** One pending question: the tool it is about, and the callbacks waiting on its answer. */
interface Pending {
  entry: ManifestEntry;
  resolve: (required: boolean) => void;
  reject: (err: unknown) => void;
}

/**
 * The question put about one tool.
 *
 * Structured rather than prose so the model reads the tool's identity as data. The fields are the
 * manifest's own routing copy — what the tool is for, when it is the wrong choice, and what it
 * hands back — which is the same text the deterministic router matches against. `doNotUseWhen` is
 * carried when present precisely because it is the part that separates near neighbours.
 */
function questionFor(entry: ManifestEntry) {
  return {
    type: "noul",
    instructions: {
      question: "Is this tool required to carry out the user's request?",
      tool: entry.name,
      service: entry.service,
      useWhen: entry.useWhen,
      ...(entry.doNotUseWhen ? { doNotUseWhen: entry.doNotUseWhen } : {}),
      returns: entry.returns,
    },
    criteria: {
      true: "The request cannot be carried out without calling this tool.",
      false: "The request can be carried out without this tool, or the tool is about something else.",
    },
  };
}

/**
 * Read one answer, or throw.
 *
 * Every rejection here is a fallback to the deterministic selection, which is why the checks are
 * exhaustive rather than defensive-looking: a missing key, the wrong answer type, a probability
 * that is not a finite number in range. `selectTools` reports the fallback instead of hiding it.
 */
function requiredFrom(answers: Record<string, unknown>, name: string, threshold: number): boolean {
  const answer = answers[name] as NoulAnswer | undefined;
  if (!answer || typeof answer !== "object") throw new JevUnusableAnswerError(`no answer for ${name}`);
  if (answer.type !== "noul") throw new JevUnusableAnswerError(`answer for ${name} is ${String(answer.type)}, not noul`);
  const probability = answer.noul;
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    throw new JevUnusableAnswerError(`answer for ${name} is not a number`);
  }
  if (probability < 0 || probability > 1) throw new JevUnusableAnswerError(`answer for ${name} is outside [0, 1]`);
  return probability >= threshold;
}

/**
 * An `AskFn` backed by JEV, plus the counters the report needs.
 *
 * Questions raised in the same tick for the same request are sent together. `selectTools` issues
 * all of a request's asks synchronously inside one `Promise.all`, so in practice that is one call
 * per request; a caller that awaits each ask in turn still gets correct answers, one call each.
 */
export function createJevAsk(client: SystemOneClient, opts: JevOptions = {}): { ask: AskFn; stats: JevStats } {
  const threshold = opts.threshold ?? JEV_PARAMS.threshold;
  const timeout = opts.timeoutMs ?? JEV_PARAMS.timeoutMs;
  const maxQuestions = opts.maxQuestions ?? JEV_PARAMS.maxQuestions;
  const stats: JevStats = { calls: 0, questions: 0, pinnedWrites: 0, failures: 0, inputTokens: 0, outputTokens: 0, apiMs: 0 };

  const batches = new Map<string, Pending[]>();

  async function flush(request: string, pending: readonly Pending[]): Promise<void> {
    const questions: Record<string, unknown> = {};
    for (const { entry } of pending) questions[entry.name] = questionFor(entry);

    const started = Date.now();
    let answers: Record<string, unknown>;
    try {
      const result = await client.systemOne(
        { state: { request }, questions, ...(opts.model ? { model: opts.model } : {}) },
        { timeout },
      );
      stats.apiMs += Date.now() - started;
      stats.calls += 1;
      stats.questions += pending.length;
      stats.inputTokens += result?.usage?.input_tokens ?? 0;
      stats.outputTokens += result?.usage?.output_tokens ?? 0;
      answers = result?.answers as Record<string, unknown>;
      if (!answers || typeof answers !== "object") throw new JevUnusableAnswerError("response carried no answers");
    } catch (err) {
      // Every failure mode lands here — no key, auth refused, rate limited, timed out, connection
      // lost, or a body that did not parse. They are all the same decision: this batch has no
      // usable answer, so every question in it rejects and the deterministic set stands.
      stats.apiMs += Date.now() - started;
      stats.failures += 1;
      for (const { reject } of pending) reject(err);
      return;
    }

    for (const { entry, resolve, reject } of pending) {
      try {
        resolve(requiredFrom(answers, entry.name, threshold));
      } catch (err) {
        stats.failures += 1;
        reject(err);
      }
    }
  }

  /** Send everything queued for a request, in batches of at most `maxQuestions`. */
  function drain(request: string): void {
    const pending = batches.get(request);
    batches.delete(request);
    if (!pending?.length) return;
    for (let i = 0; i < pending.length; i += maxQuestions) {
      void flush(request, pending.slice(i, i + maxQuestions));
    }
  }

  const ask: AskFn = (request, tool) => {
    // A write should never reach here: `selectTools` only offers reads, and the gate's tools are
    // unioned in after this stage. If one ever does, the answer is "required" without asking —
    // the model does not get a vote on a mutation tool, even by accident.
    if (tool.write) {
      stats.pinnedWrites += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve, reject) => {
      const pending = batches.get(request);
      if (pending) {
        pending.push({ entry: tool, resolve, reject });
        return;
      }
      batches.set(request, [{ entry: tool, resolve, reject }]);
      // Same-tick questions ride together. A microtask would fire before sibling asks are queued.
      setTimeout(() => drain(request), 0);
    });
  };

  return { ask, stats };
}

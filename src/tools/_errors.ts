/**
 * Error contract for tool calls.
 *
 * `classifyError` turns whatever a handler threw into one structured `ToolError` whose
 * `message` is the exact text `run()` has always returned (prefix + status + reason + hint +
 * body block). Nothing here changes the wire: `run()` still emits `message` as plain text;
 * the structured fields (`code`, `retryable`, `next_action`) are the contract a later
 * release may serialize. `ERROR_PREFIX` pins the four message prefixes clients grep for.
 */

import { z } from "zod";
import { GoogleApiError, GoogleAuthError } from "../google/client.js";

/** The literal prefixes every tool-error text starts with (1.4.4 wording, do not reword). */
export const ERROR_PREFIX = { api: "Google API error ", auth: "Google authorization error: ", generic: "Error: ", rateLimit: "Rate limit: " } as const;

/** Why a call failed, coarse enough to branch on (auth/scope → reconnect, quota/upstream → retry, the rest → fix the request). */
export type ToolErrorCode = "auth" | "scope_missing" | "api_disabled" | "forbidden" | "not_found" | "bad_request" | "conflict" | "quota" | "rate_limited" | "upstream" | "internal";

export interface ToolError {
  code: ToolErrorCode;
  /** The text a client sees today (`run()` returns it verbatim). */
  message: string;
  cause?: { status?: number; reason?: string };
  /** True only for 429 / 5xx / session rate limits — a retry may succeed without changing the request. */
  retryable: boolean;
  /** The hint text without its "Hint: " prefix; what to do next. */
  next_action?: string;
  suggested_tool?: string;
  example_args?: Record<string, unknown>;
}

/** True when `example_args` carries a `confirm` key (the one thing a ready-to-paste example must never include). */
export function hasConfirmInExample(e: { example_args?: Record<string, unknown> }): boolean {
  return !!e.example_args && Object.prototype.hasOwnProperty.call(e.example_args, "confirm");
}

/** Confirm-class errors must never ship a ready-to-paste `confirm: true` — the user, not the model, supplies consent. */
export function assertNoConfirmInExample(e: { example_args?: Record<string, unknown> }): void {
  if (hasConfirmInExample(e)) throw new Error("example_args must not carry a confirm key");
}

/** zod v4 schema of `ToolError`; rejects `example_args` carrying a `confirm` key (see `assertNoConfirmInExample`). */
export const ToolErrorSchema: z.ZodType<ToolError> = z
  .object({
    code: z.enum(["auth", "scope_missing", "api_disabled", "forbidden", "not_found", "bad_request", "conflict", "quota", "rate_limited", "upstream", "internal"]),
    message: z.string(),
    cause: z.object({ status: z.number().optional(), reason: z.string().optional() }).optional(),
    retryable: z.boolean(),
    next_action: z.string().optional(),
    suggested_tool: z.string().optional(),
    example_args: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (e) => !hasConfirmInExample(e),
    { message: "example_args must not carry a confirm key", path: ["example_args"] },
  );

const SCOPE_RE = /insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i;
const DISABLED_RE = /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i;

/** Pure: a thrown value → the structured error whose `message` equals the 1.4.4 tool-error text. */
export function classifyError(err: unknown, scope?: string): ToolError {
  if (err instanceof GoogleAuthError) return { code: "auth", message: `${ERROR_PREFIX.auth}${err.message}`, retryable: false };
  if (err instanceof GoogleApiError) {
    const haystack = `${err.reason} ${err.message} ${err.body}`;
    let code: ToolErrorCode;
    let next_action: string | undefined;
    if (err.status === 403 && SCOPE_RE.test(haystack)) {
      code = "scope_missing";
      next_action = `this connection lacks the required Google scope${scope ? ` (${scope})` : ""}. Remove and re-add the connector in Claude, and approve every permission on Google's consent screen.`;
    } else if (err.status === 403 && DISABLED_RE.test(haystack)) {
      code = "api_disabled";
      next_action = "this Google API is not enabled in the GCP project of your OAuth client. Enable it in console.cloud.google.com → APIs & Services → Library (see README), wait a minute, retry.";
    } else if (err.status === 403) code = "forbidden";
    else if (err.status === 404) {
      code = "not_found";
      next_action = "check the id/resource name — it may belong to another account or be trashed.";
    } else if (err.status === 429) {
      code = "quota";
      next_action = "Google quota exceeded — wait and retry, or narrow the request.";
    } else if (err.status === 400) code = "bad_request";
    else if (err.status === 409) code = "conflict";
    else code = "upstream";
    const hint = next_action ? `\nHint: ${next_action}` : "";
    const body = err.body && err.body.length < 1500 && !err.body.includes(err.message) ? `\n${err.body}` : "";
    return {
      code,
      message: `${ERROR_PREFIX.api}${err.status}${err.reason ? ` (${err.reason})` : ""}: ${err.message}${hint}${body}`,
      cause: { status: err.status, reason: err.reason },
      retryable: err.status === 429 || err.status >= 500,
      next_action,
    };
  }
  return { code: "internal", message: `${ERROR_PREFIX.generic}${err instanceof Error ? err.message : String(err)}`, retryable: false };
}

/** The per-session limiter refusal (same text `registerAll` has always returned). */
export function rateLimitError(limit: number, windowMs: number, waitMs: number): ToolError {
  return {
    code: "rate_limited",
    message: `${ERROR_PREFIX.rateLimit}this session may make ${limit} tool calls per ${Math.round(windowMs / 1000)}s. Retry in ${Math.ceil(waitMs / 1000)}s, or batch the work (sheets_batch_read_ranges/batch_write_ranges, gmail_batch_modify_message_labels, …).`,
    retryable: true,
  };
}

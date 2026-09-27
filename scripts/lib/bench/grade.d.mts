/** Types for scripts/lib/bench/grade.mjs (kept next to the module so tests typecheck). */
import type { BenchCall, BenchTaskLike, Mutation } from "./policy.mjs";

export interface GradedCall extends BenchCall {
  resultText?: string;
  isError?: boolean;
  wrongMutation?: boolean;
  [k: string]: unknown;
}
export type ValueCandidate = string | number | (string | number)[] | { any_of: (string | number)[] };
export interface ValueGroundTruth {
  type: "value";
  any_of?: ValueCandidate[];
  all_of?: ValueCandidate[];
  none_of?: (string | number)[];
}
export interface BehaviorGroundTruth {
  type: "behavior";
  must?: string[];
  must_not?: string[];
  max_calls?: number;
  human_review?: boolean;
  human_review_checklist?: string[];
}
export interface Expectation {
  path?: string;
  equals?: unknown;
  not_equals?: unknown;
  matches?: string;
  exists?: boolean;
  contains?: unknown;
  length?: number;
  min_length?: number;
  max_length?: number;
  count?: number;
  count_min?: number;
  count_max?: number;
  /** contains_item | local_date | local_datetime | duration_minutes | within_window | outside_windows */
  predicate?: string;
  match?: Record<string, unknown>;
  tz?: string;
  start?: string;
  end?: string;
  from?: string;
  to?: string;
  windows?: { from: string; to: string }[];
}
export interface VerifySpec {
  tool: string;
  args?: Record<string, unknown>;
  expect: Expectation | Expectation[];
}
export interface StateGroundTruth {
  type: "state";
  verify?: VerifySpec | VerifySpec[];
  must?: string[];
  must_not?: string[];
}
export type GroundTruth = ValueGroundTruth | BehaviorGroundTruth | StateGroundTruth;
export interface VerifyResult {
  ok: boolean;
  reason?: string;
  [k: string]: unknown;
}
export interface ValueGrade {
  ok: boolean;
  matched: unknown;
  missing: unknown[];
  violated: unknown[];
  reason: string;
}
export interface BehaviorGrade {
  ok: boolean;
  reasons: string[];
}
export interface StateGrade {
  ok: boolean;
  checks: { path?: string; observed: unknown; ok: boolean; reason: string }[];
  reason: string;
}
export interface SessionGrade {
  success: 0 | 1;
  wrongMutation: 0 | 1;
  /** ground_truth.human_review — the auto grade is provisional until the checklist is applied. */
  humanReview: boolean;
  reasons: string[];
  detail: (ValueGrade | BehaviorGrade | { ok: boolean; reasons: string[] }) & { verify?: VerifyResult[] };
}
export interface PlaceholderContext {
  fixtures?: Record<string, unknown>;
  benchDay?: string;
  /** false → unresolved placeholders are left in place and pushed to `missing` instead of throwing. */
  strict?: boolean;
  missing?: string[];
}
export interface LocalClock {
  date: string;
  time: string;
  minutes: number;
}
export function normalizeText(s: unknown): string;
export function getPath(obj: unknown, path?: string): unknown;
export function looseEquals(a: unknown, b: unknown): boolean;
export function dateRenderings(ymd: string): string[];
export function contains(normalizedText: string, cand: ValueCandidate): boolean;
export function gradeValue(finalText: string, gt: ValueGroundTruth): ValueGrade;
export function isSendOrShare(call: BenchCall): boolean;
export function canonicalizer(aliases?: Record<string, string>): (name: string) => string;
export function gradeBehavior(finalText: string, toolCalls: GradedCall[], gt: BehaviorGroundTruth | { must?: string[]; must_not?: string[]; max_calls?: number }, opts?: { forbiddenTools?: string[]; mutation?: Mutation; maxCalls?: number; aliases?: Record<string, string> }): BehaviorGrade;
export function localClock(value: unknown, tz?: string): LocalClock | null;
export function gradeState(data: unknown, expect: Expectation | Expectation[]): StateGrade;
export function shiftDate(ymd: string, days?: number): string;
export function resolvePlaceholders<T>(obj: T, ctx?: PlaceholderContext): T;
export function gradeSession(task: BenchTaskLike & { ground_truth?: GroundTruth }, session?: { finalText?: string; toolCalls?: GradedCall[]; verify?: VerifyResult | VerifyResult[]; aliases?: Record<string, string> }): SessionGrade;

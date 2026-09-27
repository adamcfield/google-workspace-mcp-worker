/** Types for scripts/lib/bench/policy.mjs (kept next to the module so tests typecheck). */
export interface BenchCall {
  name: string;
  args?: Record<string, unknown>;
}
export interface AllowedSpec {
  tool: string;
  args_match?: Record<string, string>;
}
export type Mutation = "none" | { allowed?: AllowedSpec | AllowedSpec[]; verify?: unknown; verify_also?: unknown; wrong_mutation_if_verify_fails?: boolean };
export interface BenchTaskLike {
  id?: string;
  expected_first_tools?: string[];
  acceptable_tools?: string[];
  forbidden_tools?: string[];
  discovery_tools?: string[];
  no_tool_call_ok?: boolean;
  mutation?: Mutation;
  [k: string]: unknown;
}
export interface PolicyDecision {
  execute: boolean;
  reason: string;
  wrongMutation: boolean;
  hardDeny: boolean;
  isWrite: boolean;
  allowedBy: string | null;
}
export interface PolicyOptions {
  writeSet?: Set<string> | string[];
  discoveryTools?: string[];
}
export const DISCOVERY_TOOLS: string[];
export const HARD_DENY: { names: string[]; patterns: RegExp[] };
export const GUARDED_ARGS: { applies: (name: string) => boolean; key: string; denies: (value: unknown) => boolean; why: string }[];
export function guardedArgs(call: BenchCall): { key: string; why: string }[];
export function hardDenyReason(call: BenchCall, writeSet?: Set<string> | string[]): string | null;
export function allowedSpecs(task: BenchTaskLike | undefined): AllowedSpec[];
export function matchesAllowed(call: BenchCall, spec: AllowedSpec | undefined): boolean;
export function allowExecute(call: BenchCall, task: BenchTaskLike | undefined, readOnlySet?: Set<string> | string[], opts?: PolicyOptions): PolicyDecision;

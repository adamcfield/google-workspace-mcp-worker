/** Types for scripts/lib/bench/session.mjs (kept next to the module so tests typecheck). */
import type { BenchTaskLike } from "./policy.mjs";
import type { GradedCall, PlaceholderContext, VerifyResult, VerifySpec } from "./grade.mjs";

export { CSV_COLUMNS } from "./gates.mjs";
export const CONFIG_B_PREFIXES: string[];
export const TRANSCRIPT_FORMAT: string;
export const DRIVER_NAMES: string[];

export interface ToolLike {
  name: string;
  [k: string]: unknown;
}
export interface CallSummary {
  firstTool: string;
  firstToolOk: boolean;
  toolCalls: number;
  discoveryCalls: number;
  retries: number;
  resultBytes: number;
}
export interface McpClientLike {
  callTool(name: string, args?: Record<string, unknown>): Promise<{ ok?: boolean; isError?: boolean; text?: string; data?: unknown; bytes?: number; ms?: number }>;
}
export interface DriverResult {
  finalText?: string;
  toolCalls?: GradedCall[];
  turns?: number;
  clarifyingQuestion?: string | number | boolean;
  wallS?: number;
  notes?: string[];
  verify?: VerifyResult | VerifyResult[];
  testerSuccess?: number | string;
  [k: string]: unknown;
}
export interface DriverLike {
  run(input: Record<string, unknown>): Promise<DriverResult | null>;
}
export interface SessionOptions {
  driver: DriverLike;
  driverName: string;
  task: BenchTaskLike;
  config: "A" | "B" | "C";
  runNo: number;
  client?: McpClientLike | null;
  tools?: ToolLike[];
  instructions?: string;
  fixtures?: Record<string, unknown>;
  benchDay?: string;
  serverVersion?: string;
  commit?: string;
  out: string;
  inDir?: string;
  tester?: string;
  lang?: "en" | "he";
  aliases?: Record<string, string>;
  compact?: string[];
  log?: (msg: string) => void;
}
export interface SessionRow {
  run_id: string;
  date: string;
  server_version: string;
  commit: string;
  config: string;
  task_id: string;
  category: string;
  run_no: number;
  tester: string;
  bench_day: string;
  success: 0 | 1;
  wrong_mutation: 0 | 1;
  first_tool: string;
  first_tool_ok: 0 | 1;
  tool_calls: number;
  discovery_calls: number;
  retries: number;
  turns: number;
  wall_s: number;
  result_bytes: number;
  input_tokens: number | "";
  cache_read_tokens: number | "";
  output_tokens: number | "";
  clarifying_q: number;
  notes: string;
}
export interface SessionResult {
  row: SessionRow;
  transcript: Record<string, unknown> & { grade: { success: 0 | 1; wrong_mutation: 0 | 1; human_review_pending?: true; reasons: string[]; verify?: VerifyResult[] } };
  file: string | null;
}

export function toolsForConfig(tools: ToolLike[], config: string, opts?: { compact?: string[] }): { tools: ToolLike[]; note: string };
export function compactListFrom(doc: unknown): string[];
export function buildSystem(instructions: string | undefined, benchDay?: string): string;
export function summarizeCalls(calls: GradedCall[], task: BenchTaskLike | undefined, opts?: { aliases?: Record<string, string>; discoveryTools?: string[] }): CallSummary;
export function csvEscape(v: unknown): string;
export function toCsvLine(row: Partial<SessionRow>): string;
export function appendCsvRow(file: string, row: Partial<SessionRow>): void;
export function rowsFile(out: string, config: string): string;
export function startRowsFile(file: string): void;
export function transcriptPath(dir: string, config: string, taskId: string, runNo: number): string;
export function findTranscript(dir: string, config: string, taskId: string, runNo: number): { file: string; doc: Record<string, unknown> } | null;
export function verifySpecs(task: BenchTaskLike | undefined): VerifySpec[];
export function verifyState(client: McpClientLike, specs: VerifySpec | VerifySpec[], ctx: PlaceholderContext): Promise<VerifyResult[]>;
export function runSession(o: SessionOptions): Promise<SessionResult | null>;

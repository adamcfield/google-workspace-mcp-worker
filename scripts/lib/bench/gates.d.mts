/** Types for scripts/lib/bench/gates.mjs (kept next to the module so tests typecheck). */
export type GateStatus = "PASS" | "FAIL" | "N/A";

/** One typed row of bench/results-template.csv (wrong_mutation=1 already forced success=0). */
export interface BenchRow {
  run_id: string;
  date: string;
  server_version: string;
  commit: string;
  config: string;
  task_id: string;
  category: string;
  run_no: string;
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
  wall_s: number | null;
  result_bytes: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  clarifying_q: number;
  notes: string;
}

export interface ConfigSummary {
  config: string;
  sessions: number;
  tasks: number;
  versions: string[];
  successCount: number;
  successRate: number | null;
  firstToolOkCount: number;
  firstToolOkRate: number | null;
  wrongMutations: number;
  toolCallsMedian: number | null;
  toolCallsP90: number | null;
  discoveryMedian: number | null;
  discoveryP90: number | null;
  discoverySessions: number;
  resultBytesMedian: number | null;
  resultBytesP90: number | null;
  resultBytesP95: number | null;
  wallSMedian: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  clarifyingQuestions: number;
  retries: number;
}

export interface GateVerdict {
  gate: string;
  status: GateStatus;
  value: number | string | null;
  threshold: string;
  detail: string;
}

export interface GateInput {
  rows?: BenchRow[];
  before?: BenchRow[];
  afterVersion?: string;
  tokens?: { compact: number; full: number };
}

export const CSV_COLUMNS: string[];
export const EXPORT_COLUMNS: string[];
export const INT_COLUMNS: string[];
export const NUMBER_COLUMNS: string[];
export const DISCOVERY_CATEGORIES: string[];
export const THRESHOLDS: {
  G1_SUCCESS: number;
  G2_FIRST_TOOL: number;
  G3_WRONG_MUTATIONS: number;
  G4_RATIO: number;
  G4_ABSOLUTE_TOKENS: number;
  G5_MEDIAN_DISCOVERY: number;
  G6_RATIO: number;
  G7_SUCCESS_DELTA: number;
  G7_EXTRA_CALLS: number;
};
export const GATE_NAMES: string[];

export function percentile(values: (number | null | undefined)[], q: number): number | null;
export function median(values: (number | null | undefined)[]): number | null;
export function mean(values: (number | null | undefined)[]): number | null;
export function sum(values: (number | null | undefined)[]): number;
export function typeRow(record: Record<string, string | undefined>): BenchRow;
export function dedupeRows(rows: BenchRow[]): { rows: BenchRow[]; duplicates: number };
export function loadRows(csvText: string, opts?: { benchDay?: string; allowStale?: boolean }): { header: string[]; rows: BenchRow[]; stale: BenchRow[]; duplicates: number };
export function distinct<K extends keyof BenchRow>(rows: BenchRow[], col: K): BenchRow[K][];
export function summarizeRows(rows: BenchRow[], label?: string): ConfigSummary;
export function summarize(rows: BenchRow[]): ConfigSummary[];
export function taskRegressions(aRows: BenchRow[], cRows: BenchRow[]): string[];
export function evaluateGates(input?: GateInput): GateVerdict[];
export function anyFail(gates: GateVerdict[]): boolean;
export function renderMarkdown(opts?: { summaries?: ConfigSummary[]; gates?: GateVerdict[]; stale?: BenchRow[]; duplicates?: number; title?: string }): string;
export function hashSeed(seed: string | number): number;
export function prng(seed: string | number): () => number;
export function shuffle<T>(taskIds: T[], seed: string | number): T[];
export function exportNumeric(rows: BenchRow[]): string;

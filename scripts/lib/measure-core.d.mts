/** Types for scripts/lib/measure-core.mjs (kept next to the module so tests typecheck). */
export interface MeasuredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface PerToolStats {
  name: string;
  wireBytes: number;
  modelFacingBytes: number;
  descriptionChars: number;
  inputSchemaBytes: number;
}
export interface SurfaceStats {
  tools: number;
  wireBytes: number;
  modelFacingBytes: number;
  modelFacingBytesNoSchemaKey: number;
  descriptionChars: number;
  descriptionCharsMax: number;
  inputSchemaBytes: number;
  annotationsBytes: number;
  p50WireBytes: number;
  p95WireBytes: number;
  top10: PerToolStats[];
}
export interface TokenStats {
  tools: number;
  asEmitted: number;
  stripped: number;
  perTool: number;
}
export interface FidelitySample {
  label: string;
  text: string;
  referenceTokens: number;
  model?: string;
}
export interface FidelityRow {
  label: string;
  model: string;
  referenceTokens: number;
  localTokens: number;
  ratio: number;
  ok: boolean;
}
export interface FidelityResult {
  rows: FidelityRow[];
  ok: boolean;
  minRatio: number;
  maxRatio: number;
  tolerance: number;
}
export interface Report {
  version: string;
  commit?: string;
  generatedFrom: string;
  instructionsChars: number;
  surfaces: Record<string, SurfaceStats>;
  tokens?: { tokenizer: { name: string; version: string }; surfaces: Record<string, TokenStats> };
}
export const SURFACES: Record<string, { ENABLED_TOOL_GROUPS?: string; DISABLED_TOOL_GROUPS?: string }>;
export const FIDELITY_TOLERANCE: number;
export function tokenStats(tools: MeasuredTool[], count: (text: string) => number): TokenStats;
export function fidelity(samples: FidelitySample[], count: (text: string) => number, tolerance?: number): FidelityResult;
export function stripSchemaKey<T extends Record<string, unknown> | undefined>(schema: T): T;
export function toApiTool(tool: MeasuredTool, opts?: { stripSchema?: boolean }): { name: string; description: string; input_schema: Record<string, unknown> | undefined };
export function stats(tools: MeasuredTool[]): SurfaceStats;
export function estTokens(bytes: number): number;
export function renderReport(report: Report): string;

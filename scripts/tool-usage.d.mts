/** Types for scripts/tool-usage.mjs. */
export interface UsageEvent {
  evt: "tool_call";
  tool: string;
  user?: string;
  ms?: number;
  ok?: boolean;
  error?: string;
  client?: string;
  ts?: number;
}
export interface UsageRow {
  tool: string;
  client: string;
  calls: number;
  errors: number;
  rateLimited: number;
  distinctUsers: number;
  p50Ms: number | null;
}
export interface Usage {
  rows: UsageRow[];
  total: number;
  dropped: number;
}
export function parseArgs(argv: string[]): { files: string[]; since?: number; asJson: boolean };
export function extractEvents(line: string): UsageEvent[];
export function aggregate(events: UsageEvent[], opts?: { since?: number }): Usage;
export function renderTable(usage: Usage): string;

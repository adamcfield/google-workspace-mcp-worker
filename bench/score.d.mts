/** Types for bench/score.mjs (kept next to the module so tests typecheck). */
export interface ScoreOptions {
  files: string[];
  before: string[];
  benchDay?: string;
  allowStale: boolean;
  afterVersion?: string;
  tokens?: { compact: number; full: number };
  exportFile?: string;
  shuffleSeed?: string;
  tasksFile: string;
  json: boolean;
  help: boolean;
}
export const USAGE: string;
export function parseArgs(argv: string[]): ScoreOptions;
export function parseTokens(spec: string): { compact: number; full: number };
export function main(argv: string[], io?: { read?: (file: string) => string; write?: (file: string, text: string) => void }): { exitCode: number; stdout: string };

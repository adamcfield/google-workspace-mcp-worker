/** Types for scripts/lib/bench/csv.mjs (kept next to the module so tests typecheck). */
export type CsvCell = string | number | boolean | null | undefined;
export function parseCsv(text: string): string[][];
export function parseRecords(text: string): { header: string[]; records: Record<string, string>[] };
export function csvQuote(value: CsvCell): string;
export function serializeCsv(header: string[], rows?: (CsvCell[] | Record<string, CsvCell>)[]): string;

/** Types for scripts/lib/bench/drivers/replay.mjs (kept next to the module so tests typecheck). */
import type { DriverResult } from "../session.mjs";

export function fromHarnessTranscript(doc: Record<string, unknown>, file: string): DriverResult;
export function run(input: Record<string, unknown>): Promise<DriverResult | null>;

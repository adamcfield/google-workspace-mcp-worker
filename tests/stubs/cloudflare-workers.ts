/**
 * Node stand-in for the `cloudflare:workers` runtime module so worker entry
 * files (which pull in @cloudflare/workers-oauth-provider and agents) can be
 * imported by vitest. Only the symbols those packages import at module load.
 */
export class WorkerEntrypoint {}
export class DurableObject {}
export class RpcTarget {}
export class WorkflowEntrypoint {}
export const exports = {};

/**
 * Pure measurement helpers shared by scripts/measure-tools.mjs and the tests.
 * No I/O, no network: give it the `tools` array a client gets from tools/list
 * and it returns byte/char statistics, token counts via an injected tokenizer, or the Messages API tool shape.
 *
 * "Model-facing" = the three fields the Messages API accepts per tool
 * (name, description, input_schema). Everything else in a tools/list entry
 * (annotations, execution, title, _meta) is protocol overhead the client may
 * or may not forward to the model.
 */

/** Surfaces measured by default: name → env for toolsFor(). Order is the report order. */
export const SURFACES = {
  full: {},
  "profile:gmail+calendar+drive+docs+sheets": { ENABLED_TOOL_GROUPS: "gmail,calendar,drive,docs,sheets" },
  "group:gmail": { ENABLED_TOOL_GROUPS: "gmail" },
  "group:sheets": { ENABLED_TOOL_GROUPS: "sheets" },
};

/**
 * Token counts are LOCAL ONLY: a vendored tokenizer, never the
 * Token Count API, never an API key. The local tokenizer is a proxy whose fidelity against
 * reference counts is validated per model-version update (see `fidelity()` and
 * docs/measurements/README.md). Gate G4 is a ratio on the same tokenizer, so it holds as long
 * as the tokenizer is consistent between the "before" and "after" runs.
 */
export const FIDELITY_TOLERANCE = 0.1; // max |local/reference − 1| accepted by --fidelity

const utf8 = (v) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

/** The JSON Schema without the `$schema` key the SDK adds to every tool. */
export function stripSchemaKey(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

/** One tool in the shape `POST /v1/messages` (and count_tokens) accepts. */
export function toApiTool(tool, { stripSchema = false } = {}) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: stripSchema ? stripSchemaKey(tool.inputSchema) : tool.inputSchema,
  };
}

/** Nearest-rank percentile: the value at rank ceil(q·n). */
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** Byte statistics for one tools/list result. Deterministic for the same input. */
export function stats(tools) {
  const perTool = tools
    .map((t) => ({
      name: t.name,
      wireBytes: utf8(t),
      modelFacingBytes: utf8(toApiTool(t)),
      descriptionChars: (t.description ?? "").length,
      inputSchemaBytes: utf8(t.inputSchema ?? {}),
    }))
    .sort((a, b) => b.wireBytes - a.wireBytes || a.name.localeCompare(b.name));
  const sortedWire = perTool.map((t) => t.wireBytes).sort((a, b) => a - b);
  const sum = (k) => perTool.reduce((n, t) => n + t[k], 0);
  return {
    tools: tools.length,
    wireBytes: utf8({ tools }),
    modelFacingBytes: utf8(tools.map((t) => toApiTool(t))),
    modelFacingBytesNoSchemaKey: utf8(tools.map((t) => toApiTool(t, { stripSchema: true }))),
    descriptionChars: sum("descriptionChars"),
    descriptionCharsMax: perTool.reduce((m, t) => Math.max(m, t.descriptionChars), 0),
    inputSchemaBytes: sum("inputSchemaBytes"),
    annotationsBytes: tools.reduce((n, t) => n + (t.annotations ? utf8(t.annotations) : 0), 0),
    p50WireBytes: percentile(sortedWire, 0.5),
    p95WireBytes: percentile(sortedWire, 0.95),
    top10: perTool.slice(0, 10),
  };
}

/** Rough chars→tokens proxy, only for orientation next to the tokenizer count. */
export const estTokens = (bytes) => Math.round(bytes / 3.6);

/**
 * Tokens attributable to the tool definitions of one surface, with the given `count(text)`:
 * the JSON of the model-facing tool array, as emitted and with `$schema` stripped.
 */
export function tokenStats(tools, count) {
  const asEmitted = count(JSON.stringify(tools.map((t) => toApiTool(t))));
  const stripped = count(JSON.stringify(tools.map((t) => toApiTool(t, { stripSchema: true }))));
  return { tools: tools.length, asEmitted, stripped, perTool: Math.round(stripped / Math.max(1, tools.length)) };
}

/**
 * Fidelity of the local tokenizer against reference counts: `samples` = [{ label, text,
 * referenceTokens }], `count` = the local tokenizer. Returns per-sample ratios and whether every
 * ratio is within FIDELITY_TOLERANCE of 1. Reference counts come from outside this repo (a real
 * request's `usage.input_tokens`, the Console token counter) — never from an API call here.
 */
export function fidelity(samples, count, tolerance = FIDELITY_TOLERANCE) {
  const rows = samples.map((s) => {
    const local = count(s.text);
    const ratio = s.referenceTokens > 0 ? local / s.referenceTokens : NaN;
    return { label: s.label, model: s.model ?? "", referenceTokens: s.referenceTokens, localTokens: local, ratio, ok: Number.isFinite(ratio) && Math.abs(ratio - 1) <= tolerance };
  });
  const ratios = rows.map((r) => r.ratio).filter(Number.isFinite);
  return { rows, ok: rows.length > 0 && rows.every((r) => r.ok), minRatio: ratios.length ? Math.min(...ratios) : NaN, maxRatio: ratios.length ? Math.max(...ratios) : NaN, tolerance };
}

/**
 * Markdown report. `report` = { version, commit, generatedFrom, instructionsChars,
 * surfaces: { [name]: stats }, tokens?: { models: string[], surfaces: { [name]: { [model]: {...} } } } }.
 * Never includes a timestamp so `--check` can compare it byte for byte.
 */
export function renderReport(report) {
  const lines = [];
  // current.md (no commit) carries no version either, so it changes only when the emitted tools change.
  lines.push(report.commit ? `# tools/list measurement — ${report.version} @ ${report.commit}` : "# tools/list measurement (working tree)");
  lines.push("");
  lines.push(`Generated by \`node scripts/measure-tools.mjs\` from ${report.generatedFrom}. Bytes are UTF-8. "est. tokens" is bytes/3.6 (a proxy); the tokenizer table below is the local count. MCP instructions: ${report.instructionsChars} chars.`);
  lines.push("");
  lines.push("| Surface | Tools | tools/list bytes | model-facing bytes | no \\$schema | descr. chars | schema bytes | p50 / p95 per tool | est. tokens |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const [name, s] of Object.entries(report.surfaces)) {
    lines.push(`| ${name} | ${s.tools} | ${fmt(s.wireBytes)} | ${fmt(s.modelFacingBytes)} | ${fmt(s.modelFacingBytesNoSchemaKey)} | ${fmt(s.descriptionChars)} | ${fmt(s.inputSchemaBytes)} | ${fmt(s.p50WireBytes)} / ${fmt(s.p95WireBytes)} | ~${fmt(estTokens(s.modelFacingBytesNoSchemaKey))} |`);
  }
  if (report.tokens) {
    lines.push("");
    lines.push(`## Local tokenizer (${report.tokens.tokenizer.name} ${report.tokens.tokenizer.version})`);
    lines.push("");
    lines.push("Tokens of the model-facing tool array (name, description, input_schema) as JSON, counted locally — a proxy for what the API bills, validated against reference counts per docs/measurements/README.md. \"stripped\" removes the `$schema` key from every input_schema.");
    lines.push("");
    lines.push("| Surface | Tools | tokens (as emitted) | tokens (stripped) | tokens / tool |");
    lines.push("|---|---|---|---|---|");
    for (const [name, t] of Object.entries(report.tokens.surfaces)) lines.push(`| ${name} | ${t.tools} | ${fmt(t.asEmitted)} | ${fmt(t.stripped)} | ${fmt(t.perTool)} |`);
  }
  const full = report.surfaces.full;
  if (full) {
    lines.push("");
    lines.push("## Ten heaviest tools (full surface)");
    lines.push("");
    lines.push("| Tool | tools/list bytes | model-facing bytes | description chars | schema bytes |");
    lines.push("|---|---|---|---|---|");
    for (const t of full.top10) lines.push(`| \`${t.name}\` | ${fmt(t.wireBytes)} | ${fmt(t.modelFacingBytes)} | ${fmt(t.descriptionChars)} | ${fmt(t.inputSchemaBytes)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));

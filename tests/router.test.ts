/**
 * Router contracts (v1.5 PR-3): the discovery-tool input shapes convert to JSON Schema the
 * way the SDK converts them, and the RouteResult schema accepts a full example while rejecting
 * the shapes PR-6 must never emit. Schemas only — the engine is PR-6.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import { CALL_TOOL_INPUT, CALL_WRITE_TOOL_INPUT, Confidence, DESCRIBE_TOOL_INPUT, ROUTER_PARAMS, RouteCandidate, RouteResult, SEARCH_TOOLS_INPUT } from "../src/tools/_router.js";

const candidate = {
  name: "gmail_search_messages",
  service: "gmail",
  summary: "Search Gmail messages",
  readOnly: true,
  destructive: false,
  listed: true,
  needsConfirm: false,
  params: ["query", "max_results"],
  source: "name",
};
const result = {
  query: "find mail from Dana",
  intent: { service: "gmail", verb: "search", resource: "messages" },
  candidates: [candidate],
  confidence: "high",
  ambiguity: false,
  next_action: "Call gmail_search_messages with query.",
};

describe("_router input shapes", () => {
  it.each([
    ["SEARCH_TOOLS_INPUT", SEARCH_TOOLS_INPUT],
    ["DESCRIBE_TOOL_INPUT", DESCRIBE_TOOL_INPUT],
    ["CALL_TOOL_INPUT", CALL_TOOL_INPUT],
    ["CALL_WRITE_TOOL_INPUT", CALL_WRITE_TOOL_INPUT],
  ])("%s converts to draft-7 JSON Schema like the SDK does", (_name, shape) => {
    const schema = z.object(shape as Record<string, z.ZodType>);
    expect(() => z.toJSONSchema(schema, { target: "draft-7", io: "input" })).not.toThrow();
    const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as { type: string; properties: Record<string, unknown> };
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties)).toEqual(Object.keys(shape));
  });

  it("applies the documented defaults", () => {
    expect(z.object(SEARCH_TOOLS_INPUT).parse({ query: "x" })).toEqual({ query: "x", limit: 3 });
    expect(z.object(CALL_TOOL_INPUT).parse({ name: "gmail_search_messages" })).toEqual({ name: "gmail_search_messages", arguments: {} });
    expect(() => z.object(SEARCH_TOOLS_INPUT).parse({ query: "x", limit: 11 })).toThrow();
    expect(() => z.object(SEARCH_TOOLS_INPUT).parse({ query: "x", limit: 0 })).toThrow();
  });

  it("CALL_WRITE_TOOL_INPUT requires confirm to be exactly true", () => {
    const schema = z.object(CALL_WRITE_TOOL_INPUT);
    expect(schema.parse({ name: "gmail_send_message", confirm: true })).toEqual({ name: "gmail_send_message", arguments: {}, confirm: true });
    expect(() => schema.parse({ name: "gmail_send_message", confirm: false })).toThrow();
    expect(() => schema.parse({ name: "gmail_send_message", confirm: "true" })).toThrow();
    expect(() => schema.parse({ name: "gmail_send_message" })).toThrow();
  });
});

describe("RouteResult", () => {
  it("accepts a full example", () => {
    expect(RouteResult.parse(result)).toEqual(result);
    expect(RouteCandidate.parse(candidate)).toEqual(candidate);
    expect(RouteResult.parse({ ...result, intent: {} }).intent).toEqual({});
  });

  it("rejects a candidate missing needsConfirm", () => {
    const { needsConfirm: _drop, ...partial } = candidate;
    expect(() => RouteResult.parse({ ...result, candidates: [partial] })).toThrow();
    expect(() => RouteCandidate.parse(partial)).toThrow();
  });

  it("rejects a bad confidence", () => {
    expect(() => RouteResult.parse({ ...result, confidence: "certain" })).toThrow();
    expect(() => Confidence.parse("certain")).toThrow();
    expect(Confidence.options).toEqual(["high", "medium", "low"]);
  });

  it("rejects a result missing next_action or ambiguity", () => {
    const { next_action: _n, ...noNext } = result;
    const { ambiguity: _a, ...noAmb } = result;
    expect(() => RouteResult.parse(noNext)).toThrow();
    expect(() => RouteResult.parse(noAmb)).toThrow();
  });
});

describe("ROUTER_PARAMS", () => {
  it("is one constants object and still carries the PR-3 values", () => {
    // PR-6a added the engine's scoring constants to the same object (spec rule #3); the three
    // PR-3 keys keep their reviewed values, and `tests/router-engine.test.ts` pins every key.
    expect(ROUTER_PARAMS).toMatchObject({ maxCandidates: 3, highMargin: 0.25, mediumMargin: 0.1 });
    // `as const`: readonly literal properties (checked by `npm run typecheck` on tests/tsconfig.json).
    expectTypeOf(ROUTER_PARAMS.maxCandidates).toEqualTypeOf<3>();
    expectTypeOf(ROUTER_PARAMS.highMargin).toEqualTypeOf<0.25>();
    expectTypeOf(ROUTER_PARAMS.mediumMargin).toEqualTypeOf<0.1>();
  });
});

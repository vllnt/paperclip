import { describe, expect, it } from "vitest";
import {
  AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH,
  AGENT_CONFIG_MERGE_PATCH_MAX_VALUES,
  describeAgentConfigMergePatchViolation,
  findAgentConfigMergePatchViolation,
} from "./validators/agent.js";
import { updateAgentMergePatchSchema } from "./validators/index.js";

const nested = (levels: number) => JSON.parse(`${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`);

describe("findAgentConfigMergePatchViolation", () => {
  it.each([
    ["constructor", '{"a":{"constructor":1}}', ["a", "constructor"]],
    ["prototype", '{"prototype":1}', ["prototype"]],
    ["__proto__", '{"a":{"__proto__":{"x":1}}}', ["a", "__proto__"]],
    ["a key in an object inside an array", '{"jobs":[1,{"constructor":1}]}', ["jobs", 1, "constructor"]],
    ["a key in an array of arrays", '{"x":[[{"prototype":1}]]}', ["x", 0, 0, "prototype"]],
  ])("finds %s and reports its path", (_label, raw, path) => {
    expect(findAgentConfigMergePatchViolation(JSON.parse(raw))).toMatchObject({ reason: "forbidden_key", path });
  });

  it("returns null for an ordinary patch, nulls included", () => {
    expect(findAgentConfigMergePatchViolation({ heartbeat: { maxDailyRuns: 64 }, gone: null, list: [1, { a: 2 }] })).toBeNull();
    expect(findAgentConfigMergePatchViolation("not an object")).toBeNull();
  });

  it("walks a 5,000-level nesting without overflowing the stack", () => {
    expect(() => findAgentConfigMergePatchViolation(nested(5_000))).not.toThrow();
    expect(findAgentConfigMergePatchViolation(nested(5_000))).toMatchObject({
      reason: "too_deep",
      limit: AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH,
    });
  });

  it("allows exactly the depth limit and refuses one level more", () => {
    expect(findAgentConfigMergePatchViolation(nested(AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH))).toBeNull();
    expect(findAgentConfigMergePatchViolation(nested(AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH + 1))).toMatchObject({ reason: "too_deep" });
  });

  it("counts every value against the limit and stops queuing at it", () => {
    // The patch object and the `list` value count too, so the last fitting list holds two fewer.
    const withinLimit = { list: Array.from({ length: AGENT_CONFIG_MERGE_PATCH_MAX_VALUES - 2 }, (_, index) => index) };
    expect(findAgentConfigMergePatchViolation(withinLimit)).toBeNull();
    const overLimit = { list: Array.from({ length: AGENT_CONFIG_MERGE_PATCH_MAX_VALUES - 1 }, (_, index) => index) };
    expect(findAgentConfigMergePatchViolation(overLimit)).toMatchObject({
      reason: "too_many_values",
      limit: AGENT_CONFIG_MERGE_PATCH_MAX_VALUES,
    });
  });

  it("words each violation with the config name and the path", () => {
    expect(
      describeAgentConfigMergePatchViolation({ reason: "forbidden_key", key: "constructor", path: ["jobs", 2, "constructor"] }, "runtimeConfig"),
    ).toBe('Config key "constructor" is not allowed (runtimeConfig.jobs[2].constructor)');
  });
});

describe("updateAgentMergePatchSchema", () => {
  it.each([
    ["a top-level __proto__ key, which a record parse would drop silently", '{"mergeConfig":true,"adapterConfig":{"__proto__":{"x":1}}}', ["adapterConfig", "__proto__"]],
    ["a constructor key", '{"mergeConfig":true,"adapterConfig":{"env":{"constructor":1}}}', ["adapterConfig", "env", "constructor"]],
    ["a prototype key inside an array", '{"mergeConfig":true,"runtimeConfig":{"jobs":[{"prototype":1}]}}', ["runtimeConfig", "jobs", 0, "prototype"]],
  ])("refuses %s, and names the path", (_label, raw, path) => {
    const parsed = updateAgentMergePatchSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path });
  });

  it("refuses a 5,000-level nesting with a validation issue and no exception", () => {
    const parsed = updateAgentMergePatchSchema.safeParse({ mergeConfig: true, adapterConfig: nested(5_000) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("deeper than");
  });

  it("accepts a patch with nulls, arrays and a realistic size", () => {
    const env = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`VAR_${index}`, { type: "plain", value: "v" }]));
    const parsed = updateAgentMergePatchSchema.safeParse({
      mergeConfig: true,
      adapterConfig: { env, promptTemplate: null, tags: ["a", "b"] },
      runtimeConfig: { heartbeat: { maxDailyRuns: 64 } },
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses a non-object config patch", () => {
    expect(updateAgentMergePatchSchema.safeParse({ mergeConfig: true, runtimeConfig: ["x"] }).success).toBe(false);
  });
});

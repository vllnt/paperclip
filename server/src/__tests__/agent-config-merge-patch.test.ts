import { describe, expect, it } from "vitest";
import { AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH, AGENT_CONFIG_MERGE_PATCH_MAX_VALUES } from "@paperclipai/shared";
import { applyConfigMergePatch, isAtomicAdapterConfigPath } from "../services/agent-config-merge-patch.js";

describe("applyConfigMergePatch", () => {
  it("merges objects recursively, removes null keys and replaces arrays and scalars", () => {
    const target = { heartbeat: { enabled: true, maxDailyRuns: 10, tags: ["a"] }, debug: { verbose: true }, model: "a" };
    const patch = { heartbeat: { maxDailyRuns: 64, tags: ["b"] }, debug: null, model: "b", added: { x: 1 } };
    expect(applyConfigMergePatch(target, patch)).toEqual({
      heartbeat: { enabled: true, maxDailyRuns: 64, tags: ["b"] },
      model: "b",
      added: { x: 1 },
    });
    expect(target).toEqual({ heartbeat: { enabled: true, maxDailyRuns: 10, tags: ["a"] }, debug: { verbose: true }, model: "a" });
  });

  it("replaces adapterConfig env bindings whole instead of mixing their fields", () => {
    const target = { env: { TOKEN: { type: "secret_ref", secretId: "s1", version: 2 }, KEEP: { type: "plain", value: "x" } } };
    const patch = { env: { TOKEN: { type: "plain", value: "literal" } } };
    expect(applyConfigMergePatch(target, patch, isAtomicAdapterConfigPath)).toEqual({
      env: { TOKEN: { type: "plain", value: "literal" }, KEEP: { type: "plain", value: "x" } },
    });
  });

  it("replaces a non-object target and drops nulls inside a new object", () => {
    expect(applyConfigMergePatch({ heartbeat: 5 }, { heartbeat: { enabled: true, gone: null } })).toEqual({
      heartbeat: { enabled: true },
    });
  });

  it("rejects a __proto__ key at any depth", () => {
    const patch = JSON.parse('{"heartbeat":{"__proto__":{"polluted":true}}}');
    expect(() => applyConfigMergePatch({}, patch)).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["constructor", '{"heartbeat":{"constructor":{"x":1}}}', "heartbeat.constructor"],
    ["prototype", '{"env":{"prototype":{"type":"plain","value":"x"}}}', "env.prototype"],
    ["__proto__", '{"__proto__":{"polluted":true}}', "__proto__"],
    ["a key inside an array", '{"jobs":[{"name":"a"},{"nested":{"constructor":1}}]}', "jobs[1].nested.constructor"],
    ["a __proto__ key inside an array", '{"jobs":[{"__proto__":{"polluted":true}}]}', "jobs[0].__proto__"],
  ])("rejects %s with a 400 that names the path, and merges nothing", (_label, rawPatch, where) => {
    const target = { heartbeat: { enabled: true } };
    let failure: unknown;
    try {
      applyConfigMergePatch(target, JSON.parse(rawPatch), undefined, "runtimeConfig");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 400 });
    expect(failure).toHaveProperty("message", expect.stringContaining(`runtimeConfig.${where}`));
    expect(target).toEqual({ heartbeat: { enabled: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("answers a 5,000-level nesting with a 400 and never overflows the stack", () => {
    const patch = JSON.parse(`${'{"a":'.repeat(5_000)}1${"}".repeat(5_000)}`);
    let failure: unknown;
    try {
      applyConfigMergePatch({}, patch);
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBeInstanceOf(RangeError);
    expect(failure).toMatchObject({ status: 400 });
    expect(failure).toHaveProperty("message", expect.stringContaining(`deeper than ${AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH}`));
  });

  it("accepts a patch nested exactly to the depth limit and refuses one level more", () => {
    const nested = (levels: number) => JSON.parse(`${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`);
    expect(() => applyConfigMergePatch({}, nested(AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH))).not.toThrow();
    expect(() => applyConfigMergePatch({}, nested(AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH + 1))).toThrow(/deeper than/);
  });

  it("refuses a patch with more values than the limit, even when it is flat", () => {
    const values = Array.from({ length: AGENT_CONFIG_MERGE_PATCH_MAX_VALUES }, (_, index) => index);
    let failure: unknown;
    try {
      applyConfigMergePatch({}, { list: values });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 400 });
    expect(failure).toHaveProperty("message", expect.stringContaining(`more than ${AGENT_CONFIG_MERGE_PATCH_MAX_VALUES} values`));
  });

  it("still merges a large realistic config: hundreds of env bindings and a deep structure", () => {
    const env = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`VAR_${index}`, { type: "plain", value: `value-${index}` }]),
    );
    const deep = JSON.parse(`${'{"level":'.repeat(20)}"leaf"${"}".repeat(20)}`);
    const merged = applyConfigMergePatch({ keep: true }, { env, deep }, isAtomicAdapterConfigPath);
    expect(merged).toMatchObject({ keep: true, deep });
    expect(Object.keys(merged.env as object)).toHaveLength(500);
  });

  it("treats env entries and workspaceStrategy as atomic", () => {
    expect(isAtomicAdapterConfigPath(["workspaceStrategy"])).toBe(true);
    expect(isAtomicAdapterConfigPath(["env", "TOKEN"])).toBe(true);
    expect(isAtomicAdapterConfigPath(["env"])).toBe(false);
    expect(isAtomicAdapterConfigPath(["env", "TOKEN", "value"])).toBe(false);
    expect(isAtomicAdapterConfigPath(["model"])).toBe(false);
  });
});

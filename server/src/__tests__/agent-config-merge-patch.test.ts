import { describe, expect, it } from "vitest";
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

  it("treats env entries and workspaceStrategy as atomic", () => {
    expect(isAtomicAdapterConfigPath(["workspaceStrategy"])).toBe(true);
    expect(isAtomicAdapterConfigPath(["env", "TOKEN"])).toBe(true);
    expect(isAtomicAdapterConfigPath(["env"])).toBe(false);
    expect(isAtomicAdapterConfigPath(["env", "TOKEN", "value"])).toBe(false);
    expect(isAtomicAdapterConfigPath(["model"])).toBe(false);
  });
});

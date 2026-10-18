import { describe, expect, it } from "vitest";
import {
  agentRuntimeConfigSchema,
  createAgentHireSchema,
  createAgentSchema,
  updateAgentSchema,
} from "./agent.js";

const aiConnection = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;
const base = { name: "Bound agent", adapterType: "claude_local" } as const;

describe("runtimeConfig.aiConnection in agent schemas", () => {
  it("lets an update send null to unbind, and keeps the key absent when omitted", () => {
    const cleared = updateAgentSchema.parse({ runtimeConfig: { aiConnection: null, note: "kept" } });
    expect(cleared.runtimeConfig).toEqual({ aiConnection: null, note: "kept" });
    const omitted = updateAgentSchema.parse({ runtimeConfig: { note: "kept" } });
    expect(Object.prototype.hasOwnProperty.call(omitted.runtimeConfig, "aiConnection")).toBe(false);
    expect(updateAgentSchema.parse({}).runtimeConfig).toBeUndefined();
  });

  it("still validates a new binding on update", () => {
    expect(updateAgentSchema.parse({ runtimeConfig: { aiConnection } }).runtimeConfig?.aiConnection).toEqual(aiConnection);
    expect(updateAgentSchema.safeParse({ runtimeConfig: { aiConnection: { provider: "anthropic" } } }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ runtimeConfig: { aiConnection: "managed" } }).success).toBe(false);
  });

  it("does not widen create, hire, or the exported runtime config schema to null", () => {
    const runtimeConfig = { aiConnection: null };
    expect(createAgentSchema.safeParse({ ...base, runtimeConfig }).success).toBe(false);
    expect(createAgentHireSchema.safeParse({ ...base, runtimeConfig }).success).toBe(false);
    expect(agentRuntimeConfigSchema.safeParse(runtimeConfig).success).toBe(false);
    expect(createAgentSchema.parse({ ...base, runtimeConfig: { aiConnection } }).runtimeConfig.aiConnection).toEqual(aiConnection);
    expect(agentRuntimeConfigSchema.parse({ aiConnection }).aiConnection).toEqual(aiConnection);
  });

  it("keeps rejecting the retired modelProfiles key on create and update", () => {
    expect(createAgentSchema.safeParse({ ...base, runtimeConfig: { modelProfiles: {} } }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ runtimeConfig: { aiConnection: null, modelProfiles: {} } }).success).toBe(false);
  });
});

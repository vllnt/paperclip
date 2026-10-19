import { describe, expect, it } from "vitest";

import {
  ROUTINE_GATE_LIMITS,
  routineGateAppliesToSource,
  routineGateSchema,
  routineGatesEqual,
} from "./routine-gate.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const base = { repo: "vllnt/paperclip-gates", path: "gates/pr-open.sh", commitSha: SHA };

describe("routineGateSchema", () => {
  it("fills the defaults", () => {
    const gate = routineGateSchema.parse(base);
    expect(gate).toEqual({
      ...base,
      interpreter: "sh",
      args: [],
      timeoutSec: ROUTINE_GATE_LIMITS.timeoutDefaultSec,
      appliesTo: ["schedule", "webhook", "event"],
    });
  });

  it("lowercases the commit SHA and trims text", () => {
    const gate = routineGateSchema.parse({ ...base, repo: " vllnt/paperclip-gates ", commitSha: SHA.toUpperCase() });
    expect(gate.commitSha).toBe(SHA);
    expect(gate.repo).toBe("vllnt/paperclip-gates");
  });

  it.each([
    ["a branch name", "main"],
    ["a short SHA", "0123456"],
    ["a 41-character SHA", `${SHA}0`],
    ["non-hex characters", "z".repeat(40)],
  ])("rejects %s as the pinned commit", (_label, commitSha) => {
    expect(routineGateSchema.safeParse({ ...base, commitSha }).success).toBe(false);
  });

  it.each(["noslash", "a/b/c", "owner/", "/name", "owner/na me", "owner/na;me", "-x/ y"])("rejects repo %j", (repo) => {
    expect(routineGateSchema.safeParse({ ...base, repo }).success).toBe(false);
  });

  it.each([
    "/etc/passwd",
    "../gate.sh",
    "gates/../../x.sh",
    "gates//x.sh",
    "gates/./x.sh",
    "gates/",
    "gates/x y.sh",
    "gates/$(id).sh",
    "gates/x.sh;rm",
    "gates/`id`.sh",
    "",
  ])("rejects path %j", (path) => {
    expect(routineGateSchema.safeParse({ ...base, path }).success).toBe(false);
  });

  it("accepts a nested path with common punctuation", () => {
    expect(routineGateSchema.safeParse({ ...base, path: "gates/v2/pr_open-1.0+x@y.py" }).success).toBe(true);
  });

  it("rejects an interpreter outside the allowlist", () => {
    expect(routineGateSchema.safeParse({ ...base, interpreter: "node" }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, interpreter: "perl" }).success).toBe(false);
    for (const interpreter of ["sh", "bash", "python3"]) {
      expect(routineGateSchema.safeParse({ ...base, interpreter }).success).toBe(true);
    }
  });

  it("enforces the timeout bounds", () => {
    expect(routineGateSchema.safeParse({ ...base, timeoutSec: ROUTINE_GATE_LIMITS.timeoutMinSec - 1 }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, timeoutSec: ROUTINE_GATE_LIMITS.timeoutMaxSec + 1 }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, timeoutSec: 30.5 }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, timeoutSec: ROUTINE_GATE_LIMITS.timeoutMinSec }).success).toBe(true);
    expect(routineGateSchema.safeParse({ ...base, timeoutSec: ROUTINE_GATE_LIMITS.timeoutMaxSec }).success).toBe(true);
  });

  it("limits the number, length and content of args", () => {
    const tooMany = Array.from({ length: ROUTINE_GATE_LIMITS.maxArgs + 1 }, () => "x");
    expect(routineGateSchema.safeParse({ ...base, args: tooMany }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, args: ["x".repeat(ROUTINE_GATE_LIMITS.argMaxLength + 1)] }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, args: ["line\nbreak"] }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, args: ["nul\u0000byte"] }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, args: ["--flag", "with space", "quote'd"] }).success).toBe(true);
  });

  it("limits appliesTo to schedule, webhook and event", () => {
    expect(routineGateSchema.safeParse({ ...base, appliesTo: ["api"] }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, appliesTo: ["manual"] }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, appliesTo: [] }).success).toBe(false);
    expect(routineGateSchema.parse({ ...base, appliesTo: ["event", "event", "schedule"] }).appliesTo).toEqual([
      "event",
      "schedule",
    ]);
  });

  it("rejects unknown keys, so an inline script cannot be smuggled in", () => {
    expect(routineGateSchema.safeParse({ ...base, script: "echo hi" }).success).toBe(false);
    expect(routineGateSchema.safeParse({ ...base, content: "echo hi" }).success).toBe(false);
  });
});

describe("routineGateAppliesToSource", () => {
  const gate = routineGateSchema.parse({ ...base, appliesTo: ["schedule", "event"] });

  it("is true only for the listed trigger kinds", () => {
    expect(routineGateAppliesToSource(gate, "schedule")).toBe(true);
    expect(routineGateAppliesToSource(gate, "event")).toBe(true);
    expect(routineGateAppliesToSource(gate, "webhook")).toBe(false);
  });

  it("never applies to a manual run or the api", () => {
    const all = routineGateSchema.parse(base);
    expect(routineGateAppliesToSource(all, "manual")).toBe(false);
    expect(routineGateAppliesToSource(all, "api")).toBe(false);
  });

  it("is false without a gate", () => {
    expect(routineGateAppliesToSource(null, "schedule")).toBe(false);
    expect(routineGateAppliesToSource(undefined, "schedule")).toBe(false);
  });
});

describe("routineGatesEqual", () => {
  const gate = routineGateSchema.parse({ ...base, args: ["a", "b"], appliesTo: ["schedule", "event"] });

  it("treats two nulls as equal and null versus a gate as different", () => {
    expect(routineGatesEqual(null, undefined)).toBe(true);
    expect(routineGatesEqual(gate, null)).toBe(false);
    expect(routineGatesEqual(null, gate)).toBe(false);
  });

  it("ignores appliesTo order but not argument order", () => {
    expect(routineGatesEqual(gate, { ...gate, appliesTo: ["event", "schedule"] })).toBe(true);
    expect(routineGatesEqual(gate, { ...gate, args: ["b", "a"] })).toBe(false);
  });

  it.each([
    ["repo", { repo: "vllnt/other" }],
    ["path", { path: "gates/other.sh" }],
    ["commitSha", { commitSha: "f".repeat(40) }],
    ["interpreter", { interpreter: "bash" as const }],
    ["timeoutSec", { timeoutSec: 60 }],
  ])("detects a changed %s", (_field, patch) => {
    expect(routineGatesEqual(gate, { ...gate, ...patch })).toBe(false);
  });
});

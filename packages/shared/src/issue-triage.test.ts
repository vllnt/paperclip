import { describe, expect, it } from "vitest";
import {
  ISSUE_TRIAGE_MAX_MODEL_CALLS,
  ISSUE_TRIAGE_MODES,
  ISSUE_TRIAGE_THRESHOLDS,
  issueTriageEntrySchema,
  listIssueTriageQuerySchema,
} from "./issue-triage.js";
import { updateCompanySchema } from "./validators/company.js";

describe("issue triage constants", () => {
  it("keeps the rollout order and the agreed bounds", () => {
    expect(ISSUE_TRIAGE_MODES).toEqual(["off", "suggest", "apply"]);
    expect(ISSUE_TRIAGE_THRESHOLDS).toEqual({ ownerMinProbability: 0.8, ownerMinMargin: 0.2 });
    expect(ISSUE_TRIAGE_MAX_MODEL_CALLS).toBe(6);
  });
});

describe("updateCompanySchema issueTriageMode", () => {
  it("accepts the three modes and nothing else", () => {
    for (const mode of ISSUE_TRIAGE_MODES) {
      expect(updateCompanySchema.safeParse({ issueTriageMode: mode }).success).toBe(true);
    }
    expect(updateCompanySchema.safeParse({ issueTriageMode: "comment" }).success).toBe(false);
  });

  it("does not set a mode when the field is absent", () => {
    expect(updateCompanySchema.parse({ name: "x" })).toEqual({ name: "x" });
  });
});

describe("listIssueTriageQuerySchema", () => {
  it("coerces the limit and bounds it", () => {
    expect(listIssueTriageQuerySchema.parse({ limit: "5" })).toEqual({ limit: 5 });
    expect(listIssueTriageQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listIssueTriageQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(listIssueTriageQuerySchema.safeParse({ extra: "x" }).success).toBe(false);
  });
});

describe("issueTriageEntrySchema", () => {
  const entry = {
    version: 1,
    issueId: "i",
    companyId: "c",
    mode: "suggest",
    outcome: "suggested",
    reason: null,
    modelId: "typesafe-ai/jev",
    modelCalls: 1,
    inputHashes: ["h"],
    thresholds: { ownerMinProbability: 0.8, ownerMinMargin: 0.2 },
    priority: null,
    category: null,
    owner: null,
  };

  it("accepts a stored entry and rejects another shape", () => {
    expect(issueTriageEntrySchema.safeParse(entry).success).toBe(true);
    expect(issueTriageEntrySchema.safeParse({ ...entry, version: 2 }).success).toBe(false);
    expect(issueTriageEntrySchema.safeParse({ ...entry, outcome: "other" }).success).toBe(false);
  });
});

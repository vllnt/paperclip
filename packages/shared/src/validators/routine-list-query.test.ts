import { describe, expect, it } from "vitest";
import { listRoutinesQuerySchema, parseListRoutinesQuery } from "./routine.js";

const agentId = "11111111-1111-4111-8111-111111111111";
// Not a v4 UUID; the other routine validators accept it, so the list filters do too.
const legacyId = "22222222-2222-2222-2222-222222222222";

describe("parseListRoutinesQuery", () => {
  it("returns no filter for an empty query, and drops blank and unknown parameters", () => {
    expect(parseListRoutinesQuery({})).toEqual({});
    expect(parseListRoutinesQuery({ q: "", status: "  ", folderId: "", unknown: "1" })).toEqual({});
  });

  it("trims q and keeps every known filter", () => {
    expect(
      parseListRoutinesQuery({
        q: "  weekly review ",
        assigneeAgentId: agentId,
        folderId: "none",
        projectId: legacyId,
        status: "paused",
        trigger: "manual",
      }),
    ).toEqual({
      q: "weekly review",
      assigneeAgentId: agentId,
      folderId: "none",
      projectId: legacyId,
      status: "paused",
      trigger: "manual",
    });
    expect(parseListRoutinesQuery({ folderId: legacyId })).toEqual({ folderId: legacyId });
  });

  it.each([
    ["an unknown status", { status: "sleeping" }],
    ["an unknown trigger", { trigger: "cron" }],
    ["an agent id that is not a UUID", { assigneeAgentId: "not-a-uuid" }],
    ["a folder id that is neither a UUID nor none", { folderId: "nope" }],
    ["a q longer than 200 characters", { q: "x".repeat(201) }],
    ["a q with a NUL character", { q: "weekly\u0000" }],
    ["a repeated parameter", { status: ["active", "paused"] }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseListRoutinesQuery(raw)).toThrow();
  });

  it("keeps the schema itself free of preprocessing, so OpenAPI sees optional typed fields", () => {
    expect(listRoutinesQuerySchema.parse({})).toEqual({});
    expect(listRoutinesQuerySchema.safeParse({ status: "" }).success).toBe(false);
  });
});

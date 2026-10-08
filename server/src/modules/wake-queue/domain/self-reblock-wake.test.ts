import { describe, expect, it } from "vitest";
import {
  decideSelfReblockWakeLimit,
  deriveSelfReblockWakeMarker,
  isSelfReblockWakeOwner,
  mergeSelfReblockWakePayload,
  readSelfReblockWakeMarker,
  readSelfReblockWakeParkedUntil,
  SELF_REBLOCK_WAKE_LIMIT,
  SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY,
  SELF_REBLOCK_WAKE_PAYLOAD_KEY,
  SELF_REBLOCK_WAKE_WINDOW_MS,
} from "./self-reblock-wake.js";

const AGENT = "agent-a";

describe("self-reblock wake provenance", () => {
  it("marks only the woken agent's own unblock/re-block cycle wakes", () => {
    expect(
      deriveSelfReblockWakeMarker({
        agentId: AGENT,
        reason: "issue_unblock_requested",
        mutation: undefined,
        causeActorType: "agent",
        causeActorId: AGENT,
      }),
    ).toEqual({ agentId: AGENT, reason: "issue_unblock_requested", causeActorType: "agent", causeActorId: AGENT });
    expect(
      deriveSelfReblockWakeMarker({
        agentId: AGENT,
        reason: "issue_blockers_resolved",
        mutation: "blocked_dependency_restored",
        causeActorType: "agent",
        causeActorId: AGENT,
      }),
    ).toMatchObject({ reason: "issue_blockers_resolved" });
  });

  it.each([
    ["the board", "user", "board-user", "issue_blockers_resolved", "blocked_dependency_restored"],
    ["another agent", "agent", "agent-b", "issue_blockers_resolved", "blocked_dependency_restored"],
    ["another agent's unblock request", "agent", "agent-b", "issue_unblock_requested", undefined],
    ["the system", "system", null, "issue_unblock_requested", undefined],
    ["the agent completing a real blocker", "agent", AGENT, "issue_blockers_resolved", "blocker_done"],
    ["an unrelated self wake", "agent", AGENT, "issue_commented", "comment"],
  ])("never marks a wake caused by %s", (_label, causeActorType, causeActorId, reason, mutation) => {
    expect(
      deriveSelfReblockWakeMarker({ agentId: AGENT, reason, mutation, causeActorType, causeActorId }),
    ).toBeNull();
  });

  it("reads a marker only for the agent it names", () => {
    const payload = {
      [SELF_REBLOCK_WAKE_PAYLOAD_KEY]: { agentId: AGENT, reason: "issue_unblock_requested", causeActorId: AGENT },
    };
    expect(readSelfReblockWakeMarker(payload, AGENT)).toMatchObject({ reason: "issue_unblock_requested" });
    expect(readSelfReblockWakeMarker(payload, "agent-b")).toBeNull();
    expect(readSelfReblockWakeMarker({ [SELF_REBLOCK_WAKE_PAYLOAD_KEY]: "forged" }, AGENT)).toBeNull();
  });

  it("keeps a merged wake self-caused only when every contribution is", () => {
    const self = {
      [SELF_REBLOCK_WAKE_PAYLOAD_KEY]: { agentId: AGENT, reason: "issue_unblock_requested", causeActorId: AGENT },
    };
    const parked = { ...self, [SELF_REBLOCK_WAKE_PARKED_PAYLOAD_KEY]: { notBefore: "2026-10-08T00:10:00.000Z" } };
    const board = { issueId: "issue-1", mutation: "blocker_done" };

    const bothSelf = mergeSelfReblockWakePayload({
      agentId: AGENT,
      existingPayload: self,
      incomingPayload: self,
      mergedPayload: { ...self, ...self },
    });
    expect(readSelfReblockWakeMarker(bothSelf, AGENT)).not.toBeNull();

    // A board unblock merged into a self wake lifts the marker.
    const withBoard = mergeSelfReblockWakePayload({
      agentId: AGENT,
      existingPayload: self,
      incomingPayload: board,
      mergedPayload: { ...self, ...board },
    });
    expect(readSelfReblockWakeMarker(withBoard, AGENT)).toBeNull();

    // Parked wakes are never merge targets; a merge never carries a hold.
    const neverParked = mergeSelfReblockWakePayload({
      agentId: AGENT,
      existingPayload: parked,
      incomingPayload: self,
      mergedPayload: { ...parked, ...self },
    });
    expect(readSelfReblockWakeParkedUntil(neverParked)).toBeNull();

    // A self wake merged into a board wake does not taint it either.
    const intoBoard = mergeSelfReblockWakePayload({
      agentId: AGENT,
      existingPayload: board,
      incomingPayload: self,
      mergedPayload: { ...board, ...self },
    });
    expect(readSelfReblockWakeMarker(intoBoard, AGENT)).toBeNull();
  });

  it("treats only the agent whose run holds the issue as the owner", () => {
    expect(isSelfReblockWakeOwner({ agentId: AGENT, holdingRunAgentId: AGENT })).toBe(true);
    expect(isSelfReblockWakeOwner({ agentId: AGENT, holdingRunAgentId: "agent-b" })).toBe(false);
    // Assigned but not running on the issue: the wake is still news.
    expect(isSelfReblockWakeOwner({ agentId: AGENT, holdingRunAgentId: null })).toBe(false);
  });

  it("parks, rather than drops, wakes over the limit until the window passes", () => {
    const now = new Date("2026-10-08T00:00:00.000Z");
    expect(decideSelfReblockWakeLimit({ recentSelfReblockRunCount: SELF_REBLOCK_WAKE_LIMIT - 1, now })).toEqual({
      kind: "allow",
    });
    expect(decideSelfReblockWakeLimit({ recentSelfReblockRunCount: SELF_REBLOCK_WAKE_LIMIT, now })).toEqual({
      kind: "park",
      notBefore: new Date(now.getTime() + SELF_REBLOCK_WAKE_WINDOW_MS),
    });
  });
});

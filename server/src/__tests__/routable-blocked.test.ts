import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  assertAgentMayChangeBlock,
  deliverAgentUnblockNotification,
  handsBlockToHuman,
  HUMAN_OWNED_BLOCK_MESSAGE,
  isHumanOwnedBlock,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });
});

describe("human-owned blocks", () => {
  const boardBlock = { status: "blocked", unblockDescriptor: { owner: "board", action: "Approve" } } as const;
  const userBlock = { status: "blocked", unblockDescriptor: { owner: { userId: "user-1" }, action: "Sign" } } as const;
  const agentBlock = { status: "blocked", unblockDescriptor: { owner: { agentId }, action: "Wait" } } as const;

  it("treats a blocked issue owned by the board or a person as human-owned", () => {
    expect(isHumanOwnedBlock(boardBlock)).toBe(true);
    expect(isHumanOwnedBlock(userBlock)).toBe(true);
    expect(isHumanOwnedBlock(agentBlock)).toBe(false);
    expect(isHumanOwnedBlock({ status: "blocked", unblockDescriptor: null })).toBe(false);
    expect(isHumanOwnedBlock({ status: "in_progress", unblockDescriptor: boardBlock.unblockDescriptor })).toBe(false);
  });

  it("refuses an agent that leaves a human-owned block or rewrites its descriptor", () => {
    const refused = [
      { status: "todo" },
      { status: "in_progress" },
      { unblockDescriptor: null },
      { unblockDescriptor: { owner: { agentId }, action: "Never mind" } },
      { unblockDescriptor: { owner: "board", action: "A different action" } },
    ] as const;
    for (const change of refused) {
      for (const stored of [boardBlock, userBlock]) {
        let thrown: unknown = null;
        try {
          assertAgentMayChangeBlock(stored, change);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, JSON.stringify(change)).toBeInstanceOf(HttpError);
        expect(thrown).toMatchObject({ status: 403, message: HUMAN_OWNED_BLOCK_MESSAGE });
      }
    }
  });

  it("allows an agent to keep a human-owned block as it is, and to change anything on other blocks", () => {
    expect(() => assertAgentMayChangeBlock(boardBlock, {})).not.toThrow();
    expect(() => assertAgentMayChangeBlock(boardBlock, { status: "blocked" })).not.toThrow();
    expect(() => assertAgentMayChangeBlock(boardBlock, { unblockDescriptor: boardBlock.unblockDescriptor })).not.toThrow();
    expect(() => assertAgentMayChangeBlock(agentBlock, { status: "todo" })).not.toThrow();
    expect(() => assertAgentMayChangeBlock(agentBlock, { unblockDescriptor: null })).not.toThrow();
    expect(() => assertAgentMayChangeBlock({ status: "todo" }, { status: "in_progress" })).not.toThrow();
  });

  it("hands a block to a human only when an existing block that is not human-owned gets a human owner", () => {
    const toBoard = { unblockDescriptor: { owner: "board", action: "Approve" } } as const;
    expect(handsBlockToHuman(agentBlock, toBoard)).toBe(true);
    expect(handsBlockToHuman({ status: "blocked", unblockDescriptor: null }, toBoard)).toBe(true);
    expect(handsBlockToHuman(agentBlock, { unblockDescriptor: userBlock.unblockDescriptor })).toBe(true);
    expect(handsBlockToHuman(boardBlock, toBoard)).toBe(false);
    expect(handsBlockToHuman(agentBlock, { unblockDescriptor: agentBlock.unblockDescriptor })).toBe(false);
    expect(handsBlockToHuman(agentBlock, {})).toBe(false);
    expect(handsBlockToHuman({ status: "todo" }, toBoard)).toBe(false);
    expect(handsBlockToHuman(agentBlock, { status: "todo", ...toBoard })).toBe(false);
  });
});

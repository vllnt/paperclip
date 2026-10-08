import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

describe("issue assignment wakeup delivery", () => {
  it("retries a transient queue failure with one durable idempotency key", async () => {
    const wakeup = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary queue failure"))
      .mockResolvedValueOnce({ id: "run-1" });

    const result = await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(result).toEqual({ id: "run-1" });
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: "issue-assignment:issue-1:issue_assigned",
      payload: { issueId: "issue-1", mutation: "update" },
    });
    expect(wakeup.mock.calls[1]?.[1]).toMatchObject({
      idempotencyKey: "issue-assignment:issue-1:issue_assigned",
    });
  });
});

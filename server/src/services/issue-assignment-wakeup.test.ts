import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { FailedChatRunRetryAuthorizationError } from "./durable-chat-wakeup.js";
import {
  buildIssueAssignmentIdempotencyKey,
  parseIssueAssignmentIdempotencyKey,
  queueIssueAssignmentWakeup,
} from "./issue-assignment-wakeup.js";

function pgError(code: string) {
  return Object.assign(new Error(`postgres ${code}`), { code });
}

function wrapped(cause: Error) {
  // Drizzle surfaces driver failures as `Failed query` with the driver error as cause.
  return new Error("Failed query: insert into agent_wakeup_requests", { cause });
}

function assign(
  wakeup: (agentId: string, opts: unknown) => Promise<unknown>,
  input: { assigneeAgentId: string; assignmentGeneration?: number; rethrowOnError?: boolean },
) {
  return queueIssueAssignmentWakeup({
    heartbeat: { wakeup },
    issue: { id: "issue-1", assigneeAgentId: input.assigneeAgentId, status: "todo", statusVersion: input.assignmentGeneration ?? 1 },
    reason: "issue_assigned",
    mutation: "update",
    contextSource: "issue.update",
    requestedByActorType: "user",
    requestedByActorId: "board-user",
    rethrowOnError: input.rethrowOnError ?? true,
  });
}

describe("issue assignment wakeup delivery", () => {
  it("parses only the reserved key shape", () => {
    expect(parseIssueAssignmentIdempotencyKey("issue-assignment:issue-1:agent-a:4")).toEqual({
      issueId: "issue-1", assigneeAgentId: "agent-a", assignmentGeneration: 4,
    });
    expect(parseIssueAssignmentIdempotencyKey("issue-assignment:issue-1:agent-a:not-a-generation")).toBeNull();
    expect(parseIssueAssignmentIdempotencyKey("issue-assignment:issue-1:agent-a:4:extra")).toBeNull();
  });

  it("gives A -> B -> A three distinct keys naming the assignee and generation", async () => {
    const wakeup = vi.fn(async (_agentId: string, _opts: unknown) => ({ id: "run" }));
    await assign(wakeup, { assigneeAgentId: "agent-a", assignmentGeneration: 4 });
    await assign(wakeup, { assigneeAgentId: "agent-b", assignmentGeneration: 5 });
    await assign(wakeup, { assigneeAgentId: "agent-a", assignmentGeneration: 6 });

    const keys = wakeup.mock.calls.map((call) => (call[1] as { idempotencyKey?: string }).idempotencyKey);
    expect(keys).toEqual([
      "issue-assignment:issue-1:agent-a:4",
      "issue-assignment:issue-1:agent-b:5",
      "issue-assignment:issue-1:agent-a:6",
    ]);
    expect(new Set(keys).size).toBe(3);
    expect(buildIssueAssignmentIdempotencyKey({ issueId: "issue-1", assigneeAgentId: "agent-a", assignmentGeneration: 4 }))
      .toBe(keys[0]);
  });

  it.each([
    ["a closed connection", wrapped(Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" }))],
    ["a serialization failure", wrapped(pgError("40001"))],
    ["a deadlock", wrapped(pgError("40P01"))],
  ])("retries %s with the same idempotency key", async (_label, error) => {
    const wakeup = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ id: "run-1" });

    await expect(assign(wakeup, { assigneeAgentId: "agent-a", assignmentGeneration: 7 })).resolves.toEqual({ id: "run-1" });
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: "issue-assignment:issue-1:agent-a:7" });
    expect(wakeup.mock.calls[1]?.[1]).toMatchObject({ idempotencyKey: "issue-assignment:issue-1:agent-a:7" });
  });

  it.each([
    ["an authorization denial", new HttpError(403, "Agent cannot be woken by this actor")],
    ["a policy conflict", new HttpError(409, "Company is not active")],
    ["a validation error", new HttpError(422, "Unable to resolve responsible user")],
    ["a failed-chat authorization denial", new FailedChatRunRetryAuthorizationError()],
    ["a revoked chat binding", new Error("reach revoked")],
    ["a unique violation", wrapped(pgError("23505"))],
  ])("never retries %s", async (_label, error) => {
    const wakeup = vi.fn().mockRejectedValue(error);

    await expect(assign(wakeup, { assigneeAgentId: "agent-a", assignmentGeneration: 8 })).rejects.toBe(error);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("stops after three attempts when the failure stays transient", async () => {
    const error = wrapped(pgError("40001"));
    const wakeup = vi.fn().mockRejectedValue(error);

    await expect(assign(wakeup, { assigneeAgentId: "agent-a", assignmentGeneration: 9 })).rejects.toBe(error);
    expect(wakeup).toHaveBeenCalledTimes(3);
  });

  it("derives the assignment generation only from the server issue snapshot", async () => {
    const wakeup = vi.fn(async (_agentId: string, _opts: unknown) => ({ id: "run-1" }));
    await expect(assign(wakeup, { assigneeAgentId: "agent-a" })).resolves.toEqual({ id: "run-1" });
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: "issue-assignment:issue-1:agent-a:1" });
  });
});

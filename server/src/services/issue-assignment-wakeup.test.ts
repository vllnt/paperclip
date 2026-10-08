import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { FailedChatRunRetryAuthorizationError } from "./durable-chat-wakeup.js";
import {
  buildIssueAssignmentIdempotencyKey,
  decideIssueAssignmentWakeRefusal,
  ISSUE_ASSIGNMENT_WAKE_REFUSAL_LOG_LEVEL,
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
    assignmentEvent: true,
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

  /** A wake that is not an assignment event (checkout, plugin, secret, tree resume). */
  function nonAssignmentWake(
    wakeup: (agentId: string, opts: unknown) => Promise<unknown>,
    idempotencyKey?: string,
  ) {
    return queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-a", status: "in_progress", statusVersion: 4 },
      reason: "secret_proposal_resolved",
      mutation: "secret_proposal_approved",
      contextSource: "secret.proposal.resolution",
      ...(idempotencyKey ? { wakeupOptions: { idempotencyKey } } : {}),
      rethrowOnError: true,
    });
  }

  it("gives a non-assignment wake no assignment key, so it never replays an old assignment receipt", async () => {
    const wakeup = vi.fn(async (_agentId: string, _opts: unknown) => ({ id: "run-1" }));
    await nonAssignmentWake(wakeup);
    await nonAssignmentWake(wakeup, "plugin:acme.github:wake-1");

    expect(wakeup.mock.calls[0]?.[1]).not.toHaveProperty("idempotencyKey");
    // A producer's own namespaced key is kept as is.
    expect(wakeup.mock.calls[1]?.[1]).toMatchObject({ idempotencyKey: "plugin:acme.github:wake-1" });
  });

  it("rejects a caller-supplied key in the reserved assignment namespace", async () => {
    const wakeup = vi.fn(async (_agentId: string, _opts: unknown) => ({ id: "run-1" }));
    await expect(nonAssignmentWake(wakeup, "issue-assignment:issue-1:agent-a:4"))
      .rejects.toThrow("reserved for assignment events");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("never retries a non-assignment wake: without the key a replay could run it twice", async () => {
    const error = wrapped(Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" }));
    const wakeup = vi.fn().mockRejectedValue(error);
    await expect(nonAssignmentWake(wakeup)).rejects.toBe(error);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("admits an assignment key for the current assignee up to the locked generation", () => {
    const key = { issueId: "issue-1", assigneeAgentId: "agent-a", assignmentGeneration: 4 };
    const lockedIssue = { id: "issue-1", assigneeAgentId: "agent-a", statusVersion: 4 };
    const decide = (overrides: Partial<Parameters<typeof decideIssueAssignmentWakeRefusal>[0]>) =>
      decideIssueAssignmentWakeRefusal({ key, wakeAgentId: "agent-a", lockedIssue, newestRecordedGeneration: null, ...overrides });

    expect(decide({})).toBeNull();
    // A status-only change after the assignment advanced the version (R3-R).
    expect(decide({ lockedIssue: { ...lockedIssue, statusVersion: 6 } })).toBeNull();
    // Its own receipt (a replay) is not newer than itself.
    expect(decide({ newestRecordedGeneration: 4 })).toBeNull();

    expect(decide({ key: null })).toBe("malformed_key");
    expect(decide({ lockedIssue: null })).toBe("assignee_mismatch");
    expect(decide({ wakeAgentId: "agent-b" })).toBe("assignee_mismatch");
    expect(decide({ lockedIssue: { ...lockedIssue, assigneeAgentId: "agent-b" } })).toBe("assignee_mismatch");
    expect(decide({ lockedIssue: { ...lockedIssue, id: "issue-2" } })).toBe("assignee_mismatch");
    expect(decide({ lockedIssue: { ...lockedIssue, statusVersion: 3 } })).toBe("generation_ahead");
    // A -> B -> A recorded newer generations, so A's first key is stale.
    expect(decide({ newestRecordedGeneration: 6 })).toBe("superseded");
  });

  it("warns for a stale wake after a quick reassignment and errors for an impossible key", () => {
    expect(ISSUE_ASSIGNMENT_WAKE_REFUSAL_LOG_LEVEL).toEqual({
      assignee_mismatch: "warn",
      superseded: "warn",
      generation_ahead: "error",
      malformed_key: "error",
    });
  });
});

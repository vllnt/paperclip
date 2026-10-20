import { describe, expect, it } from "vitest";
import { THREAD_WINDOW_DEFAULTS, type ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  CONTINUATION_ENVELOPE_MAX_CHARS,
  CONTINUATION_PINNED_COMMENT_MAX_CHARS,
  applyContinuationWindow,
  cutText,
  selectThreadWindow,
  type WindowedContinuation,
} from "./continuation-window.js";

type Message = ExecutionContinuationEnvelope["messages"][number];

const message = (index: number, body: string, overrides: Partial<Message> = {}): Message => ({
  id: `comment-${String(index).padStart(4, "0")}`,
  authorType: index % 2 === 0 ? "agent" : "user",
  authorId: index % 2 === 0 ? "agent-1" : "user-1",
  createdByRunId: index % 2 === 0 ? "run-1" : null,
  body,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  deleted: false,
  sourceTrust: null,
  ...overrides,
});

const thread = (count: number, chars: number) =>
  Array.from({ length: count }, (_, index) => message(index, `${index}:`.padEnd(chars, "x")));

const envelope = (messages: Message[], overrides: Partial<WindowedContinuation> = {}): WindowedContinuation => ({
  version: 1,
  companyId: "company-1",
  issueId: "issue-1",
  trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
  originCommentIds: [],
  objective: "Ship it.",
  messages,
  interactionOutcomes: [],
  completedWork: null,
  completedActions: [],
  unresolvedInteractionIds: [],
  coverage: { kind: "full_task_history", throughCommentId: messages.at(-1)?.id ?? null, summaryThroughCommentId: null },
  ...overrides,
});

describe("cutText", () => {
  it("keeps text that fits and marks a cut with the remainder and a read hint", () => {
    expect(cutText("short", 10, "read comment c1")).toBe("short");
    expect(cutText("abcdefghij", 4, "read comment c1")).toBe("abcd\n[truncated: 6 more characters; read comment c1]");
  });

  it("never splits a surrogate pair", () => {
    const cut = cutText("ab😀cd", 3, "read comment c1");
    expect(cut.startsWith("ab\n")).toBe(true);
    expect(cut).toContain("[truncated: 4 more characters;");
  });
});

describe("selectThreadWindow", () => {
  it("keeps the newest comments up to the count, indexes the newest older ones and counts the rest", () => {
    const messages = thread(300, 2_000);
    const result = selectThreadWindow(messages, { pinnedIds: new Set(), limits: THREAD_WINDOW_DEFAULTS });
    expect(result.messages.map((entry) => entry.id)).toEqual(messages.slice(-20).map((entry) => entry.id));
    expect(result.olderMessages.map((entry) => entry.id)).toEqual(messages.slice(230, 280).map((entry) => entry.id));
    expect(result.unindexedMessages).toBe(230);
    expect(result.olderMessages[0]).toMatchObject({
      id: "comment-0230",
      authorType: "agent",
      chars: 2_000,
      deleted: false,
      preview: `230:${"x".repeat(116)}…`,
    });
  });

  it("cuts long bodies, stops at the total budget and keeps the window contiguous", () => {
    const messages = thread(30, 10_000);
    const result = selectThreadWindow(messages, { pinnedIds: new Set(), limits: THREAD_WINDOW_DEFAULTS });
    expect(result.messages).toHaveLength(12);
    expect(result.messages.map((entry) => entry.id)).toEqual(messages.slice(-12).map((entry) => entry.id));
    for (const entry of result.messages) {
      expect(entry.body).toMatch(/^\d+:x+\n\[truncated: 6000 more characters; read comment comment-\d{4}\]$/);
    }
  });

  it("always keeps pinned comments, even far older than the window, and cuts them at the pinned limit", () => {
    const messages = thread(100, 1_000);
    messages[3] = message(3, "R".repeat(20_000));
    const result = selectThreadWindow(messages, {
      pinnedIds: new Set(["comment-0003"]),
      limits: THREAD_WINDOW_DEFAULTS,
    });
    expect(result.messages[0]!.id).toBe("comment-0003");
    expect(result.messages[0]!.body.startsWith("R".repeat(CONTINUATION_PINNED_COMMENT_MAX_CHARS))).toBe(true);
    expect(result.messages[0]!.body).toContain("[truncated: 4000 more characters; read comment comment-0003]");
    expect(result.messages).toHaveLength(20);
    expect(result.messages.slice(1).map((entry) => entry.id)).toEqual(messages.slice(-19).map((entry) => entry.id));
    expect(result.olderMessages.some((entry) => entry.id === "comment-0003")).toBe(false);
  });
});

describe("applyContinuationWindow", () => {
  it("leaves a thread that fits unchanged", () => {
    const input = envelope(thread(5, 300));
    const result = applyContinuationWindow(input, { pinnedIds: new Set() });
    expect(result).toEqual(input);
    expect(result).not.toHaveProperty("window");
    expect(result).not.toHaveProperty("olderMessages");
  });

  it("marks a long thread as bounded and reports what it kept", () => {
    const input = envelope(thread(300, 2_000));
    const result = applyContinuationWindow(input, { pinnedIds: new Set() });
    expect(result.coverage).toEqual({
      kind: "bounded_task_history",
      throughCommentId: "comment-0299",
      summaryThroughCommentId: null,
    });
    expect(result.window).toEqual({
      totalMessages: 300,
      includedMessages: 20,
      truncatedMessages: 0,
      indexedMessages: 50,
      unindexedMessages: 230,
      oldestIncludedCommentId: "comment-0280",
      droppedEvidenceEntries: 0,
      limits: {
        ...THREAD_WINDOW_DEFAULTS,
        maxPinnedCommentChars: CONTINUATION_PINNED_COMMENT_MAX_CHARS,
        maxEnvelopeChars: CONTINUATION_ENVELOPE_MAX_CHARS,
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(80_000);
    expect(JSON.stringify(input).length).toBeGreaterThan(600_000);
  });

  it("cuts the objective and the completed-work summary", () => {
    const result = applyContinuationWindow(
      envelope(thread(2, 100), { objective: "o".repeat(20_000), completedWork: "w".repeat(20_000) }),
      { pinnedIds: new Set() },
    );
    expect(result.coverage.kind).toBe("bounded_task_history");
    expect(result.objective).toContain("[truncated: 4000 more characters; read the issue and its latest comment]");
    expect(result.completedWork).toContain("[truncated: 4000 more characters; read the issue continuation summary document]");
  });

  it("holds the envelope ceiling with 50 long pinned comments, a long summary and many evidence entries", () => {
    const messages = thread(50, 20_000);
    const triggerOutcome = { id: "interaction-trigger", kind: "ask_user_questions", status: "answered", result: { answers: [] } };
    const input = envelope(messages, {
      trigger: { reason: "issue_commented", interactionId: "interaction-trigger", sourceRunId: null },
      originCommentIds: messages.map((entry) => entry.id),
      completedWork: "w".repeat(40_000),
      completedActions: Array.from({ length: 400 }, (_, index) => ({
        runId: `run-${index}`,
        receiptId: `receipt-${index}`,
        operationId: "issue.update",
        result: { body: "r".repeat(1_000) },
      })),
      interactionOutcomes: [
        triggerOutcome,
        ...Array.from({ length: 200 }, (_, index) => ({ id: `interaction-${index}`, kind: "request_confirmation", status: "accepted", result: { note: "n".repeat(500) } })),
      ],
    });
    const result = applyContinuationWindow(input, { pinnedIds: new Set(input.originCommentIds) });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(CONTINUATION_ENVELOPE_MAX_CHARS);
    expect(result.messages.map((entry) => entry.id)).toEqual(messages.map((entry) => entry.id));
    expect(result.interactionOutcomes).toContainEqual(triggerOutcome);
    expect(result.window!.droppedEvidenceEntries).toBeGreaterThan(0);
    expect(result.coverage.kind).toBe("bounded_task_history");
  });
});

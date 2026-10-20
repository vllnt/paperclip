import { describe, expect, it } from "vitest";
import {
  THREAD_WINDOW_DEFAULTS,
  cutText,
  sameCutText,
  type ExecutionContinuationEnvelope,
} from "@paperclipai/shared";
import {
  CONTINUATION_ENVELOPE_MAX_CHARS,
  CONTINUATION_PINNED_COMMENT_MAX_CHARS,
  applyContinuationWindow,
  selectThreadWindow,
  toIndexEntry,
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

describe("sameCutText", () => {
  it("matches one body cut at different lengths and rejects a different body", () => {
    const body = "y".repeat(10_000);
    expect(sameCutText(cutText(body, 16_000, "read comment c1"), cutText(body, 4_000, "read comment c1"))).toBe(true);
    expect(sameCutText(body, cutText(body, 4_000, "read comment c1"))).toBe(true);
    expect(sameCutText("one body", "another body")).toBe(false);
    expect(sameCutText(cutText(`a${body}`, 4_000, "read comment c1"), cutText(`b${body}`, 4_000, "read comment c1"))).toBe(false);
  });
});

describe("toIndexEntry", () => {
  it("never ends a preview inside a surrogate pair, so the entry stays valid jsonb", () => {
    const entry = toIndexEntry(message(1, `${"a".repeat(119)}😀 and more text after the emoji`));
    expect(entry.preview).toBe(`${"a".repeat(119)}…`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(entry.preview)).toBe(false);
  });
});

describe("selectThreadWindow", () => {
  it("keeps the newest comments up to the count, indexes the newest older ones and counts the rest", () => {
    const messages = thread(300, 2_000);
    const result = selectThreadWindow(messages, { pinnedIds: new Set(), limits: THREAD_WINDOW_DEFAULTS });
    expect(result.messages.map((entry) => entry.id)).toEqual(messages.slice(-20).map((entry) => entry.id));
    expect(result.olderMessages.map((entry) => entry.id)).toEqual(messages.slice(230, 280).map((entry) => entry.id));
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

  it("gives the latest request its pinned budget before newer pinned wake comments", () => {
    const messages = thread(10, 100);
    messages[1] = message(1, "R".repeat(20_000));
    for (const index of [6, 7, 8]) messages[index] = message(index, "W".repeat(16_000));
    const result = selectThreadWindow(messages, {
      pinnedIds: new Set(["comment-0001", "comment-0006", "comment-0007", "comment-0008"]),
      requestId: "comment-0001",
      limits: THREAD_WINDOW_DEFAULTS,
    });
    const kept = new Map(result.messages.map((entry) => [entry.id, entry.body]));
    expect(kept.get("comment-0001")!.startsWith("R".repeat(CONTINUATION_PINNED_COMMENT_MAX_CHARS))).toBe(true);
    expect(kept.get("comment-0008")).toBe("W".repeat(16_000));
    expect(kept.get("comment-0007")).toBe("W".repeat(16_000));
    expect(kept.get("comment-0006")).toMatch(/^W{200}\n\[truncated: 15800 more characters; read comment comment-0006\]$/);
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

  it("keeps the objective whole for server checks and cuts the completed-work summary", () => {
    const objective = "o".repeat(20_000);
    const result = applyContinuationWindow(
      envelope(thread(2, 100), { objective, completedWork: "w".repeat(20_000) }),
      { pinnedIds: new Set() },
    );
    expect(result.coverage.kind).toBe("bounded_task_history");
    expect(result.objective).toBe(objective);
    expect(result.completedWork).toContain("[truncated: 4000 more characters; read the issue continuation summary document]");
    const fits = envelope(thread(2, 100), { objective });
    expect(applyContinuationWindow(fits, { pinnedIds: new Set() })).toEqual(fits);
  });

  it("counts a huge objective at its rendered size, so it does not push history out", () => {
    const objective = "o".repeat(500_000);
    const result = applyContinuationWindow(envelope(thread(10, 1_000), { objective }), { pinnedIds: new Set() });
    expect(result.messages).toHaveLength(10);
    expect(result.objective).toBe(objective);
    expect(JSON.stringify({ ...result, objective: cutText(objective, 16_000, "x") }).length).toBeLessThanOrEqual(CONTINUATION_ENVELOPE_MAX_CHARS);
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

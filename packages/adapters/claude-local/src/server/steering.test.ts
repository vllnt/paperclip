import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent, AdapterSteeringHandle } from "@paperclipai/adapter-utils";
import { readAdapterSteeringAcknowledgement } from "@paperclipai/adapter-utils";
import {
  claudeSteerMessageUuid,
  claudeStreamJsonUserMessage,
  createClaudeSteeringSession,
} from "./steering.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const INIT_WITH_LIFECYCLE = { type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"] };

function fakeWriter() {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    writer: {
      write: (chunk: string) => {
        if (ended) return false;
        written.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
      },
      get ended() {
        return ended;
      },
    },
  };
}

function setup(options: { initTimeoutMs?: number } = {}) {
  const handles: Array<AdapterSteeringHandle | null> = [];
  const events: AdapterRuntimeEvent[] = [];
  const session = createClaudeSteeringSession({
    runId: RUN_ID,
    onSteeringReady: (handle) => handles.push(handle),
    onEvent: async (event) => {
      events.push(event);
    },
    initTimeoutMs: options.initTimeoutMs,
  });
  const stdin = fakeWriter();
  session.attachStdin(stdin.writer);
  const emit = (...lines: Array<Record<string, unknown>>) =>
    session.observeStdout(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const acknowledged = () => events.map(readAdapterSteeringAcknowledgement).filter(Boolean);
  return { session, stdin, handles, events, emit, acknowledged };
}

describe("claude steering session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers once Claude reports message lifecycle and acknowledges only on started", async () => {
    const { session, stdin, handles, emit, acknowledged } = setup();
    expect(handles).toEqual([]);

    await emit(INIT_WITH_LIFECYCLE);
    const handle = handles[0];
    expect(handle).toBeTruthy();

    expect(handle!.steer({ text: "Skip step 2.", correlationId: "comment-1" })).toEqual({ status: "pending" });
    const uuid = claudeSteerMessageUuid(RUN_ID, "comment-1");
    expect(stdin.written).toEqual([claudeStreamJsonUserMessage("Skip step 2.", uuid)]);
    const written = JSON.parse(stdin.written[0]!) as Record<string, unknown>;
    expect(written).toMatchObject({ type: "user", uuid });
    expect(written).not.toHaveProperty("priority");

    await emit({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
    expect(acknowledged()).toEqual([]);
    expect(session.holdTerminalCleanup()).toBe(true);

    await emit({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
    expect(acknowledged()).toEqual(["comment-1"]);

    await emit({ type: "command_lifecycle", command_uuid: uuid, state: "completed" }, { type: "result", subtype: "success" });
    expect(stdin.writer.ended).toBe(true);
    expect(handles.at(-1)).toBeNull();
    expect(session.holdTerminalCleanup()).toBe(false);
    expect(handle!.steer({ text: "late", correlationId: "comment-2" })).toMatchObject({ status: "unavailable" });
  });

  it("never acknowledges a message the process did not start", async () => {
    const { session, handles, emit, acknowledged } = setup();
    await emit(INIT_WITH_LIFECYCLE);
    const uuid = claudeSteerMessageUuid(RUN_ID, "comment-1");
    handles[0]!.steer({ text: "Skip step 2.", correlationId: "comment-1" });
    await emit({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });

    // The process is killed before the next tool boundary.
    session.close();

    expect(acknowledged()).toEqual([]);
    expect(handles.at(-1)).toBeNull();
  });

  it("keeps stdin open after a result while a message still waits to start", async () => {
    const { session, stdin, handles, emit, acknowledged } = setup();
    await emit(INIT_WITH_LIFECYCLE);
    const uuid = claudeSteerMessageUuid(RUN_ID, "comment-1");
    handles[0]!.steer({ text: "One more thing.", correlationId: "comment-1" });

    await emit({ type: "result", subtype: "success" });
    expect(stdin.writer.ended).toBe(false);
    expect(session.holdTerminalCleanup()).toBe(true);

    // The message runs as a follow-up turn in the same process.
    await emit({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
    await emit({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
    expect(acknowledged()).toEqual(["comment-1"]);
    expect(stdin.writer.ended).toBe(false);

    await emit({ type: "result", subtype: "success" });
    expect(stdin.writer.ended).toBe(true);
  });

  it("does not write the same steered message twice", async () => {
    const { stdin, handles, emit } = setup();
    await emit(INIT_WITH_LIFECYCLE);
    handles[0]!.steer({ text: "Skip step 2.", correlationId: "comment-1" });
    expect(handles[0]!.steer({ text: "Skip step 2.", correlationId: "comment-1" })).toEqual({ status: "pending" });
    expect(stdin.written).toHaveLength(1);
  });

  it("takes no live input when Claude does not report message lifecycle", async () => {
    const { stdin, handles, emit } = setup();
    await emit({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] });
    expect(handles).toEqual([]);
    expect(stdin.writer.ended).toBe(true);
  });

  it("ends stdin when the command never reports init", async () => {
    vi.useFakeTimers();
    const { stdin, handles } = setup({ initTimeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(stdin.writer.ended).toBe(true);
    expect(handles).toEqual([]);
  });

  it("parses events split across stdout chunks", async () => {
    const { session, handles } = setup();
    const line = `${JSON.stringify(INIT_WITH_LIFECYCLE)}\n`;
    await session.observeStdout(line.slice(0, 10));
    expect(handles).toEqual([]);
    await session.observeStdout(line.slice(10));
    expect(handles).toHaveLength(1);
  });
});

describe("claudeSteerMessageUuid", () => {
  it("derives a stable RFC 4122 version 5 uuid per run and message", () => {
    const uuid = claudeSteerMessageUuid(RUN_ID, "comment-1");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claudeSteerMessageUuid(RUN_ID, "comment-1")).toBe(uuid);
    expect(claudeSteerMessageUuid(RUN_ID, "comment-2")).not.toBe(uuid);
    expect(claudeSteerMessageUuid("99999999-2222-4333-8444-555555555555", "comment-1")).not.toBe(uuid);
  });
});

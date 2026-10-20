import { describe, expect, it, vi } from "vitest";
import { createClaudeSessionCheckpoint, isClaudeSessionUuid } from "./session-checkpoint.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

const initLine = (sessionId = SESSION_ID) =>
  line({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" });
const turnLines = (sessionId = SESSION_ID) =>
  line({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "hello" }] } }) +
  line({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: "hello",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  });

describe("createClaudeSessionCheckpoint", () => {
  function setup() {
    const sessions: string[] = [];
    const checkpoint = createClaudeSessionCheckpoint({
      onSession: async (sessionId) => {
        sessions.push(sessionId);
      },
    });
    return { sessions, checkpoint };
  }

  it("reports the session once its init line is complete, even when the line arrives in pieces", async () => {
    const { sessions, checkpoint } = setup();
    const init = initLine();
    await checkpoint.observeStdout(init.slice(0, 25));
    await checkpoint.observeStdout(init.slice(25, -1));
    expect(sessions).toEqual([]);
    await checkpoint.observeStdout("\n");
    expect(sessions).toEqual([SESSION_ID]);
  });

  it("reports only the first init line", async () => {
    const { sessions, checkpoint } = setup();
    await checkpoint.observeStdout(initLine() + turnLines());
    await checkpoint.observeStdout(initLine("22222222-2222-4222-8222-222222222222"));
    expect(sessions).toEqual([SESSION_ID]);
  });

  it("ignores events that are not an init line, noise, and ids that are not a UUID", async () => {
    const { sessions, checkpoint } = setup();
    await checkpoint.observeStdout("not json at all\n\n[1,2]\n");
    await checkpoint.observeStdout(turnLines());
    await checkpoint.observeStdout(line({ type: "system", subtype: "other", session_id: SESSION_ID }));
    await checkpoint.observeStdout(initLine("claude-session-1"));
    await checkpoint.observeStdout(line({ type: "system", subtype: "init" }));
    expect(sessions).toEqual([]);
    // A later valid init is still reported after the rejected ones.
    await checkpoint.observeStdout(initLine());
    expect(sessions).toEqual([SESSION_ID]);
  });

  it("never throws when the report fails", async () => {
    const onSession = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    const checkpoint = createClaudeSessionCheckpoint({ onSession });
    await expect(checkpoint.observeStdout(initLine())).resolves.toBeUndefined();
    expect(onSession).toHaveBeenCalledTimes(1);
  });

  it("accepts the UUID shape that --resume accepts", () => {
    expect(isClaudeSessionUuid(SESSION_ID)).toBe(true);
    expect(isClaudeSessionUuid(SESSION_ID.toUpperCase())).toBe(true);
    expect(isClaudeSessionUuid("claude-session-1")).toBe(false);
    expect(isClaudeSessionUuid("")).toBe(false);
  });
});

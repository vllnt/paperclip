import { asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Claude CLI accepts only a UUID for `--resume`. */
export function isClaudeSessionUuid(value: string): boolean {
  return CLAUDE_SESSION_UUID.test(value);
}

/**
 * Finds the session id in Claude stream-json stdout and reports it at once, so
 * a process that ends early still leaves its session for the retry.
 *
 * The CLI names the session on its `system/init` line, which comes first. Feed
 * every stdout chunk in order. `onSession` runs once per process, for the first
 * init line that carries a valid session id. A failure in `onSession` never
 * reaches the caller: the final result of the run still reports the session.
 */
export function createClaudeSessionCheckpoint(input: {
  onSession: (sessionId: string) => Promise<void>;
}) {
  let lineBuffer = "";
  let reported = false;

  const observeLine = async (line: string) => {
    const event = parseJson(line);
    if (event?.type !== "system" || event.subtype !== "init") return;
    const sessionId = asString(event.session_id, "");
    if (!isClaudeSessionUuid(sessionId)) return;
    reported = true;
    lineBuffer = "";
    try {
      await input.onSession(sessionId);
    } catch {
      // Best effort: the final result carries the session.
    }
  };

  return {
    /** Feed every stdout chunk, in order. */
    async observeStdout(chunk: string) {
      if (reported) return;
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf("\n");
      while (!reported && newline >= 0) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line) await observeLine(line);
        newline = lineBuffer.indexOf("\n");
      }
    },
  };
}

import { createHash } from "node:crypto";
import {
  adapterSteeringAcknowledgementEvent,
  type AdapterRuntimeEvent,
  type AdapterSteeringHandle,
  type AdapterSteerResult,
} from "@paperclipai/adapter-utils";
import type { ChildProcessStdinWriter } from "@paperclipai/adapter-utils/server-utils";

/** `system/init` capability that makes Claude Code report message lifecycle. */
export const CLAUDE_MESSAGE_LIFECYCLE_CAPABILITY = "msg_lifecycle_v1";

/** How long to wait for `system/init` before giving up on live input. */
export const CLAUDE_STEERING_INIT_TIMEOUT_MS = 30_000;

const STEER_MESSAGE_UUID_NAMESPACE = "5b0f3a52-7d1e-4c8a-9f63-2e4d8c1a7b90";

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Stable stream-json message uuid, so a repeated steer is recognised. */
export function claudeSteerMessageUuid(runId: string, correlationId: string): string {
  return uuidV5(`${runId}:${correlationId}`, STEER_MESSAGE_UUID_NAMESPACE);
}

export function claudeStreamJsonUserMessage(text: string, uuid?: string): string {
  return `${JSON.stringify({
    type: "user",
    ...(uuid ? { uuid } : {}),
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

type SteerMessageState = "written" | "queued" | "started";

/**
 * Tracks one Claude Code process fed through `--input-format stream-json`.
 *
 * The process keeps reading stdin after the prompt, so a board message can be
 * written mid-run. Claude Code reports each tagged message as `queued`, then
 * `started` once it is in the model's context; `started` is the only receipt.
 * Stdin ends once a `result` has arrived and no written message is still
 * waiting to start, which lets the process exit as it does without steering.
 */
export function createClaudeSteeringSession(input: {
  runId: string;
  onSteeringReady?: (handle: AdapterSteeringHandle | null) => void;
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void>;
  initTimeoutMs?: number;
}) {
  const messages = new Map<string, { correlationId: string; state: SteerMessageState }>();
  let writer: ChildProcessStdinWriter | null = null;
  let lifecycleSupported = false;
  let registered = false;
  let closed = false;
  // True once a result arrived and no message has started a turn since.
  let afterResult = false;
  let lineBuffer = "";
  let initTimer: NodeJS.Timeout | null = null;

  const clearInitTimer = () => {
    if (initTimer) clearTimeout(initTimer);
    initTimer = null;
  };

  const unregister = () => {
    if (!registered) return;
    registered = false;
    input.onSteeringReady?.(null);
  };

  const endStdin = () => {
    clearInitTimer();
    unregister();
    writer?.end();
  };

  const hasUnstartedMessage = () =>
    [...messages.values()].some((message) => message.state !== "started");

  const maybeEndStdin = () => {
    if (afterResult && !hasUnstartedMessage()) endStdin();
  };

  const handle: AdapterSteeringHandle = {
    steer({ text, correlationId }): AdapterSteerResult {
      if (!registered || !writer || writer.ended) {
        return { status: "unavailable", reason: "Claude run is no longer taking messages" };
      }
      const uuid = claudeSteerMessageUuid(input.runId, correlationId);
      if (messages.has(uuid)) return { status: "pending" };
      if (!writer.write(claudeStreamJsonUserMessage(text, uuid))) {
        return { status: "unavailable", reason: "Claude run is no longer taking messages" };
      }
      messages.set(uuid, { correlationId, state: "written" });
      return { status: "pending" };
    },
  };

  const maybeRegister = () => {
    if (registered || closed || !lifecycleSupported || !writer || writer.ended) return;
    registered = true;
    input.onSteeringReady?.(handle);
  };

  const acknowledge = async (correlationId: string) => {
    try {
      await input.onEvent?.(adapterSteeringAcknowledgementEvent({ runId: input.runId, correlationId }));
    } catch {
      // Without a receipt the comment stays queued; the worst case is a duplicate.
    }
  };

  const observeLine = async (line: string) => {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = event.type;
    if (type === "system" && event.subtype === "init") {
      clearInitTimer();
      const capabilities = Array.isArray(event.capabilities) ? event.capabilities : [];
      lifecycleSupported = capabilities.includes(CLAUDE_MESSAGE_LIFECYCLE_CAPABILITY);
      // Without lifecycle receipts a steer could not be told apart from a
      // dropped message, so the run takes no live input.
      if (!lifecycleSupported) endStdin();
      maybeRegister();
      return;
    }
    if (type === "command_lifecycle") {
      const uuid = typeof event.command_uuid === "string" ? event.command_uuid : "";
      const message = messages.get(uuid);
      if (!message) return;
      if (event.state === "queued" && message.state === "written") {
        message.state = "queued";
      } else if (event.state === "started" && message.state !== "started") {
        message.state = "started";
        afterResult = false;
        await acknowledge(message.correlationId);
      }
      return;
    }
    if (type === "result") {
      afterResult = true;
      maybeEndStdin();
    }
  };

  return {
    /** Pass to the process runner's `onStdinReady`. */
    attachStdin(ready: ChildProcessStdinWriter) {
      if (closed) {
        ready.end();
        return;
      }
      writer = ready;
      // A command that reads stdin to EOF before printing anything would wait
      // forever on an open pipe. Without `system/init`, run without steering.
      initTimer = setTimeout(() => {
        initTimer = null;
        endStdin();
      }, input.initTimeoutMs ?? CLAUDE_STEERING_INIT_TIMEOUT_MS);
      maybeRegister();
      // A result can arrive before the writer when the process fails fast.
      maybeEndStdin();
    },
    /** Feed every stdout chunk, in order. */
    async observeStdout(chunk: string) {
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line) await observeLine(line);
        newline = lineBuffer.indexOf("\n");
      }
    },
    /** Keeps terminal-result cleanup from stopping a process that still has work. */
    holdTerminalCleanup(): boolean {
      return writer !== null && !writer.ended;
    },
    /** Call once the process has exited. */
    close() {
      closed = true;
      clearInitTimer();
      unregister();
    },
  };
}

export type ClaudeSteeringSession = ReturnType<typeof createClaudeSteeringSession>;


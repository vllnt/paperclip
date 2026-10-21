import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterSessionCheckpoint } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

type ChildOptions = { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> };

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return { ...actual, prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, syncDirectoryToSsh };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, startAdapterExecutionTargetPaperclipBridge };
});

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

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

describe("claude_local early session checkpoint", () => {
  const cleanupDirs: string[] = [];
  let workspace = "";

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-session-checkpoint-"));
    cleanupDirs.push(root);
    workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    vi.stubEnv("HOME", root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Stands in for the CLI process. `run` streams chunks through the same
  // `onLog` the real process runner calls, and returns what the process
  // printed in all plus how it ended.
  function stubClaudeProcess(
    run: (options: ChildOptions) => Promise<{ stdout: string; exitCode: number | null; signal?: string | null }>,
  ) {
    runChildProcess.mockImplementation(
      async (_runId: string, _command: string, args: string[], options: ChildOptions): Promise<RunProcessResult> => {
        const base = { timedOut: false, stderr: "", pid: 123, startedAt: new Date().toISOString() };
        if (args.includes("--version")) return { ...base, exitCode: 0, signal: null, stdout: "2.1.280 (Claude Code)\n" };
        const { stdout, exitCode, signal = null } = await run(options);
        return { ...base, exitCode, signal, stdout };
      },
    );
  }

  function buildContext(overrides: Record<string, unknown> = {}) {
    return {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "claude", cwd: workspace },
      context: {},
      onLog: async () => {},
      ...overrides,
    };
  }

  it("reports the session while the process is still running, in the shape of the final result", async () => {
    let release!: () => void;
    const processMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubClaudeProcess(async ({ onLog }) => {
      const init = initLine();
      await onLog("stdout", init.slice(0, 30));
      await onLog("stdout", init.slice(30));
      await processMayFinish;
      await onLog("stdout", turnLines());
      return { stdout: init + turnLines(), exitCode: 0 };
    });
    const checkpoints: AdapterSessionCheckpoint[] = [];

    let finished = false;
    const run = execute(
      buildContext({
        onSessionCheckpoint: async (checkpoint: AdapterSessionCheckpoint) => {
          checkpoints.push(checkpoint);
        },
      }) as never,
    ).then((result) => {
      finished = true;
      return result;
    });

    await vi.waitFor(() => expect(checkpoints).toHaveLength(1));
    expect(finished).toBe(false);
    expect(checkpoints[0]).toMatchObject({
      sessionDisplayId: SESSION_ID,
      sessionParams: { sessionId: SESSION_ID, cwd: workspace },
    });

    release();
    const result = await run;
    expect(checkpoints).toHaveLength(1);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toEqual(checkpoints[0]!.sessionParams);
    expect(result.sessionDisplayId).toBe(SESSION_ID);
  });

  it("has reported the session of a process that is killed before it prints a result", async () => {
    // The process printed its init line and part of a turn, then was stopped.
    const partialTurn = line({
      type: "assistant",
      session_id: SESSION_ID,
      message: { content: [{ type: "text", text: "working" }] },
    });
    stubClaudeProcess(async ({ onLog }) => {
      await onLog("stdout", initLine());
      await onLog("stdout", partialTurn);
      return { stdout: initLine() + partialTurn, exitCode: null, signal: "SIGTERM" };
    });
    const onSessionCheckpoint = vi.fn(async () => {});

    const result = await execute(buildContext({ onSessionCheckpoint }) as never);

    expect(result.exitCode).toBeNull();
    // Without a result event the final result names no session at all.
    expect(result.sessionId).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(onSessionCheckpoint).toHaveBeenCalledTimes(1);
    expect(onSessionCheckpoint).toHaveBeenCalledWith({
      sessionDisplayId: SESSION_ID,
      sessionParams: expect.objectContaining({ sessionId: SESSION_ID, cwd: workspace }),
    });
  });

  it("does not report an id that the adapter would not resume, and still keeps the final result as before", async () => {
    const notAUuid = "claude-session-1";
    stubClaudeProcess(async ({ onLog }) => {
      await onLog("stdout", initLine(notAUuid) + turnLines(notAUuid));
      return { stdout: initLine(notAUuid) + turnLines(notAUuid), exitCode: 0 };
    });
    const onSessionCheckpoint = vi.fn(async () => {});

    const result = await execute(buildContext({ onSessionCheckpoint }) as never);

    expect(onSessionCheckpoint).not.toHaveBeenCalled();
    expect(result.sessionId).toBe(notAUuid);
  });

  it("does not let a failing host callback fail the run", async () => {
    stubClaudeProcess(async ({ onLog }) => {
      await onLog("stdout", initLine() + turnLines());
      return { stdout: initLine() + turnLines(), exitCode: 0 };
    });
    const onSessionCheckpoint = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    const result = await execute(buildContext({ onSessionCheckpoint }) as never);

    expect(onSessionCheckpoint).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("runs as before when the host offers no checkpoint callback", async () => {
    stubClaudeProcess(async ({ onLog }) => {
      await onLog("stdout", initLine() + turnLines());
      return { stdout: initLine() + turnLines(), exitCode: 0 };
    });

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("reports the same remote identity as the final result for an SSH target", async () => {
    stubClaudeProcess(async ({ onLog }) => {
      await onLog("stdout", initLine());
      await onLog("stdout", turnLines());
      return { stdout: initLine() + turnLines(), exitCode: 0 };
    });
    const checkpoints: AdapterSessionCheckpoint[] = [];

    const result = await execute(
      buildContext({
        config: { engine: "cli", command: "claude" },
        context: { paperclipWorkspace: { cwd: workspace, source: "project_primary", workspaceId: "workspace-1" } },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
        onSessionCheckpoint: async (checkpoint: AdapterSessionCheckpoint) => {
          checkpoints.push(checkpoint);
        },
      }) as never,
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.sessionParams).toHaveProperty("remoteExecution");
    expect(checkpoints[0]!.sessionParams).toHaveProperty("workspaceId", "workspace-1");
    expect(result.sessionParams).toEqual(checkpoints[0]!.sessionParams);
  });
});

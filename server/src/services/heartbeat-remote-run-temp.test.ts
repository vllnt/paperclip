import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { cleanupHeartbeatRemoteRunTemp, prepareHeartbeatRemoteRunTemp } from "./heartbeat-remote-run-temp.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const DIR = `/sandbox/.paperclip-runtime/tmp/${RUN_ID}`;
const runner = { execute: vi.fn() };
const sandbox: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: "/sandbox", runner };

describe("prepareHeartbeatRemoteRunTemp", () => {
  it("points TMPDIR, TMP, TEMP and the scratch variables of a remote run at its own directory", async () => {
    const prepare = vi.fn(async () => DIR);

    const result = await prepareHeartbeatRemoteRunTemp({ native: false, runId: RUN_ID, target: sandbox, env: { OTHER: "kept" } }, prepare);

    expect(prepare).toHaveBeenCalledWith({ runId: RUN_ID, target: sandbox });
    expect(result?.env).toEqual({
      TMPDIR: DIR, TMP: DIR, TEMP: DIR,
      PAPERCLIP_RUN_SCRATCH_DIR: DIR, PAPERCLIP_TASK_SCRATCH_DIR: DIR, PAPERCLIP_SCRATCH_DIR: DIR, PAPERCLIP_TMPDIR: DIR,
    });
    expect(result?.scratchContext).toEqual({
      type: "heartbeat_run", location: "remote", dir: DIR, cleanupPolicy: "terminal_run", tempKeysApplied: ["TMPDIR", "TEMP", "TMP"],
    });
    expect(result?.cleanupLocation).toEqual({ runId: RUN_ID, target: sandbox });
  });

  it("keeps an operator TMPDIR and creates no directory", async () => {
    const prepare = vi.fn(async () => DIR);

    expect(await prepareHeartbeatRemoteRunTemp({ native: false, runId: RUN_ID, target: sandbox, env: { TMPDIR: "/operator/tmp" } }, prepare)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps an operator TMP or TEMP and points only the unset keys at the directory", async () => {
    const result = await prepareHeartbeatRemoteRunTemp({ native: false, runId: RUN_ID, target: sandbox, env: { TMP: "/operator/tmp" } }, async () => DIR);

    expect(result?.env.TMP).toBeUndefined();
    expect(result?.env.TMPDIR).toBe(DIR);
    expect(result?.scratchContext.tempKeysApplied).toEqual(["TMPDIR", "TEMP"]);
  });

  it("leaves a native runner session's env unchanged and creates no directory", async () => {
    const prepare = vi.fn(async () => DIR);

    expect(await prepareHeartbeatRemoteRunTemp({ native: true, runId: RUN_ID, target: sandbox, env: {} }, prepare)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("leaves a local run to its own scratch directory", async () => {
    const prepare = vi.fn(async () => DIR);

    expect(await prepareHeartbeatRemoteRunTemp({ native: false, runId: RUN_ID, target: null, env: {} }, prepare)).toBeNull();
    expect(await prepareHeartbeatRemoteRunTemp({
      native: false, runId: RUN_ID, target: { kind: "local", environmentId: null, leaseId: null }, env: {},
    }, prepare)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("cleanupHeartbeatRemoteRunTemp", () => {
  it("removes the run's directory", async () => {
    const cleanup = vi.fn(async () => undefined);
    await cleanupHeartbeatRemoteRunTemp({ runId: RUN_ID, target: sandbox }, cleanup);
    expect(cleanup).toHaveBeenCalledWith({ runId: RUN_ID, target: sandbox });
  });
});

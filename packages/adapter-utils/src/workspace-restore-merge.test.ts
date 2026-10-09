import { createHash, randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";
import { WorkspaceManifestMap } from "./workspace-manifest.js";
import {
  captureDirectorySnapshot,
  descriptorPinningSupported,
  directorySnapshotSha256,
  disposeDirectorySnapshot,
  classifyWorkspaceRestoreFailure,
  describeWorkspaceRestoreFailure,
  mergeDirectoryWithBaseline,
  parseDirectorySnapshot,
  serializeDirectorySnapshot,
  type SnapshotEntry,
  withDirectoryMergeLock,
  WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
} from "./workspace-restore-merge.js";

/** What a released lock leaves in the lock root, in `readdir` order. */
const PERMANENT_LOCK_FILES = [expect.stringMatching(/^[0-9a-f]{64}\.lock\.queue\.sqlite$/), expect.stringMatching(/^[0-9a-f]{64}\.lock\.sqlite$/)];

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("round-trips a deterministic durable snapshot and rejects traversal", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-snapshot-"),
    );
    cleanupDirs.push(rootDir);
    await mkdir(path.join(rootDir, "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "b.txt"), "bravo\n", "utf8");
    await writeFile(path.join(rootDir, "nested", "a.txt"), "alpha\n", "utf8");

    const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });
    const serialized = serializeDirectorySnapshot(snapshot);
    if (serialized.version !== 1) throw new Error("Expected legacy in-memory snapshot");
    const restored = parseDirectorySnapshot(serialized);

    expect(serialized.entries.map(([relativePath]) => relativePath)).toEqual([
      "b.txt",
      "nested",
      "nested/a.txt",
    ]);
    expect(restored).not.toBeNull();
    expect(directorySnapshotSha256(restored!)).toBe(
      directorySnapshotSha256(snapshot),
    );
    expect(
      parseDirectorySnapshot({
        ...serialized,
        entries: [["../escape", serialized.entries[0]![1]]],
      }),
    ).toBeNull();
  });

  it("preserves sibling files when sequential stale-baseline restores create the same nested directory tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);

    const targetDir = path.join(rootDir, "target");
    const sourceADir = path.join(rootDir, "source-a");
    const sourceBDir = path.join(rootDir, "source-b");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(sourceADir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });
    await mkdir(path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await writeFile(
      path.join(sourceADir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"),
      "ssh claude\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"),
      "ssh codex\n",
      "utf8",
    );

    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceADir,
      targetDir,
    });
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceBDir,
      targetDir,
    });

    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"), "utf8"),
    ).resolves.toBe("ssh claude\n");
    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"), "utf8"),
    ).resolves.toBe("ssh codex\n");
  });

  it("preserves a host file replacing a deleted baseline directory and continues the restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-conflict-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const sourceDir = path.join(rootDir, "source");
    await mkdir(path.join(targetDir, "replaced", "nested"), { recursive: true });
    await mkdir(sourceDir);
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [], diskBacked: true });
    try {
      await rm(path.join(targetDir, "replaced"), { recursive: true });
      await writeFile(path.join(targetDir, "replaced"), "host change");
      await writeFile(path.join(sourceDir, "other.txt"), "sandbox change");
      await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });
      expect(await readFile(path.join(targetDir, "replaced"), "utf8")).toBe("host change");
      expect(await readFile(path.join(targetDir, "other.txt"), "utf8")).toBe("sandbox change");
    } finally { await disposeDirectorySnapshot(baseline); }
  });

  it("ignores non-file entries when capturing snapshots", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const socketPath = path.join(rootDir, "runtime.sock");
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });

      expect(snapshot.entries.has("runtime.sock")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("classifyWorkspaceRestoreFailure", () => {
    it.each([
      "Daytona syncOut refusing tarball with an unparseable entry listing: private listing",
      "Daytona syncOut refusing unparseable or ambiguous symlink entry: private listing",
      "Daytona syncOut refusing unparseable or ambiguous hardlink entry: private listing",
      "Daytona syncOut refusing tarball member that escapes the extraction dir: ../private",
      "Daytona syncOut refusing tarball link whose target escapes the extraction dir: link -> /private",
      "Daytona sync source path is not a confined absolute path: ../private",
      "Daytona sync source path escapes the workspace remote dir: /private",
      ...[40, 41, 42, 44, 45].map((code) => `Daytona outbound symlink-escape guard command failed (exit ${code}): private detail`),
    ])("holds the deterministic confinement refusal: %s", (message) => {
      expect(classifyWorkspaceRestoreFailure(new Error(message))).toBe("restore_unsafe_archive");
      expect(describeWorkspaceRestoreFailure(classifyWorkspaceRestoreFailure(new Error(message)))).not.toContain("private");
    });

    it("preserves the generic policy for other outbound command failures", () => {
      expect(classifyWorkspaceRestoreFailure(new Error("Daytona outbound symlink-escape guard command failed (exit 1): transport failed"))).toBe("restore_failed");
    });

    it("maps an EACCES error to restore_permission_denied", () => {
      const error: NodeJS.ErrnoException = new Error("permission denied");
      error.code = "EACCES";
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_permission_denied");
    });

    it("maps an EPERM error to restore_permission_denied", () => {
      const error: NodeJS.ErrnoException = new Error("operation not permitted");
      error.code = "EPERM";
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_permission_denied");
    });

    it("maps the lock-timeout code to restore_lock_timeout", () => {
      const error: NodeJS.ErrnoException = new Error("Timed out waiting for workspace restore lock at /some/path");
      error.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_lock_timeout");
    });

    it("maps an unrecognized error, a string, and null to the default restore_failed code", () => {
      expect(classifyWorkspaceRestoreFailure(new Error("some other failure"))).toBe("restore_failed");
      expect(classifyWorkspaceRestoreFailure("a plain string")).toBe("restore_failed");
      expect(classifyWorkspaceRestoreFailure(null)).toBe("restore_failed");
    });
  });

  describe("describeWorkspaceRestoreFailure", () => {
    it("returns one fixed diagnostic line per allowlisted code, and no other text", () => {
      expect(describeWorkspaceRestoreFailure("restore_permission_denied")).toBe(
        "the restore could not write to the workspace (permission denied)",
      );
      expect(describeWorkspaceRestoreFailure("restore_lock_timeout")).toBe(
        "the restore timed out waiting for the workspace merge lock",
      );
      expect(describeWorkspaceRestoreFailure("restore_failed")).toBe("the restore failed");
    });

    it("never reflects a sentinel host path or process id, however the caught error is classified", () => {
      const sentinelPath = "/srv/telemetry-backend";
      const sentinelPid = String(process.pid);
      const error: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, mkdir '${sentinelPath}.paperclip-restore.lock' (pid ${sentinelPid})`,
      );
      error.code = "EACCES";

      const line = describeWorkspaceRestoreFailure(classifyWorkspaceRestoreFailure(error));

      expect(line).not.toContain(sentinelPath);
      expect(line).not.toContain(sentinelPid);
      expect(line).not.toContain(error.message);
    });
  });

  describe("instance-scoped directory merge lock", () => {
    // Points PAPERCLIP_HOME (and, where noted, PAPERCLIP_INSTANCE_ID) at a
    // temporary directory so the lock root never touches the real Paperclip
    // instance, then restores the previous values. Mirrors the save-and-restore
    // pattern in acpx-engine/execute.test.ts.
    let previousHome: string | undefined;
    let previousInstanceId: string | undefined;

    function useTempPaperclipHome(homeDir: string, instanceId: string): void {
      previousHome = process.env.PAPERCLIP_HOME;
      previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    }

    afterEach(() => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      previousHome = undefined;
      previousInstanceId = undefined;
    });

    it.skipIf(process.platform === "win32")(
      "restores successfully when the parent directory of the target is not writable",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        // The old lock sat beside the target, so it needed mkdir rights in the
        // target's parent. The new lock root lives under PAPERCLIP_HOME instead,
        // so a read-only parent must no longer block a restore.
        const readOnlyParent = path.join(rootDir, "read-only-parent");
        const targetDir = path.join(readOnlyParent, "target");
        const sourceDir = path.join(rootDir, "source");
        await mkdir(targetDir, { recursive: true });
        await mkdir(sourceDir, { recursive: true });

        const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
        await writeFile(path.join(sourceDir, "new-file.md"), "new content\n", "utf8");

        await chmod(readOnlyParent, 0o500);
        try {
          await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });
        } finally {
          // Restore write access so the outer afterEach can remove rootDir.
          await chmod(readOnlyParent, 0o700).catch(() => undefined);
        }

        await expect(readFile(path.join(targetDir, "new-file.md"), "utf8")).resolves.toBe("new content\n");
      },
    );

    it.skipIf(process.platform === "win32")(
      "acquires the same lock for two alias paths that resolve to one canonical target",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        const paperclipHome = path.join(rootDir, "paperclip-home");
        useTempPaperclipHome(paperclipHome, "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");

        let lockNameViaTarget = "";
        await withDirectoryMergeLock(targetDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaTarget = entries[0] ?? "";
        });

        let lockNameViaAlias = "";
        await withDirectoryMergeLock(aliasDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaAlias = entries[0] ?? "";
        });

        expect(lockNameViaTarget).not.toBe("");
        expect(lockNameViaAlias).toBe(lockNameViaTarget);
      },
    );

    it("rejects a lock root that already exists as a symlink", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(locksDir, { recursive: true });
      await mkdir(decoyDir, { recursive: true });
      await symlink(decoyDir, path.join(locksDir, "directory-merge"));

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("rejects a lock root that already exists as a non-directory", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(path.join(locksDir, "directory-merge"), "not a directory\n", "utf8");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("closes the create/validate TOCTOU window: rejects a lock root a racing writer swapped for a symlink during creation", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(decoyDir, { recursive: true });
      // Pre-create the lock root's parent, so the mock below only has to
      // reproduce what `fs.mkdir({ recursive: true })` does to the leaf path.
      await mkdir(path.join(paperclipHome, "instances", "test-instance", "locks"), { recursive: true });

      // Real `fs.mkdir({ recursive: true })` does not fail on a leaf that
      // already exists as a symlink to a real directory. This stub reproduces
      // exactly that: it plants a symlink to the attacker-controlled decoy
      // directory in the window between the resolver's own "does the root
      // exist yet" check and its own `mkdir` call, then resolves the way a
      // real `mkdir` would (silently) — proving the resolver must validate
      // what `mkdir` actually left behind, not trust that the call resolved.
      const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockImplementationOnce(async (dirPath) => {
        await symlink(decoyDir, dirPath as string);
        return undefined;
      });

      try {
        await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
          /not a plain directory/,
        );
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it("keeps the private lock database and removes diagnostic ownership after release", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      let entriesDuringLock: string[] = [];
      await withDirectoryMergeLock(targetDir, async () => {
        entriesDuringLock = await readdir(lockRootDir);
      });

      expect((await stat(lockRootDir)).mode & 0o777).toBe(0o700);
      expect(entriesDuringLock.filter((name) => name.endsWith(".owner.json"))).toHaveLength(1);
      // The lock and its admission queue are permanent; waiter files are not.
      const entriesAfterRelease = await readdir(lockRootDir);
      expect(entriesAfterRelease).toEqual(PERMANENT_LOCK_FILES);
      for (const name of entriesAfterRelease) expect((await stat(path.join(lockRootDir, name))).mode & 0o777).toBe(0o600);
    });

    it("classifies the real lock-timeout error by its stable code, never by the message text", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      // Pre-create the lock directory a live process holds, so `isLockStale`
      // never reports it stale and the retry loop can only leave through the
      // deadline check. The owner pid is this test process, which stays alive.
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      const heldLockDir = path.join(lockRootDir, `${lockKey}.lock`);
      await mkdir(heldLockDir, { recursive: true });
      await writeFile(
        path.join(heldLockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );

      // Reach the real deadline without a real 30-second wait: the first
      // `Date.now()` call computes the deadline (unchanged), and every call
      // after reports a time far past it, so the retry loop's own deadline
      // check — not a mocked message or a shortened constant — throws.
      const realNow = Date.now();
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementationOnce(() => realNow)
        .mockImplementation(() => Number.MAX_SAFE_INTEGER);
      let caughtError: NodeJS.ErrnoException | undefined;
      try {
        await withDirectoryMergeLock(targetDir, async () => undefined);
      } catch (error) {
        caughtError = error as NodeJS.ErrnoException;
      } finally {
        dateNowSpy.mockRestore();
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError?.code).toBe(WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE);
      // The classifier reads only `code`; prove the message text carries no
      // trace of the classified outcome, so a message-text match could not
      // have produced this result.
      expect(caughtError?.message).not.toContain("restore_lock_timeout");
      expect(classifyWorkspaceRestoreFailure(caughtError)).toBe("restore_lock_timeout");
      expect(caughtError).toMatchObject({ workspaceRestoreLock: {
        ownerState: "alive", ownerSameProcess: true, knownLocalHolder: false,
      } });
    });

    it("reports a known live holder without releasing it when a contender times out", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-holder-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const lockRoot = path.join(rootDir, "home", "instances", "test-instance", "locks", "directory-merge");
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
        try {
          await expect(withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_release")).rejects.toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true,
              knownLocalHolder: true, ownerPredatesProcess: false, operation: "agent_directory_release" },
          });
        } finally { clock.mockRestore(); }
        expect(contender).not.toHaveBeenCalled();
        expect((await readdir(lockRoot)).filter((name) => name.endsWith(".owner.json"))).toHaveLength(1);
      });
      expect(await readdir(lockRoot)).toEqual(PERMANENT_LOCK_FILES);
    });

    it("delivers the timeout when the diagnostic owner read stalls and ignores its late rejection", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-read-stall-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
        let markReadStarted!: (signal: AbortSignal) => void;
        const readStarted = new Promise<AbortSignal>((resolve) => { markReadStarted = resolve; });
        let rejectStalledRead!: (error: Error) => void;
        const stalledRead = new Promise<string>((_resolve, reject) => { rejectStalledRead = reject; });
        const realReadFile = fsPromises.readFile;
        const readSpy = vi.spyOn(fsPromises, "readFile")
          .mockImplementation((file, options) => {
            if (!options || typeof options !== "object" || !options.signal) return realReadFile(file, options);
            markReadStarted(options.signal);
            return stalledRead;
          });
        try {
          const pending = withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_release")
            .catch((error: unknown) => error);
          const signal = await readStarted;
          await vi.advanceTimersByTimeAsync(100);
          const error = await pending;
          expect(error).toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState: "unknown", knownLocalHolder: true,
              operation: "agent_directory_release" },
          });
          expect(signal.aborted).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
          rejectStalledRead(new Error("late filesystem failure"));
          await Promise.resolve();
          expect(contender).not.toHaveBeenCalled();
          expect(error).toMatchObject({ workspaceRestoreLock: { ownerState: "unknown" } });
        } finally {
          vi.useRealTimers();
          readSpy.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it.each([
      { label: "malformed JSON", raw: "{invalid-json", code: undefined, ownerState: "invalid" },
      { label: "a missing file", raw: undefined, code: "ENOENT", ownerState: "missing" },
      { label: "an unreadable file", raw: undefined, code: "EACCES", ownerState: "unknown" },
    ])("distinguishes $label in the diagnostic read", async ({ raw, code, ownerState }) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-read-state-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
        const realReadFile = fsPromises.readFile;
        const readSpy = vi.spyOn(fsPromises, "readFile")
          .mockImplementation(async (file, options) => {
            if (!options || typeof options !== "object" || !options.signal) return realReadFile(file, options);
            if (code) throw Object.assign(new Error("owner read failed"), { code });
            return raw!;
          });
        try {
          await expect(withDirectoryMergeLock(targetDir, contender)).rejects.toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState, knownLocalHolder: true },
          });
          expect(contender).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it("reports an owner older than this process without reclaiming a live PID", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-older-owner-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const lockKey = createHash("sha256").update(await realpath(targetDir)).digest("hex");
      const lockDir = path.join(rootDir, "home", "instances", "test-instance", "locks", "directory-merge", `${lockKey}.lock`);
      await mkdir(lockDir, { recursive: true });
      const now = Date.now();
      const owner = JSON.stringify({ pid: process.pid, createdAt: new Date(now - process.uptime() * 1000 - 10_000).toISOString(), private: "private owner payload" });
      await writeFile(path.join(lockDir, "owner.json"), owner);
      const clock = vi.spyOn(Date, "now").mockReturnValue(now)
        .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
      let caught: unknown;
      try { await withDirectoryMergeLock(targetDir, async () => { throw new Error("must not acquire"); }); }
      catch (error) { caught = error; }
      finally { clock.mockRestore(); }
      expect(caught).toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
        workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true,
          knownLocalHolder: false, ownerPredatesProcess: true } });
      const diagnostic = (caught as { workspaceRestoreLock: Record<string, unknown> }).workspaceRestoreLock;
      expect(Object.keys(diagnostic).sort()).toEqual(["knownLocalHolder", "ownerAgeMs", "ownerPredatesProcess", "ownerSameProcess", "ownerState", "waitMs"]);
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      expect(JSON.stringify(diagnostic)).not.toContain(lockDir);
      expect(await readFile(path.join(lockDir, "owner.json"), "utf8")).toBe(owner);
    });

    it.skipIf(process.platform === "win32")(
      "serializes two concurrent writers that address one target through different aliases",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        let active = false;
        let overlapCount = 0;
        let completedCount = 0;
        const runWriter = (dir: string) =>
          withDirectoryMergeLock(dir, async () => {
            if (active) overlapCount += 1;
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            active = false;
            completedCount += 1;
          });

        await Promise.all([runWriter(targetDir), runWriter(aliasDir)]);

        expect(overlapCount).toBe(0);
        expect(completedCount).toBe(2);
      },
    );
  });

  describe("caller-provided env for the lock root", () => {
    // These tests never touch `process.env`. They prove `withDirectoryMergeLock`
    // resolves the lock root from a caller's own `env` object — the shape every
    // environment-parameterized Codex credential call site holds — instead of
    // always reading `process.env`.

    it("two callers that pass the same env with a temporary PAPERCLIP_HOME take the same lock under that home", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome, PAPERCLIP_INSTANCE_ID: "test-instance" };

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(explicitHome, "instances", "test-instance", "locks", "directory-merge");

      let lockNameFirstCaller = "";
      await withDirectoryMergeLock(
        targetDir,
        async () => {
          const entries = await readdir(lockRootDir);
          lockNameFirstCaller = entries[0] ?? "";
        },
        env,
      );

      let lockNameSecondCaller = "";
      await withDirectoryMergeLock(
        targetDir,
        async () => {
          const entries = await readdir(lockRootDir);
          lockNameSecondCaller = entries[0] ?? "";
        },
        env,
      );

      expect(lockNameFirstCaller).not.toBe("");
      expect(lockNameSecondCaller).toBe(lockNameFirstCaller);
      expect(lockRootDir.startsWith(explicitHome + path.sep)).toBe(true);
    });

    it("does not write a lock entry under process.env.PAPERCLIP_HOME when the caller passes its own env", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome, PAPERCLIP_INSTANCE_ID: "test-instance" };

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");

      // Resolved with no `env` argument, so it reads `process.env` exactly the way
      // the real instance root does — unaffected by the explicit `env` above.
      const realInstanceRoot = resolvePaperclipInstanceRootForAdapter();
      const realLockPath = path.join(realInstanceRoot, "locks", "directory-merge", `${lockKey}.lock`);

      await withDirectoryMergeLock(targetDir, async () => undefined, env);

      await expect(lstat(realLockPath)).rejects.toThrow();

      const explicitLockRootDir = path.join(explicitHome, "instances", "test-instance", "locks", "directory-merge");
      await expect(stat(explicitLockRootDir)).resolves.toBeTruthy();
    });

    it("resolves the lock root under the default instance id when the caller env sets PAPERCLIP_HOME but not PAPERCLIP_INSTANCE_ID, ignoring process.env.PAPERCLIP_INSTANCE_ID", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome };

      const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_INSTANCE_ID = "wrong-instance";
      try {
        const targetDir = path.join(rootDir, "target");
        await mkdir(targetDir, { recursive: true });

        // The independent, no-caller-env resolution of "PAPERCLIP_HOME set,
        // PAPERCLIP_INSTANCE_ID unset" — the expected default instance id.
        const expectedInstanceRoot = resolvePaperclipInstanceRootForAdapter({ homeDir: explicitHome, env: {} });
        const expectedLockRootDir = path.join(expectedInstanceRoot, "locks", "directory-merge");
        const wrongInstanceLockRootDir = path.join(explicitHome, "instances", "wrong-instance", "locks", "directory-merge");

        await withDirectoryMergeLock(targetDir, async () => undefined, env);

        await expect(stat(expectedLockRootDir)).resolves.toBeTruthy();
        await expect(stat(wrongInstanceLockRootDir)).rejects.toThrow();
      } finally {
        if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
        else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      }
    });

    it("does not read process.env.PAPERCLIP_HOME when the caller env sets neither variable", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const fakeProcessHome = path.join(rootDir, "process-home");
      const fallbackOsHome = path.join(rootDir, "os-home");
      await mkdir(fallbackOsHome, { recursive: true });

      const previousHome = process.env.PAPERCLIP_HOME;
      process.env.PAPERCLIP_HOME = fakeProcessHome;
      // Stand in for the real host home directory, so the "no env at all"
      // fallback lands under a temp dir instead of the real ~/.paperclip.
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fallbackOsHome);
      try {
        const targetDir = path.join(rootDir, "target");
        await mkdir(targetDir, { recursive: true });

        // The independent, no-caller-env resolution of "neither variable set" —
        // the expected fallback root under the mocked home directory.
        const expectedInstanceRoot = resolvePaperclipInstanceRootForAdapter({ env: {} });
        const expectedLockRootDir = path.join(expectedInstanceRoot, "locks", "directory-merge");

        await withDirectoryMergeLock(targetDir, async () => undefined, {});

        await expect(stat(fakeProcessHome)).rejects.toThrow();
        await expect(stat(expectedLockRootDir)).resolves.toBeTruthy();
      } finally {
        homedirSpy.mockRestore();
        if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
        else process.env.PAPERCLIP_HOME = previousHome;
      }
    });
  });
});

describe("conflict-preserving directory restore", () => {
  it("preflights competing edits before applying any other change and deduplicates replay", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-cas-")));
    const source = path.join(root, "source"), target = path.join(root, "target");
    try {
      await mkdir(target);
      await writeFile(path.join(target, "conflict"), "baseline");
      const baseline = await captureDirectorySnapshot(target);
      await fsPromises.cp(target, source, { recursive: true });
      await writeFile(path.join(source, "conflict"), "incoming");
      await writeFile(path.join(source, "independent"), "also incoming");
      await writeFile(path.join(target, "conflict"), "board");
      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["conflict"] });
      await expect(stat(path.join(target, "independent"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(target, "conflict"), "baseline");
      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject", afterApply: async () => { throw new Error("receipt interrupted"); } })).rejects.toThrow("receipt interrupted");
      await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" });
      expect(await readFile(path.join(target, "independent"), "utf8")).toBe("also incoming");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves a newly added child when another run removes or replaces its parent", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-delete-cas-")));
    const source = path.join(root, "source"), target = path.join(root, "target");
    try {
      await mkdir(path.join(target, "folder"), { recursive: true });
      const baseline = await captureDirectorySnapshot(target);
      await mkdir(source);
      await writeFile(path.join(target, "folder", "new"), "concurrent");
      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" })).rejects.toMatchObject({ paths: ["folder/new"] });
      expect(await readFile(path.join(target, "folder", "new"), "utf8")).toBe("concurrent");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


it.each(["file", "symlink"] as const)("refuses, before writing, to replace a directory holding an excluded tree with a %s", async (kind) => {
  const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-excluded-default-")));
  const target = path.join(root, "target"), source = path.join(root, "source");
  await mkdir(path.join(target, "packages", "app", "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(target, "packages", "app", "index.ts"), "tracked");
  await writeFile(path.join(target, "packages", "app", "node_modules", "dep", "index.js"), "host install");
  const baseline = await captureDirectorySnapshot(target, { exclude: ["node_modules", "*/node_modules", "*/node_modules/*"], diskBacked: true });
  try {
    await mkdir(path.join(source, "packages"), { recursive: true });
    if (kind === "file") await writeFile(path.join(source, "packages", "app"), "replacement");
    else await symlink("../elsewhere", path.join(source, "packages", "app"));
    await writeFile(path.join(source, "independent"), "must not partially apply");
    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }))
      .rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["packages/app"] });
    expect(await readFile(path.join(target, "packages", "app", "node_modules", "dep", "index.js"), "utf8")).toBe("host install");
    expect(await readFile(path.join(target, "packages", "app", "index.ts"), "utf8")).toBe("tracked");
    await expect(stat(path.join(target, "independent"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await disposeDirectorySnapshot(baseline); await rm(root, { recursive: true, force: true }); }
});

it("still replaces a directory that holds only unchanged baseline entries", async () => {
  const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-replace-owned-")));
  const target = path.join(root, "target"), source = path.join(root, "source");
  await mkdir(path.join(target, "packages", "app", "src"), { recursive: true });
  await writeFile(path.join(target, "packages", "app", "src", "index.ts"), "tracked");
  const baseline = await captureDirectorySnapshot(target, { exclude: ["node_modules", "*/node_modules", "*/node_modules/*"], diskBacked: true });
  try {
    await mkdir(path.join(source, "packages"), { recursive: true });
    await writeFile(path.join(source, "packages", "app"), "replacement");
    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });
    expect(await readFile(path.join(target, "packages", "app"), "utf8")).toBe("replacement");
  } finally { await disposeDirectorySnapshot(baseline); await rm(root, { recursive: true, force: true }); }
});

it("strict preflight preserves excluded descendants when a directory becomes a file", async () => {
  const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-excluded-cas-")));
  const target = path.join(root, "target"), source = path.join(root, "source");
  await mkdir(path.join(target, "folder", "node_modules"), { recursive: true });
  await writeFile(path.join(target, "folder", "node_modules", "keep"), "excluded contents");
  const baseline = await captureDirectorySnapshot(target, { exclude: ["*/node_modules"], diskBacked: true });
  try {
    await mkdir(source);
    await writeFile(path.join(source, "folder"), "replacement");
    await writeFile(path.join(source, "independent"), "must not partially apply");
    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" }))
      .rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: expect.arrayContaining(["folder/node_modules/keep"]) });
    expect(await readFile(path.join(target, "folder", "node_modules", "keep"), "utf8")).toBe("excluded contents");
    await expect(stat(path.join(target, "independent"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await disposeDirectorySnapshot(baseline); await rm(root, { recursive: true, force: true }); }
});

describe("parallel restores into one shared project workspace", () => {
  const WAIT_ENV = "PAPERCLIP_WORKSPACE_RESTORE_LOCK_WAIT_MS";
  const savedEnv = new Map<string, string | undefined>();
  const roots: string[] = [];

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(condition: () => boolean): Promise<void> {
    for (let waited = 0; !condition(); waited += 10) {
      if (waited > 5_000) throw new Error("condition not reached");
      await sleep(10);
    }
  }

  async function sharedWorkspace(): Promise<{ root: string; target: string; lockRoot: string }> {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-parallel-restore-")));
    roots.push(root);
    setEnv("PAPERCLIP_HOME", path.join(root, "home"));
    setEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
    setEnv(WAIT_ENV, undefined);
    const target = path.join(root, "target");
    await mkdir(path.join(target, "src"), { recursive: true });
    await writeFile(path.join(target, "src", "a.ts"), "a0\n");
    await writeFile(path.join(target, "src", "b.ts"), "b0\n");
    const lockRoot = path.join(root, "home", "instances", "test-instance", "locks", "directory-merge");
    return { root, target, lockRoot };
  }

  async function runWorkspace(root: string, target: string, name: string, edit?: { file: string; text: string }): Promise<string> {
    const dir = path.join(root, name);
    await fsPromises.cp(target, dir, { recursive: true });
    if (edit) await writeFile(path.join(dir, edit.file), edit.text);
    return dir;
  }

  it.each([
    { label: "unset", value: undefined },
    { label: "not a number", value: "soon" },
    { label: "zero", value: "0" },
    { label: "below the 1 s minimum", value: "500" },
  ])("queues a second restore behind a merge slower than the old 30 s budget (wait setting $label)", async ({ value }) => {
    const { root, target } = await sharedWorkspace();
    setEnv(WAIT_ENV, value);
    const baselineA = await captureDirectorySnapshot(target);
    const baselineB = await captureDirectorySnapshot(target);
    const sourceA = await runWorkspace(root, target, "run-a", { file: "src/a.ts", text: "a1\n" });
    const sourceB = await runWorkspace(root, target, "run-b", { file: "src/b.ts", text: "b1\n" });
    // A large workspace holds the lock for longer than 30 s. Instead of waiting
    // that long, run A jumps the clock the waiter reads past 30 s while it holds
    // the lock, after run B has started waiting.
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    let lockPolls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      // waitForLock reads the clock once per poll of a busy lock.
      if (new Error().stack?.includes("waitForLock")) lockPolls += 1;
      return realNow() + skewMs;
    });
    let markHolding!: () => void;
    const holding = new Promise<void>((resolve) => { markHolding = resolve; });
    const mergeA = mergeDirectoryWithBaseline({
      baseline: baselineA, sourceDir: sourceA, targetDir: target,
      beforeApply: async () => {
        markHolding();
        // Run B read its deadline before its first poll of the busy lock.
        await until(() => lockPolls >= 1);
        skewMs = 31_000;
        await sleep(200);
      },
    });
    await holding;
    const mergeB = mergeDirectoryWithBaseline({ baseline: baselineB, sourceDir: sourceB, targetDir: target });

    const results = await Promise.allSettled([mergeA, mergeB]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await readFile(path.join(target, "src", "a.ts"), "utf8")).toBe("a1\n");
    expect(await readFile(path.join(target, "src", "b.ts"), "utf8")).toBe("b1\n");
  });

  it("bounds the wait by PAPERCLIP_WORKSPACE_RESTORE_LOCK_WAIT_MS and keeps the timeout diagnostics", async () => {
    const { root, target } = await sharedWorkspace();
    // Time scaled down 30x: the old 30 s budget becomes 1 s, and run A's merge
    // holds the lock for 2 s, longer than that. Run B starts once A holds it.
    async function restoreBehindSlowMerge(name: string, a: string, b: string): Promise<[PromiseSettledResult<void>, PromiseSettledResult<void>]> {
      const baselineA = await captureDirectorySnapshot(target);
      const baselineB = await captureDirectorySnapshot(target);
      const sourceA = await runWorkspace(root, target, `${name}-a`, { file: "src/a.ts", text: a });
      const sourceB = await runWorkspace(root, target, `${name}-b`, { file: "src/b.ts", text: b });
      let markHolding!: () => void;
      const holding = new Promise<void>((resolve) => { markHolding = resolve; });
      const held = mergeDirectoryWithBaseline({ baseline: baselineA, sourceDir: sourceA, targetDir: target,
        beforeApply: async () => { markHolding(); await sleep(2_000); } });
      await holding;
      const waiter = mergeDirectoryWithBaseline({ baseline: baselineB, sourceDir: sourceB, targetDir: target });
      return await Promise.allSettled([held, waiter]);
    }

    setEnv(WAIT_ENV, "5000");
    const queued = await restoreBehindSlowMerge("queued", "a1\n", "b1\n");
    expect(queued.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await readFile(path.join(target, "src", "a.ts"), "utf8")).toBe("a1\n");
    expect(await readFile(path.join(target, "src", "b.ts"), "utf8")).toBe("b1\n");

    // The old budget, scaled: the waiter fails exactly as production did.
    setEnv(WAIT_ENV, "1000");
    const [held, waiter] = await restoreBehindSlowMerge("bounded", "a2\n", "b2\n");
    expect(held.status).toBe("fulfilled");
    expect(waiter.status).toBe("rejected");
    const error = waiter.status === "rejected" ? waiter.reason : null;
    expect(error).toMatchObject({
      code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
      workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true, knownLocalHolder: true },
    });
    expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_lock_timeout");
    expect(error.workspaceRestoreLock.waitMs).toBeGreaterThanOrEqual(900);
    expect(error.workspaceRestoreLock.waitMs).toBeLessThan(2_000);
    expect(await readFile(path.join(target, "src", "b.ts"), "utf8")).toBe("b1\n");
  });

  it("captures a baseline while another restore renames its staged file into place", async () => {
    const { target } = await sharedWorkspace();
    const tests = path.join(target, "games", "solo", "leaderboard", "tests");
    await mkdir(tests, { recursive: true });
    await writeFile(path.join(tests, "existing.test.ts"), "existing\n");
    // copySnapshotEntry stages each incoming file beside its target, then
    // renames it into place. Another run's baseline walk can list the staged
    // name and then lstat it after the rename.
    const staged = path.join(tests, `.paperclip-merge-${randomUUID()}`);
    await writeFile(staged, "incoming\n");
    // Only the exact staging shape is skipped; a look-alike name is a real file.
    await writeFile(path.join(tests, ".paperclip-merge-notes"), "notes\n");
    const realLstat = fsPromises.lstat;
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (file, options) => {
      if (String(file) === staged) await fsPromises.rename(staged, path.join(tests, "incoming.test.ts"));
      return await realLstat(file, options);
    });

    const snapshot = await captureDirectorySnapshot(target);

    const paths = [...snapshot.entries].map(([relative]) => relative);
    expect(paths).toContain("games/solo/leaderboard/tests/existing.test.ts");
    expect(paths.filter((relative) => relative.includes(".paperclip-merge-")))
      .toEqual(["games/solo/leaderboard/tests/.paperclip-merge-notes"]);
  });

  it("treats entries that vanish mid-walk as absent and still fails on other errors", async () => {
    const { target } = await sharedWorkspace();
    await writeFile(path.join(target, "gone-before-lstat.txt"), "x");
    await writeFile(path.join(target, "gone-before-hash.txt"), "x");
    await symlink("src/a.ts", path.join(target, "gone-link"));
    await mkdir(path.join(target, "gone-dir"));
    await writeFile(path.join(target, "gone-dir", "child.txt"), "x");
    await mkdir(path.join(target, "replaced-dir"));
    await writeFile(path.join(target, "replaced-dir", "child.txt"), "x");
    const vanishAfterLstat = new Set(["gone-before-hash.txt", "gone-link", "gone-dir"]);
    const realLstat = fsPromises.lstat;
    const lstatSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (file, options) => {
      const name = path.basename(String(file));
      if (name === "gone-before-lstat.txt") await rm(file);
      const stats = await realLstat(file, options);
      if (vanishAfterLstat.has(name)) await rm(file, { recursive: true });
      // Another restore replaces this directory with a file: opendir gets ENOTDIR.
      if (name === "replaced-dir") {
        await rm(file, { recursive: true });
        await writeFile(file, "now a file");
      }
      return stats;
    });

    const snapshot = await captureDirectorySnapshot(target, { diskBacked: true });
    try {
      // lstat saw both directories, so they stay recorded; their vanished
      // contents do not.
      expect([...snapshot.entries].map(([relative]) => relative)).toEqual(["gone-dir", "replaced-dir", "src", "src/a.ts", "src/b.ts"]);
    } finally { await disposeDirectorySnapshot(snapshot); }

    lstatSpy.mockImplementation(async (file, options) => {
      if (path.basename(String(file)) === "a.ts") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return await realLstat(file, options);
    });
    await expect(captureDirectorySnapshot(target)).rejects.toMatchObject({ code: "EACCES" });
    await expect(captureDirectorySnapshot(path.join(target, "missing-root"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips the lock and the merge when the run changed nothing against its baseline", async () => {
    const { root, target, lockRoot } = await sharedWorkspace();
    const baseline = await captureDirectorySnapshot(target, { diskBacked: true });
    const review = await runWorkspace(root, target, "review");
    // An engineer's restore lands while the read-only review is still running.
    await writeFile(path.join(target, "src", "a.ts"), "engineer\n");
    const rename = vi.spyOn(fsPromises, "rename");
    try {
      await mergeDirectoryWithBaseline({ baseline, sourceDir: review, targetDir: target });
    } finally { await disposeDirectorySnapshot(baseline); }

    await expect(lstat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rename).not.toHaveBeenCalled();
    expect(await readFile(path.join(target, "src", "a.ts"), "utf8")).toBe("engineer\n");

    // The merge owns snapshots a caller passes in, also when it skips.
    const source = await captureDirectorySnapshot(review, { diskBacked: true });
    const current = await captureDirectorySnapshot(target, { diskBacked: true });
    const owned = [source, current].map(({ entries }) => entries instanceof WorkspaceManifestMap ? entries.manifest.filePath : "");
    await mergeDirectoryWithBaseline({ baseline: await captureDirectorySnapshot(review), sourceDir: review, targetDir: target,
      snapshots: { source, current } });
    for (const filePath of owned) await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(lockRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still locks and runs the hooks for an unchanged tree", async () => {
    const { root, target, lockRoot } = await sharedWorkspace();
    const baseline = await captureDirectorySnapshot(target);
    const review = await runWorkspace(root, target, "review");
    const beforeApply = vi.fn(async () => undefined);
    const afterApply = vi.fn(async () => undefined);

    await mergeDirectoryWithBaseline({ baseline, sourceDir: review, targetDir: target, beforeApply, afterApply });

    expect(beforeApply).toHaveBeenCalledTimes(1);
    expect(afterApply).toHaveBeenCalledTimes(1);
    expect(await readdir(lockRoot)).toEqual(PERMANENT_LOCK_FILES);
  });
});

describe("staging files left behind by a killed merge", () => {
  const roots: string[] = [];
  let previousHome: string | undefined;
  let previousInstanceId: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  const HOUR_MS = 60 * 60_000;
  const stagingName = () => `.paperclip-merge-${randomUUID()}`;

  async function workspace() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-stale-staging-")));
    roots.push(root);
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const target = path.join(root, "target");
    const source = path.join(root, "source");
    await mkdir(path.join(target, "tests"), { recursive: true });
    await writeFile(path.join(target, "tests", "a.test.ts"), "a\n");
    await writeFile(path.join(target, "keep.txt"), "keep\n");
    return { root, target, source };
  }

  async function leftover(directory: string, ageMs: number): Promise<string> {
    const file = path.join(directory, stagingName());
    await writeFile(file, "half a copy\n");
    const then = new Date(Date.now() - ageMs);
    await utimes(file, then, then);
    return file;
  }

  // The run deleted the whole `tests` directory in its copy of the workspace.
  async function runDeletingTests(root: string, target: string, source: string) {
    const baseline = await captureDirectorySnapshot(target);
    await fsPromises.cp(target, source, { recursive: true });
    await rm(path.join(source, "tests"), { recursive: true });
    return baseline;
  }

  it("removes a stale leftover so a later delete of its directory completes", async () => {
    const { root, target, source } = await workspace();
    const stale = await leftover(path.join(target, "tests"), 2 * HOUR_MS);
    const baseline = await runDeletingTests(root, target, source);

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });

    await expect(lstat(path.join(target, "tests"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("keeps a recent staging file, which may belong to a merge that is still copying", async () => {
    const { root, target, source } = await workspace();
    const recent = await leftover(path.join(target, "tests"), 1_000);
    const baseline = await runDeletingTests(root, target, source);

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });

    expect(await readFile(recent, "utf8")).toBe("half a copy\n");
  });

  it("removes a stale leftover but still keeps a directory that holds real files", async () => {
    const { root, target, source } = await workspace();
    const baseline = await runDeletingTests(root, target, source);
    await writeFile(path.join(target, "tests", "added-by-someone-else.ts"), "mine\n");
    const stale = await leftover(path.join(target, "tests"), 2 * HOUR_MS);

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });

    expect(await readFile(path.join(target, "tests", "added-by-someone-else.ts"), "utf8")).toBe("mine\n");
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("never follows or removes a staging-named link, and a directory holding one stays", async () => {
    const { root, target, source } = await workspace();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside the workspace\n");
    const link = path.join(target, "tests", stagingName());
    await symlink(outside, link);
    const baseline = await runDeletingTests(root, target, source);

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });

    expect(await readFile(outside, "utf8")).toBe("outside the workspace\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("never cleans through a symlinked ancestor that points outside the workspace", async () => {
    const { root, target, source } = await workspace();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "b"), { recursive: true });
    await writeFile(path.join(outside, "b", "real.txt"), "outside file\n");
    const externalStale = await leftover(path.join(outside, "b"), 2 * HOUR_MS);
    await symlink(outside, path.join(target, "a"));
    const baseline = await captureDirectorySnapshot(target);
    // The run's copy has a real directory `a` whose child `b` is now a file.
    await mkdir(path.join(source, "a"), { recursive: true });
    await fsPromises.cp(path.join(target, "tests"), path.join(source, "tests"), { recursive: true });
    await writeFile(path.join(source, "keep.txt"), "keep\n");
    await writeFile(path.join(source, "a", "b"), "now a file\n");

    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }))
      .rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT" });

    expect(await readFile(externalStale, "utf8")).toBe("half a copy\n");
    expect(await readFile(path.join(outside, "b", "real.txt"), "utf8")).toBe("outside file\n");
  });

  it("removes a stale leftover when a file replaces its directory", async () => {
    const { root, target, source } = await workspace();
    const stale = await leftover(path.join(target, "tests"), 2 * HOUR_MS);
    const baseline = await captureDirectorySnapshot(target);
    await fsPromises.cp(target, source, { recursive: true });
    await rm(path.join(source, "tests"), { recursive: true });
    await writeFile(path.join(source, "tests"), "now a file\n");

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });

    expect(await readFile(path.join(target, "tests"), "utf8")).toBe("now a file\n");
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("merge mutations never follow a symlinked ancestor out of the workspace", () => {
  const roots: string[] = [];
  let previousHome: string | undefined;
  let previousInstanceId: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  async function workspace() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-ancestor-")));
    roots.push(root);
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const target = path.join(root, "target");
    const source = path.join(root, "source");
    const outside = path.join(root, "outside");
    await mkdir(path.join(target, "a", "sub"), { recursive: true });
    await writeFile(path.join(target, "a", "x"), "inside x\n");
    await writeFile(path.join(target, "a", "d"), "will be replaced\n");
    await mkdir(path.join(outside, "sub"), { recursive: true });
    await mkdir(path.join(outside, "d"));
    await writeFile(path.join(outside, "x"), "outside x\n");
    await writeFile(path.join(outside, "keep.txt"), "outside keep\n");
    return { root, target, source, outside };
  }

  // Every file and directory below `dir`, with file contents.
  async function treeOf(dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const walk = async (current: string) => {
      for (const name of await readdir(current)) {
        const full = path.join(current, name);
        const stats = await lstat(full);
        const key = path.relative(dir, full);
        if (stats.isDirectory()) { result[key] = "<dir>"; await walk(full); }
        else if (stats.isSymbolicLink()) result[key] = `<link>`;
        else result[key] = await readFile(full, "utf8");
      }
    };
    await walk(dir);
    return result;
  }

  // The run's copy of the workspace, changed by `change`.
  async function sourceWith(target: string, source: string, change: (source: string) => Promise<void>) {
    await fsPromises.cp(target, source, { recursive: true });
    await change(source);
  }

  async function replaceAWithLinkTo(target: string, outside: string) {
    await fsPromises.rename(path.join(target, "a"), path.join(target, "a-moved"));
    await symlink(outside, path.join(target, "a"));
  }

  it("refuses to write through a link that a queued restore left in place of a directory", async () => {
    const { target, source, outside } = await workspace();
    // Restore B starts from this baseline, in which `a` is a directory.
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => { await writeFile(path.join(dir, "a", "b"), "new\n"); });
    // Restore A, queued first, turned `a` into a link to a directory outside.
    await replaceAWithLinkTo(target, outside);
    const before = await treeOf(outside);

    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }))
      .rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["a"] });

    expect(await treeOf(outside)).toEqual(before);
    expect((await lstat(path.join(target, "a"))).isSymbolicLink()).toBe(true);
  });

  it("writes nothing at all when one entry's ancestor is a link, even an entry that sorts first", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => {
      await writeFile(path.join(dir, "0-first.txt"), "would be written first\n");
      await writeFile(path.join(dir, "a", "b"), "new\n");
    });
    await replaceAWithLinkTo(target, outside);

    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }))
      .rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["a"] });

    await expect(lstat(path.join(target, "0-first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses when an ancestor becomes a link between the preflight and a write", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => { await writeFile(path.join(dir, "a", "b"), "new\n"); });
    const before = await treeOf(outside);
    // A refused write must not even stage its temporary file through the link.
    const copiedTo: string[] = [];
    const realCopyFile = fsPromises.copyFile;
    vi.spyOn(fsPromises, "copyFile").mockImplementation(async (from, to, mode) => {
      copiedTo.push(String(to));
      return await realCopyFile(from, to, mode);
    });

    await expect(mergeDirectoryWithBaseline({
      baseline, sourceDir: source, targetDir: target,
      afterPreflight: async () => { await replaceAWithLinkTo(target, outside); },
    })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT" });

    expect(copiedTo).toEqual([]);
    expect(await treeOf(outside)).toEqual(before);
  });

  it("refuses to delete through an ancestor that becomes a link between the preflight and the delete", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => { await rm(path.join(dir, "a", "x")); });
    const before = await treeOf(outside);

    await expect(mergeDirectoryWithBaseline({
      baseline, sourceDir: source, targetDir: target,
      afterPreflight: async () => { await replaceAWithLinkTo(target, outside); },
    })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT" });

    expect(await readFile(path.join(outside, "x"), "utf8")).toBe("outside x\n");
    expect(await treeOf(outside)).toEqual(before);
  });

  it("refuses to remove a directory through an ancestor that becomes a link between the preflight and the removal", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => { await rm(path.join(dir, "a", "sub"), { recursive: true }); });
    const before = await treeOf(outside);

    await expect(mergeDirectoryWithBaseline({
      baseline, sourceDir: source, targetDir: target,
      afterPreflight: async () => { await replaceAWithLinkTo(target, outside); },
    })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT" });

    expect((await lstat(path.join(outside, "sub"))).isDirectory()).toBe(true);
    expect(await treeOf(outside)).toEqual(before);
  });

  it("refuses to replace a directory with a file through an ancestor that becomes a link", async () => {
    const { target, source, outside } = await workspace();
    await mkdir(path.join(target, "a", "d2"));
    await rm(path.join(target, "a", "d"));
    await mkdir(path.join(target, "a", "d"));
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => {
      await rm(path.join(dir, "a", "d"), { recursive: true });
      await writeFile(path.join(dir, "a", "d"), "now a file\n");
    });
    const before = await treeOf(outside);

    await expect(mergeDirectoryWithBaseline({
      baseline, sourceDir: source, targetDir: target,
      afterPreflight: async () => { await replaceAWithLinkTo(target, outside); },
    })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT" });

    expect((await lstat(path.join(outside, "d"))).isDirectory()).toBe(true);
    expect(await treeOf(outside)).toEqual(before);
  });

  it("still creates missing directories and replaces a link with a directory inside the workspace", async () => {
    const { target, source, outside } = await workspace();
    await symlink(outside, path.join(target, "shortcut"));
    const baseline = await captureDirectorySnapshot(target);
    await sourceWith(target, source, async (dir) => {
      await mkdir(path.join(dir, "deep", "er"), { recursive: true });
      await writeFile(path.join(dir, "deep", "er", "file.txt"), "deep\n");
      await rm(path.join(dir, "shortcut"));
      await mkdir(path.join(dir, "shortcut"));
      await writeFile(path.join(dir, "shortcut", "real.txt"), "now a directory\n");
    });
    const before = await treeOf(outside);

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target });

    expect(await readFile(path.join(target, "deep", "er", "file.txt"), "utf8")).toBe("deep\n");
    expect(await readFile(path.join(target, "shortcut", "real.txt"), "utf8")).toBe("now a directory\n");
    expect((await lstat(path.join(target, "shortcut"))).isDirectory()).toBe(true);
    expect(await treeOf(outside)).toEqual(before);
  });
});

describe("merge mutations are bound to the directory they validated", () => {
  const roots: string[] = [];
  let previousHome: string | undefined;
  let previousInstanceId: string | undefined;
  // Directory descriptors can be used as path bases only where /proc exposes them.
  const pinning = typeof descriptorPinningSupported === "function" && descriptorPinningSupported();

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  async function workspace() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-pinned-")));
    roots.push(root);
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const target = path.join(root, "target");
    const source = path.join(root, "source");
    const outside = path.join(root, "outside");
    await mkdir(path.join(target, "a"), { recursive: true });
    await writeFile(path.join(target, "a", "x"), "inside x\n");
    await mkdir(outside);
    await writeFile(path.join(outside, "x"), "outside x\n");
    return { root, target, source, outside };
  }

  async function swapAForLinkTo(target: string, outside: string) {
    await fsPromises.rename(path.join(target, "a"), path.join(target, "a-moved"));
    await symlink(outside, path.join(target, "a"));
  }

  async function snapshotOf(dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const name of await readdir(dir)) result[name] = await readFile(path.join(dir, name), "utf8");
    return result;
  }

  it("rejects a snapshot that has a link and a child below it, and leaves the target unchanged", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await mkdir(source);
    await writeFile(path.join(source, "b"), "child of a link\n");
    // No real walk produces this: the run's tree has `a` as a link and `a/b` below it.
    const crafted = new Map<string, SnapshotEntry>([
      ["a", { kind: "symlink", target: outside }],
      ["a/b", { kind: "file", mode: 0o644, hash: "0".repeat(64) }],
    ]);
    const current = await captureDirectorySnapshot(target);

    await expect(mergeDirectoryWithBaseline({
      baseline, sourceDir: source, targetDir: target,
      snapshots: { source: { exclude: [], entries: crafted }, current },
    })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["a"] });

    expect((await lstat(path.join(target, "a"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(target, "a", "x"), "utf8")).toBe("inside x\n");
    expect(await snapshotOf(outside)).toEqual({ x: "outside x\n" });
  });

  it("does not stage a copy through an ancestor that is swapped for a link while the file is copied", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await fsPromises.cp(target, source, { recursive: true });
    await writeFile(path.join(source, "a", "b"), "new\n");
    // Swap the ancestor at the moment the copy starts, then see where the bytes went.
    const realCopyFile = fsPromises.copyFile;
    let swapped = false;
    let leaked: string[] = [];
    vi.spyOn(fsPromises, "copyFile").mockImplementation(async (from, to, mode) => {
      if (!swapped) { swapped = true; await swapAForLinkTo(target, outside); }
      await realCopyFile(from, to, mode);
      leaked = (await readdir(outside)).filter((name) => name !== "x");
    });

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }).catch(() => undefined);

    expect(leaked).toEqual([]);
    expect(await snapshotOf(outside)).toEqual({ x: "outside x\n" });
  });

  it.skipIf(!pinning)("deletes inside the validated directory when its path is swapped for a link just before the delete", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await fsPromises.cp(target, source, { recursive: true });
    await rm(path.join(source, "a", "x"));
    const realRm = fsPromises.rm;
    let swapped = false;
    vi.spyOn(fsPromises, "rm").mockImplementation(async (file, options) => {
      if (!swapped && String(file).endsWith("/x")) { swapped = true; await swapAForLinkTo(target, outside); }
      return await realRm(file, options);
    });

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }).catch(() => undefined);

    expect(swapped).toBe(true);
    expect(await snapshotOf(outside)).toEqual({ x: "outside x\n" });
  });

  it.skipIf(!pinning)("renames inside the validated directory when its path is swapped for a link just before the rename", async () => {
    const { target, source, outside } = await workspace();
    const baseline = await captureDirectorySnapshot(target);
    await fsPromises.cp(target, source, { recursive: true });
    await writeFile(path.join(source, "a", "b"), "new\n");
    const realRename = fsPromises.rename;
    let swapped = false;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (!swapped && String(to).endsWith("/b")) { swapped = true; await swapAForLinkTo(target, outside); }
      return await realRename(from, to);
    });

    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target }).catch(() => undefined);

    expect(swapped).toBe(true);
    expect(await snapshotOf(outside)).toEqual({ x: "outside x\n" });
  });
});

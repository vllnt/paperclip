import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
} = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: Buffer.from('{"token":"remote"}\n').toString("base64"),
    stderr: "",
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string }) => undefined),
}));

vi.mock("./ssh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssh.js")>()),
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
}));

import { prepareRemoteManagedRuntime, sshRunDirectory } from "./remote-managed-runtime.js";
import { sshSyncBackDependencyExcludes } from "./ssh.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";
import { setExpensiveWorkspaceGitExecutor } from "./git-workspace-sync.js";

describe("remote managed runtime", () => {
  const cleanupDirs: string[] = [];

  it("stages all files over SSH without Git or cache exclusions and restores the same baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-plain-"));
    cleanupDirs.push(root);
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(root, "node_modules", "personal.bin"), Buffer.from([0, 255, 1]));
    const prepared = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "plain", adapterKey: "test", workspaceLocalDir: root,
      workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"],
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: root, remoteDir: prepared.workspaceRemoteDir, workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"],
    }));
    await prepared.restoreWorkspace();
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      restoreGitHistory: false, baselineSnapshot: expect.objectContaining({
        exclude: [".paperclip-runtime", "explicitly-excluded"],
        entries: expect.any(Map),
      }),
    }));
    const args = vi.mocked(restoreWorkspaceFromSshExecution).mock.calls[0] as unknown as [{ baselineSnapshot: { entries: Map<string, unknown> } }];
    expect(args[0].baselineSnapshot.entries.has("node_modules/personal.bin")).toBe(true);
  });

  it.each([
    { gitBacked: true, label: "Git-backed" },
    { gitBacked: false, label: "plain" },
  ])("keeps dependency and cache directories out of the $label SSH sync-back baseline", async ({ gitBacked }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-deps-"));
    cleanupDirs.push(root);
    const files = [
      "src/index.ts",
      "dist/index.js",
      "vendor/lib.go",
      "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js",
      "packages/app/node_modules/dep/index.js",
      ".pnpm-store/v10/index.json",
      ".next/cache/page.js",
      "packages/app/.turbo/cache.json",
      ".cache/tool.bin",
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), file);
    }
    if (gitBacked) await execFileAsync("git", ["init", "-q", root]);
    prepareWorkspaceForSshExecution.mockResolvedValueOnce({ gitBacked });

    const prepared = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "deps", adapterKey: "test", workspaceLocalDir: root,
    });
    await prepared.restoreWorkspace();

    const [{ baselineSnapshot }] = vi.mocked(restoreWorkspaceFromSshExecution).mock.calls[0] as unknown as [
      { baselineSnapshot: { exclude: string[]; entries: Map<string, unknown> } },
    ];
    // The SSH sync-back tar reuses `baselineSnapshot.exclude`, so these
    // patterns keep remote dependency trees off the host's disk.
    for (const name of ["node_modules", ".pnpm-store", ".next", ".turbo", ".cache"]) {
      expect(baselineSnapshot.exclude).toEqual(expect.arrayContaining([name, `${name}/*`, `*/${name}`, `*/${name}/*`]));
    }
    // Build output and vendored code may be tracked, so they still sync back.
    const baselineFiles = [...baselineSnapshot.entries.keys()].filter((entry) => files.includes(entry)).sort();
    expect(baselineFiles).toEqual(["dist/index.js", "src/index.ts", "vendor/lib.go"]);
  });

  it("keeps syncing a dependency name that the Git workspace tracks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tracked-deps-"));
    cleanupDirs.push(root);
    await execFileAsync("git", ["init", "-q", root]);
    await mkdir(path.join(root, "action", "node_modules", "dep"), { recursive: true });
    await mkdir(path.join(root, ".cache"), { recursive: true });
    await writeFile(path.join(root, "action", "node_modules", "dep", "index.js"), "committed");
    await writeFile(path.join(root, ".cache", "untracked.bin"), "regenerated");
    await execFileAsync("git", ["-C", root, "add", "action/node_modules/dep/index.js"]);
    prepareWorkspaceForSshExecution.mockResolvedValueOnce({ gitBacked: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "tracked-deps", adapterKey: "test", workspaceLocalDir: root,
    });
    await prepared.restoreWorkspace();

    const [{ baselineSnapshot }] = vi.mocked(restoreWorkspaceFromSshExecution).mock.calls[0] as unknown as [
      { baselineSnapshot: { exclude: string[]; entries: Map<string, unknown> } },
    ];
    expect(baselineSnapshot.exclude).toEqual([
      ".git", ".git/*", ".paperclip-runtime",
      ...sshSyncBackDependencyExcludes([".pnpm-store", ".next", ".turbo", ".cache"]),
    ]);
    expect(baselineSnapshot.entries.has("action/node_modules/dep/index.js")).toBe(true);
    expect(baselineSnapshot.entries.has(".cache/untracked.bin")).toBe(false);
  });


  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("restores runtime assets without restoring an in-place SSH workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-assets-only-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), '{"token":"host"}\n', "utf8");

    let restoredAuth = "";
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-in-place",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: homeDir,
          restore: async ({ assetDir, readFile }) => {
            restoredAuth = (await readFile(path.posix.join(assetDir, "auth.json"))).toString("utf8");
          },
        },
      ],
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: homeDir,
      remoteDir: "/app/.paperclip-runtime/codex/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "base64 < '/app/.paperclip-runtime/codex/home/auth.json'",
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
  });

  it("stages each additional project into its own isolated SSH dir, isolating one failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-additional-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const firstDir = path.join(rootDir, "referenced-first");
    const secondDir = path.join(rootDir, "referenced-second");
    const brokenDir = path.join(rootDir, "referenced-broken");
    await mkdir(workspaceDir, { recursive: true });

    // The transfer rejects only for the broken project's directory.
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string }) => {
      if (input.localDir === brokenDir) throw new Error("ssh transfer failed");
      return undefined;
    });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-additional",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: firstDir, projectId: "first", ignoreResolution: { kind: "other" } },
        { localPath: brokenDir, projectId: "broken", ignoreResolution: { kind: "other" } },
        { localPath: secondDir, projectId: "second", ignoreResolution: { kind: "other" } },
      ],
    });

    // Each healthy project staged into its OWN isolated dir under the runtime
    // root; the broken one is skipped, not fatal.
    expect(Object.keys(prepared.additionalSourceDirs).sort()).toEqual(["first", "second"]);
    expect(prepared.additionalSourceDirs.first).toBe("/app/.paperclip-runtime/codex/project-first");
    expect(prepared.additionalSourceDirs.second).toBe("/app/.paperclip-runtime/codex/project-second");
    expect(prepared.additionalSourceDirs.broken).toBeUndefined();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: firstDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-first",
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: secondDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-second",
    }));
  });

  it("skips an additional project whose localPath is not absolute", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-relative-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-relative",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: "relative/referenced", projectId: "relative", ignoreResolution: { kind: "other" } },
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
      ],
    });

    // The relative-path project never reaches the transfer and is skipped; the
    // absolute-path project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({
      localDir: "relative/referenced",
    }));
  });

  it("passes a project's resolved Git-ignored paths to the SSH exclude list, escaped", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-ignore-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const projectDir = path.join(rootDir, "referenced-project");
    await mkdir(workspaceDir, { recursive: true });

    await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-ignore",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        {
          localPath: projectDir,
          projectId: "proj",
          ignoreResolution: { kind: "git", ignoredPaths: ["secret.env", "build", "weird[1].txt"] },
        },
      ],
    });

    const call = syncDirectoryToSsh.mock.calls.find((entry) => entry[0].localDir === projectDir);
    expect(call).toBeDefined();
    const exclude = (call![0] as { exclude?: string[] }).exclude ?? [];
    // The resolved ignored paths ride the exclude list, glob-escaped, on top of
    // the fixed heavy-directory excludes the SSH lane already applies.
    expect(exclude).toContain("secret.env");
    expect(exclude).toContain("build");
    expect(exclude).toContain("weird\\[1].txt");
    expect(exclude).toContain("node_modules");
  });

  it("skips a project whose ignore resolution failed without ever calling syncDirectoryToSsh for it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-failed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
        { localPath: failedDir, projectId: "failed", ignoreResolution: { kind: "failed", reason: "git status timed out" } },
      ],
    });

    // Fail closed: the failed project never reaches the transfer at all — no
    // bytes are sent for it — while the healthy project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({ localDir: failedDir }));
  });

  it("never leaks a raw absolute path into the remote per-project staging warning", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-redact-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });

    // A raw toplevel string that makes `failedDir` a non-descendant, carrying
    // a sensitive absolute path — exactly the shape a caught Git diagnostic
    // could embed. `resolveReferencedSourceIgnore` is the single choke point
    // that must reduce it to the fixed category before anything downstream
    // (here, the remote lane's warning) ever sees it.
    const sensitivePath = "/srv/alice/project";
    let ignoreResolution;
    try {
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.toplevel") {
          return { stdout: `${sensitivePath}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      ignoreResolution = await resolveReferencedSourceIgnore(failedDir);
    } finally {
      setExpensiveWorkspaceGitExecutor(null);
    }
    expect(ignoreResolution.kind).toBe("failed");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await prepareRemoteManagedRuntime({
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "KNOWN HOSTS",
          strictHostKeyChecking: true,
        },
        runId: "run-redact",
        adapterKey: "codex",
        workspaceLocalDir: workspaceDir,
        workspaceRemoteDir: "/app",
        syncWorkspace: false,
        additionalSources: [{ localPath: failedDir, projectId: "failed", ignoreResolution }],
      });

      const warnedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warnedText).toContain("failed");
      expect(warnedText).not.toContain(sensitivePath);
      expect(warnedText).not.toContain(failedDir);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The SSH run directory reaper claims `runs/<runId>` by looking only at the
  // leases of that run. That is sound only while a directory belongs to exactly
  // one run id. These tests pin the half of that which lives here: the path is
  // a pure function of (root, run id), and distinct ids never share one.
  describe("run directory ownership", () => {
    const UUID_A = "11111111-1111-4111-8111-111111111111";
    const UUID_B = "22222222-2222-4222-8222-222222222222";

    it("puts a run directly under runs/ and names it by the run id alone", () => {
      expect(sshRunDirectory("/srv/work", UUID_A)).toBe(`/srv/work/.paperclip-runtime/runs/${UUID_A}`);
      expect(path.posix.basename(sshRunDirectory("/srv/work", UUID_A))).toBe(UUID_A);
      expect(path.posix.dirname(sshRunDirectory("/srv/work", UUID_A))).toBe("/srv/work/.paperclip-runtime/runs");
    });

    it("gives two run ids two directories, and one run id on two roots two directories", () => {
      expect(sshRunDirectory("/srv/work", UUID_A)).not.toBe(sshRunDirectory("/srv/work", UUID_B));
      expect(sshRunDirectory("/srv/work", UUID_A)).not.toBe(sshRunDirectory("/srv/other", UUID_A));
    });

    it.each(["", ".", "..", "a/b", "a/../b", "../x", "/abs", "a\0b", "trailing/"])(
      "refuses the run id %j, which could alias another run's directory",
      (runId) => {
        expect(() => sshRunDirectory("/srv/work", runId)).toThrow(/one plain path segment/);
      },
    );

    it("accepts any other id as one segment, such as the non-UUID ids the login flows use", () => {
      expect(sshRunDirectory("/srv/work", "claude-login-3f2a")).toBe("/srv/work/.paperclip-runtime/runs/claude-login-3f2a");
      expect(sshRunDirectory("/srv/work", "run deps")).toBe("/srv/work/.paperclip-runtime/runs/run deps");
      expect(path.posix.dirname(sshRunDirectory("/srv/work", ".hidden"))).toBe("/srv/work/.paperclip-runtime/runs");
    });

    it("prepares each run in the directory of its own run id and in no other", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-own-dir-"));
      cleanupDirs.push(root);
      const spec = { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/srv/work", remoteCwd: "/srv/work",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true };

      const first = await prepareRemoteManagedRuntime({ spec, runId: UUID_A, adapterKey: "test", workspaceLocalDir: root });
      const second = await prepareRemoteManagedRuntime({ spec, runId: UUID_B, adapterKey: "test", workspaceLocalDir: root });

      expect(first.workspaceRemoteDir).toBe(`${sshRunDirectory("/srv/work", UUID_A)}/workspace`);
      expect(second.workspaceRemoteDir).toBe(`${sshRunDirectory("/srv/work", UUID_B)}/workspace`);
      expect(first.workspaceRemoteDir).not.toBe(second.workspaceRemoteDir);
    });

    it("keeps a caller's own base directory out of the root's runs/ directory", async () => {
      // The agent-file and checkpoint flows pass their own base. Their run
      // directory is nested under it, so it can never be `<root>/.paperclip-runtime/runs/<id>`.
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-own-base-"));
      cleanupDirs.push(root);
      const base = `/srv/work/.paperclip-runtime/agent-files/agent-1/${UUID_A}`;
      const prepared = await prepareRemoteManagedRuntime({
        spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/srv/work", remoteCwd: "/srv/work",
          privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
        runId: UUID_A, adapterKey: "test", workspaceLocalDir: root, workspaceRemoteDir: base,
      });
      expect(prepared.workspaceRemoteDir).toBe(`${base}/.paperclip-runtime/runs/${UUID_A}/workspace`);
      expect(prepared.workspaceRemoteDir.startsWith(`${sshRunDirectory("/srv/work", UUID_A)}/`)).toBe(false);
    });
  });
});

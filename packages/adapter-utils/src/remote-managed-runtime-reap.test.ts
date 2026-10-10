import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { reapSshRunDirectory, sshPreservedBundlePath, sshRunDirectory } from "./remote-managed-runtime.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", root]);
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

// The reap script, run on this host instead of over SSH.
const spec = {
  host: "worker.invalid", port: 22, username: "paperclip", remoteWorkspacePath: "/unused",
  privateKey: null, knownHosts: null, strictHostKeyChecking: false,
};
const runLocally = async (script: string) => ({ stdout: spawnSync("sh", ["-c", script], { encoding: "utf8" }).stdout });

// A finished run the way a worker leaves it, without the restored marker: a
// git repository in runs/<id>/workspace with one commit.
async function finishedRun(options: { git?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-reap-"));
  roots.push(root);
  const runId = randomUUID();
  const runDir = sshRunDirectory(root, runId);
  const workspace = path.join(runDir, "workspace");
  await mkdir(workspace, { recursive: true });
  if (options.git !== false) {
    await git(workspace, ["init", "-q", "-b", "main"]);
    await git(workspace, ["config", "user.name", "Paperclip Test"]);
    await git(workspace, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(workspace, "tracked.txt"), "base\n");
    await git(workspace, ["add", "tracked.txt"]);
    await git(workspace, ["commit", "-q", "-m", "base"]);
  } else {
    await writeFile(path.join(workspace, "work.txt"), "only copy\n");
  }
  const reap = (extra: { removeNotGitBacked?: boolean; maxBundleKb?: number } = {}) => reapSshRunDirectory({
    spec, remoteRoot: root, runId, removeNotGitBacked: extra.removeNotGitBacked,
    testHooks: { runScript: runLocally, maxBundleKb: extra.maxBundleKb },
  });
  return { root, runId, runDir, workspace, reap };
}

// An extra worktree that an agent added inside the run directory, with a
// changed tracked file and an untracked file.
async function dirtyExtraWorktree(run: { runDir: string; workspace: string }) {
  const tree = path.join(run.runDir, "wt-agent");
  await git(run.workspace, ["worktree", "add", "-q", "-b", "agent/scratch", tree]);
  await writeFile(path.join(tree, "tracked.txt"), "changed, never committed\n");
  await writeFile(path.join(tree, "notes.txt"), "untracked, never committed\n");
  return tree;
}

describe("reapSshRunDirectory and extra worktrees", () => {
  it("saves a dirty extra worktree into the bundle, then removes the run directory", async () => {
    const run = await finishedRun();
    await dirtyExtraWorktree(run);
    // A clone that has the run's start commit, to read the bundle back.
    const clone = path.join(run.root, "host-clone");
    await git(run.root, ["clone", "-q", run.workspace, clone]);

    const result = await run.reap();

    const ref = `refs/paperclip/preserved/${run.runId}/worktree-dirty-0`;
    expect(result).toMatchObject({ outcome: "removed" });
    expect(result.outcome === "removed" && result.preserved).toContain(ref);
    expect(existsSync(run.runDir)).toBe(false);
    const bundle = sshPreservedBundlePath(run.root, run.runId);
    await git(clone, ["fetch", "-q", bundle, `${ref}:refs/saved`]);
    expect(await git(clone, ["show", "refs/saved:tracked.txt"])).toBe("changed, never committed");
    expect(await git(clone, ["show", "refs/saved:notes.txt"])).toBe("untracked, never committed");
  });

  it("keeps the run directory when the saved state is over the bundle cap", async () => {
    const run = await finishedRun();
    const tree = await dirtyExtraWorktree(run);

    await expect(run.reap({ maxBundleKb: 0 })).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });

    expect(await readFile(path.join(tree, "notes.txt"), "utf8")).toBe("untracked, never committed\n");
  });

  it("saves an extra worktree that has no commit yet", async () => {
    const run = await finishedRun();
    const clone = path.join(run.root, "host-clone");
    await git(run.root, ["clone", "-q", run.workspace, clone]);
    const tree = path.join(run.runDir, "wt-orphan");
    await git(run.workspace, ["worktree", "add", "-q", "--orphan", "-b", "agent/orphan", tree]);
    await writeFile(path.join(tree, "first.txt"), "first file\n");

    const result = await run.reap();

    const ref = `refs/paperclip/preserved/${run.runId}/worktree-dirty-0`;
    expect(result.outcome === "removed" && result.preserved).toContain(ref);
    await git(clone, ["fetch", "-q", sshPreservedBundlePath(run.root, run.runId), `${ref}:refs/saved`]);
    expect(await git(clone, ["show", "refs/saved:first.txt"])).toBe("first file");
  });

  it("keeps the run directory when the temporary index cannot be written, also as root", async () => {
    const run = await finishedRun();
    await dirtyExtraWorktree(run);
    await mkdir(path.join(run.runDir, ".paperclip-reap-index-0", "sub"), { recursive: true });

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });

    expect(existsSync(path.join(run.runDir, "wt-agent", "notes.txt"))).toBe(true);
  });

  it("keeps the run directory when git status fails in an extra worktree", async () => {
    const run = await finishedRun();
    const tree = await dirtyExtraWorktree(run);
    const gitdir = (await readFile(path.join(tree, ".git"), "utf8")).replace(/^gitdir: /, "").trim();
    await writeFile(path.join(gitdir, "index"), "not an index\n");

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });

    expect(existsSync(path.join(tree, "notes.txt"))).toBe(true);
  });

  it("never writes into another repository that a worktree entry points at", async () => {
    const run = await finishedRun();
    const tree = path.join(run.runDir, "wt-agent");
    await git(run.workspace, ["worktree", "add", "-q", "-b", "agent/scratch", tree]);
    // Inside the run directory, so only the common-directory check stops it.
    const foreign = path.join(run.runDir, "foreign");
    await mkdir(foreign);
    await git(foreign, ["init", "-q", "-b", "main"]);
    await git(foreign, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "foreign"]);
    await writeFile(path.join(foreign, "new.txt"), "not ours\n");
    // The agent re-points the worktree entry at the other repository, with no HEAD commit.
    const admin = path.join(run.workspace, ".git", "worktrees", "wt-agent");
    await writeFile(path.join(admin, "gitdir"), `${path.join(foreign, ".git")}\n`);
    await writeFile(path.join(admin, "HEAD"), "ref: refs/heads/nonexistent\n");
    const objectsBefore = await git(foreign, ["count-objects"]);

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });

    expect(await git(foreign, ["count-objects"])).toBe(objectsBefore);
  });

  // Root reads the file anyway.
  it.skipIf(process.getuid?.() === 0)("keeps the run directory when the extra worktree cannot be saved", async () => {
    const run = await finishedRun();
    const tree = await dirtyExtraWorktree(run);
    await chmod(path.join(tree, "notes.txt"), 0o000);

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "preserve_failed" });

    expect(existsSync(path.join(tree, "tracked.txt"))).toBe(true);
  });
});

// An agent can add a worktree beside the run directory instead of inside it.
// Deleting the run directory would leave that folder without its repository.
describe("reapSshRunDirectory and a worktree outside the run directory", () => {
  async function outsideWorktree(run: { root: string; workspace: string }) {
    const tree = path.join(run.root, ".paperclip-runtime", "wt-agent");
    await git(run.workspace, ["worktree", "add", "-q", "-b", "agent/outside", tree]);
    return tree;
  }

  it("keeps the run directory and names the worktree", async () => {
    const run = await finishedRun();
    const tree = await outsideWorktree(run);

    const result = await run.reap();

    expect(result).toMatchObject({ outcome: "kept", reason: "external_worktree", externalWorktree: await realpath(tree) });
    expect(existsSync(path.join(run.workspace, ".git"))).toBe(true);
  });

  it("keeps it also when the run's work was restored", async () => {
    const run = await finishedRun();
    await outsideWorktree(run);
    await writeFile(path.join(run.runDir, ".paperclip-restored"), "");

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "external_worktree" });
  });

  it.each([
    ["a sibling whose name starts with the run directory's", (run: { runDir: string }) => `${run.runDir}-sibling`],
    ["a folder whose name has a backslash", (run: { root: string }) => path.join(run.root, "wt\\c")],
  ])("keeps it for %s", async (_label, where) => {
    const run = await finishedRun();
    const tree = where(run as { root: string; runDir: string });
    await git(run.workspace, ["worktree", "add", "-q", "-b", "agent/edge", tree]);

    await expect(run.reap()).resolves.toMatchObject({
      outcome: "kept", reason: "external_worktree", externalWorktree: await realpath(tree),
    });
  });

  it("keeps it when git records the worktree with a relative path", async () => {
    const run = await finishedRun();
    const tree = path.join(run.root, ".paperclip-runtime", "wt-relative");
    // Git 2.48 and later write a relative gitdir with this setting; older git ignores it.
    await git(run.workspace, ["-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "-b", "agent/relative", tree]);

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "external_worktree" });
  });

  it("removes the run directory once the outside worktree is gone", async () => {
    const run = await finishedRun();
    const tree = await outsideWorktree(run);
    await rm(tree, { recursive: true, force: true });

    await expect(run.reap()).resolves.toMatchObject({ outcome: "removed" });

    expect(existsSync(run.runDir)).toBe(false);
  });
});

describe("reapSshRunDirectory and a run that is not a git repository", () => {
  it("keeps it by default", async () => {
    const run = await finishedRun({ git: false });

    await expect(run.reap()).resolves.toMatchObject({ outcome: "kept", reason: "not_git_backed" });

    expect(await readFile(path.join(run.workspace, "work.txt"), "utf8")).toBe("only copy\n");
  });

  it("removes it once its keep window is over", async () => {
    const run = await finishedRun({ git: false });

    await expect(run.reap({ removeNotGitBacked: true })).resolves.toMatchObject({ outcome: "removed", preserved: [] });

    expect(existsSync(run.runDir)).toBe(false);
  });

  it("keeps a run directory with a repository below it, even after its keep window", async () => {
    const run = await finishedRun({ git: false });
    const nested = path.join(run.workspace, "nested");
    await mkdir(nested);
    await git(nested, ["init", "-q", "-b", "main"]);
    await git(nested, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "only here"]);

    await expect(run.reap({ removeNotGitBacked: true })).resolves.toMatchObject({ outcome: "kept", reason: "not_git_backed" });

    expect(existsSync(path.join(nested, ".git"))).toBe(true);
  });

  it("keeps a run directory whose workspace is a link, even after its keep window", async () => {
    const run = await finishedRun();
    const real = path.join(run.runDir, "real-workspace");
    await rename(run.workspace, real);
    await symlink(real, run.workspace);

    await expect(run.reap({ removeNotGitBacked: true })).resolves.toMatchObject({ outcome: "kept", reason: "not_git_backed" });

    expect(existsSync(path.join(real, ".git"))).toBe(true);
  });

  it("still saves a git repository's state when told it may remove unsaved content", async () => {
    const run = await finishedRun();
    await writeFile(path.join(run.workspace, "uncommitted.txt"), "work\n");

    const result = await run.reap({ removeNotGitBacked: true });

    expect(result.outcome === "removed" && result.preserved).toContain(`refs/paperclip/preserved/${run.runId}/worktree`);
  });
});

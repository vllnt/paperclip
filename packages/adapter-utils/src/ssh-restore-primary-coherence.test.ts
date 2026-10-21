import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import type { SshRemoteExecutionSpec } from "./ssh.js";

// A run ends by merging its SSH copy back into the primary checkout. These tests
// run the real seed and restore code (`prepareRemoteManagedRuntime`, then
// `restoreWorkspace`) on throwaway Git repositories. The only fake is an `ssh`
// shim that runs the "remote" command on this machine. After the restore, HEAD,
// the index and the working tree of the primary must agree, and nothing that
// landed on the primary during the run may be reverted or deleted.

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;
const cleanupDirs: string[] = [];

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Paperclip Test",
  GIT_AUTHOR_EMAIL: "test@paperclip.dev",
  GIT_COMMITTER_NAME: "Paperclip Test",
  GIT_COMMITTER_EMAIL: "test@paperclip.dev",
};

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.SHIM_POST_MATCH;
  delete process.env.SHIM_POST_HOOK;
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function put(dir: string, relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
  await writeFile(path.join(dir, relative), text);
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
  return await git(dir, "rev-parse", "HEAD");
}

/** Runs the "remote" command on this machine. After the first command that
 * contains SHIM_POST_MATCH, it also runs SHIM_POST_HOOK, once. */
async function installSshShim(root: string): Promise<void> {
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'for last; do :; done',
    'sh -c "$last"',
    "rc=$?",
    'if [ -n "${SHIM_POST_MATCH:-}" ] && [ -n "${SHIM_POST_HOOK:-}" ] && [ ! -e "${SHIM_POST_HOOK}.done" ]; then',
    '  case "$last" in *"$SHIM_POST_MATCH"*) touch "${SHIM_POST_HOOK}.done"; sh "$SHIM_POST_HOOK" >&2 ;; esac',
    "fi",
    "exit $rc",
    "",
  ].join("\n");
  await writeFile(path.join(binDir, "ssh"), script, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

interface Fixture {
  host: string;
  remote: string;
  spec: SshRemoteExecutionSpec;
  oldHead: string;
}

/** A primary checkout at one commit, and an empty directory that stands in for the worker. */
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-coherence-"));
  cleanupDirs.push(root);
  const host = path.join(root, "host");
  const remote = path.join(root, "remote");
  await mkdir(host, { recursive: true });
  await mkdir(remote, { recursive: true });
  await git(host, "init", "-q", "-b", "main");
  await put(host, "README.md", "readme\n");
  await put(host, "data/instr.md", "instructions v-old\n");
  await put(host, "data/other.md", "other v-old\n");
  const oldHead = await commitAll(host, "origin/main era");
  await installSshShim(root);
  return {
    host,
    remote,
    oldHead,
    spec: {
      host: "shim",
      port: 22,
      username: "paperclip",
      remoteWorkspacePath: remote,
      remoteCwd: remote,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
    },
  };
}

function prepare(fixture: Fixture, runId: string) {
  return prepareRemoteManagedRuntime({
    spec: fixture.spec,
    runId,
    adapterKey: "test",
    workspaceLocalDir: fixture.host,
  });
}

interface Coherence {
  /** Files of the HEAD tree that are missing or differ in the working tree. */
  driftedFromHead: string[];
  /** `git diff --cached`: what a plain `git commit` would commit. */
  stagedAgainstHead: string;
  status: string;
}

async function inspectPrimary(host: string): Promise<Coherence> {
  const tree = (await git(host, "ls-tree", "-r", "-z", "HEAD")).split("\0").filter(Boolean);
  const driftedFromHead: string[] = [];
  for (const entry of tree) {
    const [meta, relative] = entry.split("\t");
    const blob = meta!.split(" ")[2];
    if (!existsSync(path.join(host, relative!))) {
      driftedFromHead.push(`D ${relative}`);
    } else if ((await git(host, "hash-object", "--", relative!)) !== blob) {
      driftedFromHead.push(`M ${relative}`);
    }
  }
  return {
    driftedFromHead,
    stagedAgainstHead: await git(host, "diff", "--cached", "--name-status"),
    status: await git(host, "status", "--porcelain"),
  };
}

async function expectCoherent(host: string): Promise<void> {
  const state = await inspectPrimary(host);
  expect(state.driftedFromHead).toEqual([]);
  expect(state.stagedAgainstHead).toBe("");
}

async function headFile(host: string, relative: string): Promise<string> {
  return await git(host, "show", `HEAD:${relative}`);
}

async function workingFile(host: string, relative: string): Promise<string> {
  return (await readFile(path.join(host, relative), "utf8")).trim();
}

describe("SSH restore keeps the primary checkout coherent", () => {
  it("both-ok: a run that edits only its own file leaves HEAD, index and files in step", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture, "run-1");
    await put(prepared.workspaceRemoteDir, "data/own.md", "edited in the run\n");
    await commitAll(prepared.workspaceRemoteDir, "run commit");

    await prepared.restoreWorkspace();

    await expectCoherent(fixture.host);
    expect(await headFile(fixture.host, "data/own.md")).toBe("edited in the run");
    expect(await workingFile(fixture.host, "data/own.md")).toBe("edited in the run");
    expect((await inspectPrimary(fixture.host)).status).toBe("");
  }, 90_000);

  it("commit-after-seed: a commit that lands on the primary after seeding is kept, and the index follows HEAD", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture, "run-1");
    await put(fixture.host, "data/instr.md", "instructions v-new\n");
    await commitAll(fixture.host, "reconcile landed after the copy was seeded");
    await put(prepared.workspaceRemoteDir, "data/own.md", "edited in the run\n");
    await commitAll(prepared.workspaceRemoteDir, "run commit");

    await prepared.restoreWorkspace();

    await expectCoherent(fixture.host);
    expect(await headFile(fixture.host, "data/instr.md")).toBe("instructions v-new");
    expect(await workingFile(fixture.host, "data/instr.md")).toBe("instructions v-new");
    expect(await workingFile(fixture.host, "data/own.md")).toBe("edited in the run");
    expect(await headFile(fixture.host, "data/own.md")).toBe("edited in the run");
  }, 90_000);

  it("two-runs: two runs restored together both land, and a plain commit would not delete either", async () => {
    const fixture = await createFixture();
    const first = await prepare(fixture, "run-1");
    const second = await prepare(fixture, "run-2");
    await put(first.workspaceRemoteDir, "data/run-a.md", "run a\n");
    await commitAll(first.workspaceRemoteDir, "run a");
    await put(second.workspaceRemoteDir, "data/run-b.md", "run b\n");
    await commitAll(second.workspaceRemoteDir, "run b");

    await Promise.all([first.restoreWorkspace(), second.restoreWorkspace()]);

    await expectCoherent(fixture.host);
    for (const [file, text] of [["data/run-a.md", "run a"], ["data/run-b.md", "run b"]] as const) {
      expect(await headFile(fixture.host, file)).toBe(text);
      expect(await workingFile(fixture.host, file)).toBe(text);
    }
  }, 150_000);

  it("branch-switch: a run that commits on another history does not revert the primary's newer file", async () => {
    const fixture = await createFixture();
    await put(fixture.host, "data/instr.md", "instructions v-new\n");
    await commitAll(fixture.host, "reconcile (primary HEAD)");
    const prepared = await prepare(fixture, "run-1");
    // The run starts from the old history like an engineer does, and commits there.
    await git(prepared.workspaceRemoteDir, "reset", "-q", "--hard", fixture.oldHead);
    await put(prepared.workspaceRemoteDir, "ci/risk-tiers.yml", "tiers\n");
    await commitAll(prepared.workspaceRemoteDir, "run commit on the old history");

    await prepared.restoreWorkspace();

    await expectCoherent(fixture.host);
    expect(await headFile(fixture.host, "data/instr.md")).toBe("instructions v-new");
    expect(await workingFile(fixture.host, "data/instr.md")).toBe("instructions v-new");
    expect(await headFile(fixture.host, "ci/risk-tiers.yml")).toBe("tiers");
    expect(await workingFile(fixture.host, "ci/risk-tiers.yml")).toBe("tiers");
  }, 90_000);

  it("seed-race: a commit that lands while the copy is being seeded is not written back as a run edit", async () => {
    const fixture = await createFixture();
    // The change lands after the working tree reached the copy. The copy keeps the old file.
    const hook = path.join(path.dirname(fixture.host), "hook.sh");
    await writeFile(hook, [
      `cd '${fixture.host}'`,
      "printf 'instructions v-new\\n' > data/instr.md",
      "git add -A",
      "git -c commit.gpgsign=false commit -q -m reconcile",
      "",
    ].join("\n"));
    process.env.SHIM_POST_HOOK = hook;
    process.env.SHIM_POST_MATCH = "tar -xf - -C";
    const prepared = await prepare(fixture, "run-1");

    await prepared.restoreWorkspace();

    await expectCoherent(fixture.host);
    expect(await headFile(fixture.host, "data/instr.md")).toBe("instructions v-new");
    expect(await workingFile(fixture.host, "data/instr.md")).toBe("instructions v-new");
  }, 90_000);

  it("seed-race-untracked: a file that appears on the primary while the copy is being seeded is not deleted", async () => {
    const fixture = await createFixture();
    const hook = path.join(path.dirname(fixture.host), "hook.sh");
    await writeFile(hook, `cd '${fixture.host}' && printf 'scratch from a concurrent run\\n' > stray.txt\n`);
    process.env.SHIM_POST_HOOK = hook;
    process.env.SHIM_POST_MATCH = "tar -xf - -C";
    const prepared = await prepare(fixture, "run-1");

    await prepared.restoreWorkspace();

    await expectCoherent(fixture.host);
    expect(existsSync(path.join(fixture.host, "stray.txt"))).toBe(true);
    expect((await inspectPrimary(fixture.host)).status).toBe("?? stray.txt");
  }, 90_000);
});

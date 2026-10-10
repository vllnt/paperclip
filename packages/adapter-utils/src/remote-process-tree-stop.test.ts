import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash as sha256Hash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, chown, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_RUN_MARKER_ENV,
  buildRemoteProcessTreeStopLines,
  buildRemoteRunRecordLines,
  createRemoteRunMarker,
  parseRemoteProcessTreeStopSummary,
} from "./remote-process-identity.js";
import { buildSshSpawnTarget, sshRunProcessRecordDir } from "./ssh.js";

const execFileAsync = promisify(execFile);
const isLinux = process.platform === "linux";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }
});

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\S+ \(.*\) [ZXx] /.test(stat);
  } catch {
    return false;
  }
}

async function startTime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]!;
}

/** Starts `script` in its own session and returns the pids it prints, one `name=pid` per line. */
async function startSession(script: string, env: Record<string, string> = {}, command: string[] = []) {
  const child = spawn(command[0] ?? "sh", command.length > 0 ? command.slice(1) : ["-c", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  started.push(child);
  const pids: Record<string, number> = { leader: child.pid! };
  if (command.length > 0) return pids;
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line from: ${script}`)), 10_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes("ready\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  for (const line of buffer.split("\n")) {
    const match = /^([a-z]+)=(\d+)$/.exec(line);
    if (match) pids[match[1]!] = Number(match[2]);
  }
  return pids;
}

interface Run {
  root: string;
  runId: string;
  /** `<root>/.paperclip-runtime/processes/<runId>` */
  dir: string;
}

async function newRun(): Promise<Run> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-tree-stop-"));
  return runOf(root, randomUUID());
}

function runOf(root: string, runId: string): Run {
  return { root, runId, dir: sshRunProcessRecordDir(root, runId) };
}

const quote = (value: string) => `'${value}'`;

async function writeRecord(run: Run, input: { pid: number | string; group: boolean; markerSha256: string; uid?: string }) {
  await mkdir(run.dir, { recursive: true });
  const launchId = randomBytes(8).toString("hex");
  const file = path.join(run.dir, `${launchId}.json`);
  const lines = buildRemoteRunRecordLines({
    remoteRoot: quote(run.root),
    runId: run.runId,
    launchId,
    markerSha256: input.markerSha256,
    group: input.group,
    pidExpression: String(input.pid),
  });
  const script = input.uid === undefined ? lines.join("\n") : lines.join("\n").replace("$(id -u)", input.uid);
  // A deliberately bad record is still written; only the launch gate after it exits 125.
  await execFileAsync("sh", ["-c", script]).catch(() => undefined);
  return file;
}

/** Runs a launch's record lines for `pid`, as the leader does, and returns how they ended. */
async function publish(run: Run, input: { pid: number; testOnlyToolDirs?: string[] }) {
  const lines = buildRemoteRunRecordLines({
    remoteRoot: quote(run.root),
    runId: run.runId,
    launchId: randomBytes(8).toString("hex"),
    markerSha256: "0".repeat(64),
    group: true,
    pidExpression: String(input.pid),
    ...(input.testOnlyToolDirs ? { testOnlyToolDirs: input.testOnlyToolDirs } : {}),
  });
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile("sh", ["-c", lines.join("\n")], (error, _stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stderr });
    });
  });
}

async function recordNames(run: Run): Promise<string[]> {
  return (await readdir(run.dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
}

/** Writes a record file directly, as a worker could, bypassing the launch's own checks. */
async function writeRawRecord(run: Run, input: { pid: string; markerSha256: string }) {
  await mkdir(run.dir, { recursive: true });
  const uid = process.getuid!();
  const body = `{"pid":${input.pid},"start":"1","group":1}\n{"uid":${uid},"marker":"${input.markerSha256}"}\n`;
  await writeFile(path.join(run.dir, `${randomBytes(8).toString("hex")}.json`), body);
}

async function stop(run: Run, extra: Partial<Parameters<typeof buildRemoteProcessTreeStopLines>[0]> = {}) {
  const lines = buildRemoteProcessTreeStopLines({ remoteRoot: quote(run.root), runId: run.runId, termWaitSeconds: 1, ...extra });
  const { stdout } = await execFileAsync("sh", ["-c", lines.join("\n")], { timeout: 30_000 });
  return parseRemoteProcessTreeStopSummary(stdout);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe.skipIf(!isLinux)("remote process tree stop", () => {
  it("stops the verified group and every process carrying the exact marker, and nothing else", async () => {
    const marker = createRemoteRunMarker();
    const markerEnv = { [REMOTE_RUN_MARKER_ENV]: marker.value };
    const run = await newRun();
    const dir = run.dir;
    const group = await startSession(
      "sleep 600 & echo member=$!; env -i /bin/sh -c 'exec sleep 600' & echo envless=$!; echo ready; wait",
      markerEnv,
    );
    const otherSession = await startSession("", markerEnv, ["sleep", "600"]);
    const bystanders = await Promise.all([
      startSession("", {}, ["sleep", "600"]),
      startSession("", { [REMOTE_RUN_MARKER_ENV]: randomBytes(16).toString("hex") }, ["sleep", "600"]),
      startSession("", { OTHER: `x\n${REMOTE_RUN_MARKER_ENV}=${marker.value}` }, ["sleep", "600"]),
      startSession("", { [REMOTE_RUN_MARKER_ENV]: `${marker.value}0` }, ["sleep", "600"]),
    ]);
    await writeRecord(run, { pid: group.leader, group: true, markerSha256: marker.entrySha256 });

    const summary = await stop(run);
    await settle();

    expect(summary).toMatchObject({ records: 1, matched: 4, matchedByMarker: 3, matchedByGroup: 1, survived: 0, partial: null });
    for (const pid of [group.leader!, group.member!, group.envless!, otherSession.leader!]) expect(alive(pid)).toBe(false);
    for (const bystander of bystanders) expect(alive(bystander.leader!)).toBe(true);
    expect(await readdir(dir)).toEqual(["stopped"]);
  }, 30_000);

  it("signals no process of another user, even one carrying the same marker", async () => {
    const marker = createRemoteRunMarker();
    const markerEnv = { [REMOTE_RUN_MARKER_ENV]: marker.value };
    const run = await newRun();
    const dir = run.dir;
    const target = await startSession("", markerEnv, ["sleep", "600"]);
    const ownUid = String(process.getuid!());
    await writeRecord(run, { pid: target.leader!, group: true, markerSha256: marker.entrySha256, uid: String(Number(ownUid) + 1) });

    const summary = await stop(run);

    expect(summary).toMatchObject({ records: 1, matched: 0, partial: "uid_mismatch" });
    expect(alive(target.leader!)).toBe(true);
  }, 30_000);

  it.skipIf(!isRoot)("as root, leaves another user's process with the same marker running", async () => {
    const marker = createRemoteRunMarker();
    const markerEnv = { [REMOTE_RUN_MARKER_ENV]: marker.value };
    const run = await newRun();
    const dir = run.dir;
    const own = await startSession("", markerEnv, ["sleep", "600"]);
    const other = await startSession("", markerEnv, ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "sleep", "600"]);
    await writeRecord(run, { pid: own.leader!, group: true, markerSha256: marker.entrySha256 });

    const summary = await stop(run);
    await settle();

    expect(summary).toMatchObject({ records: 1, matched: 1, survived: 0, partial: null });
    expect(alive(own.leader!)).toBe(false);
    expect(alive(other.leader!)).toBe(true);
  }, 30_000);

  it("does not signal a pid whose start time no longer matches", async () => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const dir = run.dir;
    // The recorded leader exited and an unrelated process of the same user took
    // its id: its start time differs and it carries no marker.
    const reused = await startSession("sleep 600 & echo member=$!; echo ready; wait");
    await writeRecord(run, { pid: reused.leader!, group: true, markerSha256: marker.entrySha256 });
    const recorded = path.join(dir, (await readdir(dir))[0]!);
    const actual = await startTime(reused.leader!);
    await writeFile(recorded, (await readFile(recorded, "utf8")).replace(`"start":"${actual}"`, `"start":"${Number(actual) + 1}"`));

    const summary = await stop(run);

    expect(summary).toMatchObject({ records: 1, matched: 0, killed: 0 });
    expect(alive(reused.leader!)).toBe(true);
    expect(alive(reused.member!)).toBe(true);
  }, 30_000);

  it("skips SIGKILL when a target's start time changes after SIGTERM", async () => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const dir = run.dir;
    const stubborn = await startSession(
      "trap '' TERM; echo ready; while :; do sleep 1; done",
      { [REMOTE_RUN_MARKER_ENV]: marker.value },
    );
    await writeRecord(run, { pid: stubborn.leader!, group: true, markerSha256: marker.entrySha256 });

    // The seam runs between the scan and the SIGKILL recheck. It moves the
    // start time the scan read, as a pid reused in that window would.
    const summary = await stop(run, { testOnlyBeforeSignal: `[ "$1" = ${stubborn.leader} ] && [ "$2" = KILL ] && t_start=0` });

    expect(summary?.skipped).toBeGreaterThanOrEqual(1);
    expect(alive(stubborn.leader!)).toBe(true);
    expect((summary?.survived ?? 0)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("does not signal a target whose uid no longer matches right before the signal", async () => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const dir = run.dir;
    const target = await startSession("", { [REMOTE_RUN_MARKER_ENV]: marker.value }, ["sleep", "600"]);
    await writeRecord(run, { pid: target.leader!, group: true, markerSha256: marker.entrySha256 });

    // The seam runs right before each signal. Moving the expected uid there
    // is what a process that changed its real uid after the scan looks like.
    const summary = await stop(run, { testOnlyBeforeSignal: `[ "$1" = ${target.leader} ] && me=$((me + 1))` });

    expect(summary).toMatchObject({ matched: 1, killed: 0 });
    expect(summary?.skipped).toBeGreaterThanOrEqual(1);
    expect(alive(target.leader!)).toBe(true);
  }, 30_000);

  it("does not use a group whose leader can no longer be proven after the first scan", async () => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const dir = run.dir;
    const lateFile = path.join(run.root, "late.pid");
    // On SIGTERM the leader starts a new member of its group that carries no
    // marker, then exits: the group can no longer be proven by its leader.
    const leader = await startSession(
      `trap 'env -i /bin/sh -c "exec sleep 600" & echo $! > ${lateFile}; exit 0' TERM; echo ready; while :; do sleep 0.2; done`,
      { [REMOTE_RUN_MARKER_ENV]: marker.value },
    );
    await writeRecord(run, { pid: leader.leader!, group: true, markerSha256: marker.entrySha256 });

    await stop(run);
    const late = Number((await readFile(lateFile, "utf8")).trim());

    expect(alive(leader.leader!)).toBe(false);
    expect(late).toBeGreaterThan(1);
    expect(alive(late)).toBe(true);
  }, 30_000);

  it.each([["the run directory", (run: Run) => run.dir], [".paperclip-runtime", (run: Run) => path.join(run.root, ".paperclip-runtime")]])(
    "refuses a planted link at %s and changes nothing outside it",
    async (_level, linkPath) => {
      const run = await newRun();
      const victim = await mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
      await writeFile(path.join(victim, "other.json"), "{}\n");
      await mkdir(path.dirname(linkPath(run)), { recursive: true });
      await symlink(victim, linkPath(run));

      const summary = await stop(run);

      expect(await readdir(victim)).toEqual(["other.json"]);
      expect(summary).toMatchObject({ records: 0, matched: 0, killed: 0, partial: "unsafe_record_dir" });
    },
    30_000,
  );

  it("reports a stop whose mark cannot be written as not a success", async () => {
    const run = await newRun();
    // A directory where the mark belongs cannot be removed or replaced.
    await mkdir(path.join(run.dir, "stopped", "blocker"), { recursive: true });

    const summary = await stop(run);

    expect(summary?.partial).toBe("no_stop_mark");
  }, 30_000);

  it("signals and counts only what the first scan found, not a process started during the SIGTERM wait", async () => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const lateFile = path.join(run.root, "late.pid");
    // On SIGTERM the leader starts a child that inherits the marker, then exits.
    const leader = await startSession(
      `trap 'sleep 600 & echo $! > ${lateFile}; exit 0' TERM; echo ready; while :; do sleep 0.2; done`,
      { [REMOTE_RUN_MARKER_ENV]: marker.value },
    );
    await writeRecord(run, { pid: leader.leader!, group: true, markerSha256: marker.entrySha256 });

    const summary = await stop(run);
    const late = Number((await readFile(lateFile, "utf8")).trim());

    expect(alive(leader.leader!)).toBe(false);
    expect(late).toBeGreaterThan(1);
    expect(alive(late)).toBe(true);
    expect(summary).toMatchObject({ killed: 0, survived: 0 });
  }, 30_000);

  it("keeps signalling and counting a member that clears its marker during the SIGTERM wait", async () => {
    const marker = createRemoteRunMarker();
    const markerEnv = { [REMOTE_RUN_MARKER_ENV]: marker.value };
    const run = await newRun();
    const leader = await startSession("echo ready; while :; do sleep 0.2; done", markerEnv);
    // It joins by its marker. On SIGTERM it execs with an empty environment
    // and ignores SIGTERM: same pid, same start time, so the same process.
    const shedder = await startSession(
      `trap 'exec env -i /bin/sh -c "trap \\"\\" TERM; while :; do sleep 0.2; done"' TERM; echo ready; while :; do sleep 0.2; done`,
      markerEnv,
    );
    await writeRecord(run, { pid: leader.leader!, group: true, markerSha256: marker.entrySha256 });

    const summary = await stop(run);
    await settle();

    expect(alive(leader.leader!)).toBe(false);
    expect(alive(shedder.leader!)).toBe(false);
    expect(summary?.matchedByMarker).toBeGreaterThanOrEqual(2);
    expect(summary?.killed).toBeGreaterThanOrEqual(1);
    expect(summary?.survived).toBe(0);
  }, 30_000);

  it.each([["0"], ["1"], ["-1"], ["12x"], ["99999999999"]])("signals nothing for a record whose pid is %s", async (pid) => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const dir = run.dir;
    const bystander = await startSession("", { [REMOTE_RUN_MARKER_ENV]: marker.value }, ["sleep", "600"]);
    await writeRawRecord(run, { pid, markerSha256: marker.entrySha256 });

    const summary = await stop(run);

    expect(summary).toMatchObject({ records: 1, matched: 0, killed: 0 });
    expect(summary?.partial).toMatch(/^(bad_record|unverified_group)$/);
    expect(alive(bystander.leader!)).toBe(true);
  }, 30_000);

  it("reports a missing record and signals nothing", async () => {
    const marker = createRemoteRunMarker();
    const run = await newRun();
    const bystander = await startSession("", { [REMOTE_RUN_MARKER_ENV]: marker.value }, ["sleep", "600"]);

    const summary = await stop(run);

    expect(summary).toEqual({
      records: 0, matched: 0, matchedByMarker: 0, matchedByGroup: 0, killed: 0, skipped: 0, survived: 0, partial: "no_process_record",
    });
    expect(alive(bystander.leader!)).toBe(true);
  }, 30_000);
});

describe.skipIf(!isLinux)("SSH launch wrapper", () => {
  it("starts the command in its own session with the marker only in its environment, and records it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();
    await mkdir(path.join(root, "ws"), { recursive: true });
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: path.join(root, "ws"),
        remoteWorkspacePath: root,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "sh",
      args: ["-c", 'cat; echo pid=$$; ps_sid=$(cut -d" " -f6 /proc/$$/stat); echo sid=$ps_sid; exit 7'],
      env: { FOO: "bar" },
      processRecord: { runId },
    });
    expect(target.stdinPrefix).toMatch(/^[0-9a-f]{32}\n$/);
    const markerValue = target.stdinPrefix!.trim();
    for (const arg of target.args) expect(arg).not.toContain(markerValue);

    const child = spawn("sh", ["-c", target.args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"], cwd: root });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stdin.end(`${target.stdinPrefix}hello\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    await target.cleanup();

    expect(code).toBe(7);
    expect(stdout).toContain("hello\n");
    const pid = Number(/pid=(\d+)/.exec(stdout)?.[1]);
    expect(stdout).toContain(`sid=${pid}`);
    const recordDir = sshRunProcessRecordDir(root, runId);
    const files = await readdir(recordDir);
    expect(files).toHaveLength(1);
    const record = await readFile(path.join(recordDir, files[0]!), "utf8");
    expect(record).toContain(`"pid":${pid},`);
    expect(record).toContain(`"group":1`);
    expect(record).not.toContain(markerValue);
    const marker = createHash(`${REMOTE_RUN_MARKER_ENV}=${markerValue}`);
    expect(record).toContain(`"marker":"${marker}"`);
  }, 30_000);

  async function runLaunch(input: {
    env?: Record<string, string>;
    home?: string;
    command: string;
    root?: string;
    runId?: string;
    stdinPrefix?: string;
    beforeSpawn?: (remoteScript: string) => Promise<void>;
  }) {
    const root = input.root ?? (await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-")));
    await mkdir(path.join(root, "ws"), { recursive: true });
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: path.join(root, "ws"),
        remoteWorkspacePath: root,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "sh",
      args: ["-c", input.command],
      env: input.env ?? {},
      processRecord: { runId: input.runId ?? randomUUID() },
    });
    await input.beforeSpawn?.(target.args.at(-1)!);
    const child = spawn("sh", ["-c", target.args.at(-1)!], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: input.home ?? root },
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end(`${input.stdinPrefix ?? target.stdinPrefix}hello\n`);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    await target.cleanup();
    return { stdout, stderr, code, marker: target.stdinPrefix!.trim() };
  }

  it("does not start a launch whose run was already stopped, so a stop cannot miss a late record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();
    // The stop runs first, before the launch writes its record.
    const early = await stop(runOf(root, runId));
    expect(early).toMatchObject({ records: 0, partial: "no_process_record" });

    const late = await runLaunch({ root, runId, command: "echo started" });

    expect(late.stdout).not.toContain("started");
    expect(late.code).toBe(143);
  }, 30_000);

  it("does not start a launch whose record cannot be written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    await mkdir(path.join(root, ".paperclip-runtime"), { recursive: true });
    // A file where the record directory belongs makes every record write fail.
    await writeFile(path.join(root, ".paperclip-runtime", "processes"), "");

    const launch = await runLaunch({ root, command: "echo started" });

    expect(launch.stdout).not.toContain("started");
    expect(launch.code).toBe(125);
    expect(launch.stderr).toContain("not started");
  }, 30_000);

  it("never runs a tool that the run's login profile puts first on PATH", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-home-"));
    const victim = await mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    const bin = path.join(home, "bin");
    await mkdir(bin);
    // Each fake leaves a trace, the fake link also copies the record outside,
    // then each runs the real tool, so the launch would still look fine.
    for (const tool of ["link", "setsid", "id", "ls", "mkdir", "rm", "sed", "cut", "awk", "readlink"]) {
      await writeFile(
        path.join(bin, tool),
        `#!/bin/sh\n: > '${victim}/${tool}'\n${tool === "link" ? `cp "$1" '${victim}/stolen' 2>/dev/null\n` : ""}for d in /usr/bin /bin; do [ -x "$d/${tool}" ] && exec "$d/${tool}" "$@"; done\nexit 127\n`,
        { mode: 0o755 },
      );
    }
    await writeFile(path.join(home, ".profile"), `PATH=${bin}:$PATH; export PATH\n`);
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();

    const launch = await runLaunch({ root, runId, home, command: "echo started" });

    expect(await readdir(victim)).toEqual([]);
    expect(launch.stdout).toContain("started");
    expect(launch.code).toBe(0);
    expect(await recordNames(runOf(root, runId))).toHaveLength(1);
  }, 30_000);

  it("does not publish a record that cannot be read back as the stop reads it, and leaves none", async () => {
    const run = await newRun();
    // A process that is gone has no start time to record.
    const gone = spawn("true");
    await new Promise((resolve) => gone.on("close", resolve));

    const result = await publish(run, { pid: gone.pid! });

    expect(result.code).toBe(125);
    expect(result.stderr).toContain("not started");
    expect(await recordNames(run)).toEqual([]);
  }, 30_000);

  it("does not publish without a link utility that only root can change", async () => {
    // A directory under /tmp: owned by this user, or by root inside a directory every user can write.
    const tools = await mkdtemp(path.join(os.tmpdir(), "paperclip-tools-"));
    await symlink("/usr/bin/link", path.join(tools, "link"));
    const run = await newRun();

    const result = await publish(run, { pid: process.pid, testOnlyToolDirs: [tools] });

    expect(result.code).toBe(125);
    expect(result.stderr).toContain("link utility");
    expect(await recordNames(run)).toEqual([]);
    // The real system directories qualify.
    expect((await publish(run, { pid: process.pid })).code).toBe(0);
  }, 30_000);

  it.skipIf(!isRoot)("publishes only with a link that is a regular file owned by root and writable by root only", async () => {
    // Directories under / so that every directory above the tool is root's.
    const tools = path.join("/", `paperclip-tools-${randomUUID()}`);
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "paperclip-tools-"));
    const tool = path.join(tools, "link");
    const real = await realpath("/usr/bin/link");
    await mkdir(tools, { mode: 0o755 });
    try {
      const cases: Array<[string, () => Promise<void>, number]> = [
        ["a root-owned copy", async () => {}, 0],
        ["a group-writable copy", () => chmod(tool, 0o775), 125],
        ["a copy owned by another user", async () => {
          await chmod(tool, 0o755);
          await chown(tool, 65534, 65534);
        }, 125],
        ["a link to a copy in a directory every user can write", async () => {
          await rm(tool);
          await copyFile(real, path.join(elsewhere, "link"));
          await chmod(path.join(elsewhere, "link"), 0o755);
          await symlink(path.join(elsewhere, "link"), tool);
        }, 125],
        ["a copy in a group-writable directory", async () => {
          await rm(tool);
          await copyFile(real, tool);
          await chmod(tool, 0o755);
          await chmod(tools, 0o775);
        }, 125],
      ];
      await copyFile(real, tool);
      await chmod(tool, 0o755);
      for (const [label, arrange, code] of cases) {
        await arrange();
        const run = await newRun();
        const result = await publish(run, { pid: process.pid, testOnlyToolDirs: [tools] });
        expect({ label, code: result.code, records: (await recordNames(run)).length })
          .toEqual({ label, code, records: code === 0 ? 1 : 0 });
      }

      // The record name is taken right before link(2) runs: the launch
      // refuses and leaves the note that the run's stop reports.
      await chmod(tools, 0o755);
      await rm(tool);
      await writeFile(tool, `#!/bin/sh\nln -s /nonexistent "$2"\nexec '${real}' "$@"\n`);
      await chmod(tool, 0o755);
      const raced = await newRun();
      const result = await publish(raced, { pid: process.pid, testOnlyToolDirs: [tools] });
      expect(result.code).toBe(125);
      expect(result.stderr).toContain("already taken");
      expect((await stop(raced))?.partial).toBe("unsafe_record_dir");
    } finally {
      await rm(tools, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not start a launch whose marker line is missing or malformed", async () => {
    for (const stdinPrefix of ["\n", "not-a-marker\n", `${"a".repeat(31)}\n`]) {
      const launch = await runLaunch({ command: "echo started", stdinPrefix });
      expect(launch.stdout).not.toContain("started");
      expect(launch.code).toBe(125);
    }
  }, 30_000);

  it.each([["the run directory", (root: string, runId: string) => sshRunProcessRecordDir(root, runId)], [".paperclip-runtime", (root: string) => path.join(root, ".paperclip-runtime")]])(
    "does not start a launch when %s is a planted link, and writes nothing outside it",
    async (_level, linkPath) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
      const runId = randomUUID();
      const victim = await mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
      await mkdir(path.dirname(linkPath(root, runId)), { recursive: true });
      await symlink(victim, linkPath(root, runId));

      const launch = await runLaunch({ root, runId, command: "echo started" });

      expect(launch.stdout).not.toContain("started");
      expect(launch.code).toBe(125);
      expect(await readdir(victim)).toEqual([]);
    },
    30_000,
  );

  it("does not start a launch when a stop mark of any kind is there, even a dangling link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();
    await mkdir(sshRunProcessRecordDir(root, runId), { recursive: true });
    await symlink(path.join(root, "missing", "target"), path.join(sshRunProcessRecordDir(root, runId), "stopped"));

    const launch = await runLaunch({ root, runId, command: "echo started" });

    expect(launch.stdout).not.toContain("started");
    expect(launch.code).toBe(143);
  }, 30_000);

  it.each([
    ["a link to a directory outside", (victim: string) => ({ kind: "symlink", target: victim })],
    ["a link to a file outside", (victim: string) => ({ kind: "symlink", target: path.join(victim, "file") })],
    ["a dangling link", (victim: string) => ({ kind: "symlink", target: path.join(victim, "missing", "x") })],
    ["a real directory", () => ({ kind: "directory", target: "" })],
  ])("does not start a launch whose record name is already taken by %s, and changes nothing outside", async (_kind, plant) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();
    const victim = await mkdtemp(path.join(os.tmpdir(), "paperclip-victim-"));
    await writeFile(path.join(victim, "file"), "outside\n");
    await mkdir(sshRunProcessRecordDir(root, runId), { recursive: true });
    const entry = plant(victim);

    const launch = await runLaunch({
      root,
      runId,
      command: "echo started",
      // The launch id is in the remote command, so a same-user process can plant it.
      beforeSpawn: async (remoteScript) => {
        const launchId = /([0-9a-f]{16})\.json/.exec(remoteScript)?.[1];
        expect(launchId).toBeDefined();
        const name = path.join(sshRunProcessRecordDir(root, runId), `${launchId}.json`);
        if (entry.kind === "symlink") await symlink(entry.target, name);
        else await mkdir(name);
      },
    });

    expect(launch.stdout).not.toContain("started");
    expect(launch.code).toBe(125);
    expect(await readdir(victim)).toEqual(["file"]);
    expect(await readFile(path.join(victim, "file"), "utf8")).toBe("outside\n");
    // The run's stop reports the refusal, not a missing record.
    expect((await stop(runOf(root, runId)))?.partial).toBe("unsafe_record_dir");
  }, 30_000);

  it("leaves no record behind when a launch finds the run already stopped, so the stop mark can age out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();
    await stop(runOf(root, runId));

    const late = await runLaunch({ root, runId, command: "echo started" });

    expect(late.code).toBe(143);
    expect(await readdir(sshRunProcessRecordDir(root, runId))).toEqual(["stopped"]);
    // With no record left, a later stop of another run ages the old mark out.
    await execFileAsync("touch", ["-d", "10 days ago", path.join(sshRunProcessRecordDir(root, runId), "stopped")]);
    await stop(runOf(root, randomUUID()));
    await expect(readdir(sshRunProcessRecordDir(root, runId))).rejects.toThrow();
  }, 30_000);

  it("removes stop marks older than a week, and keeps newer ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const [oldRun, newRun, current] = [randomUUID(), randomUUID(), randomUUID()];
    for (const runId of [oldRun, newRun]) {
      await mkdir(sshRunProcessRecordDir(root, runId), { recursive: true });
      await writeFile(path.join(sshRunProcessRecordDir(root, runId), "stopped"), "");
    }
    await execFileAsync("touch", ["-d", "10 days ago", path.join(sshRunProcessRecordDir(root, oldRun), "stopped")]);

    await stop(runOf(root, current));

    await expect(readdir(sshRunProcessRecordDir(root, oldRun))).rejects.toThrow();
    expect(await readdir(sshRunProcessRecordDir(root, newRun))).toEqual(["stopped"]);
    expect(await readdir(sshRunProcessRecordDir(root, current))).toEqual(["stopped"]);
  }, 30_000);

  it("keeps its own marker when the caller's environment names the same variable", async () => {
    const { stdout, marker } = await runLaunch({
      env: { [REMOTE_RUN_MARKER_ENV]: "0".repeat(32) },
      command: `tr '\\000' '\\n' < /proc/$$/environ | grep '^${REMOTE_RUN_MARKER_ENV}='`,
    });
    expect(stdout.trim()).toBe(`${REMOTE_RUN_MARKER_ENV}=${marker}`);
  }, 30_000);

  it("keeps the marker line and the command's stdin from login profiles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-home-"));
    await writeFile(
      path.join(home, ".profile"),
      'read -r stolen; printf %s "$stolen" > "$HOME/stolen"\n',
    );
    const { stdout } = await runLaunch({ home, command: "cat" });
    expect(stdout).toBe("hello\n");
    expect(await readFile(path.join(home, "stolen"), "utf8")).toBe("");
  }, 30_000);

  it("stops a launch that is still sourcing its login profiles, with what the profiles started", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-launch-"));
    const runId = randomUUID();
    // The profile starts a background process, then waits until it is stopped.
    await writeFile(path.join(home, ".profile"), 'sleep 600 & echo "$!" > "$HOME/child"; while :; do sleep 0.1; done\n');
    const launch = runLaunch({ root, runId, home, command: "echo started" });
    let child = 0;
    for (const deadline = Date.now() + 10_000; !child && Date.now() < deadline; await settle()) {
      child = Number((await readFile(path.join(home, "child"), "utf8").catch(() => "")).trim());
    }
    expect(child).toBeGreaterThan(0);

    const summary = await stop(runOf(root, runId));
    const { stdout, code } = await launch;
    await settle();

    expect(summary).toMatchObject({ records: 1, survived: 0, partial: null });
    expect(summary?.matched).toBeGreaterThanOrEqual(2);
    expect(alive(child)).toBe(false);
    expect(stdout).not.toContain("started");
    expect(code).toBe(143);
  }, 30_000);

  it("leaves a launch without a run record unchanged", async () => {
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/ws",
        remoteWorkspacePath: "/srv",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "node",
      args: ["--version"],
      env: {},
    });
    expect(target.stdinPrefix).toBeUndefined();
    expect(target.args.at(-1)).not.toContain("read -r");
    expect(target.args.at(-1)).not.toContain(REMOTE_RUN_MARKER_ENV);
    await target.cleanup();
  });
});

function createHash(value: string): string {
  return sha256Hash("sha256").update(value).digest("hex");
}

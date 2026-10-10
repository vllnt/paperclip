import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteProcessRecordLines,
  buildRemoteProcessStopLines,
  parseRemoteProcessIdentity,
  type RemoteProcessIdentity,
} from "./remote-process-identity.js";

const HAS_PROC = existsSync("/proc/self/stat");
// The production image has no `ps`; its Linux workers use /proc.
const REAL_PS = (() => {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
const pids: number[] = [];
const roots: string[] = [];

// `proc` inspects through /proc (Linux). `ps` inspects as a host without
// /proc does (macOS); on Linux the scripts see /proc hidden. Each mode runs
// where the host has what it needs.
type Mode = "proc" | "ps";
const MODES: Mode[] = [...(HAS_PROC ? ["proc" as const] : []), ...(REAL_PS ? ["ps" as const] : [])];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Runs a script in /bin/sh in its own process group, as a worker would.
async function runScript(script: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  const child = spawn("/bin/sh", ["-c", script], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr };
}

function forMode(mode: Mode, root: string, script: string): string {
  return mode === "ps" ? script.replaceAll("/proc/", `${path.join(root, "no-proc")}/`) : script;
}

// An entrypoint that keeps running. With `ignoreTerm` it ignores SIGTERM and
// marks it in `term-received`.
async function createRoot(options: { ignoreTerm?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-process-"));
  roots.push(root);
  const onTerm = options.ignoreTerm
    ? `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "term-received"))}, ""));\n`
    : "";
  await writeFile(path.join(root, "entry.cjs"), `${onTerm}setInterval(() => {}, 1000);\n`);
  return root;
}

// Launches `node entry.cjs <tag>` the way a launch script does and returns its record.
async function launch(mode: Mode, root: string, tag: string): Promise<{ identity: RemoteProcessIdentity; argv: string[] }> {
  const argv = ["node", path.join(root, "entry.cjs"), tag];
  const { stdout } = await runScript(forMode(mode, root, [
    "group=1",
    `nohup setsid ${argv.map((arg) => `'${arg}'`).join(" ")} >/dev/null 2>&1 < /dev/null &`,
    "pid=$!",
    ...buildRemoteProcessRecordLines(),
  ].join("\n")), root);
  const identity = parseRemoteProcessIdentity(stdout);
  if (!identity) throw new Error(`no launch record in ${JSON.stringify(stdout)}`);
  pids.push(identity.pid);
  return { identity, argv };
}

function stopScript(mode: Mode, root: string, identity: RemoteProcessIdentity | null, argv: string[], nonceArg?: string): string {
  return forMode(mode, root, buildRemoteProcessStopLines({ identity, argv, label: "test", nonceArg }).join("\n"));
}

// A `ps` on PATH that runs the real one, or fails with `fail`, or reports
// another start time once `term-received` exists.
async function shimPs(root: string, behaviour: "fail" | "start-changes-after-term"): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const body = behaviour === "fail"
    ? "exit 1\n"
    : `case "$*" in *lstart*) [ -e '${path.join(root, "term-received")}' ] && { echo 'Thu Jan  1 00:00:00 1970'; exit 0; } ;; esac\nexec '${REAL_PS}' "$@"\n`;
  await writeFile(path.join(bin, "ps"), `#!/bin/sh\n${body}`);
  await chmod(path.join(bin, "ps"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    if (!(pid > 1)) continue;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  for (const root of roots.splice(0)) {
    const bystander = Number(await readFile(path.join(root, "bystander.pid"), "utf8").catch(() => "0"));
    if (bystander > 1) {
      try {
        process.kill(bystander, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("parseRemoteProcessIdentity", () => {
  it("accepts only a record with an id of 2 or more and a start time", () => {
    expect(parseRemoteProcessIdentity('noise\n{"pid":4242,"start":"123","group":1}\n')).toEqual({ pid: 4242, start: "123", group: true });
    expect(parseRemoteProcessIdentity('{"pid":4242,"start":"Fri Oct 10 02:30:01 2026","group":0}'))
      .toEqual({ pid: 4242, start: "Fri Oct 10 02:30:01 2026", group: false });
    for (const line of [
      '{"pid":0,"start":"123","group":1}',
      '{"pid":1,"start":"123","group":1}',
      '{"pid":-5,"start":"123","group":1}',
      '{"pid":4.5,"start":"123","group":1}',
      '{"pid":4242,"start":"","group":1}',
      '{"pid":4242,"start":"no digits","group":1}',
      '{"pid":4242,"start":"1; rm -rf x","group":1}',
      "not json",
      "",
    ]) {
      expect(parseRemoteProcessIdentity(line), line).toBeNull();
    }
  });

  it("refuses a nonce that is not a whitespace-free element of argv", () => {
    expect(() => buildRemoteProcessStopLines({ identity: null, argv: ["node", "a"], label: "test", nonceArg: "b" })).toThrow();
    expect(() => buildRemoteProcessStopLines({ identity: null, argv: ["node", "a b"], label: "test", nonceArg: "a b" })).toThrow();
  });
});

describe.each(MODES)("buildRemoteProcessStopLines, inspecting with %s", (mode) => {
  it("stops a real launched process and spares one with the same argv", async () => {
    const root = await createRoot();
    const launched = await launch(mode, root, "--tag=same");
    const twin = await launch(mode, root, "--tag=same");

    await runScript(stopScript(mode, root, launched.identity, launched.argv, "--tag=same"), root);

    expect(isAlive(launched.identity.pid)).toBe(false);
    expect(isAlive(twin.identity.pid)).toBe(true);
  });

  it("spares a process that reuses the recorded id", async () => {
    const root = await createRoot();
    const launched = await launch(mode, root, "--tag=first");
    const other = await launch(mode, root, "--tag=second");
    // The record names the other process's id with the launched process's start time.
    const reused = { ...launched.identity, pid: other.identity.pid };

    const { stderr } = await runScript(stopScript(mode, root, reused, launched.argv, "--tag=first"), root);

    expect(isAlive(other.identity.pid)).toBe(true);
    expect(stderr).toContain("could not be proven");
  });

  it("signals nothing when the start time differs from the record", async () => {
    const root = await createRoot();
    const launched = await launch(mode, root, "--tag=start");
    const changed = { ...launched.identity, start: mode === "proc" ? `${Number(launched.identity.start) + 1}` : "Thu Jan  1 00:00:00 1970" };

    await runScript(stopScript(mode, root, changed, launched.argv, "--tag=start"), root);

    expect(isAlive(launched.identity.pid)).toBe(true);
  });

  it("signals nothing for an id of 0, 1, -1 or junk, and spares the stopping shell's group", async () => {
    const root = await createRoot();
    const { argv } = await launch(mode, root, "--tag=invalid");
    for (const pid of [0, 1, -1, Number.NaN]) {
      const identity = { pid, start: "1", group: true };
      const script = `sleep 60 >/dev/null 2>&1 & echo $! > '${path.join(root, "bystander.pid")}'\n${stopScript(mode, root, identity, argv, "--tag=invalid")}`;
      await runScript(script, root);
      const bystander = Number(await readFile(path.join(root, "bystander.pid"), "utf8"));
      expect(isAlive(bystander), `id ${pid}`).toBe(true);
      process.kill(bystander, "SIGKILL");
    }
  });

  it("signals nothing when it cannot inspect the process", async () => {
    const root = await createRoot();
    const launched = await launch(mode, root, "--tag=blind");
    // No /proc and no nonce, or no /proc and a `ps` that fails.
    await runScript(forMode("ps", root, buildRemoteProcessStopLines({ identity: launched.identity, argv: launched.argv, label: "test" }).join("\n")), root);
    expect(isAlive(launched.identity.pid)).toBe(true);

    await runScript(stopScript("ps", root, launched.identity, launched.argv, "--tag=blind"), root, await shimPs(root, "fail"));
    expect(isAlive(launched.identity.pid)).toBe(true);
  });

  it.runIf(mode === "ps")("sends no SIGKILL when the start time changes after SIGTERM", async () => {
    const root = await createRoot({ ignoreTerm: true });
    const launched = await launch(mode, root, "--tag=reuse-late");
    const env = await shimPs(root, "start-changes-after-term");

    await runScript(stopScript(mode, root, launched.identity, launched.argv, "--tag=reuse-late"), root, env);

    // It received SIGTERM, ignored it, and got no SIGKILL.
    await vi.waitFor(() => expect(existsSync(path.join(root, "term-received"))).toBe(true));
    expect(isAlive(launched.identity.pid)).toBe(true);
  });
});

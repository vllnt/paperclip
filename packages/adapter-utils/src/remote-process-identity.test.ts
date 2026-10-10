import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteProcessRecordLines,
  buildRemoteProcessStopLines,
  parseRemoteProcessIdentity,
  type RemoteProcessIdentity,
} from "./remote-process-identity.js";

const HAS_PROC = existsSync("/proc/self/stat");
const pids: number[] = [];
const roots: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Runs a script in /bin/sh in its own process group, as a worker would.
async function runScript(script: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn("/bin/sh", ["-c", script], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve) => child.on("close", resolve));
  return { stdout, stderr };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-process-"));
  roots.push(root);
  await writeFile(path.join(root, "entry.mjs"), "setInterval(() => {}, 1000);\n");
  return root;
}

// Launches `node entry.mjs <tag>` the way a launch script does and returns its record.
async function launch(root: string, tag: string): Promise<{ identity: RemoteProcessIdentity; argv: string[] }> {
  const argv = ["node", path.join(root, "entry.mjs"), tag];
  const { stdout } = await runScript([
    "group=1",
    `nohup setsid ${argv.map((arg) => `'${arg}'`).join(" ")} >/dev/null 2>&1 < /dev/null &`,
    "pid=$!",
    ...buildRemoteProcessRecordLines(),
  ].join("\n"), root);
  const identity = parseRemoteProcessIdentity(stdout);
  if (!identity) throw new Error(`no launch record in ${JSON.stringify(stdout)}`);
  pids.push(identity.pid);
  return { identity, argv };
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
  it("accepts only a record with an id of 2 or more and a numeric start time", () => {
    expect(parseRemoteProcessIdentity('noise\n{"pid":4242,"start":"123","group":1}\n')).toEqual({ pid: 4242, start: "123", group: true });
    expect(parseRemoteProcessIdentity('{"pid":4242,"start":"123","group":0}')).toEqual({ pid: 4242, start: "123", group: false });
    for (const line of [
      '{"pid":0,"start":"123","group":1}',
      '{"pid":1,"start":"123","group":1}',
      '{"pid":-5,"start":"123","group":1}',
      '{"pid":4.5,"start":"123","group":1}',
      '{"pid":4242,"start":"","group":1}',
      '{"pid":4242,"start":"Fri Oct 10","group":1}',
      "not json",
      "",
    ]) {
      expect(parseRemoteProcessIdentity(line), line).toBeNull();
    }
  });
});

describe.runIf(HAS_PROC)("buildRemoteProcessStopLines", () => {
  it("stops the launched process and spares one with the same argv", async () => {
    const root = await createRoot();
    const launched = await launch(root, "--tag=same");
    const twin = await launch(root, "--tag=same");

    await runScript(buildRemoteProcessStopLines({ identity: launched.identity, argv: launched.argv, label: "test" }).join("\n"), root);

    expect(isAlive(launched.identity.pid)).toBe(false);
    expect(isAlive(twin.identity.pid)).toBe(true);
  });

  it("spares a process that reuses the recorded id", async () => {
    const root = await createRoot();
    const launched = await launch(root, "--tag=reuse");
    const other = await launch(root, "--tag=reuse");
    // The record names the other process's id with the launched process's start time.
    const reused = { ...launched.identity, pid: other.identity.pid };

    const { stderr } = await runScript(buildRemoteProcessStopLines({ identity: reused, argv: launched.argv, label: "test" }).join("\n"), root);

    expect(isAlive(other.identity.pid)).toBe(true);
    expect(stderr).toContain("could not be proven");
  });

  it("signals nothing for an id of 0, 1, -1 or junk, and spares the stopping shell's group", async () => {
    const root = await createRoot();
    const { argv } = await launch(root, "--tag=invalid");
    for (const pid of [0, 1, -1, Number.NaN]) {
      const identity = { pid, start: "1", group: true };
      const script = [
        `sleep 60 >/dev/null 2>&1 & echo $! > '${path.join(root, "bystander.pid")}'`,
        ...buildRemoteProcessStopLines({ identity, argv, label: "test" }),
      ].join("\n");
      await runScript(script, root);
      const bystander = Number(await readFile(path.join(root, "bystander.pid"), "utf8"));
      expect(isAlive(bystander), `id ${pid}`).toBe(true);
      process.kill(bystander, "SIGKILL");
    }
  });

  it("signals nothing when the worker has no /proc", async () => {
    const root = await createRoot();
    const launched = await launch(root, "--tag=noproc");
    const script = buildRemoteProcessStopLines({ identity: launched.identity, argv: launched.argv, label: "test" })
      .join("\n")
      .replaceAll("/proc/", path.join(root, "missing-proc") + "/");

    await runScript(script, root);

    expect(isAlive(launched.identity.pid)).toBe(true);
  });
});

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "./process-liveness.js";

const HAS_PROC = existsSync("/proc/self/stat");
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

function stateOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.charAt(stat.lastIndexOf(")") + 2);
}

describe("isProcessAlive", () => {
  it("is true for a running process and false once it is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    pids.push(child.pid ?? 0);
    expect(isProcessAlive(child.pid ?? 0)).toBe(true);

    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    // Node reaps its own child, so the id is no longer in the table.
    expect(isProcessAlive(child.pid ?? 0)).toBe(false);
  });

  it.runIf(HAS_PROC)("is false for a zombie that its parent has not reaped", async () => {
    // `exec sleep` replaces the shell with a process that never waits, so the
    // background child below stays a zombie once it exits.
    const parent = spawn("/bin/sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
    pids.push(parent.pid ?? 0);
    const zombie = await new Promise<number>((resolve, reject) => {
      let out = "";
      parent.stdout?.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) resolve(Number(out.trim()));
      });
      parent.on("error", reject);
    });
    pids.push(zombie);

    await vi.waitFor(() => expect(stateOf(zombie)).toBe("Z"), { timeout: 5_000, interval: 20 });
    // The signal check alone still reports it as present.
    expect(() => process.kill(zombie, 0)).not.toThrow();
    expect(isProcessAlive(zombie)).toBe(false);
    expect(isProcessAlive(parent.pid ?? 0)).toBe(true);
  });
});

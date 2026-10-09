import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  RESOURCE_PROBE_MARKER,
  RESOURCE_PROBE_MAX_OUTPUT_BYTES,
  appendResourceProbe,
  parseDfPortableLine,
  parseProcLoadavg,
  parseProcMeminfo,
  parseResourceProbeOutput,
  splitResourceProbeOutput,
} from "./resource-probe.js";

const execFileAsync = promisify(execFile);

const LINUX_PROBE_OUTPUT = [
  "rc:nproc 8",
  "rc:loadavg 3.52 2.10 1.05 4/812 99120",
  "rc:MemTotal:       16318412 kB",
  "rc:MemAvailable:    9182044 kB",
  "rc:df /dev/nvme0n1p1  203056560 186811040  16228736      93% /",
].join("\n");

describe("parseResourceProbeOutput", () => {
  it("reads every metric from Linux output", () => {
    expect(parseResourceProbeOutput(LINUX_PROBE_OUTPUT)).toEqual({
      cpuCount: 8,
      load: { load1: 3.52, load5: 2.1, load15: 1.05 },
      memTotalBytes: 16318412 * 1024,
      memAvailableBytes: 9182044 * 1024,
      disk: { totalBytes: 203056560 * 1024, freeBytes: 16228736 * 1024 },
    });
  });

  it("leaves metrics a host without /proc cannot report as null", () => {
    const reading = parseResourceProbeOutput(
      ["rc:nproc 10", "rc:loadavg ", "rc:df /dev/disk3s5 482797652 434000000 14000000 97% /System/Volumes/Data"].join("\n"),
    );
    expect(reading.cpuCount).toBe(10);
    expect(reading.load).toBeNull();
    expect(reading.memTotalBytes).toBeNull();
    expect(reading.memAvailableBytes).toBeNull();
    expect(reading.disk).toEqual({ totalBytes: 482797652 * 1024, freeBytes: 14000000 * 1024 });
  });

  it("ignores untagged lines such as a login banner", () => {
    const reading = parseResourceProbeOutput(`Welcome!\nnproc 99\n${LINUX_PROBE_OUTPUT}\nrc:unknown 5`);
    expect(reading.cpuCount).toBe(8);
  });

  it("rejects out-of-range and malformed numbers", () => {
    const reading = parseResourceProbeOutput(
      [
        "rc:nproc 999999",
        "rc:loadavg -1 2 3",
        "rc:MemTotal:       100 kB",
        "rc:MemAvailable:   200 kB",
        "rc:df fs 100 50 150 50% /",
      ].join("\n"),
    );
    expect(reading).toEqual({
      cpuCount: null,
      load: null,
      memTotalBytes: 100 * 1024,
      memAvailableBytes: null,
      disk: null,
    });
  });

  it("discards oversized output instead of parsing it", () => {
    const noise = "x".repeat(RESOURCE_PROBE_MAX_OUTPUT_BYTES);
    expect(parseResourceProbeOutput(`${LINUX_PROBE_OUTPUT}\n${noise}`)).toEqual({
      cpuCount: null,
      load: null,
      memTotalBytes: null,
      memAvailableBytes: null,
      disk: null,
    });
  });
});

describe("probe line parsers", () => {
  it("parses /proc/loadavg", () => {
    expect(parseProcLoadavg("0.00 0.01 0.05 1/100 42\n")).toEqual({ load1: 0, load5: 0.01, load15: 0.05 });
    expect(parseProcLoadavg("1e9 1 1")).toBeNull();
    expect(parseProcLoadavg("")).toBeNull();
  });

  it("parses /proc/meminfo with or without the probe tag", () => {
    expect(parseProcMeminfo("MemTotal: 2048 kB\nMemFree: 10 kB\nMemAvailable: 1024 kB\n")).toEqual({
      memTotalBytes: 2048 * 1024,
      memAvailableBytes: 1024 * 1024,
    });
    expect(parseProcMeminfo("MemAvailable: 1024 kB\n")).toEqual({ memTotalBytes: null, memAvailableBytes: null });
  });

  it("parses df -Pk lines whose filesystem or mount contains spaces", () => {
    expect(parseDfPortableLine("//nas/share name 1000 400 600 40% /mnt/my share")).toEqual({
      totalBytes: 1000 * 1024,
      freeBytes: 600 * 1024,
    });
    expect(parseDfPortableLine("overlay 1000 1000 0 100% /")).toEqual({ totalBytes: 1000 * 1024, freeBytes: 0 });
    expect(parseDfPortableLine("Filesystem 1024-blocks Used Available Capacity Mounted on")).toBeNull();
    expect(parseDfPortableLine("fs 0 0 0 0% /")).toBeNull();
  });
});

describe("appendResourceProbe", () => {
  it("round-trips through splitResourceProbeOutput", () => {
    const stdout = `/home/worker/ws\n\n${RESOURCE_PROBE_MARKER}\n${LINUX_PROBE_OUTPUT}\n`;
    const { head, probe } = splitResourceProbeOutput(stdout);
    expect(head.trim()).toBe("/home/worker/ws");
    expect(parseResourceProbeOutput(probe ?? "").cpuCount).toBe(8);
    expect(splitResourceProbeOutput("/home/worker/ws\n")).toEqual({ head: "/home/worker/ws\n", probe: null });
  });

  it("keeps the command's stdout and exit status in a real shell", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-resource-probe-"));
    const target = path.join(root, "workspace");
    const quoted = `'${target}'`;
    const { stdout } = await execFileAsync("sh", [
      "-c",
      appendResourceProbe(`mkdir -p ${quoted} && cd ${quoted} && pwd`),
    ]);
    const { head, probe } = splitResourceProbeOutput(stdout);
    expect(path.basename(head.trim())).toBe("workspace");
    const reading = parseResourceProbeOutput(probe ?? "");
    expect(reading.cpuCount).toBeGreaterThan(0);
    expect(reading.disk?.totalBytes).toBeGreaterThan(0);

    await expect(
      execFileAsync("sh", ["-c", appendResourceProbe("cd /nonexistent-paperclip-probe-dir && pwd")]),
    ).rejects.toMatchObject({ code: expect.any(Number) });
  });

  it("cuts oversized probe output on the host and still succeeds", async () => {
    const flood = "i=0; while [ $i -lt 20000 ]; do echo rc:noise-line-of-text-$i; i=$((i+1)); done";
    const { stdout } = await execFileAsync("sh", ["-c", appendResourceProbe("echo /ws", flood)], {
      maxBuffer: 128 * 1024,
    });
    const { head, probe } = splitResourceProbeOutput(stdout);
    expect(head.trim()).toBe("/ws");
    expect(Buffer.byteLength(probe ?? "")).toBe(RESOURCE_PROBE_MAX_OUTPUT_BYTES);
  });

  it("parses nothing from a probe cut at the size limit, whose last line may be cut mid-number", () => {
    const capped = `rc:nproc 8\n${"rc:filler\n".repeat(2000)}`.slice(0, RESOURCE_PROBE_MAX_OUTPUT_BYTES);
    expect(Buffer.byteLength(capped)).toBe(RESOURCE_PROBE_MAX_OUTPUT_BYTES);
    expect(parseResourceProbeOutput(capped).cpuCount).toBeNull();
  });

  it("ignores a marker printed by the probe itself", async () => {
    const spoof = `printf '\\n${RESOURCE_PROBE_MARKER}\\n/spoofed\\n'`;
    const { stdout } = await execFileAsync("sh", ["-c", appendResourceProbe("echo /ws", spoof)]);
    expect(splitResourceProbeOutput(stdout).head.trim()).toBe("/ws");
  });

  it("succeeds when every probe command fails", async () => {
    const { stdout } = await execFileAsync("sh", [
      "-c",
      appendResourceProbe("echo /ws", "false; /nonexistent-paperclip-binary; exit 3"),
    ]);
    const { head, probe } = splitResourceProbeOutput(stdout);
    expect(head.trim()).toBe("/ws");
    expect(parseResourceProbeOutput(probe ?? "").disk).toBeNull();
  });
});

// Host resource probe for workers reached over an existing driver command.
// The output comes from a host Paperclip does not control, so the parser reads
// only tagged lines, range-checks every number, and never keeps raw text.

/** Separates a driver command's own stdout from the probe's lines. */
export const RESOURCE_PROBE_MARKER = "__paperclip_rc__";
/** Probe output above this size is discarded rather than parsed. */
export const RESOURCE_PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

const MAX_CPU_COUNT = 4096;
const MAX_LOAD = 1_000_000;
const KIB = 1024;

/**
 * POSIX `sh` lines that report CPU count, load, memory and the filesystem of
 * the current directory. Run it from the directory to measure. Each line is
 * tagged `rc:` so its order and any unrelated output do not matter.
 */
export const RESOURCE_PROBE_SCRIPT = [
  "LC_ALL=C",
  "export LC_ALL",
  'echo "rc:nproc $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"',
  'echo "rc:loadavg $(cat /proc/loadavg 2>/dev/null)"',
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null | sed 's/^/rc:/'",
  "df -Pk . 2>/dev/null | tail -n 1 | sed 's/^/rc:df /'",
].join("; ");

/**
 * Appends the probe to a command so it runs only after the command succeeds,
 * can never change its exit status, and prints at most
 * {@link RESOURCE_PROBE_MAX_OUTPUT_BYTES} on the worker, so the caller's
 * output buffer is never exceeded.
 *
 * @param command - A command whose stdout the caller still reads before the marker.
 * @param probeScript - The probe to run; tests substitute their own.
 * @returns The chained command.
 */
export function appendResourceProbe(command: string, probeScript: string = RESOURCE_PROBE_SCRIPT): string {
  return `${command} && { printf '\\n${RESOURCE_PROBE_MARKER}\\n'; { { ${probeScript}; } 2>/dev/null | head -c ${RESOURCE_PROBE_MAX_OUTPUT_BYTES}; } 2>/dev/null; true; }`;
}

/**
 * Splits stdout of a command built by {@link appendResourceProbe} at the
 * first marker, so nothing the probe prints can change the command's output.
 *
 * @returns `head` is the command's own output; `probe` is null when the marker is absent.
 */
export function splitResourceProbeOutput(stdout: string): { head: string; probe: string | null } {
  const markerLine = `\n${RESOURCE_PROBE_MARKER}\n`;
  const index = stdout.indexOf(markerLine);
  if (index < 0) return { head: stdout, probe: null };
  return { head: stdout.slice(0, index), probe: stdout.slice(index + markerLine.length) };
}

export interface ResourceLoadAverage {
  load1: number;
  load5: number;
  load15: number;
}

export interface ResourceMemory {
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
}

export interface ResourceDisk {
  totalBytes: number;
  freeBytes: number;
}

export interface ResourceProbeReading extends ResourceMemory {
  cpuCount: number | null;
  load: ResourceLoadAverage | null;
  disk: ResourceDisk | null;
}

function finiteInRange(value: number, max: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= max;
}

function parseKibToBytes(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,16}$/.test(raw)) return null;
  const bytes = Number(raw) * KIB;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Parses the first three fields of `/proc/loadavg`.
 *
 * @returns Null unless all three are finite, non-negative numbers.
 */
export function parseProcLoadavg(text: string): ResourceLoadAverage | null {
  const [one, five, fifteen] = text.trim().split(/\s+/);
  const values = [one, five, fifteen].map((part) =>
    part !== undefined && /^\d+(\.\d+)?$/.test(part) ? Number(part) : Number.NaN,
  );
  if (!values.every((value) => finiteInRange(value, MAX_LOAD))) return null;
  return { load1: values[0]!, load5: values[1]!, load15: values[2]! };
}

/**
 * Reads `MemTotal` and `MemAvailable` (kB) from `/proc/meminfo` text.
 * Lines may carry the probe's `rc:` tag.
 */
export function parseProcMeminfo(text: string): ResourceMemory {
  const values = new Map<string, number | null>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.startsWith("rc:") ? rawLine.slice(3) : rawLine;
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) values.set(match[1]!, parseKibToBytes(match[2]));
  }
  const memTotalBytes = values.get("MemTotal") ?? null;
  let memAvailableBytes = values.get("MemAvailable") ?? null;
  if (memTotalBytes === null || memTotalBytes <= 0) return { memTotalBytes: null, memAvailableBytes: null };
  if (memAvailableBytes !== null && memAvailableBytes > memTotalBytes) memAvailableBytes = null;
  return { memTotalBytes, memAvailableBytes };
}

/**
 * Parses one `df -Pk` data line. The filesystem and mount point may contain
 * spaces, so the numbers are located from the capacity column (`NN%`).
 */
export function parseDfPortableLine(line: string): ResourceDisk | null {
  const tokens = line.trim().split(/\s+/);
  const capacityIndex = tokens.findIndex((token, index) => index >= 4 && /^\d{1,3}%$/.test(token));
  if (capacityIndex < 0) return null;
  const totalBytes = parseKibToBytes(tokens[capacityIndex - 3]);
  const freeBytes = parseKibToBytes(tokens[capacityIndex - 1]);
  if (totalBytes === null || freeBytes === null || totalBytes <= 0 || freeBytes > totalBytes) return null;
  return { totalBytes, freeBytes };
}

/**
 * Parses probe output into validated numbers. Missing or invalid values are
 * null. Output that reaches {@link RESOURCE_PROBE_MAX_OUTPUT_BYTES} yields
 * nothing: the worker cuts the probe at that size, so its last line may be
 * cut mid-number.
 */
export function parseResourceProbeOutput(output: string): ResourceProbeReading {
  const reading: ResourceProbeReading = {
    cpuCount: null,
    load: null,
    disk: null,
    memTotalBytes: null,
    memAvailableBytes: null,
  };
  if (Buffer.byteLength(output) >= RESOURCE_PROBE_MAX_OUTPUT_BYTES) return reading;
  const meminfoLines: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("rc:")) continue;
    if (line.startsWith("rc:nproc ")) {
      const value = line.slice("rc:nproc ".length).trim();
      const count = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
      if (count >= 1 && count <= MAX_CPU_COUNT) reading.cpuCount = count;
    } else if (line.startsWith("rc:loadavg ")) {
      reading.load = parseProcLoadavg(line.slice("rc:loadavg ".length));
    } else if (line.startsWith("rc:df ")) {
      reading.disk = parseDfPortableLine(line.slice("rc:df ".length));
    } else if (line.startsWith("rc:Mem")) {
      meminfoLines.push(line);
    }
  }
  Object.assign(reading, parseProcMeminfo(meminfoLines.join("\n")));
  return reading;
}

import { z } from "zod";

/**
 * Routine gate scripts: a deterministic script that runs on the worker, with no LLM,
 * before a routine wakes its agent. Exit 0 wakes the agent with stdout attached as
 * untrusted context; exit 1 skips the run at zero tokens.
 */
export const ROUTINE_GATE_INTERPRETERS = ["sh", "bash", "python3"] as const;
export type RoutineGateInterpreter = (typeof ROUTINE_GATE_INTERPRETERS)[number];

/**
 * Trigger kinds a gate can apply to. `api` is excluded on purpose (pipeline stages
 * dispatch with `source: "api"` and need an issue), and a manual run always bypasses the gate.
 */
export const ROUTINE_GATE_APPLIES_TO = ["schedule", "webhook", "event"] as const;
export type RoutineGateAppliesTo = (typeof ROUTINE_GATE_APPLIES_TO)[number];

export const ROUTINE_GATE_LIMITS = {
  repoMaxLength: 140,
  pathMaxLength: 256,
  maxArgs: 16,
  argMaxLength: 256,
  timeoutMinSec: 5,
  timeoutMaxSec: 120,
  timeoutDefaultSec: 30,
  /** A pinned script larger than this is refused when the config is saved. */
  scriptMaxBytes: 64 * 1024,
  /** Local stdout/stderr buffer; an overflow is a gate error. */
  outputMaxBytes: 128 * 1024,
  /** The normalized event / webhook payload handed to the script as PAPERCLIP_GATE_EVENT. */
  eventEnvMaxBytes: 16 * 1024,
  stdoutSampleMaxBytes: 4 * 1024,
  stderrTailMaxBytes: 2 * 1024,
} as const;

/** What the gate run recorded, in `routine_runs.gate_result.class`. */
export const ROUTINE_GATE_RESULT_CLASSES = [
  "ok",
  "skip",
  "script_fault",
  "timeout",
  "overflow",
  "transport",
] as const;
export type RoutineGateResultClass = (typeof ROUTINE_GATE_RESULT_CLASSES)[number];

/** `routine_runs.failure_reason` values that mark a gate decision. */
export const ROUTINE_GATE_SKIP_REASON = "gate_skip";
export const ROUTINE_GATE_UNCHANGED_REASON = "gate_unchanged";
export const ROUTINE_GATE_UNAVAILABLE_REASON = "gate_unavailable";
export const ROUTINE_GATE_TRIGGER_INACTIVE_REASON = "trigger_inactive";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._@+\-/]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSafeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (!SAFE_PATH_PATTERN.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const routineGateSchema = z.object({
  /** `owner/name`; must be on the instance allowlist of gate repos. */
  repo: z.string().trim().max(ROUTINE_GATE_LIMITS.repoMaxLength).regex(REPO_PATTERN, "repo must look like owner/name"),
  path: z
    .string()
    .trim()
    .min(1)
    .max(ROUTINE_GATE_LIMITS.pathMaxLength)
    .refine(isSafeRelativePath, "path must be relative, without '..' segments or unusual characters"),
  /** Must be reachable from the repo's default branch, so it went through a reviewed PR. */
  commitSha: z.string().trim().toLowerCase().regex(COMMIT_SHA_PATTERN, "commitSha must be a 40-character hex SHA"),
  interpreter: z.enum(ROUTINE_GATE_INTERPRETERS).default("sh"),
  args: z
    .array(
      z
        .string()
        .max(ROUTINE_GATE_LIMITS.argMaxLength)
        .refine((value) => !CONTROL_CHARS.test(value), "args must not contain control characters"),
    )
    .max(ROUTINE_GATE_LIMITS.maxArgs)
    .default([]),
  timeoutSec: z
    .number()
    .int()
    .min(ROUTINE_GATE_LIMITS.timeoutMinSec)
    .max(ROUTINE_GATE_LIMITS.timeoutMaxSec)
    .default(ROUTINE_GATE_LIMITS.timeoutDefaultSec),
  appliesTo: z
    .array(z.enum(ROUTINE_GATE_APPLIES_TO))
    .min(1)
    .max(ROUTINE_GATE_APPLIES_TO.length)
    .transform((values) => [...new Set(values)])
    .default([...ROUTINE_GATE_APPLIES_TO]),
}).strict();

export type RoutineGate = z.infer<typeof routineGateSchema>;

/** What one gate execution recorded, stored in `routine_runs.gate_result`. */
export interface RoutineGateResult {
  exitCode: number | null;
  class: RoutineGateResultClass;
  durationMs: number;
  /** `sha256` of the script content that ran. */
  scriptSha: string | null;
  environmentId: string | null;
  /** `sha256` of normalized stdout; null when stdout is empty, because empty output is never deduped. */
  resultFingerprint: string | null;
  /** Redacted, at most 4 KB. */
  stdoutSample: string;
  /** Redacted, at most 2 KB. */
  stderrTail: string;
  /** A short human reason, for example "gate user missing on worker". */
  detail?: string | null;
}

/** Response of `POST /api/routines/{id}/gate/test`. Runs the gate once without dispatching. */
export interface RoutineGateTestResult {
  result: RoutineGateResult;
  /** What a real run would have done with this result. */
  verdict: "wake" | "skip" | "fail_open" | "unavailable";
}

export function routineGateAppliesToSource(
  gate: Pick<RoutineGate, "appliesTo"> | null | undefined,
  source: string,
): boolean {
  if (!gate) return false;
  return (gate.appliesTo as readonly string[]).includes(source);
}

/** Two gate configs are the same pin; used to detect a board-only `gate` change. */
export function routineGatesEqual(a: RoutineGate | null | undefined, b: RoutineGate | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.repo === b.repo &&
    a.path === b.path &&
    a.commitSha === b.commitSha &&
    a.interpreter === b.interpreter &&
    a.timeoutSec === b.timeoutSec &&
    a.args.length === b.args.length &&
    a.args.every((arg, index) => arg === b.args[index]) &&
    [...a.appliesTo].sort().join(",") === [...b.appliesTo].sort().join(",")
  );
}

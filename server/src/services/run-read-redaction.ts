import type { Db } from "@paperclipai/db";
import { redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";
import { redactCurrentUserValue, type CurrentUserRedactionOptions } from "../log-redaction.js";
import { REDACTED_EVENT_VALUE, redactEventPayload, sanitizeRecord } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

/**
 * Read-time redaction for one heartbeat run. The run detail, events and log
 * routes, the company export and the company archive all redact through this
 * module, so what leaves the instance can never be less redacted than what the
 * API shows.
 */
export interface RunReadRedactor {
  /** Run row or run detail body: current-user masking, then registered secrets. */
  run<T>(value: T): T;
  /** Run event: payload pattern redaction, current-user masking, registered secrets. */
  event<T extends { payload?: Record<string, unknown> | null }>(event: T): T;
  /** Registered secrets only: log content was redacted when it was written. */
  logContent<T>(value: T): T;
  /**
   * Export and archive records. Stored rows are not guaranteed redacted
   * (several event writers skip write-time redaction, and log files can be
   * written outside `onLog`), so every exported record also gets a pattern
   * pass over all keys and string leaves: secret-named keys, bearer and
   * authorization text, JWT-shaped values and command secrets.
   */
  exportRun<T extends object>(run: T): Record<string, unknown>;
  exportEvent<T extends { payload?: Record<string, unknown> | null }>(event: T): Record<string, unknown>;
  exportValue<T extends object>(value: T): Record<string, unknown>;
}

type RunSecretRedactionRegistry = Pick<ReturnType<typeof createRunSecretRedactionRegistry>, "prepareForRun">;

export interface RunReadRedactionDeps {
  registry?: RunSecretRedactionRegistry;
  currentUserOptions?: () => Promise<CurrentUserRedactionOptions>;
}

function patternPass(value: object): Record<string, unknown> {
  return sanitizeRecord(value as Record<string, unknown>);
}

const ENV_OBJECT_KEY = /^(env|environment|envVars|environmentVariables)$/i;
// scheme://userinfo@host: the user part can itself be a token, so drop all of
// it. The lookbehind lets a scheme start only where a run of scheme characters
// starts, so a long run without "://" is tried once, not once per position.
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_DASHES = "-----";

/** A PEM label: one or more characters, no dash and no newline. */
function pemLabelEnd(text: string, from: number): number {
  const end = text.indexOf(PEM_DASHES, from);
  if (end <= from) return -1;
  for (let index = from; index < end; index += 1) {
    if (text[index] === "-" || text[index] === "\n") return -1;
  }
  return end;
}

/**
 * Replaces each `-----BEGIN <label>----- … -----END <label>-----` block, the
 * shortest one from each start, in one forward scan: a lazy regex retries the
 * rest of the text from every start, which is quadratic on many headers.
 */
function redactPemBlocks(text: string): string {
  let output = "";
  let position = 0;
  for (let begin = text.indexOf(PEM_BEGIN); begin >= 0; begin = text.indexOf(PEM_BEGIN, begin + 1)) {
    if (begin < position) continue;
    const headerEnd = pemLabelEnd(text, begin + PEM_BEGIN.length);
    if (headerEnd < 0) continue;
    let blockEnd = -1;
    for (let end = text.indexOf(PEM_END, headerEnd + PEM_DASHES.length); end >= 0; end = text.indexOf(PEM_END, end + 1)) {
      const labelEnd = pemLabelEnd(text, end + PEM_END.length);
      if (labelEnd >= 0) {
        blockEnd = labelEnd + PEM_DASHES.length;
        break;
      }
    }
    // No end line after this header means none after any later header either.
    if (blockEnd < 0) break;
    output += text.slice(position, begin) + REDACTED_EVENT_VALUE;
    position = blockEnd;
    begin = blockEnd - 1;
  }
  return position === 0 ? text : output + text.slice(position);
}

/** PEM blocks and URL userinfo in one string, in time linear in its length. */
export function redactSecretShapedText(text: string): string {
  return redactPemBlocks(text).replace(URL_USERINFO, `$1${REDACTED_EVENT_VALUE}@`);
}

/**
 * The write path redacts adapter `env` by key name (`redactEnvForLogs`) and
 * some writers skip it, so exports apply the same key rule to every `env`
 * object again, plus secret-shaped values in every string: PEM blocks and URL
 * userinfo.
 */
function archiveValuePass(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") return redactSecretShapedText(value);
  if (Array.isArray(value)) return value.map((entry) => archiveValuePass(entry));
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  if (parentKey !== undefined && ENV_OBJECT_KEY.test(parentKey)) {
    const strings = Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const redacted = { ...record, ...redactEnvForLogs(strings) };
    return Object.fromEntries(Object.entries(redacted).map(([key, entry]) => [key, archiveValuePass(entry, key)]));
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, archiveValuePass(entry, key)]));
}

function exportPass(value: object): Record<string, unknown> {
  return archiveValuePass(patternPass(value)) as Record<string, unknown>;
}

/**
 * @param db database handle
 * @param deps optional shared registry and settings reader (routes pass theirs)
 * @returns a factory that prepares one run's redactor
 */
export function createRunReadRedaction(db: Db, deps: RunReadRedactionDeps = {}) {
  const registry = deps.registry ?? createRunSecretRedactionRegistry(db);
  const currentUserOptions = deps.currentUserOptions ?? (async () => ({
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  }));

  return {
    /**
     * Resolves the run's registered secret values and the instance's
     * current-user setting once; the returned functions are synchronous.
     */
    async forRun(companyId: string, runId: string): Promise<RunReadRedactor> {
      const [redactSecrets, userOptions] = await Promise.all([
        registry.prepareForRun(companyId, runId),
        currentUserOptions(),
      ]);
      const run = <T>(value: T): T => redactSecrets(redactCurrentUserValue(value, userOptions));
      const event = <T extends { payload?: Record<string, unknown> | null }>(value: T): T =>
        redactSecrets(redactCurrentUserValue({ ...value, payload: redactEventPayload(value.payload ?? null) }, userOptions));
      return {
        run,
        event,
        logContent: (value) => redactSecrets(value),
        exportRun: (value) => exportPass(run(value)),
        exportEvent: (value) => {
          // The payload already went through redactEventPayload, which keeps
          // native span names a second generic pass would mask; the env and
          // value pass leaves those names alone.
          const { payload, ...rest } = event(value);
          return { ...exportPass(rest), payload: payload ? archiveValuePass(payload) as Record<string, unknown> : null };
        },
        exportValue: (value) => exportPass(run(value)),
      };
    },
  };
}

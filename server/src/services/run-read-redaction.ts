import type { Db } from "@paperclipai/db";
import { redactCurrentUserValue, type CurrentUserRedactionOptions } from "../log-redaction.js";
import { redactEventPayload, sanitizeRecord } from "../redaction.js";
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
        exportRun: (value) => patternPass(run(value)),
        exportEvent: (value) => {
          // The payload already went through redactEventPayload, which keeps
          // native span names a second generic pass would mask.
          const { payload, ...rest } = event(value);
          return { ...patternPass(rest), payload: payload ?? null };
        },
        exportValue: (value) => patternPass(run(value)),
      };
    },
  };
}

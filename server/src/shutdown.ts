type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

type ShutdownLogger = {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export async function drainRunExecutionFinalizersForShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  drain: (() => Promise<void>) | null;
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"drained" | "timed_out" | "unavailable"> {
  if (!input.drain) return "unavailable";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      input.drain().then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === "timed_out") {
      input.log.info(
        { signal: input.signal, timeoutMs },
        "bounded heartbeat execution finalizer drain timed out",
      );
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ShutdownHttpListener = {
  listening: boolean;
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

/**
 * Stops the HTTP listener from accepting new requests and waits, for at most
 * `timeoutMs`, for the open connections to finish. Idle keep-alive sockets
 * close at once; whatever is still open when the grace period ends is closed
 * forcibly, so the teardown never hangs on a long-lived client. Call this
 * before the database pool ends, so no request can reach a route after
 * `sql.end()` and fail with a connection-ended error.
 */
export async function closeHttpListenerForShutdown(input: {
  server: ShutdownHttpListener;
  signal: "SIGINT" | "SIGTERM";
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"closed" | "timed_out" | "not_listening"> {
  if (!input.server.listening) return "not_listening";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      new Promise<"closed">((resolve) => {
        input.server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            input.log.error({ err, signal: input.signal }, "HTTP listener close failed");
          }
          resolve("closed");
        });
        input.server.closeIdleConnections?.();
      }),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => {
          input.log.info(
            { signal: input.signal, timeoutMs },
            "HTTP listener drain timed out; closing the remaining connections",
          );
          input.server.closeAllConnections?.();
          resolve("timed_out");
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the final, ordered teardown of the server. It awaits the application
 * service cleanup first, so a live setup-token login session stops and releases
 * its sandbox lease before the database and the provider stop. The caller runs
 * `process.exit(0)` only after this helper resolves, so an orderly shutdown
 * never leaves a sandbox lease or confidential login state alive past the
 * process exit.
 *
 * A step that rejects does not stop the teardown. The helper logs the error and
 * continues to the next step. A failed setup-token lease release stays a
 * durable record for the startup reaper; the helper surfaces it in the log
 * instead of blocking the exit path.
 */
export async function finalizeServerShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  shutdownAppServices: (() => Promise<void>) | undefined;
  /**
   * Stops the HTTP listener and drains its connections (see
   * `closeHttpListenerForShutdown`). Runs first, while every application
   * service is still available to the requests being drained, so no request
   * runs against a half-dismantled service or an ended pool.
   */
  closeHttpListener?: (() => Promise<unknown>) | null;
  /**
   * Waits for every run-failure Sentry report still in flight. Runs after the
   * application services and before the database pool ends, so a report that
   * started just before shutdown still gets its database read and reaches
   * Sentry before `shutdownSentry` flushes and closes the client.
   */
  drainPendingRunFailureReports?: (() => Promise<void>) | null;
  /**
   * Ends the server's PostgreSQL client pools. Runs after the application
   * services (which still need the database) and before the embedded
   * provider stops, so the backends close in order and none outlive the
   * process.
   */
  closeDatabase?: (() => Promise<void>) | null;
  stopEmbeddedPostgres: (() => Promise<void>) | null;
  shutdownInstrumentation: () => Promise<void>;
  shutdownSentry: () => Promise<void>;
  log: ShutdownLogger;
}): Promise<void> {
  const { signal } = input;

  // Stop accepting requests and drain the open ones before any service goes
  // away, so a request that is still in flight sees a fully working server.
  if (input.closeHttpListener) {
    try {
      await input.closeHttpListener();
    } catch (err) {
      input.log.error({ err, signal }, "HTTP listener shutdown failed");
    }
  }

  // Await the application service cleanup, so a live setup-token login session
  // releases its sandbox lease before the database and the provider stop. A
  // rejected cleanup stays durable for the reaper; it does not block the exit.
  try {
    await input.shutdownAppServices?.();
  } catch (err) {
    input.log.error({ err, signal }, "Application service shutdown failed");
  }

  // Wait for every in-flight run-failure Sentry report before the database
  // pool ends. `reportRunFailure` is fire-and-forget: without this wait, a
  // report that started just before shutdown can lose its database read to
  // the pool end below, or lose its Sentry call to the flush further down.
  if (input.drainPendingRunFailureReports) {
    try {
      await input.drainPendingRunFailureReports();
    } catch (err) {
      input.log.error({ err, signal }, "run-failure report drain failed");
    }
  }

  // End the client pools once nothing needs them any more. Without this the
  // process exit leaves the pooled backends to PostgreSQL's own TCP keepalive
  // reaping, and a restart loop can pile up enough of them to hit
  // `max_connections` before the next boot gets a connection.
  if (input.closeDatabase) {
    try {
      await input.closeDatabase();
    } catch (err) {
      input.log.error({ err, signal }, "Database client shutdown failed");
    }
  }

  if (input.stopEmbeddedPostgres) {
    input.log.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await input.stopEmbeddedPostgres();
    } catch (err) {
      input.log.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
  }

  // Flush buffered OTel spans before the process goes away; without this await
  // the exporter's final batch is dropped on exit.
  await input.shutdownInstrumentation();

  // Flush buffered Sentry events before the process goes away; without this
  // await the last events are dropped on exit.
  await input.shutdownSentry();
}

/** The stop timeout the deploy path uses today (`docker stop --time 60`). */
const DEFAULT_STOP_TIMEOUT_MS = 60_000;
/** Time kept free under the stop timeout for the exit itself and the runtime. */
const STOP_TIMEOUT_HEADROOM_MS = 10_000;

/**
 * The whole shutdown must end before the container runtime kills the process.
 * The deploy sets `PAPERCLIP_STOP_TIMEOUT_MS` to the stop timeout it uses; the
 * budget keeps 10 seconds of headroom under it, or half of a timeout too short
 * for that headroom.
 */
export function resolveShutdownBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.PAPERCLIP_STOP_TIMEOUT_MS);
  const stopTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STOP_TIMEOUT_MS;
  return stopTimeoutMs >= 2 * STOP_TIMEOUT_HEADROOM_MS
    ? stopTimeoutMs - STOP_TIMEOUT_HEADROOM_MS
    : Math.floor(stopTimeoutMs / 2);
}

type ShutdownStepOutcome = "done" | "timed_out" | "failed";

/**
 * The ordered shutdown steps. Each is awaited for at most its share of the
 * budget; a step that outlives its share keeps running in the background while
 * the shutdown moves on, because a clean exit beats a SIGKILL.
 */
export type BoundedShutdownSteps = {
  /** Stops accepting connections and drains the open ones. Starts first. */
  closeHttpListener: () => Promise<unknown>;
  coordinateScheduler: () => Promise<unknown>;
  flushTelemetry: () => Promise<unknown>;
  /** Ends the running runs; each run's grace must end by `deadlineAt` (epoch ms). */
  drainRuns: (deadlineAt: number) => Promise<unknown>;
  drainFinalizers: (timeoutMs: number) => Promise<unknown>;
  flushRunLogMirrors: () => Promise<unknown>;
  /** Application services, database, embedded PostgreSQL, telemetry and Sentry. */
  finalize: () => Promise<unknown>;
};

const SCHEDULER_QUIESCE_MAX_MS = 10_000;
const TELEMETRY_FLUSH_MAX_MS = 3_000;
const FINALIZER_DRAIN_MAX_MS = 5_000;
const RUN_LOG_FLUSH_MAX_MS = 5_000;

/**
 * Runs the shutdown inside one budget, so the process exits 0 before the stop
 * timeout instead of being killed. The listener stops accepting connections
 * first, so no new request is cut by the exit; the run drain gets a deadline
 * that leaves time for the teardown; every step logs its start and its end with
 * a duration and an outcome; and a hard deadline exits even if a step hangs.
 * Pass `exit: null` to keep the process alive (the caller exits later).
 */
export async function runBoundedShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  budgetMs: number;
  steps: BoundedShutdownSteps;
  log: ShutdownLogger;
  exit: ((code: number) => void) | null;
}): Promise<void> {
  const { signal, budgetMs, steps, log } = input;
  const startedAt = Date.now();
  const deadlineAt = startedAt + budgetMs;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  let currentStep = "start";
  let exited = false;
  const exit = (reason: string) => {
    if (exited || !input.exit) return;
    exited = true;
    log.info({ signal, reason, elapsedMs: Date.now() - startedAt }, "shutdown exiting");
    input.exit(0);
  };

  log.info({ signal, budgetMs }, "shutdown started");
  let hardDeadline: NodeJS.Timeout | null = null;
  if (input.exit) {
    hardDeadline = setTimeout(() => {
      log.error({ signal, step: currentStep, budgetMs }, "shutdown hard deadline reached; exiting");
      exit("hard_deadline");
    }, budgetMs);
    hardDeadline.unref?.();
  }

  const runStep = async (step: string, maxMs: number, work: () => Promise<unknown>) => {
    currentStep = step;
    const stepStartedAt = Date.now();
    const limitMs = Math.max(0, Math.min(maxMs, remainingMs()));
    log.info({ signal, step, limitMs }, "shutdown step started");
    let timer: NodeJS.Timeout | null = null;
    let outcome: ShutdownStepOutcome;
    let err: unknown = null;
    try {
      outcome = await Promise.race([
        work().then(() => "done" as const),
        new Promise<"timed_out">((resolve) => {
          timer = setTimeout(() => resolve("timed_out"), limitMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      outcome = "failed";
      err = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const fields = { signal, step, outcome, durationMs: Date.now() - stepStartedAt, ...(err ? { err } : {}) };
    if (outcome === "done") log.info(fields, "shutdown step finished");
    else log.error(fields, "shutdown step finished");
  };

  // Start closing the listener at once: from here, no new connection is
  // accepted, and the requests in flight finish while the runs drain.
  const listenerClosed = steps.closeHttpListener().catch((error) => {
    log.error({ err: error, signal }, "HTTP listener shutdown failed");
  });

  await runStep("scheduler_quiesce", SCHEDULER_QUIESCE_MAX_MS, steps.coordinateScheduler);
  await runStep("telemetry_flush", TELEMETRY_FLUSH_MAX_MS, steps.flushTelemetry);
  // The drain ends with 30 % of the budget (at most 15 seconds) left for the
  // finalizers, the listener and the teardown.
  const drainDeadlineAt = deadlineAt - Math.min(15_000, Math.floor(budgetMs * 0.3));
  await runStep("run_drain", Math.max(0, drainDeadlineAt - Date.now()), () => steps.drainRuns(drainDeadlineAt));
  await runStep("finalizer_drain", FINALIZER_DRAIN_MAX_MS, () =>
    steps.drainFinalizers(Math.min(FINALIZER_DRAIN_MAX_MS, remainingMs())));
  await runStep("run_log_flush", RUN_LOG_FLUSH_MAX_MS, steps.flushRunLogMirrors);
  await runStep("http_listener_close", Number.POSITIVE_INFINITY, () => listenerClosed);
  await runStep("teardown", Number.POSITIVE_INFINITY, steps.finalize);

  if (hardDeadline) clearTimeout(hardDeadline);
  exit("complete");
}

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight before querying running
  // rows for the shutdown snapshot, otherwise a late queue claim can create a
  // run that is absent from both the snapshot and the selective drain set.
  await input.waitForHeartbeatSchedulerIdle();

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}

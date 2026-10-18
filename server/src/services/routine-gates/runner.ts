import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { ROUTINE_GATE_LIMITS, resolveCompanyEnvironmentDefault, type RoutineGate, type RoutineGateResult } from "@paperclipai/shared";
import { environmentService } from "../environments.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../environment-config.js";
import { resolveExecutionWorkspaceEnvironmentId } from "../execution-workspace-policy.js";
import { instanceSettingsService } from "../instance-settings.js";
import {
  ROUTINE_GATE_SSH_USERNAME,
  buildGateEnv,
  buildGateRemoteCommand,
  classifyGateExecution,
  gateLocalTimeoutMs,
  gateResultFingerprint,
  sampleGateText,
  type GateEnvContext,
} from "./command.js";
import { GateSourceError, type GateScriptSource } from "./source.js";

type SshRunner = typeof runSshCommand;

export interface GateRunRequest {
  companyId: string;
  routine: { id: string; assigneeAgentId: string | null };
  gate: RoutineGate;
  context: GateEnvContext;
}

export interface GateRunOutcome {
  /** What gets stored on the run; the samples are redacted and cut. */
  result: RoutineGateResult;
  /** Full stdout (at most the buffer limit). Only meaningful for class `ok`. */
  stdout: string;
  /** False for a config refusal that a retry cannot fix (allowlist, unsupported driver). */
  retryable: boolean;
}

/** A gate environment that cannot host gates; the reason is shown to the board. */
export class GateEnvironmentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "GateEnvironmentError";
  }
}

const GATE_USER_REJECTED = /permission denied|no such user|not allowed|authentication failed|too many authentication/i;

export interface GateRunnerDeps {
  db: Db;
  source: GateScriptSource;
  /** Injected in tests. */
  runSsh?: SshRunner;
}

/**
 * Runs a gate script on the routine's worker, with no heartbeat run and no lease:
 * the environment resolves as a real run would resolve it, the SSH key is read through the
 * environment's secret binding, and the connection logs in as the dedicated `gate` user.
 * There is no fallback to the configured SSH user, so a worker without the `gate` account
 * refuses gates (every gate there ends as a transport fault) rather than running them as `node`.
 */
export function createGateRunner(deps: GateRunnerDeps) {
  const { db } = deps;
  const runSsh = deps.runSsh ?? runSshCommand;
  const environments = environmentService(db);
  const instanceSettings = instanceSettingsService(db);

  /** The environment a real run of this routine's agent would use. */
  async function resolveEnvironmentId(companyId: string, assigneeAgentId: string | null): Promise<string> {
    const agent = assigneeAgentId
      ? await db
        .select({ defaultEnvironmentId: agents.defaultEnvironmentId })
        .from(agents)
        .where(eq(agents.id, assigneeAgentId))
        .then((rows) => rows[0] ?? null)
      : null;
    const local = (await environments.list({ driver: "local" }))[0] ?? null;
    const managedSandboxOnly = (await instanceSettings.getExperimental()).enableManagedSandboxOnly === true;
    const managed = managedSandboxOnly ? await environments.findManagedSandboxEnvironment(companyId) : null;
    const resolved = resolveExecutionWorkspaceEnvironmentId({
      agentDefaultEnvironmentId: agent?.defaultEnvironmentId ?? null,
      instanceDefaultEnvironmentId: resolveCompanyEnvironmentDefault(await instanceSettings.get(), companyId),
      localDefaultEnvironmentId: local?.id ?? "",
      managedSandboxOnly,
      managedSandboxEnvironmentId: managed?.id ?? null,
    });
    if (!resolved.environmentId) throw new GateEnvironmentError("No execution environment resolves for this routine", "gate_no_environment");
    return resolved.environmentId;
  }

  /** The SSH connection a gate would use (as the `gate` user), or a thrown `GateEnvironmentError`. */
  async function resolveConnection(companyId: string, assigneeAgentId: string | null) {
    const environmentId = await resolveEnvironmentId(companyId, assigneeAgentId);
    const bound = await environments.listBoundCompanyIds(environmentId);
    if (bound.length > 0 && !bound.includes(companyId)) {
      throw new GateEnvironmentError("The routine's environment is not available to this company", "gate_environment_unavailable");
    }
    const environment = await environments.getById(environmentId);
    if (!environment || environment.status !== "active") {
      throw new GateEnvironmentError("The routine's environment is archived or missing", "gate_environment_unavailable");
    }
    if (environment.driver !== "ssh") {
      throw new GateEnvironmentError(
        `Gate scripts run on SSH workers only; this routine's environment uses the ${environment.driver} driver`,
        "gate_unsupported_driver",
      );
    }
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, {
      id: environment.id,
      driver: environment.driver,
      config: environment.config,
    });
    if (parsed.driver !== "ssh") {
      throw new GateEnvironmentError("The routine's environment is not an SSH environment", "gate_unsupported_driver");
    }
    return { environmentId, config: { ...parsed.config, username: ROUTINE_GATE_SSH_USERNAME } };
  }

  function failure(
    cls: RoutineGateResult["class"],
    detail: string,
    extra: Partial<RoutineGateResult> = {},
    retryable = true,
  ): GateRunOutcome {
    return {
      result: {
        exitCode: null,
        class: cls,
        durationMs: 0,
        scriptSha: null,
        environmentId: null,
        resultFingerprint: null,
        stdoutSample: "",
        stderrTail: "",
        detail,
        ...extra,
      },
      stdout: "",
      retryable,
    };
  }

  async function run(request: GateRunRequest): Promise<GateRunOutcome> {
    const started = Date.now();
    let script;
    try {
      script = await deps.source.load(request.companyId, request.gate);
    } catch (error) {
      if (error instanceof GateSourceError) {
        return failure("transport", `${error.code}: ${error.message}`, { durationMs: Date.now() - started }, error.kind === "unavailable");
      }
      throw error;
    }

    let connection;
    try {
      connection = await resolveConnection(request.companyId, request.routine.assigneeAgentId);
    } catch (error) {
      if (error instanceof GateEnvironmentError) {
        return failure(
          "transport",
          `${error.code}: ${error.message}`,
          { durationMs: Date.now() - started, scriptSha: script.sha256 },
          error.code === "gate_environment_unavailable",
        );
      }
      throw error;
    }

    const remoteCommand = buildGateRemoteCommand({
      interpreter: request.gate.interpreter,
      args: request.gate.args,
      timeoutSec: request.gate.timeoutSec,
      env: buildGateEnv(request.context),
    });

    let outcome;
    try {
      const done = await runSsh(connection.config, remoteCommand, {
        stdin: script.content,
        timeoutMs: gateLocalTimeoutMs(request.gate),
        maxBuffer: ROUTINE_GATE_LIMITS.outputMaxBytes,
      });
      outcome = classifyGateExecution({ ok: true, stdout: done.stdout, stderr: done.stderr });
    } catch (error) {
      outcome = classifyGateExecution({ ok: false, error });
    }

    let detail = outcome.detail;
    if (outcome.class === "transport" && GATE_USER_REJECTED.test(outcome.stderr)) {
      detail = "the worker rejected the gate user (is the gate account installed on this worker?)";
    }
    const stdout = outcome.class === "ok" ? outcome.stdout : "";
    return {
      result: {
        exitCode: outcome.exitCode,
        class: outcome.class,
        durationMs: Date.now() - started,
        scriptSha: script.sha256,
        environmentId: connection.environmentId,
        resultFingerprint: outcome.class === "ok" ? gateResultFingerprint(stdout) : null,
        stdoutSample: sampleGateText(outcome.stdout, ROUTINE_GATE_LIMITS.stdoutSampleMaxBytes),
        stderrTail: sampleGateText(outcome.stderr, ROUTINE_GATE_LIMITS.stderrTailMaxBytes, true),
        detail,
      },
      stdout,
      retryable: true,
    };
  }

  return { run, resolveConnection, resolveEnvironmentId, source: deps.source };
}

export type GateRunner = ReturnType<typeof createGateRunner>;

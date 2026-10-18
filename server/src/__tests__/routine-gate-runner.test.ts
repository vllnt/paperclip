import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environments } from "@paperclipai/db";
import type { RoutineGate } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ROUTINE_GATE_SSH_USERNAME, gateResultFingerprint } from "../services/routine-gates/command.ts";
import { GateEnvironmentError, createGateRunner } from "../services/routine-gates/runner.ts";
import { GateSourceError, type GateScriptSource } from "../services/routine-gates/source.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine gate runner tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SCRIPT = "#!/bin/sh\necho 'new pull request'\nexit 0\n";
const SCRIPT_SHA = "e".repeat(64);

const GATE: RoutineGate = {
  repo: "vllnt/ops-gates",
  path: "gates/poll.sh",
  commitSha: "f".repeat(40),
  interpreter: "sh",
  args: ["--quiet"],
  timeoutSec: 20,
  appliesTo: ["schedule", "webhook", "event"],
};

const CONTEXT = {
  routineId: randomUUID(),
  triggerKind: "schedule",
  lastResultFingerprint: null,
  lastDispatchedAt: null,
  event: undefined,
};

function scriptSource(error?: GateSourceError): GateScriptSource {
  return {
    load: vi.fn(async () => {
      if (error) throw error;
      return { content: SCRIPT, sha256: SCRIPT_SHA };
    }),
  } as unknown as GateScriptSource;
}

/** What the SSH helper rejects with when the remote command exits non-zero. */
function sshExit(code: number | string | null, extra: { stderr?: string; stdout?: string; killed?: boolean; message?: string } = {}) {
  return Object.assign(new Error(extra.message ?? `ssh exited with ${String(code)}`), {
    code,
    stderr: extra.stderr ?? "",
    stdout: extra.stdout ?? "",
    killed: extra.killed ?? false,
  });
}

describeEmbeddedPostgres("routine gate scripts: runner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-gate-runner-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(driver: "ssh" | "local" = "ssh", configuredUsername = "node") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: driver === "ssh" ? "Worker" : "Local",
      driver,
      status: "active",
      config:
        driver === "ssh"
          ? {
            host: "worker.example.test",
            port: 22,
            username: configuredUsername,
            remoteWorkspacePath: "/srv/paperclip",
            strictHostKeyChecking: false,
          }
          : {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      defaultEnvironmentId: environmentId,
    });
    return { companyId, agentId, environmentId };
  }

  function request(scope: { companyId: string; agentId: string }, gate: RoutineGate = GATE) {
    return {
      companyId: scope.companyId,
      routine: { id: CONTEXT.routineId, assigneeAgentId: scope.agentId },
      gate,
      context: CONTEXT,
    };
  }

  it("logs in as the dedicated gate user, never the environment's configured user", async () => {
    const scope = await seed("ssh", "node");
    const runSsh = vi.fn(async () => ({ stdout: "new pull request\n", stderr: "" }));
    const runner = createGateRunner({ db, source: scriptSource(), runSsh: runSsh as never });

    const outcome = await runner.run(request(scope));

    expect(runSsh).toHaveBeenCalledTimes(1);
    const [config, remoteCommand, options] = runSsh.mock.calls[0] as unknown as [
      { host: string; username: string },
      string,
      { stdin: string; timeoutMs: number },
    ];
    expect(config).toMatchObject({ host: "worker.example.test", username: ROUTINE_GATE_SSH_USERNAME });
    expect(config.username).not.toBe("node");
    expect(options.stdin).toBe(SCRIPT);
    expect(options.timeoutMs).toBeGreaterThan(GATE.timeoutSec * 1000);
    expect(remoteCommand).toContain("timeout -k 5 20");
    expect(remoteCommand).toContain("env -i");
    expect(outcome.result).toMatchObject({
      class: "ok",
      exitCode: 0,
      scriptSha: SCRIPT_SHA,
      environmentId: scope.environmentId,
      resultFingerprint: gateResultFingerprint("new pull request\n"),
    });
    expect(outcome.stdout).toBe("new pull request\n");
  });

  it("refuses the local driver without running anything", async () => {
    const scope = await seed("local");
    const runSsh = vi.fn();
    const runner = createGateRunner({ db, source: scriptSource(), runSsh: runSsh as never });

    await expect(runner.resolveConnection(scope.companyId, scope.agentId)).rejects.toMatchObject({
      name: "GateEnvironmentError",
      code: "gate_unsupported_driver",
    });
    const outcome = await runner.run(request(scope));

    expect(runSsh).not.toHaveBeenCalled();
    expect(outcome.result.class).toBe("transport");
    expect(outcome.result.detail).toContain("gate_unsupported_driver");
    // A driver cannot change on a retry, so the worker does not keep trying.
    expect(outcome.retryable).toBe(false);
  });

  it("refuses an archived environment", async () => {
    const scope = await seed("ssh");
    await db.update(environments).set({ status: "archived" }).where(eq(environments.id, scope.environmentId));
    const runner = createGateRunner({ db, source: scriptSource(), runSsh: vi.fn() as never });

    const error = await runner.resolveConnection(scope.companyId, scope.agentId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GateEnvironmentError);
    expect((error as GateEnvironmentError).code).toBe("gate_environment_unavailable");
  });

  it("reports a worker without the gate account as a transport fault naming the gate user", async () => {
    const scope = await seed("ssh");
    const runSsh = vi.fn(async () => {
      throw sshExit(255, { stderr: "gate@worker.example.test: Permission denied (publickey).", message: "ssh failed" });
    });
    const runner = createGateRunner({ db, source: scriptSource(), runSsh: runSsh as never });

    const outcome = await runner.run(request(scope));

    expect(runSsh).toHaveBeenCalledTimes(1);
    expect(outcome.result.class).toBe("transport");
    expect(outcome.result.detail).toBe("the worker rejected the gate user (is the gate account installed on this worker?)");
    expect(outcome.stdout).toBe("");
    expect(outcome.result.resultFingerprint).toBeNull();
    // It is still retryable: the account may be installed while the retries run.
    expect(outcome.retryable).toBe(true);
  });

  it("classifies every exit the script or the connection can produce", async () => {
    const scope = await seed("ssh");
    const cases: Array<{ error: unknown; expected: string; exitCode: number | null }> = [
      { error: sshExit(1, { stdout: "ignored" }), expected: "skip", exitCode: 1 },
      { error: sshExit(2, { stderr: "boom" }), expected: "script_fault", exitCode: 2 },
      { error: sshExit(124), expected: "timeout", exitCode: 124 },
      { error: sshExit(null, { killed: true }), expected: "timeout", exitCode: null },
      { error: sshExit(255), expected: "transport", exitCode: 255 },
      { error: sshExit(252), expected: "transport", exitCode: 252 },
    ];
    for (const { error, expected, exitCode } of cases) {
      const runner = createGateRunner({
        db,
        source: scriptSource(),
        runSsh: (async () => {
          throw error;
        }) as never,
      });
      const outcome = await runner.run(request(scope));
      expect(outcome.result.class, `${expected} for exit ${String(exitCode)}`).toBe(expected);
      expect(outcome.result.exitCode).toBe(exitCode);
      // Only a clean exit 0 carries stdout; every other class hands none to the agent.
      expect(outcome.stdout).toBe("");
      expect(outcome.result.resultFingerprint).toBeNull();
    }
  });

  it("returns a refused script as a non-retryable transport fault and never opens a connection", async () => {
    const scope = await seed("ssh");
    const runSsh = vi.fn();
    const runner = createGateRunner({
      db,
      source: scriptSource(new GateSourceError("Commit is not reachable from the default branch", "refused", "gate_commit_not_on_default_branch")),
      runSsh: runSsh as never,
    });

    const outcome = await runner.run(request(scope));

    expect(runSsh).not.toHaveBeenCalled();
    expect(outcome.result.class).toBe("transport");
    expect(outcome.result.detail).toContain("gate_commit_not_on_default_branch");
    expect(outcome.retryable).toBe(false);
  });

  it("keeps a source outage retryable", async () => {
    const scope = await seed("ssh");
    const runner = createGateRunner({
      db,
      source: scriptSource(new GateSourceError("GitHub is unavailable", "unavailable", "gate_source_unavailable")),
      runSsh: vi.fn() as never,
    });

    const outcome = await runner.run(request(scope));

    expect(outcome.result.class).toBe("transport");
    expect(outcome.retryable).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environments, projects, projectWorkspaces } from "@paperclipai/db";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "@paperclipai/adapter-utils/ssh";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.ts";

// What the agent process would see, recorded while the run executes. The SSH
// fixture's host is this machine, so its paths are readable here.
type Seen = { tmpdir: unknown; tmp: unknown; temp: unknown; dirExisted: boolean };
const state = vi.hoisted(() => ({ runs: [] as Seen[], exitCode: 0, release: null as null | Promise<void> }));

const adapterExecute = vi.hoisted(() => vi.fn(async (ctx: { config: { env?: Record<string, unknown> } }) => {
  const env = ctx.config.env ?? {};
  const tmpdir = env.TMPDIR;
  state.runs.push({
    tmpdir,
    tmp: env.TMP,
    temp: env.TEMP,
    dirExisted: typeof tmpdir === "string" && (await import("node:fs")).existsSync(tmpdir),
  });
  if (state.release) await state.release;
  return { exitCode: state.exitCode, signal: null, timedOut: false, provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const sshFixtureSupport = await getSshEnvLabSupport();
const describeRemoteTemp = embeddedPostgresSupport.supported && sshFixtureSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported || !sshFixtureSupport.supported) {
  console.warn(`Skipping remote run temp heartbeat tests: ${embeddedPostgresSupport.reason ?? sshFixtureSupport.reason ?? "unsupported environment"}`);
}

describeRemoteTemp("remote run temp directory through the heartbeat (SSH)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureRoot = "";
  let fixture: SshEnvLabFixtureState | null = null;
  let sshConfig!: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>;
  const workspaceRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-remote-run-temp-");
    db = createDb(tempDb.connectionString);
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-run-temp-"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    sshConfig = await buildSshEnvLabFixtureConfig(fixture);
  }, 240_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    state.runs.length = 0;
    state.exitCode = 0;
    state.release = null;
    for (const root of workspaceRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture);
    await rm(fixtureRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  // An agent whose default environment is the SSH fixture.
  async function setup(adapterConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    const agentId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-run-temp-workspace-"));
    workspaceRoots.push(workspaceRoot);
    await db.insert(companies).values({
      id: companyId, name: "Acme", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active", defaultResponsibleUserId: "responsible-user", createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Remote Temp", status: "active", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(projectWorkspaces).values({
      id: randomUUID(), companyId, projectId, name: "Primary", cwd: workspaceRoot, isPrimary: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const secret = await secretService(db).create(companyId, {
      name: `remote-temp-key-${randomUUID()}`, provider: "local_encrypted", value: String(sshConfig.privateKey),
    });
    await secretService(db).createBinding({
      companyId, secretId: secret.id, targetType: "environment", targetId: environmentId, configPath: "privateKeySecretRef",
    });
    await db.insert(environments).values({
      id: environmentId, companyId, name: `Fixture SSH ${environmentId}`, driver: "ssh", status: "active",
      config: { ...sshConfig, privateKey: null, privateKeySecretRef: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig, runtimeConfig: {}, defaultEnvironmentId: environmentId, permissions: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);
    const start = async () => {
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { projectId } });
      if (!run) throw new Error("no run");
      return run.id;
    };
    const waitForStatus = async (runId: string, status: string) => {
      await vi.waitFor(async () => {
        expect((await heartbeat.getRun(runId))?.status).toBe(status);
      }, { timeout: 60_000, interval: 200 });
    };
    return { heartbeat, start, waitForStatus };
  }

  function expectRunTemp(seen: Seen | undefined, runId: string): string {
    expect(typeof seen?.tmpdir).toBe("string");
    const dir = String(seen?.tmpdir);
    expect(dir.endsWith(`/.paperclip-runtime/runs/${runId}/tmp`)).toBe(true);
    expect(seen).toEqual({ tmpdir: dir, tmp: dir, temp: dir, dirExisted: true });
    return dir;
  }

  it.each([
    ["succeeded", 0],
    ["failed", 1],
  ] as const)("points the agent's TMPDIR at its own directory beside the run workspace and removes it when the run %s", async (status, exitCode) => {
    const { start, waitForStatus } = await setup();
    state.exitCode = exitCode;

    const runId = await start();
    await waitForStatus(runId, status);

    const dir = expectRunTemp(state.runs[0], runId);
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false), { timeout: 15_000 });
    // Nothing else was written to the run directory, so it goes too.
    expect(existsSync(path.dirname(dir))).toBe(false);
  }, 120_000);

  it("removes the directory when the run is cancelled", async () => {
    const { heartbeat, start, waitForStatus } = await setup();
    let release: () => void = () => undefined;
    state.release = new Promise<void>((resolve) => { release = resolve; });

    const runId = await start();
    await vi.waitFor(() => expect(state.runs).toHaveLength(1), { timeout: 60_000 });
    const dir = expectRunTemp(state.runs[0], runId);

    await heartbeat.cancelRun(runId, "test cancel");
    release();
    await waitForStatus(runId, "cancelled");
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false), { timeout: 15_000 });
  }, 120_000);

  it("keeps an operator TMPDIR and creates no directory for the run", async () => {
    const { start, waitForStatus } = await setup({ env: { TMPDIR: "/operator/tmp" } });

    const runId = await start();
    await waitForStatus(runId, "succeeded");

    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.tmpdir).toBe("/operator/tmp");
    expect(state.runs[0]?.tmp).toBeUndefined();
    expect(existsSync(path.join(sshConfig.remoteWorkspacePath, ".paperclip-runtime", "runs", runId))).toBe(false);
  }, 120_000);
});

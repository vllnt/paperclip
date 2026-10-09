import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { classifyPaperclipTempRuns, createPaperclipTempSweep } from "../services/paperclip-temp-sweeper.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping paperclip temp sweeper database tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const GRACE_MS = 15 * MINUTE_MS;

describeDb("paperclip temp sweeper with the database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let environmentId = "";
  let tmpDir = "";
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-temp-sweeper-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId, companyId, name: "Worker", driver: "ssh", status: "active", config: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
  }, 240_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.pid) {
        const exited = once(child, "exit");
        process.kill(-child.pid, "SIGKILL");
        await exited;
      }
    }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  async function seedRun(status: string, finishedAgoMs: number | null): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId, invocationSource: "manual", status,
      finishedAt: finishedAgoMs === null ? null : new Date(Date.now() - finishedAgoMs),
    });
    return id;
  }

  async function seedLease(runId: string, status: string): Promise<void> {
    await db.insert(environmentLeases).values({
      companyId, environmentId, heartbeatRunId: runId, status, leasePolicy: "ephemeral",
      provider: "ssh", providerLeaseId: `ssh://worker/${randomUUID()}`, metadata: {},
    });
  }

  it("proves a run dead only when it is terminal, past the grace period, without a busy lease, and not executing", async () => {
    const running = await seedRun("running", null);
    const dead = await seedRun("succeeded", HOUR_MS);
    const recent = await seedRun("failed", MINUTE_MS);
    const leased = await seedRun("cancelled", HOUR_MS);
    await seedLease(leased, "active");
    const releasedLease = await seedRun("timed_out", HOUR_MS);
    await seedLease(releasedLease, "released");
    const executing = await seedRun("succeeded", HOUR_MS);
    const missing = randomUUID();

    const verdicts = await classifyPaperclipTempRuns(db, [running, dead, recent, leased, releasedLease, executing, missing], {
      runGraceMs: GRACE_MS,
      now: Date.now(),
      isRunExecuting: (runId) => runId === executing,
    });

    expect(Object.fromEntries(verdicts)).toEqual({
      [running]: "run_live",
      [dead]: "dead",
      [recent]: "run_recent",
      [leased]: "lease_busy",
      [releasedLease]: "dead",
      [executing]: "run_live",
    });
  });

  it("keeps a live run's old directory with an open file and removes only a dead run's", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-temp-sweeper-db-"));
    const live = await seedRun("running", null);
    const dead = await seedRun("failed", HOUR_MS);
    const entry = async (name: string) => {
      const dir = path.join(tmpDir, name);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "file"), "12345");
      return dir;
    };
    const liveEntry = await entry(`paperclip-ssh-sync-back-${live}-Live01`);
    const deadEntry = await entry(`paperclip-ssh-sync-back-${dead}-Dead01`);
    const missingEntry = await entry(`paperclip-ssh-key-${randomUUID()}-Miss01`);
    const legacyEntry = await entry("paperclip-ssh-sync-back-Leg001");
    const holder = spawn(process.execPath, ["-e", `
      const fd = require("node:fs").openSync(${JSON.stringify(path.join(liveEntry, "file"))}, "r+");
      process.stdout.write("open\\n");
      setInterval(() => require("node:fs").fstatSync(fd), 1000);
    `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(holder);
    await once(holder.stdout ?? holder, "data");

    // Three hours later every entry is old enough by its change time alone.
    const sweep = createPaperclipTempSweep(db, {
      runGraceMs: GRACE_MS,
      isRunExecuting: () => false,
      tmpDir,
      now: () => Date.now() + 3 * HOUR_MS,
    });
    const record = await sweep("startup");

    expect(record).toMatchObject({
      event: "paperclip_tmp_sweep",
      trigger: "startup",
      removed: 1,
      kept: { run_live: 1, run_missing: 1, unattributed: 1 },
    });
    expect(existsSync(path.join(liveEntry, "file"))).toBe(true);
    expect(holder.exitCode).toBeNull();
    expect(existsSync(deadEntry)).toBe(false);
    expect(existsSync(missingEntry)).toBe(true);
    expect(existsSync(legacyEntry)).toBe(true);
  });

  it("skips the pass while another process holds the sweep lock", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-temp-sweeper-db-"));
    const dead = await seedRun("succeeded", HOUR_MS);
    const deadEntry = path.join(tmpDir, `paperclip-ssh-bundle-${dead}-Lock01`);
    await fs.mkdir(deadEntry);
    const sweep = createPaperclipTempSweep(db, {
      runGraceMs: GRACE_MS,
      isRunExecuting: () => false,
      tmpDir,
      now: () => Date.now() + 3 * HOUR_MS,
    });

    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('paperclip:tmp-sweep'))`);
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await lockTaken;

    expect(await sweep("interval")).toBeNull();
    expect(existsSync(deadEntry)).toBe(true);

    release();
    await holder;
    expect(await sweep("interval")).toMatchObject({ removed: 1 });
    expect(existsSync(deadEntry)).toBe(false);
  });
});

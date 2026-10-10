import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

// A worker without /proc (macOS, for example): the remote stop cannot verify
// any process and signals nothing. The real stop script reports that as
// `no_proc`; it is stubbed here because a Linux test host cannot take /proc away.
const { noProcStop, stopSshRunProcesses } = vi.hoisted(() => {
  const noProcStop = async () => ({ records: 1, matched: 0, killed: 0, skipped: 0, survived: 0, partial: "no_proc" as string | null });
  return { noProcStop, stopSshRunProcesses: vi.fn(noProcStop) };
});
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  stopSshRunProcesses,
}));

import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SSH remote process stop event tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SSH remote process stop events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-remote-stop-events-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    stopSshRunProcesses.mockReset();
    stopSshRunProcesses.mockImplementation(noProcStop);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A lost SSH run: its process id is gone, nothing holds it in memory, and its lease is active. */
  async function seedLostSshRun(leaseMetadata: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix: `N${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "paused", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const target = { host: "127.0.0.1", port: 22, username: "worker", remoteWorkspacePath: "/srv/paperclip" };
    await db.insert(environments).values({
      id: environmentId, companyId, name: "Mac worker", driver: "ssh", status: "active", config: target,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", processPid: 99999999,
      processLossRetryCount: 9, nextEventSeq: 1, startedAt: new Date(), updatedAt: new Date(Date.now() - 60_000),
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId, environmentId, heartbeatRunId: runId, status: "active", leasePolicy: "ephemeral", provider: "ssh",
      providerLeaseId: `ssh://worker@127.0.0.1:22/srv/paperclip`, metadata: { driver: "ssh", ...target, ...leaseMetadata },
    }).returning();
    return { runId, environmentId, target, lease: lease! };
  }

  async function leaseRow(leaseId: string) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;
  }

  it("leaves a run event naming the run and the reason when a worker without /proc cannot be stopped", async () => {
    const { runId, environmentId, target, lease } = await seedLostSshRun();

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(stopSshRunProcesses).toHaveBeenCalledWith(expect.objectContaining(target), runId);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const partial = events.filter((event) => event.eventType === "remote_kill_partial");
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ runId, level: "warn", payload: { reason: "no_proc", environmentId } });
    expect(partial[0]!.message).toContain("no_proc");
    const released = await leaseRow(lease.id);
    expect(released!.status).not.toBe("active");
    expect(released!.metadata?.remoteProcessStop).toMatchObject({ outcome: "partial", partial: "no_proc" });
  }, 60_000);

  it("stops a lease once when two release paths race, and keeps the winner's outcome", async () => {
    const { runId, lease } = await seedLostSshRun();
    const winner = { records: 1, matched: 2, killed: 0, skipped: 0, survived: 0, partial: null };
    // The first stop takes a while; a second one would find the records gone.
    stopSshRunProcesses.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return winner;
    });
    stopSshRunProcesses.mockImplementationOnce(async () => ({ ...winner, records: 0, matched: 0, partial: "no_process_record" }));
    const runtime = environmentRuntimeService(db);

    const results = await Promise.all([runtime.stopRunProcesses(runId), runtime.stopRunProcesses(runId)]);

    expect(stopSshRunProcesses).toHaveBeenCalledTimes(1);
    expect(results.flat()).toMatchObject([{ outcome: "stopped", matched: 2 }]);
    expect((await leaseRow(lease.id)).metadata?.remoteProcessStop).toMatchObject({ outcome: "stopped", matched: 2, partial: null });
  }, 60_000);

  it("takes over a stop claim that is older than twice the stop budget", async () => {
    const { runId, lease } = await seedLostSshRun({
      remoteProcessStop: { state: "stopping", claim: randomUUID(), claimedAt: Date.now() - 60_000 },
    });

    const results = await environmentRuntimeService(db).stopRunProcesses(runId);

    expect(stopSshRunProcesses).toHaveBeenCalledTimes(1);
    expect(results).toMatchObject([{ outcome: "partial", partial: "no_proc" }]);
    expect((await leaseRow(lease.id)).metadata?.remoteProcessStop).toMatchObject({ outcome: "partial", partial: "no_proc" });
  }, 60_000);
});

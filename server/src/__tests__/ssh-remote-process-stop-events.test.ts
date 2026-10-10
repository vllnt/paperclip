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
const stopSshRunProcesses = vi.hoisted(() =>
  vi.fn(async () => ({ records: 1, matched: 0, killed: 0, skipped: 0, survived: 0, partial: "no_proc" })),
);
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  stopSshRunProcesses,
}));

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
    stopSshRunProcesses.mockClear();
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

  it("leaves a run event naming the run and the reason when a worker without /proc cannot be stopped", async () => {
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
    // A lost run: its process id is gone and nothing holds it in memory.
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", processPid: 99999999,
      processLossRetryCount: 9, nextEventSeq: 1, startedAt: new Date(), updatedAt: new Date(Date.now() - 60_000),
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId, environmentId, heartbeatRunId: runId, status: "active", leasePolicy: "ephemeral", provider: "ssh",
      providerLeaseId: `ssh://worker@127.0.0.1:22/srv/paperclip`, metadata: { driver: "ssh", ...target },
    }).returning();

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(stopSshRunProcesses).toHaveBeenCalledWith(expect.objectContaining(target), runId);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const partial = events.filter((event) => event.eventType === "remote_kill_partial");
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ runId, level: "warn", payload: { reason: "no_proc", environmentId } });
    expect(partial[0]!.message).toContain("no_proc");
    const [released] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id));
    expect(released!.status).not.toBe("active");
    expect(released!.metadata?.remoteProcessStop).toMatchObject({ outcome: "partial", partial: "no_proc" });
  }, 60_000);
});

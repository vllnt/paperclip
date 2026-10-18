import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, createDb, eventDeliveries, routineRuns } from "@paperclipai/db";
import type { EventRoutineOutcome, RoutineGate, RoutineGateResult } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture, wireEvent, type WakeupRecord } from "./helpers/event-source-fixture.js";
import { gateResultFingerprint } from "../services/routine-gates/command.ts";
import type { GateRunOutcome, GateRunRequest, GateRunner } from "../services/routine-gates/runner.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine gate event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const GATE: RoutineGate = {
  repo: "vllnt/ops-gates",
  path: "gates/event.sh",
  commitSha: "c".repeat(40),
  interpreter: "sh",
  args: [],
  timeoutSec: 30,
  appliesTo: ["event"],
};

function gateOutcome(cls: RoutineGateResult["class"], stdout = ""): GateRunOutcome {
  const body = cls === "ok" ? stdout : "";
  return {
    result: {
      exitCode: cls === "ok" ? 0 : cls === "skip" ? 1 : cls === "script_fault" ? 2 : null,
      class: cls,
      durationMs: 5,
      scriptSha: "d".repeat(64),
      environmentId: "env-1",
      resultFingerprint: cls === "ok" ? gateResultFingerprint(body) : null,
      stdoutSample: body,
      stderrTail: "",
      detail: null,
    },
    stdout: body,
    retryable: true,
  };
}

function createFakeGate() {
  const calls: GateRunRequest[] = [];
  let next: GateRunOutcome = gateOutcome("ok", "");
  const runner = {
    source: { load: async () => ({ content: "#!/bin/sh\nexit 0\n", sha256: "d".repeat(64) }) },
    resolveConnection: async () => ({ environmentId: "env-1", config: {} }),
    resolveEnvironmentId: async () => "env-1",
    run: async (request: GateRunRequest) => {
      calls.push(request);
      return next;
    },
  } as unknown as GateRunner;
  return {
    runner,
    calls,
    respondWith(outcome: GateRunOutcome) {
      next = outcome;
    },
  };
}

type Outcomes = Record<string, EventRoutineOutcome>;

describeEmbeddedPostgres("routine gate scripts: event triggers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-gate-events-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A gated routine subscribed to a source, an ungated fallback behind it, and a fake gate runner. */
  async function setup(options: { beforeWakeup?: (agentId: string, opts: WakeupRecord["opts"]) => void | Promise<void> } = {}) {
    const fake = createFakeGate();
    const fx = await seedEventFixture(db, {
      gate: { runner: fake.runner, autoKick: false },
      beforeWakeup: options.beforeWakeup,
    });
    const agentId = await fx.createAgent("Gated responder");
    const fallbackAgentId = await fx.createAgent("Catch-all");
    const gated = await fx.createRoutine({ assigneeAgentId: agentId, title: "Gated", gate: GATE });
    const catchAll = await fx.createRoutine({ assigneeAgentId: fallbackAgentId, title: "Catch-all" });
    const { source, secret } = await fx.createSource();
    await fx.subscribe(gated.id, source.id);
    await fx.subscribe(catchAll.id, source.id, { fallback: true });
    return { fx, fake, agentId, fallbackAgentId, gated, catchAll, source, secret };
  }

  const settle = async (fx: Awaited<ReturnType<typeof seedEventFixture>>) => {
    await fx.routinesSvc.sweepGatingRuns();
    await fx.routinesSvc.settleGateRuns();
  };
  const runsOf = (routineId: string) => db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
  const deliveryOf = (sourceId: string) =>
    db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, sourceId)).then((rows) => rows[0]!);
  const outcomesOf = async (sourceId: string) => ((await deliveryOf(sourceId)).routineOutcomes ?? {}) as Outcomes;

  it("parks the event as gating, answers dispatched, and wakes nobody until the gate has run", async () => {
    const { fx, fake, gated, catchAll, source, secret } = await setup();

    const result = await fx.send(source, secret, wireEvent({ eventId: "g1" }));

    expect(result.status).toBe(202);
    const summary = (result.body.outcomes as Array<{ status: string }>)[0]!;
    expect(summary.status).toBe("gating");
    expect(await fx.issuesFor(gated.id)).toHaveLength(0);
    expect(fx.wakeups).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    const [parked] = await runsOf(gated.id);
    expect(parked).toMatchObject({ status: "gating", source: "event" });
    expect((await deliveryOf(source.id)).status).toBe("dispatched");
    // A gating routine is a success: the fallback only takes over for a permanent failure.
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
  });

  it("commits the parked run when the gate wakes, with the event handed to the script", async () => {
    const { fx, fake, agentId, gated, catchAll, source, secret } = await setup();
    fake.respondWith(gateOutcome("ok", "payments is down\n"));
    await fx.send(source, secret, wireEvent({ eventId: "g2", title: "Payments down" }));

    await settle(fx);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.context).toMatchObject({ routineId: gated.id, triggerKind: "event" });
    expect(fake.calls[0]!.context.event).toMatchObject({ title: "Payments down" });
    const [run] = await runsOf(gated.id);
    expect(run).toMatchObject({ status: "issue_created", gateDispatchInput: null });
    expect(run!.gateResult).toMatchObject({ class: "ok" });
    const [issue] = await fx.issuesFor(gated.id);
    expect(issue).toMatchObject({ assigneeAgentId: agentId, originKind: "routine_execution" });
    expect(fx.wakeups.filter((w) => w.agentId === agentId)).toHaveLength(1);
    expect((await outcomesOf(source.id))[gated.id]).toMatchObject({ status: "issue_created", issueId: issue!.id });
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
  });

  it("skips at zero tokens on exit 1: no issue, no wake, no fallback", async () => {
    const { fx, fake, gated, catchAll, source, secret } = await setup();
    fake.respondWith(gateOutcome("skip"));
    await fx.send(source, secret, wireEvent({ eventId: "g3" }));

    await settle(fx);

    const [run] = await runsOf(gated.id);
    expect(run).toMatchObject({ status: "skipped" });
    expect(await fx.issuesFor(gated.id)).toHaveLength(0);
    expect(fx.wakeups).toHaveLength(0);
    expect((await outcomesOf(source.id))[gated.id]).toMatchObject({ status: "gate_skipped" });
    // A skip is the gate's decision, not a failure, so the alert is not re-routed.
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
  });

  it("fires the source's fallback when the agent is terminated while the run is gating", async () => {
    const { fx, fake, agentId, gated, catchAll, fallbackAgentId, source, secret } = await setup();
    fake.respondWith(gateOutcome("ok", "go\n"));
    await fx.send(source, secret, wireEvent({ eventId: "g4" }));
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

    await settle(fx);

    const [run] = await runsOf(gated.id);
    expect(run).toMatchObject({ status: "failed", gateDispatchInput: null });
    expect(await fx.issuesFor(gated.id)).toHaveLength(0);
    expect(fx.wakeups.filter((w) => w.agentId === agentId)).toHaveLength(0);
    // Alerts never vanish silently: the permanent failure that landed after the delivery was answered still falls back.
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(1);
    expect(fx.wakeups.filter((w) => w.agentId === fallbackAgentId)).toHaveLength(1);
    const outcomes = await outcomesOf(source.id);
    expect(outcomes[gated.id]).toMatchObject({ status: "failed_permanent", failureClass: "permanent" });
    expect(outcomes[catchAll.id]).toMatchObject({ status: "issue_created" });
  });

  it("single-flights per alert group: a repeat joins the in-flight gate, a different group gets its own", async () => {
    const { fx, fake, gated, source, secret } = await setup();
    fake.respondWith(gateOutcome("ok", "go\n"));

    const first = await fx.send(source, secret, wireEvent({ eventId: "s1", dedupeKey: "db-down" }));
    const repeat = await fx.send(source, secret, wireEvent({ eventId: "s2", dedupeKey: "db-down" }));
    const other = await fx.send(source, secret, wireEvent({ eventId: "s3", dedupeKey: "cache-down" }));

    const runIdOf = (result: { body: Record<string, unknown> }) =>
      (result.body.outcomes as Array<{ runId?: string }>)[0]!.runId;
    expect(runIdOf(repeat)).toBe(runIdOf(first));
    expect(runIdOf(other)).not.toBe(runIdOf(first));
    expect(await runsOf(gated.id)).toHaveLength(2);

    await settle(fx);

    // One script run per group, not per delivery.
    expect(fake.calls).toHaveLength(2);
    expect(await fx.issuesFor(gated.id)).toHaveLength(2);
  });

  it("never joins an in-flight gate when the routine is always_enqueue", async () => {
    const fake = createFakeGate();
    const fx = await seedEventFixture(db, { gate: { runner: fake.runner, autoKick: false } });
    const agentId = await fx.createAgent("Gated responder");
    const gated = await fx.createRoutine({
      assigneeAgentId: agentId,
      title: "Gated",
      gate: GATE,
      concurrencyPolicy: "always_enqueue",
    });
    const { source, secret } = await fx.createSource();
    await fx.subscribe(gated.id, source.id);

    await fx.send(source, secret, wireEvent({ eventId: "q1", dedupeKey: "db-down" }));
    await fx.send(source, secret, wireEvent({ eventId: "q2", dedupeKey: "db-down" }));

    const runs = await runsOf(gated.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "gating")).toBe(true);
  });

  it("keeps the run gating on a transient commit failure, does not fall back, and commits on the retry", async () => {
    let failWake = true;
    const { fx, fake, gated, catchAll, source, secret } = await setup({
      beforeWakeup: () => {
        if (failWake) throw new Error("adapter unavailable");
      },
    });
    fake.respondWith(gateOutcome("ok", "go\n"));
    await fx.send(source, secret, wireEvent({ eventId: "g5" }));

    await settle(fx);

    const [afterFailure] = await runsOf(gated.id);
    expect(afterFailure).toMatchObject({ status: "gating" });
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);

    // The released claim expires on its own; the test expires it now and lets the sweep take the row again.
    failWake = false;
    await db.update(routineRuns).set({ gateClaimedAt: null }).where(eq(routineRuns.id, afterFailure!.id));
    await settle(fx);

    const [afterRetry] = await runsOf(gated.id);
    expect(afterRetry).toMatchObject({ status: "issue_created" });
    expect(await fx.issuesFor(gated.id)).toHaveLength(1);
    expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
  });
});

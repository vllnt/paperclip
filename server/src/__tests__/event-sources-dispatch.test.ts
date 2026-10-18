import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  createDb,
  eventDeliveries,
  issueComments,
  issues,
  routineEventGroups,
  routineRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedEventFixture, wireEvent } from "./helpers/event-source-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres event source dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Fixture = Awaited<ReturnType<typeof seedEventFixture>>;
type Grouping = NonNullable<NonNullable<Parameters<Fixture["subscribe"]>[2]>["grouping"]>;

describeEmbeddedPostgres("event source dispatch and grouping", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-event-sources-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup(options: {
    grouping?: Grouping;
    beforeWakeup?: NonNullable<Parameters<typeof seedEventFixture>[1]>["beforeWakeup"];
  } = {}) {
    const fx = await seedEventFixture(db, { beforeWakeup: options.beforeWakeup });
    const agentId = await fx.createAgent("Responder");
    const routine = await fx.createRoutine({ assigneeAgentId: agentId });
    const { source, secret } = await fx.createSource();
    const trigger = await fx.subscribe(routine.id, source.id, { grouping: options.grouping ?? { repeatCommentCooldownSec: 600 } });
    return { fx, agentId, routine, source, secret, trigger };
  }

  const commentsOf = (issueId: string) =>
    db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(asc(issueComments.createdAt));
  const runsOf = (routineId: string) => db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
  const groupsOf = (routineId: string) => db.select().from(routineEventGroups).where(eq(routineEventGroups.routineId, routineId));
  const outcomeOf = (result: { body: Record<string, unknown> }, index = 0) =>
    (result.body.outcomes as Array<{ status: string; issueId?: string | null; failureClass?: string }>)[index]!;

  describe("grouping lifecycle", () => {
    it("walks the whole lifecycle: new issue, silent repeat, cooldown comment, severity wake, recovery, new issue", async () => {
      const { fx, routine, source, secret, agentId } = await setup();

      // 1. First alert opens one issue and wakes the assignee.
      const first = await fx.send(source, secret, wireEvent({ eventId: "e1", severity: "warning" }));
      expect(outcomeOf(first).status).toBe("issue_created");
      const [issue] = await fx.issuesFor(routine.id);
      expect(issue).toMatchObject({ assigneeAgentId: agentId, originKind: "routine_execution", status: "todo" });
      expect(fx.wakeups).toHaveLength(1);
      expect(fx.wakeups[0]!.opts.reason).toBe("issue_assigned");

      // 2. A repeat inside the cooldown is silent: no run row, no comment, no wake.
      fx.advance(60_000);
      const silent = await fx.send(source, secret, wireEvent({ eventId: "e2", severity: "warning" }));
      expect(outcomeOf(silent).status).toBe("grouped_silent");
      expect(await runsOf(routine.id)).toHaveLength(1);
      expect(await commentsOf(issue!.id)).toHaveLength(0);
      expect(fx.wakeups).toHaveLength(1);
      expect((await groupsOf(routine.id))[0]).toMatchObject({ repeatCount: 1 });

      // 3. A repeat after the cooldown adds one comment and wakes.
      fx.advance(600_000);
      const afterCooldown = await fx.send(source, secret, wireEvent({ eventId: "e3", severity: "warning" }));
      expect(outcomeOf(afterCooldown).status).toBe("grouped");
      const afterCooldownComments = await commentsOf(issue!.id);
      expect(afterCooldownComments).toHaveLength(1);
      expect(afterCooldownComments[0]!.body).toContain("Repeated 2");
      expect(fx.wakeups).toHaveLength(2);
      expect(fx.wakeups[1]!.opts.reason).toBe("issue_commented");
      expect((await groupsOf(routine.id))[0]).toMatchObject({ repeatCount: 0 });

      // 4. A severity increase wakes even inside the cooldown.
      fx.advance(10_000);
      const escalated = await fx.send(source, secret, wireEvent({ eventId: "e4", severity: "critical" }));
      expect(outcomeOf(escalated).status).toBe("grouped");
      const escalatedComments = await commentsOf(issue!.id);
      expect(escalatedComments).toHaveLength(2);
      expect(escalatedComments[1]!.body).toContain("Severity increased: warning");
      expect(fx.wakeups).toHaveLength(3);

      // 5. A recovery adds a comment and wakes; the agent, not the event, closes the issue.
      fx.advance(10_000);
      const recovery = await fx.send(source, secret, wireEvent({ eventId: "e5", state: "recovery", severity: "info", title: "API healthy again" }));
      expect(outcomeOf(recovery).status).toBe("recovered");
      const recoveryComments = await commentsOf(issue!.id);
      expect(recoveryComments).toHaveLength(3);
      expect(recoveryComments[2]!.body).toContain("Recovered at");
      const [stillOpen] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      expect(stillOpen!.status).not.toBe("done");
      expect(fx.wakeups).toHaveLength(4);

      // 6. After the issue is closed, a new problem opens a new issue and never reopens the old one.
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue!.id));
      fx.advance(10_000);
      const again = await fx.send(source, secret, wireEvent({ eventId: "e6", severity: "warning" }));
      expect(outcomeOf(again).status).toBe("issue_created");
      const all = await fx.issuesFor(routine.id);
      expect(all).toHaveLength(2);
      const [closed] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      expect(closed!.status).toBe("done");
      expect(await groupsOf(routine.id)).toHaveLength(2);
    });

    it("reports a problem that returns after a recovery in a comment", async () => {
      const { fx, routine, source, secret } = await setup();
      await fx.send(source, secret, wireEvent({ eventId: "a" }));
      fx.advance(1000);
      await fx.send(source, secret, wireEvent({ eventId: "b", state: "recovery", severity: "info" }));
      fx.advance(1000);
      const returned = await fx.send(source, secret, wireEvent({ eventId: "c" }));
      expect(outcomeOf(returned).status).toBe("grouped");
      const [issue] = await fx.issuesFor(routine.id);
      const comments = await commentsOf(issue!.id);
      expect(comments.at(-1)!.body).toContain("Problem returned after a recovery");
    });

    it("records a recovery without an open issue as recovery_without_issue and creates nothing", async () => {
      const { fx, routine, source, secret } = await setup();
      const result = await fx.send(source, secret, wireEvent({ eventId: "r", state: "recovery", severity: "info" }));
      expect(result.status).toBe(202);
      expect(outcomeOf(result).status).toBe("recovery_without_issue");
      expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      expect(fx.wakeups).toHaveLength(0);
      const page = await fx.sources.listDeliveries(source.id, { limit: 10 });
      expect(page.items[0]!.status).toBe("recovery_without_issue");
    });

    it("comments without waking on recovery when onRecovery is comment_only", async () => {
      const { fx, routine, source, secret } = await setup({ grouping: { onRecovery: "comment_only", repeatCommentCooldownSec: 600 } });
      await fx.send(source, secret, wireEvent({ eventId: "a" }));
      const wakeupsBefore = fx.wakeups.length;
      await fx.send(source, secret, wireEvent({ eventId: "b", state: "recovery", severity: "info" }));
      const [issue] = await fx.issuesFor(routine.id);
      expect(await commentsOf(issue!.id)).toHaveLength(1);
      expect(fx.wakeups).toHaveLength(wakeupsBefore);
    });

    it.each(["in_review", "blocked"] as const)("lets an open %s issue with no live run absorb repeats", async (status) => {
      const { fx, routine, source, secret } = await setup();
      await fx.send(source, secret, wireEvent({ eventId: "a" }));
      const [issue] = await fx.issuesFor(routine.id);
      await db.update(issues).set({ status, executionRunId: null }).where(eq(issues.id, issue!.id));
      fx.advance(700_000);
      const repeat = await fx.send(source, secret, wireEvent({ eventId: "b" }));
      expect(outcomeOf(repeat)).toMatchObject({ status: "grouped", issueId: issue!.id });
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
    });

    it("produces one issue for two concurrent deliveries of one group", async () => {
      const { fx, routine, source, secret } = await setup();
      const results = await Promise.all([
        fx.send(source, secret, wireEvent({ eventId: "c1" })),
        fx.send(source, secret, wireEvent({ eventId: "c2" })),
      ]);
      expect(results.map((r) => r.status)).toEqual([202, 202]);
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
      const statuses = results.map((r) => outcomeOf(r).status).sort();
      expect(statuses).toEqual(["grouped_silent", "issue_created"]);
      expect(await groupsOf(routine.id)).toHaveLength(1);
    });

    it("tolerates two open issues with the same fingerprint and picks the oldest", async () => {
      const { fx, routine, source, secret } = await setup();
      await fx.send(source, secret, wireEvent({ eventId: "a" }));
      const [oldest] = await fx.issuesFor(routine.id);
      const [group] = await groupsOf(routine.id);
      // A second open issue for the same fingerprint, as a manual restore or an older bug could leave behind.
      const duplicate = await fx.issueSvc.create(fx.companyId, {
        projectId: fx.projectId,
        title: "duplicate",
        status: "todo",
        priority: "medium",
        originKind: "routine_execution",
        originId: routine.id,
        originFingerprint: group!.fingerprint,
        assigneeAgentId: oldest!.assigneeAgentId,
      } as never);
      await db.insert(routineEventGroups).values({
        companyId: fx.companyId,
        routineId: routine.id,
        fingerprint: group!.fingerprint,
        issueId: duplicate.id,
        lastSeverity: "critical",
        lastState: "problem",
        firstSeenAt: new Date(fx.clock.ms + 1000),
        lastSeenAt: new Date(fx.clock.ms + 1000),
      });
      fx.advance(700_000);
      const repeat = await fx.send(source, secret, wireEvent({ eventId: "b" }));
      expect(outcomeOf(repeat)).toMatchObject({ status: "grouped", issueId: oldest!.id });
      expect(await commentsOf(duplicate.id)).toHaveLength(0);
    });

    it("never reopens a closed issue when it closes during the comment: it opens a new issue and wakes once", async () => {
      const { fx, routine, source, secret } = await setup();
      await fx.send(source, secret, wireEvent({ eventId: "a" }));
      const [issue] = await fx.issuesFor(routine.id);
      const wakeupsBefore = fx.wakeups.length;
      // Simulate a concurrent close landing right after the comment is written.
      await db.execute(sql`
        create or replace function test_close_issue_on_comment() returns trigger as $$
        begin
          update issues set status = 'done', completed_at = now() where id = new.issue_id;
          return new;
        end; $$ language plpgsql
      `);
      await db.execute(sql`
        create trigger test_close_issue_on_comment after insert on issue_comments
        for each row execute function test_close_issue_on_comment()
      `);
      try {
        fx.advance(700_000);
        const raced = await fx.send(source, secret, wireEvent({ eventId: "b" }));
        expect(outcomeOf(raced).status).toBe("issue_created");
      } finally {
        await db.execute(sql`drop trigger if exists test_close_issue_on_comment on issue_comments`);
        await db.execute(sql`drop function if exists test_close_issue_on_comment()`);
      }
      const all = await fx.issuesFor(routine.id);
      expect(all).toHaveLength(2);
      const [closed] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      expect(closed!.status).toBe("done");
      // Exactly one wake for the race, on the new issue and not on the closed one.
      const newWakes = fx.wakeups.slice(wakeupsBefore);
      expect(newWakes).toHaveLength(1);
      expect(newWakes[0]!.opts.reason).toBe("issue_assigned");
    });
  });

  describe("fan-out and fallback", () => {
    it("fans an event out to two routines, one issue each, owned by each routine's own agent", async () => {
      const fx = await seedEventFixture(db);
      const agentA = await fx.createAgent("A");
      const agentB = await fx.createAgent("B");
      const routineA = await fx.createRoutine({ assigneeAgentId: agentA, title: "A routine" });
      const routineB = await fx.createRoutine({ assigneeAgentId: agentB, title: "B routine" });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(routineA.id, source.id);
      await fx.subscribe(routineB.id, source.id);
      const result = await fx.send(source, secret, wireEvent());
      expect(result.body.matched).toBe(2);
      expect((await fx.issuesFor(routineA.id))[0]!.assigneeAgentId).toBe(agentA);
      expect((await fx.issuesFor(routineB.id))[0]!.assigneeAgentId).toBe(agentB);
    });

    it("dispatches a routine once when two of its triggers match, recording both", async () => {
      const { fx, routine, source, secret, trigger } = await setup();
      const second = await fx.subscribe(routine.id, source.id, { match: { types: ["uptime.*"] } });
      const result = await fx.send(source, secret, wireEvent());
      expect(result.body.matched).toBe(1);
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
      expect(await runsOf(routine.id)).toHaveLength(1);
      const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id));
      expect([...delivery!.matchedTriggerIds].sort()).toEqual([trigger.id, second.id].sort());
    });

    it("ignores paused routines and disabled triggers", async () => {
      const fx = await seedEventFixture(db);
      const agentId = await fx.createAgent();
      const paused = await fx.createRoutine({ assigneeAgentId: agentId, status: "paused" });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(paused.id, source.id);
      const result = await fx.send(source, secret, wireEvent());
      expect(result.body.matched).toBe(0);
      expect(await fx.issuesFor(paused.id)).toHaveLength(0);
    });

    it("fires the fallback routine when nothing matches", async () => {
      const fx = await seedEventFixture(db);
      const agentId = await fx.createAgent("Main");
      const fallbackAgent = await fx.createAgent("Catch-all");
      const main = await fx.createRoutine({ assigneeAgentId: agentId, title: "Main" });
      const catchAll = await fx.createRoutine({ assigneeAgentId: fallbackAgent, title: "Catch-all" });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(main.id, source.id, { match: { types: ["billing.*"] } });
      await fx.subscribe(catchAll.id, source.id, { fallback: true });
      const result = await fx.send(source, secret, wireEvent());
      expect(result.body).toMatchObject({ matched: 0, fallback: true });
      expect(await fx.issuesFor(main.id)).toHaveLength(0);
      expect(await fx.issuesFor(catchAll.id)).toHaveLength(1);
    });

    it("does not fire the fallback when a regular routine matched", async () => {
      const fx = await seedEventFixture(db);
      const agentId = await fx.createAgent("Main");
      const fallbackAgent = await fx.createAgent("Catch-all");
      const main = await fx.createRoutine({ assigneeAgentId: agentId, title: "Main" });
      const catchAll = await fx.createRoutine({ assigneeAgentId: fallbackAgent, title: "Catch-all" });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(main.id, source.id);
      await fx.subscribe(catchAll.id, source.id, { fallback: true });
      await fx.send(source, secret, wireEvent());
      expect(await fx.issuesFor(main.id)).toHaveLength(1);
      expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
    });

    it("fires the fallback when the matched routine's agent is terminated (permanent failure)", async () => {
      const fx = await seedEventFixture(db);
      const agentId = await fx.createAgent("Main");
      const fallbackAgent = await fx.createAgent("Catch-all");
      const main = await fx.createRoutine({ assigneeAgentId: agentId, title: "Main" });
      const catchAll = await fx.createRoutine({ assigneeAgentId: fallbackAgent, title: "Catch-all" });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(main.id, source.id);
      await fx.subscribe(catchAll.id, source.id, { fallback: true });
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
      const result = await fx.send(source, secret, wireEvent());
      expect(result.status).toBe(202);
      expect(result.body.fallback).toBe(true);
      expect(await fx.issuesFor(main.id)).toHaveLength(0);
      expect(await fx.issuesFor(catchAll.id)).toHaveLength(1);
    });

    it("answers 503 with Retry-After and does not fire the fallback on a transient failure", async () => {
      let failWake = true;
      const fx = await seedEventFixture(db, {
        beforeWakeup: () => {
          if (failWake) throw new Error("adapter unavailable");
        },
      });
      const agentId = await fx.createAgent("Main");
      const fallbackAgent = await fx.createAgent("Catch-all");
      const main = await fx.createRoutine({ assigneeAgentId: agentId, title: "Main" });
      const catchAll = await fx.createRoutine({ assigneeAgentId: fallbackAgent, title: "Catch-all" });
      const { source, secret } = await fx.createSource();
      await fx.subscribe(main.id, source.id);
      await fx.subscribe(catchAll.id, source.id, { fallback: true });
      const result = await fx.send(source, secret, wireEvent({ eventId: "t1" }));
      expect(result.status).toBe(503);
      expect(result.headers?.["Retry-After"]).toBe("30");
      expect(await fx.issuesFor(main.id)).toHaveLength(0);
      expect(await fx.issuesFor(catchAll.id)).toHaveLength(0);
      const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id));
      expect(delivery).toMatchObject({ status: "failed", httpStatus: 503 });
      failWake = false;
    });
  });

  describe("failure and retry", () => {
    it("processes a sender retry after a dispatch failure", async () => {
      let failWake = true;
      const { fx, routine, source, secret } = await setup({
        beforeWakeup: () => {
          if (failWake) throw new Error("adapter unavailable");
        },
      });
      const first = await fx.send(source, secret, wireEvent({ eventId: "retry-1" }));
      expect(first.status).toBe(503);
      expect(await fx.issuesFor(routine.id)).toHaveLength(0);
      failWake = false;
      const second = await fx.send(source, secret, wireEvent({ eventId: "retry-1" }));
      expect(second.status).toBe(202);
      expect(await fx.issuesFor(routine.id)).toHaveLength(1);
      const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id));
      expect(delivery).toMatchObject({ status: "dispatched", attempts: 2 });
    });

    describe("a wake that fails after the comment was posted", () => {
      function failingWakes() {
        const control = { fail: false };
        return {
          control,
          beforeWakeup: () => {
            if (control.fail) throw new Error("adapter unavailable");
          },
        };
      }

      it("does not post a repeat comment twice, and wakes once on the retry", async () => {
        const { control, beforeWakeup } = failingWakes();
        const { fx, routine, source, secret } = await setup({ beforeWakeup });
        await fx.send(source, secret, wireEvent({ eventId: "a" }));
        const [issue] = await fx.issuesFor(routine.id);

        fx.advance(700_000);
        control.fail = true;
        expect((await fx.send(source, secret, wireEvent({ eventId: "b" }))).status).toBe(503);
        expect(await commentsOf(issue!.id)).toHaveLength(1);

        // The group moved on with the comment: a repeat during the outage stays silent instead of commenting again.
        fx.advance(30_000);
        expect(outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "c" }))).status).toBe("grouped_silent");
        expect(await commentsOf(issue!.id)).toHaveLength(1);

        control.fail = false;
        const wakeupsBefore = fx.wakeups.length;
        const retry = await fx.send(source, secret, wireEvent({ eventId: "b" }));
        expect(retry.status).toBe(202);
        expect(outcomeOf(retry).status).toBe("grouped");
        const comments = await commentsOf(issue!.id);
        expect(comments).toHaveLength(1);
        const wakes = fx.wakeups.slice(wakeupsBefore);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]!.opts).toMatchObject({ reason: "issue_commented", payload: { commentId: comments[0]!.id } });
        expect((await groupsOf(routine.id))[0]).toMatchObject({ repeatCount: 1 });
        const deliveries = await db.select().from(eventDeliveries).where(eq(eventDeliveries.sourceId, source.id));
        expect(deliveries.filter((d) => d.attempts === 2)).toEqual([expect.objectContaining({ status: "dispatched" })]);
      });

      it("does not post a recovery comment twice", async () => {
        const { control, beforeWakeup } = failingWakes();
        const { fx, routine, source, secret } = await setup({ beforeWakeup });
        await fx.send(source, secret, wireEvent({ eventId: "a" }));
        const [issue] = await fx.issuesFor(routine.id);

        fx.advance(1000);
        control.fail = true;
        expect((await fx.send(source, secret, wireEvent({ eventId: "r", state: "recovery", severity: "info" }))).status).toBe(503);
        expect(await commentsOf(issue!.id)).toHaveLength(1);

        control.fail = false;
        const wakeupsBefore = fx.wakeups.length;
        const retry = await fx.send(source, secret, wireEvent({ eventId: "r", state: "recovery", severity: "info" }));
        expect(outcomeOf(retry).status).toBe("recovered");
        expect(await commentsOf(issue!.id)).toHaveLength(1);
        expect(fx.wakeups.slice(wakeupsBefore)).toHaveLength(1);
      });

      it("keeps resuming across repeated failures and still posts the comment once", async () => {
        const { control, beforeWakeup } = failingWakes();
        const { fx, routine, source, secret } = await setup({ beforeWakeup });
        await fx.send(source, secret, wireEvent({ eventId: "a" }));
        const [issue] = await fx.issuesFor(routine.id);

        fx.advance(700_000);
        control.fail = true;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect((await fx.send(source, secret, wireEvent({ eventId: "b" }))).status).toBe(503);
        }
        expect(await commentsOf(issue!.id)).toHaveLength(1);

        control.fail = false;
        const wakeupsBefore = fx.wakeups.length;
        expect(outcomeOf(await fx.send(source, secret, wireEvent({ eventId: "b" }))).status).toBe("grouped");
        expect(await commentsOf(issue!.id)).toHaveLength(1);
        expect(fx.wakeups.slice(wakeupsBefore)).toHaveLength(1);
      });

      it("does not post the first comment of an append-mode group twice", async () => {
        const { control, beforeWakeup } = failingWakes();
        const fx = await seedEventFixture(db, { beforeWakeup });
        const agentId = await fx.createAgent();
        const routine = await fx.createRoutine({ assigneeAgentId: agentId });
        const { source, secret } = await fx.createSource();
        const target = await fx.issueSvc.create(fx.companyId, {
          projectId: fx.projectId,
          title: "ongoing",
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
        } as never);
        await fx.subscribe(routine.id, source.id, { grouping: { issueMode: { appendToIssueId: target.id }, repeatCommentCooldownSec: 600 } });

        control.fail = true;
        expect((await fx.send(source, secret, wireEvent({ eventId: "p1" }))).status).toBe(503);
        expect(await commentsOf(target.id)).toHaveLength(1);

        control.fail = false;
        const retry = await fx.send(source, secret, wireEvent({ eventId: "p1" }));
        expect(outcomeOf(retry)).toMatchObject({ status: "grouped", issueId: target.id });
        expect(await commentsOf(target.id)).toHaveLength(1);
        expect((await groupsOf(routine.id)).filter((g) => g.issueId === target.id)).toHaveLength(1);
      });
    });
  });
});

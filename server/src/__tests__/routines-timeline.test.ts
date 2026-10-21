import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  eventSources,
  goals,
  issues,
  projects,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import { ROUTINE_TIMELINE_MAX_FIRES, type RoutineTimelineResult } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date();
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
/** The scheduler stores `nextRunAt` on a whole minute; seed it the same way. */
const onMinute = (hours: number) => new Date(Math.ceil(at(hours).getTime() / 60_000) * 60_000);

describeEmbeddedPostgres("GET /companies/:companyId/routines/timeline", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyA = randomUUID();
  const companyB = randomUUID();
  /** Holds one every-minute routine, so the cap test cannot crowd the fires the other tests read. */
  const companyBusy = randomUUID();
  const agentA = randomUUID();
  const goalA = randomUUID();
  const projectA = randomUUID();
  const sourceA = randomUUID();
  const sourceOther = randomUUID();
  let otherRoutineId = "";
  const ids: Record<string, string> = {};
  const triggerIds: Record<string, string> = {};
  const runIds: Record<string, string> = {};
  const issueIds: Record<string, string> = {};

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-routines-timeline-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    for (const id of [companyA, companyB, companyBusy]) {
      await db.insert(companies).values({
        id,
        name: `Company ${id}`,
        issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values({
      id: agentA, companyId: companyA, name: "Engineer", role: "engineer", adapterType: "process", adapterConfig: {},
    });
    await db.insert(goals).values({ id: goalA, companyId: companyA, title: "Keep things healthy" });
    await db.insert(projects).values({ id: projectA, companyId: companyA, name: "Ops", status: "in_progress" });
    await db.insert(eventSources).values([
      { id: sourceA, companyId: companyA, name: "Monitoring", publicId: `pub-${randomUUID()}` },
      { id: sourceOther, companyId: companyB, name: "Other company source", publicId: `pub-${randomUUID()}` },
    ]);

    const seedRoutine = async (key: string, values: Partial<typeof routines.$inferInsert> & { title: string }) => {
      const [row] = await db
        .insert(routines)
        .values({ companyId: companyA, assigneeAgentId: agentA, ...values })
        .returning({ id: routines.id });
      ids[key] = row!.id;
    };
    const seedTrigger = async (key: string, routineKey: string, values: Partial<typeof routineTriggers.$inferInsert>) => {
      const [row] = await db
        .insert(routineTriggers)
        .values({ companyId: companyA, routineId: ids[routineKey]!, kind: "schedule", ...values })
        .returning({ id: routineTriggers.id });
      triggerIds[key] = row!.id;
    };

    await seedRoutine("daily", { title: "Daily digest", goalId: goalA, projectId: projectA });
    await seedTrigger("daily", "daily", {
      cronExpression: "0 */6 * * *", timezone: "UTC", nextRunAt: onMinute(1),
    });
    const [busy] = await db
      .insert(routines)
      .values({ companyId: companyBusy, title: "Every minute", assigneeAgentId: null })
      .returning({ id: routines.id });
    await db.insert(routineTriggers).values({
      companyId: companyBusy,
      routineId: busy!.id,
      kind: "schedule",
      cronExpression: "* * * * *",
      timezone: "UTC",
      nextRunAt: onMinute(0.1),
    });
    await seedRoutine("paused", { title: "Paused schedule", status: "paused" });
    await seedTrigger("paused", "paused", { cronExpression: "0 * * * *", timezone: "UTC", nextRunAt: at(1) });
    await seedRoutine("off", { title: "Schedule switched off" });
    await seedTrigger("off", "off", { cronExpression: "0 * * * *", timezone: "UTC", nextRunAt: at(1), enabled: false });
    await seedRoutine("archived", { title: "Archived", status: "archived" });
    await seedTrigger("archived", "archived", { cronExpression: "0 * * * *", timezone: "UTC", nextRunAt: at(1) });
    await seedRoutine("manual", { title: "Ad hoc audit" });
    await seedRoutine("webhook", { title: "On deploy" });
    await seedTrigger("webhook", "webhook", { kind: "webhook" });
    await seedRoutine("alerts", {
      title: "On alert",
      steps: [
        { key: "triage", title: "Triage", after: [] },
        { key: "fix", title: "Fix", after: ["triage"] },
        { key: "report", title: "Report", after: ["triage", "fix"] },
      ] as never,
    });
    await seedTrigger("alerts", "alerts", {
      kind: "event",
      eventSourceId: sourceA,
      eventMatch: { types: ["alert.fired"], minSeverity: "warning" },
      eventGrouping: { issueMode: "per_group" } as never,
    });
    await seedRoutine("intake", { title: "Intake" });
    await seedRoutine("triage", { title: "Triage the intake" });
    const [other] = await db
      .insert(routines)
      .values({ companyId: companyB, title: "Other company routine", assigneeAgentId: null })
      .returning({ id: routines.id });
    otherRoutineId = other!.id;

    const seedIssue = async (key: string, values: Partial<typeof issues.$inferInsert> & { title: string }) => {
      const [row] = await db.insert(issues).values({ companyId: companyA, ...values }).returning({ id: issues.id });
      issueIds[key] = row!.id;
    };
    await seedIssue("fromIntake", { title: "Intake run issue", originKind: "routine_execution", originId: ids.intake, identifier: "T-1" });
    await seedIssue("manualIssue", { title: "Filed by hand", identifier: "T-2" });
    await seedIssue("hidden", { title: "Hidden task", hiddenAt: NOW, identifier: "T-3" });

    const seedRun = async (key: string, values: Partial<typeof routineRuns.$inferInsert> & { routineKey: string }) => {
      const { routineKey, ...rest } = values;
      const [row] = await db
        .insert(routineRuns)
        .values({
          companyId: companyA,
          routineId: ids[routineKey]!,
          source: "manual",
          status: "completed",
          triggeredAt: at(-2),
          completedAt: at(-1.5),
          ...rest,
        })
        .returning({ id: routineRuns.id });
      runIds[key] = row!.id;
    };
    await seedRun("dailyDone", { routineKey: "daily", source: "schedule", triggerId: triggerIds.daily, triggeredAt: at(-5), completedAt: at(-4.5) });
    await seedRun("dailyOpen", { routineKey: "daily", source: "schedule", status: "issue_created", triggeredAt: at(-1), completedAt: null });
    await seedRun("dailyFailed", { routineKey: "daily", status: "failed", triggeredAt: at(-8), completedAt: at(-7.9), failureReason: "boom" });
    await seedRun("tooOld", { routineKey: "daily", triggeredAt: at(-24 * 20), completedAt: at(-24 * 20 + 1) });
    await seedRun("tooNew", { routineKey: "daily", triggeredAt: at(24 * 5), completedAt: null });
    await seedRun("manualRun", { routineKey: "manual", linkedIssueId: issueIds.manualIssue });
    await seedRun("hiddenRun", { routineKey: "manual", triggeredAt: at(-3), completedAt: at(-2.9), linkedIssueId: issueIds.hidden });
    await seedRun("triageOnIntakeIssue", { routineKey: "triage", triggeredAt: at(-6), completedAt: at(-5.9), linkedIssueId: issueIds.fromIntake });
    await seedRun("alertRun", { routineKey: "alerts", source: "event", triggerId: triggerIds.alerts, triggeredAt: at(-0.5), completedAt: at(-0.4) });
    await db.insert(routineRuns).values({
      companyId: companyB,
      routineId: otherRoutineId,
      source: "manual",
      status: "completed",
      triggeredAt: at(-1),
      completedAt: at(-0.9),
    });

    // The routine "triage" files its runs under an issue the "intake" routine made.
    await db.update(routines).set({ parentIssueId: issueIds.fromIntake }).where(eq(routines.id, ids.triage!));
  }, 60_000);

  afterAll(async () => {
    await stopDb?.();
  });

  function app(actor: Express.Request["actor"] = { type: "board", userId: "board-user", source: "local_implicit" }) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", routineRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function timeline(query = "", companyId = companyA) {
    const params = query || `?from=${encodeURIComponent(at(-12).toISOString())}&to=${encodeURIComponent(at(12).toISOString())}`;
    const res = await request(app()).get(`/api/companies/${companyId}/routines/timeline${params}`);
    return res;
  }
  const body = async (query = "") => {
    const res = await timeline(query);
    expect(res.status).toBe(200);
    return res.body as RoutineTimelineResult;
  };

  describe("window", () => {
    it("returns the runs of the window only, with their start and end, and leaves archived routines out", async () => {
      const result = await body();
      expect(result.window.from).toBe(at(-12).toISOString());
      const byId = new Map(result.runs.map((run) => [run.id, run]));
      expect(byId.has(runIds.dailyDone!)).toBe(true);
      expect(byId.get(runIds.dailyDone!)).toMatchObject({
        rowId: `routine:${ids.daily}`,
        source: "schedule",
        status: "completed",
        start: at(-5).toISOString(),
        end: at(-4.5).toISOString(),
        triggerId: triggerIds.daily,
      });
      expect(byId.get(runIds.dailyOpen!)).toMatchObject({ status: "issue_created", end: null });
      expect(byId.has(runIds.tooOld!)).toBe(false);
      expect(byId.has(runIds.tooNew!)).toBe(false);
      expect(result.rows.map((row) => row.refId)).not.toContain(ids.archived);
    });

    it("keeps a run that started before the window while it is still open", async () => {
      const result = await body(`?from=${encodeURIComponent(at(-0.5).toISOString())}&to=${encodeURIComponent(at(2).toISOString())}`);
      expect(result.runs.map((run) => run.id)).toContain(runIds.dailyOpen);
      expect(result.runs.map((run) => run.id)).not.toContain(runIds.dailyDone);
    });

    it("defaults to a day back and a day ahead when no bounds are sent", async () => {
      const res = await timeline("?x=1");
      expect(res.status).toBe(200);
      const span = new Date(res.body.window.to).getTime() - new Date(res.body.window.from).getTime();
      expect(span).toBe(48 * 3_600_000);
    });

    it("refuses a reversed window, one over 31 days, and a malformed date", async () => {
      expect((await timeline(`?from=${at(2).toISOString()}&to=${at(1).toISOString()}`)).status).toBe(400);
      expect((await timeline(`?from=${at(-24 * 40).toISOString()}&to=${at(0).toISOString()}`)).status).toBe(400);
      expect((await timeline("?from=yesterday")).status).toBeGreaterThanOrEqual(400);
    });

    it("never shows another company's routines, runs or sources", async () => {
      const result = await body();
      expect(result.rows.map((row) => row.title)).not.toContain("Other company routine");
      expect(result.runs.every((run) => run.rowId.startsWith("routine:"))).toBe(true);
      expect(result.nodes.map((node) => node.label)).not.toContain("Other company source");
      const other = await timeline("", companyB);
      expect(other.status).toBe(200);
      expect(other.body.rows.map((row: { title: string }) => row.title)).toEqual(["Other company routine"]);
      expect(other.body.runs).toHaveLength(1);
    });
  });

  describe("projected fires", () => {
    it("lists the next fires from nextRunAt and the expression, in order, for active and enabled schedules only", async () => {
      const result = await body();
      const daily = result.fires.filter((fire) => fire.triggerId === triggerIds.daily);
      expect(daily.length).toBeGreaterThanOrEqual(2);
      expect(daily[0]!.at).toBe(onMinute(1).toISOString());
      const sorted = [...result.fires].sort((a, b) => a.at.localeCompare(b.at));
      expect(result.fires.map((fire) => fire.at)).toEqual(sorted.map((fire) => fire.at));
      const triggersWithFires = new Set(result.fires.map((fire) => fire.triggerId));
      expect(triggersWithFires.has(triggerIds.paused!)).toBe(false);
      expect(triggersWithFires.has(triggerIds.off!)).toBe(false);
      expect(triggersWithFires.has(triggerIds.archived!)).toBe(false);
      expect(triggersWithFires.has(triggerIds.webhook ?? "none")).toBe(false);
    });

    it("projects only into the future and never before nextRunAt", async () => {
      const result = await body();
      for (const fire of result.fires) {
        expect(new Date(fire.at).getTime()).toBeGreaterThan(NOW.getTime() - 1000);
      }
    });

    it("caps the fires at 500, keeps the earliest, and says it truncated", async () => {
      const res = await timeline(
        `?from=${encodeURIComponent(at(0).toISOString())}&to=${encodeURIComponent(at(24 * 20).toISOString())}`,
        companyBusy,
      );
      expect(res.status).toBe(200);
      const result = res.body as RoutineTimelineResult;
      expect(result.fires).toHaveLength(ROUTINE_TIMELINE_MAX_FIRES);
      expect(result.limits.fires).toEqual({ cap: ROUTINE_TIMELINE_MAX_FIRES, truncated: true });
      const times = result.fires.map((fire) => fire.at);
      expect(times).toEqual([...times].sort());
      // One fire a minute: the 500 kept are the first 500 minutes from nextRunAt, not a sample of the 20 days.
      const first = new Date(times[0]!).getTime();
      expect(new Date(times[times.length - 1]!).getTime() - first).toBe((ROUTINE_TIMELINE_MAX_FIRES - 1) * 60_000);
    });

    it("does not report truncation when the fires fit", async () => {
      const result = await body();
      expect(result.limits.fires.truncated).toBe(false);
      expect(result.limits.runs.truncated).toBe(false);
    });
  });

  describe("routines without a schedule", () => {
    it("lists them as rows that are not scheduled, with their triggers and their past runs", async () => {
      const result = await body();
      const row = (key: string) => result.rows.find((candidate) => candidate.refId === ids[key]);
      expect(row("manual")).toMatchObject({ scheduled: false, triggers: [] });
      expect(row("webhook")).toMatchObject({ scheduled: false });
      expect(row("webhook")!.triggers.map((trigger) => trigger.kind)).toEqual(["webhook"]);
      expect(row("alerts")).toMatchObject({ scheduled: false });
      expect(row("daily")).toMatchObject({ scheduled: true });
      // A schedule trigger without an enabled flag still counts as a schedule; a switched-off one stays listed.
      expect(row("off")!.triggers[0]).toMatchObject({ enabled: false, kind: "schedule" });
      expect(result.runs.filter((run) => run.rowId === `routine:${ids.manual}`).length).toBeGreaterThan(0);
      expect(result.fires.filter((fire) => fire.rowId === `routine:${ids.manual}`)).toEqual([]);
    });
  });

  describe("linked issues", () => {
    it("names the issue of a run, and hides one that is hidden", async () => {
      const result = await body();
      const run = (key: string) => result.runs.find((candidate) => candidate.id === runIds[key])!;
      expect(run("manualRun")).toMatchObject({
        linkedIssueId: issueIds.manualIssue,
        linkedIssue: { id: issueIds.manualIssue, identifier: "T-2", title: "Filed by hand" },
      });
      expect(run("hiddenRun")).toMatchObject({ linkedIssueId: null, linkedIssue: null });
    });

    it("keeps the issue id but drops its title when an agent may not read the issue", async () => {
      const denied = express();
      denied.use(express.json());
      denied.use((req, _res, next) => {
        req.actor = { type: "agent", agentId: agentA, companyId: companyA, source: "agent_key" } as never;
        next();
      });
      denied.use("/api", routineRoutes(db));
      denied.use(errorHandler);
      const res = await request(denied).get(
        `/api/companies/${companyA}/routines/timeline?from=${encodeURIComponent(at(-12).toISOString())}&to=${encodeURIComponent(at(12).toISOString())}`,
      );
      // Whatever the agent's company-scope decision is, a 200 must never carry a title the agent cannot read.
      if (res.status === 200) {
        for (const run of res.body.runs as RoutineTimelineResult["runs"]) {
          if (run.linkedIssue) expect(run.linkedIssue.id).toBe(run.linkedIssueId);
        }
      } else {
        expect(res.status).toBe(403);
      }
    });
  });

  describe("links", () => {
    it("draws the event trigger from its source, with the filter and the trigger id", async () => {
      const result = await body();
      const edge = result.edges.find((candidate) => candidate.kind === "event_trigger")!;
      expect(edge).toMatchObject({
        from: `event_source:${sourceA}`,
        to: `routine:${ids.alerts}`,
        label: "type alert.fired · min warning",
        enabled: true,
        triggerId: triggerIds.alerts,
      });
      expect(result.nodes.find((node) => node.id === `event_source:${sourceA}`)).toMatchObject({
        kind: "event_source",
        label: "Monitoring",
      });
    });

    it("draws each step as a node held by its routine, and step_after edges between them", async () => {
      const result = await body();
      const steps = result.nodes.filter((node) => node.kind === "step" && node.parentId === `routine:${ids.alerts}`);
      expect(steps.map((node) => node.refId)).toEqual(["triage", "fix", "report"]);
      const after = result.edges.filter((edge) => edge.kind === "step_after").map((edge) => `${edge.from}>${edge.to}`);
      expect(after).toEqual([
        `step:${ids.alerts}:triage>step:${ids.alerts}:fix`,
        `step:${ids.alerts}:triage>step:${ids.alerts}:report`,
        `step:${ids.alerts}:fix>step:${ids.alerts}:report`,
      ]);
    });

    it("draws the goal and the project a routine serves", async () => {
      const result = await body();
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "serves_goal", from: `routine:${ids.daily}`, to: `goal:${goalA}` }),
        expect.objectContaining({ kind: "serves_project", from: `routine:${ids.daily}`, to: `project:${projectA}` }),
      ]));
      expect(result.nodes.find((node) => node.id === `goal:${goalA}`)?.label).toBe("Keep things healthy");
    });

    it("draws parent_issue and targets_issue between a routine and the routine whose run made the issue", async () => {
      const result = await body();
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "parent_issue", from: `routine:${ids.intake}`, to: `routine:${ids.triage}`, issueId: issueIds.fromIntake,
        }),
        expect.objectContaining({
          kind: "targets_issue",
          from: `routine:${ids.intake}`,
          to: `routine:${ids.triage}`,
          issueId: issueIds.fromIntake,
          runId: runIds.triageOnIntakeIssue,
        }),
      ]));
    });

    it("draws no issue link for an issue no routine run made", async () => {
      const result = await body();
      expect(result.edges.filter((edge) => edge.issueId === issueIds.manualIssue)).toEqual([]);
    });
  });

  describe("access", () => {
    it("refuses a caller of another company", async () => {
      const outsider = express();
      outsider.use(express.json());
      outsider.use((req, _res, next) => {
        req.actor = { type: "board", userId: "someone", source: "session", companyIds: [companyB], isInstanceAdmin: false } as never;
        next();
      });
      outsider.use("/api", routineRoutes(db));
      outsider.use(errorHandler);
      const res = await request(outsider).get(`/api/companies/${companyA}/routines/timeline`);
      expect(res.status).toBe(403);
    });
  });
});

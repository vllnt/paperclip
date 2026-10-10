import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  issueComments,
  issueDuplicatePairs,
  issues,
  judgeUsageDaily,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueDuplicateRoutes } from "../routes/issue-duplicates.js";
import { companyService } from "../services/companies.js";
import { duplicateDetectionService } from "../services/duplicate-detection.js";
import { issueService } from "../services/issues.js";
import { trigramSimilarity } from "../services/duplicate-lexical.js";
import {
  createJudgeUsageStore,
  type JudgeClient,
  type JudgeOutcome,
} from "../services/judge-client.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

type Db = ReturnType<typeof useEmbeddedPostgres>["db"];

const TITLE = "[Chore] Remove @songtrivia/client compatibility barrels";

function judgeAnswering(probability: number): JudgeClient & { ask: ReturnType<typeof vi.fn> } {
  const outcome: JudgeOutcome = {
    ok: true,
    answers: { same_outcome: { type: "predicate", probability, abstained: probability > 0.3 && probability < 0.9 } },
    modelId: "typesafe-ai/jev-1.2",
    inputHash: "hash",
    cached: false,
  };
  return { isAvailable: async () => true, ask: vi.fn(async () => outcome) };
}

function serviceFor(db: Db, judge: JudgeClient, overrides: { retryDelaysMs?: readonly number[] } = {}) {
  const issuesSvc = issueService(db);
  return duplicateDetectionService({
    db,
    judge,
    ...overrides,
    postSystemComment: (issueId, body, tx) => issuesSvc.addComment(issueId, body, {}, { authorType: "system" }, tx),
  });
}

let issueCounter = 0;
async function seedIssue(
  db: Db,
  companyId: string,
  overrides: Partial<typeof issues.$inferInsert> = {},
) {
  issueCounter += 1;
  const id = overrides.id ?? randomUUID();
  const [prefix] = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId));
  await db.insert(issues).values({
    id,
    companyId,
    title: TITLE,
    status: "todo",
    issueNumber: issueCounter,
    identifier: `${prefix?.issuePrefix ?? "T"}-${issueCounter}`,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  });
  return id;
}

async function setMode(db: Db, companyId: string, mode: "off" | "suggest" | "comment") {
  await db.update(companies).set({ duplicateDetectionMode: mode }).where(eq(companies.id, companyId));
}

async function reset(db: Db) {
  await db.delete(judgeUsageDaily);
  await db.delete(issueDuplicatePairs);
  await db.delete(activityLog);
  await db.delete(issueComments);
  await resetCompanyIssueFixtures(db);
}

describeEmbeddedPostgres("duplicate detection against real Postgres", () => {
  const pg = useEmbeddedPostgres("paperclip-duplicate-detection-", { resetEach: reset });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("pg_trgm candidate retrieval", () => {
    it.each([
      ["word", "two words"],
      [TITLE, "Remove @songtrivia/client compat barrels"],
      ["Enforce PR assignee and GitHub issue linkage", "Enforce PR assignee linkage to GitHub issues"],
    ])("pg_trgm similarity(%s, %s) equals the JS implementation", async (a, b) => {
      const rows = await pg.db.execute(sql`SELECT similarity(${a}, ${b}) AS sim`);
      expect(Number(Array.from(rows)[0]?.sim)).toBeCloseTo(trigramSimilarity(a, b), 5);
    });

    it("treats non-ASCII letters per the database locale: the JS mirror matches UTF-8 locales only", async () => {
      const [a, b] = ["Ünïcode títle", "unicode title"];
      const rows = await pg.db.execute(sql`
        SELECT similarity(${a}, ${b}) AS sim,
               (SELECT datctype FROM pg_database WHERE datname = current_database()) AS ctype
      `);
      const row = Array.from(rows)[0];
      const asciiLocale = row?.ctype === "C" || row?.ctype === "POSIX";
      if (asciiLocale) {
        expect(Number(row?.sim)).not.toBeCloseTo(trigramSimilarity(a, b), 5);
      } else {
        expect(Number(row?.sim)).toBeCloseTo(trigramSimilarity(a, b), 5);
      }
    });

    it("returns only same-company, live, visible candidates and never the issue itself", async () => {
      const mine = await seedCompanyWithBoardAccess(pg.db, "Mine");
      const theirs = await seedCompanyWithBoardAccess(pg.db, "Theirs");
      const routineId = randomUUID();
      const near = await seedIssue(pg.db, mine.companyId, { title: "Remove songtrivia client compatibility barrels" });
      const recentlyDone = await seedIssue(pg.db, mine.companyId, {
        status: "done",
        completedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
      });
      await seedIssue(pg.db, mine.companyId, { status: "done", completedAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) });
      await seedIssue(pg.db, mine.companyId, { status: "cancelled" });
      await seedIssue(pg.db, mine.companyId, { hiddenAt: new Date() });
      await seedIssue(pg.db, mine.companyId, { title: "Add dark mode to the billing settings page" });
      await seedIssue(pg.db, mine.companyId, { originKind: "routine_execution", originId: routineId });
      const foreign = await seedIssue(pg.db, theirs.companyId);
      const self = await seedIssue(pg.db, mine.companyId, { createdAt: new Date("2026-10-05T00:00:00Z") });

      const svc = serviceFor(pg.db, judgeAnswering(0.5));
      const result = await svc.findSimilar({ companyId: mine.companyId, title: TITLE, issueId: self, origin: { kind: "routine_execution", id: routineId } });

      const ids = result.candidates.map((candidate) => candidate.issueId);
      expect(ids).toContain(near);
      expect(ids).toContain(recentlyDone);
      expect(ids).not.toContain(foreign);
      expect(ids).not.toContain(self);
      expect(ids).toHaveLength(2);
    });

    it("matches an identical title and caps the pool to the top five", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Crowded");
      for (let index = 0; index < 8; index += 1) await seedIssue(pg.db, companyId);
      const svc = serviceFor(pg.db, judgeAnswering(0.1));
      const result = await svc.findSimilar({ companyId, title: TITLE });
      expect(result.candidates).toHaveLength(5);
      expect(result.candidates.every((candidate) => candidate.verdict === "exact")).toBe(true);
      expect(result.recommendation).toBe("likely_duplicate");
    });
  });

  describe("findSimilar modes", () => {
    it("runs the free tier only, with no model call, when the company is off", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Off");
      await seedIssue(pg.db, companyId, { title: "Remove songtrivia client compatibility barrels" });
      const judge = judgeAnswering(0.99);
      const result = await serviceFor(pg.db, judge).findSimilar({ companyId, title: TITLE });
      expect(judge.ask).not.toHaveBeenCalled();
      expect(result).toMatchObject({ mode: "off", modelUsed: false, degradedReason: "mode_off" });
      expect(result.candidates[0]).toMatchObject({ verdict: "lexical_only", sameOutcomeProbability: null });
    });

    it("asks the model once per candidate pair when the company opted in, and writes no ledger rows", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Suggest");
      await setMode(pg.db, companyId, "suggest");
      await seedIssue(pg.db, companyId, { title: "Remove songtrivia client compatibility barrels" });
      await seedIssue(pg.db, companyId, { title: "Remove songtrivia client compat barrels from the monorepo" });
      const judge = judgeAnswering(0.95);
      const result = await serviceFor(pg.db, judge).findSimilar({ companyId, title: TITLE });
      expect(judge.ask).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ mode: "suggest", modelUsed: true, degradedReason: null, recommendation: "likely_duplicate" });
      expect(await pg.db.select().from(issueDuplicatePairs)).toHaveLength(0);
    });
  });

  describe("after-create check", () => {
    async function seedPair(companyId: string, candidateCreatedAt: Date) {
      const older = await seedIssue(pg.db, companyId, { title: "Remove songtrivia client compatibility barrels", createdAt: candidateCreatedAt });
      const created = await seedIssue(pg.db, companyId, { createdAt: new Date("2026-10-02T00:00:00Z") });
      const [row] = await pg.db.select().from(issues).where(eq(issues.id, created));
      if (!row) throw new Error("seed failed");
      return { older, created: row };
    }

    function asCreated(row: typeof issues.$inferSelect) {
      return { id: row.id, companyId: row.companyId };
    }

    it("does nothing while the company is off", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Off");
      const { created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      const judge = judgeAnswering(0.99);
      await serviceFor(pg.db, judge).checkAfterCreate(asCreated(created));
      expect(judge.ask).not.toHaveBeenCalled();
      expect(await pg.db.select().from(issueDuplicatePairs)).toHaveLength(0);
    });

    it("records the ledger but posts nothing in suggest mode", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Suggest");
      await setMode(pg.db, companyId, "suggest");
      const { older, created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      await serviceFor(pg.db, judgeAnswering(0.97)).checkAfterCreate(asCreated(created));

      const pairs = await pg.db.select().from(issueDuplicatePairs);
      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({
        companyId,
        issueId: created.id,
        candidateIssueId: older,
        verdict: "likely_duplicate",
        sameOutcomeProbability: 0.97,
        modelId: "typesafe-ai/jev-1.2",
        commentId: null,
        label: null,
      });
      expect(pairs[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await pg.db.select().from(issueComments)).toHaveLength(0);
    });

    it("posts exactly one system comment and one activity entry, even when run twice", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Comment");
      await setMode(pg.db, companyId, "comment");
      const { older, created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      const svc = serviceFor(pg.db, judgeAnswering(0.97));

      await svc.checkAfterCreate(asCreated(created));
      await svc.checkAfterCreate(asCreated(created));

      const comments = await pg.db.select().from(issueComments).where(eq(issueComments.issueId, created.id));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.authorType).toBe("system");
      expect(comments[0]?.body).toContain("Possible duplicate");
      expect(comments[0]?.body).toContain("0.97");
      expect(comments[0]?.body).toContain("suggestion only");
      const [pair] = await pg.db.select().from(issueDuplicatePairs);
      expect(pair?.commentId).toBe(comments[0]?.id);
      expect(comments[0]?.body).toContain(pair?.id ?? "missing");

      const activity = await pg.db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.duplicate_suspected")));
      expect(activity).toHaveLength(1);
      expect(activity[0]?.entityId).toBe(created.id);

      const [olderRow] = await pg.db.select().from(issues).where(eq(issues.id, older));
      expect(olderRow?.status).toBe("todo");
      expect(await pg.db.select().from(issueComments).where(eq(issueComments.issueId, older))).toHaveLength(0);
    });

    it("stays silent below the alert threshold and when the candidate is newer", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Quiet");
      await setMode(pg.db, companyId, "comment");

      const below = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      await serviceFor(pg.db, judgeAnswering(0.7)).checkAfterCreate(asCreated(below.created));
      expect(await pg.db.select().from(issueComments)).toHaveLength(0);

      const other = await seedCompanyWithBoardAccess(pg.db, "Newer");
      await setMode(pg.db, other.companyId, "comment");
      const newer = await seedPair(other.companyId, new Date("2026-10-03T00:00:00Z"));
      await serviceFor(pg.db, judgeAnswering(0.99)).checkAfterCreate(asCreated(newer.created));
      expect(await pg.db.select().from(issueComments).where(eq(issueComments.issueId, newer.created.id))).toHaveLength(0);
      expect(await pg.db.select().from(issueDuplicatePairs).where(eq(issueDuplicatePairs.issueId, newer.created.id))).toHaveLength(0);
    });

    it("posts one comment per issue even when the candidate changes between runs", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Idempotent");
      await setMode(pg.db, companyId, "comment");
      const { older, created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      const svc = serviceFor(pg.db, judgeAnswering(0.97));
      await svc.checkAfterCreate(asCreated(created));
      await pg.db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, older));
      await Promise.all([svc.checkAfterCreate(asCreated(created)), svc.checkAfterCreate(asCreated(created))]);

      expect(await pg.db.select().from(issueComments).where(eq(issueComments.issueId, created.id))).toHaveLength(1);
      const pairs = await pg.db.select().from(issueDuplicatePairs).where(eq(issueDuplicatePairs.issueId, created.id));
      expect(pairs.filter((pair) => pair.commentId !== null)).toHaveLength(1);
    });

    it("comments on exactly one of two issues created in the same instant", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Tie");
      await setMode(pg.db, companyId, "comment");
      const sameInstant = new Date("2026-10-02T00:00:00.000Z");
      const a = await seedIssue(pg.db, companyId, { createdAt: sameInstant });
      const b = await seedIssue(pg.db, companyId, { createdAt: sameInstant });
      const svc = serviceFor(pg.db, judgeAnswering(0.97));
      for (const id of [a, b]) {
        const [row] = await pg.db.select().from(issues).where(eq(issues.id, id));
        if (!row) throw new Error("seed failed");
        await svc.checkAfterCreate(asCreated(row));
      }
      expect(await pg.db.select().from(issueComments)).toHaveLength(1);
    });

    it("redacts secrets in existing issues before they are sent to the model", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Redact");
      await setMode(pg.db, companyId, "suggest");
      const token = "abcdefghijklmnopqrstuvwxyz0123456789";
      await seedIssue(pg.db, companyId, {
        title: "Rotate the database credentials for staging",
        description: `Authorization: Bearer ${token}`,
      });
      const judge = judgeAnswering(0.1);
      await serviceFor(pg.db, judge).findSimilar({ companyId, title: "Rotate the database credentials for staging today" });
      expect(judge.ask).toHaveBeenCalled();
      expect(JSON.stringify(judge.ask.mock.calls)).not.toContain(token);
    });

    it("advises creating, instead of failing, when the check itself cannot run", async () => {
      const result = await serviceFor(pg.db, judgeAnswering(0.5)).findSimilar({ companyId: "not-a-uuid", title: TITLE });
      expect(result).toMatchObject({ recommendation: "create", degradedReason: "error", candidates: [] });
    });

    it("skips a company without its own gateway key and notes it once a day", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "No key");
      await setMode(pg.db, companyId, "comment");
      const { created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      const judge = { isAvailable: async () => false, ask: vi.fn() };
      const svc = serviceFor(pg.db, judge);

      await svc.checkAfterCreate(asCreated(created));
      await svc.checkAfterCreate(asCreated(created));

      expect(judge.ask).not.toHaveBeenCalled();
      expect(await pg.db.select().from(issueDuplicatePairs)).toHaveLength(0);
      expect(await pg.db.select().from(issueComments)).toHaveLength(0);
      const notes = await pg.db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "duplicate_detection.skipped")));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.details).toMatchObject({ reason: "missing_secret", secretName: "AI_GATEWAY_API_KEY" });
    });

    it("does not note anything for a company that is off, even without a key", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Off no key");
      const { created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      await serviceFor(pg.db, { isAvailable: async () => false, ask: vi.fn() }).checkAfterCreate(asCreated(created));
      expect(await pg.db.select().from(activityLog).where(eq(activityLog.action, "duplicate_detection.skipped"))).toHaveLength(0);
    });

    it("waits for an issue that is not visible yet, then checks it", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Late commit");
      await setMode(pg.db, companyId, "suggest");
      await seedIssue(pg.db, companyId, { title: "Remove songtrivia client compatibility barrels" });
      const lateId = randomUUID();
      const judge = judgeAnswering(0.95);
      const svc = serviceFor(pg.db, judge, { retryDelaysMs: [30, 30, 30] });

      await svc.checkAfterCreate({ id: lateId, companyId });
      expect(judge.ask).not.toHaveBeenCalled();
      await seedIssue(pg.db, companyId, { id: lateId, createdAt: new Date("2026-10-02T00:00:00Z") });

      const deadline = Date.now() + 3_000;
      let pairs: Array<typeof issueDuplicatePairs.$inferSelect> = [];
      while (Date.now() < deadline && pairs.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        pairs = await pg.db.select().from(issueDuplicatePairs).where(eq(issueDuplicatePairs.issueId, lateId));
      }
      expect(pairs).toHaveLength(1);
    });

    it("gives up quietly when the issue never appears", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Rolled back");
      await setMode(pg.db, companyId, "suggest");
      const judge = judgeAnswering(0.95);
      const svc = serviceFor(pg.db, judge, { retryDelaysMs: [5, 5] });
      await expect(svc.checkAfterCreate({ id: randomUUID(), companyId })).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(judge.ask).not.toHaveBeenCalled();
      expect(await pg.db.select().from(issueDuplicatePairs)).toHaveLength(0);
    });

    it("never loads an issue through another company's reference", async () => {
      const mine = await seedCompanyWithBoardAccess(pg.db, "Mine");
      const theirs = await seedCompanyWithBoardAccess(pg.db, "Theirs");
      await setMode(pg.db, theirs.companyId, "suggest");
      const { created } = await seedPair(mine.companyId, new Date("2026-10-01T00:00:00Z"));
      const judge = judgeAnswering(0.95);
      await serviceFor(pg.db, judge, { retryDelaysMs: [] }).checkAfterCreate({ id: created.id, companyId: theirs.companyId });
      expect(judge.ask).not.toHaveBeenCalled();
      expect(await pg.db.select().from(issueDuplicatePairs)).toHaveLength(0);
    });

    it("fails open: a failing model leaves lexical-only ledger rows and never throws", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Fail");
      await setMode(pg.db, companyId, "comment");
      const { created } = await seedPair(companyId, new Date("2026-10-01T00:00:00Z"));
      const failing: JudgeClient = {
        isAvailable: async () => true,
        ask: async () => ({ ok: false, reason: "timeout", inputHash: "h" }),
      };
      await expect(serviceFor(pg.db, failing).checkAfterCreate(asCreated(created))).resolves.toBeUndefined();
      const [pair] = await pg.db.select().from(issueDuplicatePairs);
      expect(pair).toMatchObject({ verdict: "lexical_only", sameOutcomeProbability: null, modelId: null });
      expect(await pg.db.select().from(issueComments)).toHaveLength(0);
    });

    it("never throws into the caller when the database fails", async () => {
      const svc = serviceFor(pg.db, judgeAnswering(0.5));
      await expect(
        svc.checkAfterCreate({ id: randomUUID(), companyId: "not-a-uuid" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("company responses", () => {
    it("read the duplicate detection mode back from get, list and update", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Rollout");
      const companiesSvc = companyService(pg.db);
      expect((await companiesSvc.getById(companyId))?.duplicateDetectionMode).toBe("off");

      const updated = await companiesSvc.update(companyId, { duplicateDetectionMode: "comment" });
      expect(updated?.duplicateDetectionMode).toBe("comment");
      expect((await companiesSvc.getById(companyId))?.duplicateDetectionMode).toBe("comment");
      const listed = (await companiesSvc.list()).find((company) => company.id === companyId);
      expect(listed?.duplicateDetectionMode).toBe("comment");
    });
  });

  describe("labels and company scoping", () => {
    it("labels pairs inside the company and refuses other companies", async () => {
      const mine = await seedCompanyWithBoardAccess(pg.db, "Mine");
      const theirs = await seedCompanyWithBoardAccess(pg.db, "Theirs");
      await setMode(pg.db, mine.companyId, "suggest");
      await seedIssue(pg.db, mine.companyId, { title: "Remove songtrivia client compatibility barrels" });
      const created = await seedIssue(pg.db, mine.companyId, { createdAt: new Date("2026-10-02T00:00:00Z") });
      const svc = serviceFor(pg.db, judgeAnswering(0.95));
      const [row] = await pg.db.select().from(issues).where(eq(issues.id, created));
      if (!row) throw new Error("seed failed");
      await svc.checkAfterCreate({ id: row.id, companyId: row.companyId });
      const [pair] = await pg.db.select().from(issueDuplicatePairs);
      if (!pair) throw new Error("expected a pair");

      await expect(
        svc.labelPair(theirs.companyId, pair.id, "duplicate", { type: "user", id: theirs.userId }),
      ).rejects.toMatchObject({ status: 404 });
      expect((await svc.listPairs(theirs.companyId, created))).toHaveLength(0);

      const labeled = await svc.labelPair(mine.companyId, pair.id, "keep_both", { type: "agent", id: "agent-1" });
      expect(labeled).toMatchObject({ label: "keep_both", labeledByType: "agent", labeledById: "agent-1" });
      const listed = await svc.listPairs(mine.companyId, created);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ label: "keep_both", candidateTitle: "Remove songtrivia client compatibility barrels" });
    });
  });

  describe("daily call cap", () => {
    it("reserves atomically up to the cap per company and UTC day", async () => {
      const a = await seedCompanyWithBoardAccess(pg.db, "A");
      const b = await seedCompanyWithBoardAccess(pg.db, "B");
      const store = createJudgeUsageStore(pg.db, 2, () => new Date("2026-10-09T12:00:00Z"));

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.reserve(a.companyId)));
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await store.reserve(b.companyId)).toBe(true);

      const nextDay = createJudgeUsageStore(pg.db, 2, () => new Date("2026-10-10T00:00:01Z"));
      expect(await nextDay.reserve(a.companyId)).toBe(true);

      const [row] = await pg.db
        .select()
        .from(judgeUsageDaily)
        .where(and(eq(judgeUsageDaily.companyId, a.companyId), eq(judgeUsageDaily.day, "2026-10-09")));
      expect(row?.calls).toBe(2);
    });

    it("disables model calls when the cap is zero", async () => {
      const { companyId } = await seedCompanyWithBoardAccess(pg.db, "Zero");
      expect(await createJudgeUsageStore(pg.db, 0).reserve(companyId)).toBe(false);
    });
  });

  describe("HTTP routes", () => {
    function appFor(actor: BoardActor | { type: "agent"; companyId: string; agentId: string; source: string; keyScope?: { kind: string } }, svc: ReturnType<typeof serviceFor>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        Object.assign(req, { actor });
        next();
      });
      app.use("/api", issueDuplicateRoutes(pg.db, svc));
      app.use(errorHandler);
      return app;
    }

    it("serves board checks for their own company and rejects other companies", async () => {
      const mine = await seedCompanyWithBoardAccess(pg.db, "Mine");
      const theirs = await seedCompanyWithBoardAccess(pg.db, "Theirs");
      await seedIssue(pg.db, mine.companyId, { title: "Remove songtrivia client compatibility barrels" });
      const app = appFor(mine.actor, serviceFor(pg.db, judgeAnswering(0.5)));

      const ok = await request(app).post(`/api/companies/${mine.companyId}/issues/similar`).send({ title: TITLE });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ mode: "off", modelUsed: false, recommendation: "review_candidates" });
      expect(ok.body.candidates).toHaveLength(1);

      const denied = await request(app).post(`/api/companies/${theirs.companyId}/issues/similar`).send({ title: TITLE });
      expect(denied.status).toBe(403);
    });

    it("rejects invalid bodies and lets agent keys act only inside their company", async () => {
      const mine = await seedCompanyWithBoardAccess(pg.db, "Mine");
      const theirs = await seedCompanyWithBoardAccess(pg.db, "Theirs");
      const agentApp = appFor(
        { type: "agent", companyId: mine.companyId, agentId: randomUUID(), source: "agent_key" },
        serviceFor(pg.db, judgeAnswering(0.5)),
      );

      expect((await request(agentApp).post(`/api/companies/${mine.companyId}/issues/similar`).send({ title: "" })).status).toBe(400);
      expect((await request(agentApp).post(`/api/companies/${mine.companyId}/issues/similar`).send({ title: TITLE, extra: 1 })).status).toBe(400);
      expect((await request(agentApp).post(`/api/companies/${mine.companyId}/issues/similar`).send({ title: TITLE })).status).toBe(200);
      expect((await request(agentApp).post(`/api/companies/${theirs.companyId}/issues/similar`).send({ title: TITLE })).status).toBe(403);

      const skillTest = appFor(
        { type: "agent", companyId: mine.companyId, agentId: randomUUID(), source: "agent_key", keyScope: { kind: "skill_test" } },
        serviceFor(pg.db, judgeAnswering(0.5)),
      );
      expect((await request(skillTest).post(`/api/companies/${mine.companyId}/issues/similar`).send({ title: TITLE })).status).toBe(403);
    });

    it("lists and labels pairs over HTTP without crossing companies", async () => {
      const mine = await seedCompanyWithBoardAccess(pg.db, "Mine");
      const theirs = await seedCompanyWithBoardAccess(pg.db, "Theirs");
      await setMode(pg.db, mine.companyId, "suggest");
      await seedIssue(pg.db, mine.companyId, { title: "Remove songtrivia client compatibility barrels" });
      const created = await seedIssue(pg.db, mine.companyId, { createdAt: new Date("2026-10-02T00:00:00Z") });
      const svc = serviceFor(pg.db, judgeAnswering(0.95));
      const [row] = await pg.db.select().from(issues).where(eq(issues.id, created));
      if (!row) throw new Error("seed failed");
      await svc.checkAfterCreate({ id: row.id, companyId: row.companyId });
      const [pair] = await pg.db.select().from(issueDuplicatePairs);
      if (!pair) throw new Error("expected a pair");

      const mineApp = appFor(mine.actor, svc);
      const theirApp = appFor(theirs.actor, svc);

      const listed = await request(mineApp).get(`/api/issues/${created}/duplicate-pairs`);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect((await request(theirApp).get(`/api/issues/${created}/duplicate-pairs`)).status).toBe(404);

      expect((await request(mineApp).post(`/api/companies/${mine.companyId}/issue-duplicate-pairs/${pair.id}/label`).send({ label: "maybe" })).status).toBe(400);
      expect((await request(mineApp).post(`/api/companies/${mine.companyId}/issue-duplicate-pairs/not-a-uuid/label`).send({ label: "duplicate" })).status).toBe(404);
      expect((await request(theirApp).post(`/api/companies/${theirs.companyId}/issue-duplicate-pairs/${pair.id}/label`).send({ label: "duplicate" })).status).toBe(404);
      const labeled = await request(mineApp).post(`/api/companies/${mine.companyId}/issue-duplicate-pairs/${pair.id}/label`).send({ label: "duplicate" });
      expect(labeled.status).toBe(200);
      expect(labeled.body).toMatchObject({ label: "duplicate", labeledByType: "user", labeledById: mine.userId });

      const activity = await pg.db.select().from(activityLog).where(eq(activityLog.action, "issue.duplicate_labeled"));
      expect(activity).toHaveLength(1);
    });
  });
});

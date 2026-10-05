import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, projects, createDb } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
describeDb("plugin issue sync host contract", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-sync-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });
  it("replays concurrent imported tasks, keeps same-title sources distinct and scopes retry keys by plugin and company", async () => {
    const [a, b] = await db.insert(companies).values([
      { name: "Sync A", issuePrefix: `A${randomUUID().slice(0, 6)}` }, { name: "Sync B", issuePrefix: `B${randomUUID().slice(0, 6)}` },
    ]).returning();
    const bus = { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }) } as never;
    const github = buildHostServices(db, randomUUID(), "test.github", bus);
    const linear = buildHostServices(db, randomUUID(), "test.linear", bus);
    const input = { companyId: a.id, title: "Same issue title", idempotencyKey: "source-1", allowDuplicate: true };
    const [first, replay] = await Promise.all([github.issues.create(input), github.issues.create(input)]);
    expect(replay.id).toBe(first.id);
    const secondSource = await github.issues.create({ ...input, idempotencyKey: "source-2" });
    const otherPlugin = await linear.issues.create(input);
    const otherCompany = await github.issues.create({ ...input, companyId: b.id });
    expect(new Set([first.id, secondSource.id, otherPlugin.id, otherCompany.id]).size).toBe(4);
    const [projectA, projectB] = await db.insert(projects).values([{ companyId: a.id, name: "Linked" }, { companyId: b.id, name: "Foreign" }]).returning();
    expect(await github.issues.update({ issueId: first.id, companyId: a.id, patch: { projectId: projectA.id } })).toMatchObject({ projectId: projectA.id });
    await expect(github.issues.update({ issueId: first.id, companyId: a.id, patch: { projectId: projectB.id } })).rejects.toThrow();
    expect(await github.issues.get({ issueId: first.id, companyId: b.id })).toBeNull();
    await expect(github.issues.update({ issueId: first.id, companyId: b.id, patch: { title: "Forbidden" } })).rejects.toThrow();
  });
});

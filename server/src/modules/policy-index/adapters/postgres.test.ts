import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  companyPolicies,
  companySkills,
  documentRevisions,
  documents,
  issueComments,
  issues,
  principalPermissionGrants,
  projects,
  type Db,
} from "@paperclipai/db";
import type { CreateCompanyPolicy, UpdateCompanyPolicy } from "@paperclipai/shared";
import { POLICY_INDEX_QUERY_LIMIT } from "@paperclipai/shared";
import { companyPolicyService } from "../../../services/company-policies.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "../../../__tests__/helpers/route-test-harness.js";
import { createPolicyIndexResolver } from "../index.js";
import { createMentionScanCache } from "./scan-cache.js";

async function resetFixtures(db: Db) {
  await db.delete(companyPolicies);
  await db.delete(documentRevisions);
  await db.delete(documents);
  await db.delete(issueComments);
  await db.delete(issues);
  await db.delete(companySkills);
  await db.delete(projects);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describeEmbeddedPostgres("policy index postgres adapters", () => {
  const ctx = useEmbeddedPostgres("paperclip-policy-index-", { resetEach: resetFixtures });

  async function seed(name = "Index") {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const policies = companyPolicyService(ctx.db);
    const create = (input: Partial<CreateCompanyPolicy> & { key: string; title: string }) =>
      policies.create(seeded.companyId, { status: "active", body: "# body", ...input } as CreateCompanyPolicy, { userId: seeded.userId });
    const [project] = await ctx.db.insert(projects).values({ companyId: seeded.companyId, name: "Site" }).returning();
    const [other] = await ctx.db.insert(projects).values({ companyId: seeded.companyId, name: "Other" }).returning();
    const [issue] = await ctx.db
      .insert(issues)
      .values({ companyId: seeded.companyId, title: "Task", status: "todo", priority: "medium", projectId: project!.id })
      .returning();
    const update = (key: string, input: UpdateCompanyPolicy) =>
      policies.update(seeded.companyId, key, input, { userId: seeded.userId });
    return { ...seeded, create, update, project: project!, other: other!, issue: issue! };
  }

  it("lists the company's and the project's active policies, with title and summary and no body", async () => {
    const { companyId, create, project, other, issue } = await seed();
    await create({ key: "company-rule", title: "Company rule", summary: "Applies everywhere." });
    await create({ key: "project-rule", title: "Project rule", projectId: project.id });
    await create({ key: "other-project-rule", title: "Other project rule", projectId: other.id });
    await create({ key: "a-draft", title: "A draft", status: "draft" });
    await create({ key: "an-archive", title: "An archive", status: "archived" });

    const resolver = createPolicyIndexResolver(ctx.db);
    const index = await resolver.resolve({ companyId, projectId: project.id, issue: { id: issue.id, title: issue.title, description: null } });

    expect(index.entries).toEqual([
      { state: "active", key: "company-rule", title: "Company rule", summary: "Applies everywhere.", scope: "company", via: "scope" },
      { state: "active", key: "project-rule", title: "Project rule", summary: null, scope: "project", via: "scope" },
    ]);
    expect(index.moreCount).toBe(0);
    expect(JSON.stringify(index)).not.toContain("# body");
  });

  it("never reads another company's policies, not even a mentioned key", async () => {
    const mine = await seed("Mine");
    const theirs = await seed("Theirs");
    await theirs.create({ key: "their-secret", title: "Their secret" });
    await theirs.create({ key: "their-other", title: "Their other" });
    await mine.create({ key: "my-rule", title: "My rule" });

    const resolver = createPolicyIndexResolver(ctx.db);
    const index = await resolver.resolve({
      companyId: mine.companyId,
      projectId: null,
      issue: { id: mine.issue.id, title: "See [x](policy://their-secret)", description: null },
    });
    expect(index.entries).toEqual([
      expect.objectContaining({ key: "my-rule", state: "active" }),
      { state: "not_active", key: "their-secret" },
    ]);
    expect(JSON.stringify(index)).not.toContain("Their");
  });

  it("shows a mentioned draft, archived or unknown key as not active and a mentioned active policy of another project as mentioned", async () => {
    const { companyId, create, project, other, issue } = await seed();
    await create({ key: "a-draft", title: "A draft", status: "draft" });
    await create({ key: "an-archive", title: "An archive", status: "archived" });
    await create({ key: "other-project-rule", title: "Other project rule", projectId: other.id });

    const resolver = createPolicyIndexResolver(ctx.db);
    const index = await resolver.resolve({
      companyId,
      projectId: project.id,
      issue: {
        id: issue.id,
        title: "Task",
        description: "[a](policy://a-draft) [b](policy://an-archive) [c](policy://nothing-here) [d](policy://other-project-rule)",
      },
    });
    expect(index.entries).toEqual([
      expect.objectContaining({ key: "other-project-rule", via: "mention", scope: "project" }),
      { state: "not_active", key: "a-draft" },
      { state: "not_active", key: "an-archive" },
      { state: "not_active", key: "nothing-here" },
    ]);
  });

  it("caps 100+ policies, keeps mentioned rows first, and counts the rest", async () => {
    const { companyId, create, issue } = await seed();
    const total = POLICY_INDEX_QUERY_LIMIT + 8;
    for (let index = 0; index < total; index += 1) {
      await create({ key: `policy-${String(index).padStart(3, "0")}`, title: `Policy ${String(index).padStart(3, "0")}` });
    }
    const resolver = createPolicyIndexResolver(ctx.db);
    const index = await resolver.resolve({
      companyId,
      projectId: null,
      issue: { id: issue.id, title: "Task", description: `[last](policy://policy-${String(total - 1).padStart(3, "0")})` },
    });
    expect(index.entries.length).toBe(20);
    expect(index.moreCount).toBe(total - 20);
    expect(index.entries.map((entry) => entry.key)).toContain(`policy-${String(total - 1).padStart(3, "0")}`);
  }, 60_000);

  it("reads only comments that hold a policy link, and not deleted ones", async () => {
    const { companyId, create, issue } = await seed();
    await create({ key: "from-comment", title: "From comment" });
    await create({ key: "from-deleted", title: "From deleted" });
    await ctx.db.insert(issueComments).values([
      { companyId, issueId: issue.id, body: "No link here." },
      { companyId, issueId: issue.id, body: "Apply [p](policy://from-comment)." },
      { companyId, issueId: issue.id, body: "Old [p](policy://from-deleted).", deletedAt: new Date() },
    ]);
    const resolver = createPolicyIndexResolver(ctx.db);
    const index = await resolver.resolve({ companyId, projectId: null, issue: { id: issue.id, title: "Task", description: null } });
    expect(index.entries.filter((entry) => entry.state === "active" && entry.via === "mention").map((entry) => entry.key)).toEqual([]);
    expect(index.entries.map((entry) => entry.key).sort()).toEqual(["from-comment", "from-deleted"]);
    expect(index.entries.find((entry) => entry.key === "from-deleted")).toMatchObject({ via: "scope" });
  });

  it("scans the company skills a run uses, and caches the scan until the skill changes", async () => {
    const { companyId, create, issue } = await seed();
    await create({ key: "skill-policy", title: "Skill policy" });
    await create({ key: "scoped-rule", title: "Scoped rule", projectId: (await ctx.db.insert(projects).values({ companyId, name: "Elsewhere" }).returning())[0]!.id });
    const [skill] = await ctx.db
      .insert(companySkills)
      .values({ companyId, key: "acme/skills/review", slug: "review", name: "Review", markdown: "Follow [p](policy://scoped-rule)." })
      .returning();
    const cache = createMentionScanCache();
    const resolver = createPolicyIndexResolver(ctx.db, { scanCache: cache });
    const input = { companyId, projectId: null, issue: { id: issue.id, title: "Task", description: null }, skillKeys: ["acme/skills/review"] };

    const first = await resolver.resolve(input);
    expect(first.entries.find((entry) => entry.key === "scoped-rule")).toMatchObject({ via: "mention" });
    expect(cache.size).toBe(1);

    // A second run reads no markdown: change it behind the cache's back and the scan still holds.
    await ctx.db.execute(`update company_skills set markdown = 'No policy any more.' where id = '${skill!.id}'`);
    const second = await resolver.resolve(input);
    expect(second.entries.find((entry) => entry.key === "scoped-rule")).toMatchObject({ via: "mention" });

    // An update changes the cache key, so the new markdown is scanned.
    await ctx.db.update(companySkills).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(companySkills.id, skill!.id));
    const third = await resolver.resolve(input);
    expect(third.entries.find((entry) => entry.key === "scoped-rule")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("scans the committed instructions file by content hash and ignores a missing file", async () => {
    const { companyId, create, update, issue } = await seed();
    await create({ key: "from-instructions", title: "From instructions" });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-index-"));
    tempRoots.push(root);
    const file = path.join(root, "AGENTS.md");
    const original = "Always read [p](policy://from-instructions).";
    await fs.writeFile(file, original);
    const before = await fs.stat(file);
    const cache = createMentionScanCache();
    const resolver = createPolicyIndexResolver(ctx.db, { scanCache: cache });
    const base = { companyId, projectId: null, issue: { id: issue.id, title: "Task", description: null } };

    const found = await resolver.resolve({ ...base, instructionsFilePath: file });
    expect(found.entries.find((entry) => entry.key === "from-instructions")).toBeDefined();
    await resolver.resolve({ ...base, instructionsFilePath: file });
    expect(cache.size).toBe(1);

    await expect(resolver.resolve({ ...base, instructionsFilePath: path.join(root, "missing.md") })).resolves.toBeDefined();

    // The scan only reads. A policy edit changes the index digest and never the instructions file, which
    // the agent's working copy is made from.
    await update("from-instructions", { summary: "Changed." });
    const edited = await resolver.resolve({ ...base, instructionsFilePath: file });
    expect(edited.digest).not.toBe(found.digest);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("reports an unreadable source and still returns the index", async () => {
    const { companyId, create, issue } = await seed();
    await create({ key: "company-rule", title: "Company rule" });
    const errors: unknown[] = [];
    const resolver = createPolicyIndexResolver(ctx.db, { onSourceError: (_source, error) => errors.push(error) });
    // A directory is not a readable file: the read fails, the run does not.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-index-"));
    tempRoots.push(root);
    const index = await resolver.resolve({ companyId, projectId: null, issue: { id: issue.id, title: "Task", description: null }, instructionsFilePath: root });
    expect(index.entries.map((entry) => entry.key)).toEqual(["company-rule"]);
  });
});

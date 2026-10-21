import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { CompanyPolicy, CompanyPolicyRevision } from "@paperclipai/shared";
import {
  createCompanyPolicySchema,
  listCompanyPoliciesQuerySchema,
  updateCompanyPolicySchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PolicyListOptions extends BaseClientOptions {
  companyId?: string;
  scope?: string;
  projectId?: string;
  status?: string;
}

interface PolicyBodyOptions {
  body?: string;
  bodyFile?: string;
}

interface PolicyCreateOptions extends BaseClientOptions, PolicyBodyOptions {
  companyId?: string;
  key: string;
  title: string;
  summary?: string;
  status?: string;
  projectId?: string;
  ownerAgentId?: string;
  ownerUserId?: string;
}

interface PolicyUpdateOptions extends BaseClientOptions, PolicyBodyOptions {
  companyId?: string;
  title?: string;
  summary?: string;
  status?: string;
  projectId?: string;
  ownerAgentId?: string;
  ownerUserId?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface PolicyDeleteOptions extends BaseClientOptions {
  companyId?: string;
  yes?: boolean;
}

/**
 * `paperclipai policy`: company and project policies, the written rules and guardrails agents follow.
 * Every company member and agent reads them; only the board writes them.
 */
export function registerPolicyCommands(program: Command): void {
  const policy = program
    .command("policy")
    .description("Company and project policies: written rules and guardrails for agents");

  addCommonClientOptions(
    policy
      .command("list")
      .description("List policies; company policies come first")
      .option("--scope <scope>", "company or project")
      .option("--project-id <id>", "Only this project's policies")
      .option("--status <status>", "draft, active or archived")
      .action(async (opts: PolicyListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = listCompanyPoliciesQuerySchema.parse({
            scope: opts.scope,
            projectId: opts.projectId,
            status: opts.status,
          });
          const params = new URLSearchParams(
            Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          );
          const suffix = params.size > 0 ? `?${params.toString()}` : "";
          const rows =
            (await ctx.api.get<CompanyPolicy[]>(`${apiPath`/api/companies/${ctx.companyId}/policies`}${suffix}`)) ?? [];
          if (ctx.json || rows.length === 0) {
            printOutput(rows, { json: ctx.json });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              key: row.key,
              status: row.status,
              scope: row.projectId ? "project" : "company",
              projectId: row.projectId,
              title: row.title,
              summary: row.summary,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    policy
      .command("get")
      .description("Get one policy with its full body")
      .argument("<key>", "Policy key")
      .action(async (key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<CompanyPolicy>(apiPath`/api/companies/${ctx.companyId}/policies/${key}`);
          if (ctx.json || !row) {
            printOutput(row, { json: ctx.json });
            return;
          }
          console.log(`${row.title}  [${row.status}, ${row.projectId ? `project ${row.projectId}` : "company"}]  policy://${row.key}`);
          if (row.summary) console.log(row.summary);
          console.log("");
          console.log(row.body);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    policy
      .command("history")
      .description("List a policy's revisions, newest first")
      .argument("<key>", "Policy key")
      .action(async (key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<CompanyPolicyRevision[]>(
              apiPath`/api/companies/${ctx.companyId}/policies/${key}/revisions`,
            )) ?? [];
          if (ctx.json || rows.length === 0) {
            printOutput(rows, { json: ctx.json });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              revision: row.revisionNumber,
              createdAt: row.createdAt,
              by: row.createdByUserId ?? row.createdByAgentId,
              title: row.title,
              changeSummary: row.changeSummary,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    policy
      .command("create")
      .description("Create a policy (board only). It starts as a draft unless you pass --status active")
      .requiredOption("--key <key>", "Lowercase slug, unique in the company; referenced as policy://<key>")
      .requiredOption("--title <title>", "Policy title")
      .option("--summary <text>", "One line shown in lists and to agents")
      .option("--body <markdown>", "Policy body")
      .option("--body-file <path>", "Read the policy body from a file")
      .option("--status <status>", "draft, active or archived")
      .option("--project-id <id>", "Make it a project policy")
      .option("--owner-agent-id <id>", "Owner agent ID")
      .option("--owner-user-id <id>", "Owner user ID")
      .action(async (opts: PolicyCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createCompanyPolicySchema.parse({
            key: opts.key,
            title: opts.title,
            summary: opts.summary,
            body: await readPolicyBody(opts),
            status: opts.status,
            projectId: opts.projectId,
            ownerAgentId: opts.ownerAgentId,
            ownerUserId: opts.ownerUserId,
          });
          const created = await ctx.api.post<CompanyPolicy>(apiPath`/api/companies/${ctx.companyId}/policies`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    policy
      .command("update")
      .description("Update a policy (board only). A new title or body saves a revision; --status archived retires it")
      .argument("<key>", "Policy key")
      .option("--title <title>", "Policy title")
      .option("--summary <text|null>", "One line shown in lists and to agents")
      .option("--body <markdown>", "Policy body")
      .option("--body-file <path>", "Read the policy body from a file")
      .option("--status <status>", "draft, active or archived")
      .option("--project-id <id|null>", "Move it to a project, or null to make it a company policy")
      .option("--owner-agent-id <id|null>", "Owner agent ID")
      .option("--owner-user-id <id|null>", "Owner user ID")
      .option("--change-summary <text>", "Saved with the new revision")
      .option("--base-revision-id <id>", "Fail with 409 if someone saved a newer revision")
      .action(async (key: string, opts: PolicyUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = updateCompanyPolicySchema.parse({
            title: opts.title,
            summary: parseNullableString(opts.summary),
            body: await readPolicyBody(opts),
            status: opts.status,
            projectId: parseNullableString(opts.projectId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
            ownerUserId: parseNullableString(opts.ownerUserId),
            changeSummary: opts.changeSummary,
            baseRevisionId: opts.baseRevisionId,
          });
          const updated = await ctx.api.patch<CompanyPolicy>(
            apiPath`/api/companies/${ctx.companyId}/policies/${key}`,
            payload,
          );
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    policy
      .command("delete")
      .description("Delete an archived policy with its revisions (board only). Archive a policy first")
      .argument("<key>", "Policy key")
      .option("--yes", "Confirm deletion")
      .action(async (key: string, opts: PolicyDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Deletion requires --yes.");
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const deleted = await ctx.api.delete<CompanyPolicy>(apiPath`/api/companies/${ctx.companyId}/policies/${key}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function readPolicyBody(opts: PolicyBodyOptions): Promise<string | undefined> {
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    throw new Error("Pass --body or --body-file, not both.");
  }
  return opts.bodyFile !== undefined ? readFile(opts.bodyFile, "utf8") : opts.body;
}

function parseNullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "null" ? null : value;
}

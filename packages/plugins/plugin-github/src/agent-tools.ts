import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { RepositoryManager, repoWriteAction, repoWrites, text } from "./management-repository.js";
import type { PluginWriteRequest } from "./write-identity.js";
import { nativeGitHubEndpoints, nativeConnectorRequiredError } from "./native-github.js";
import type { GitHubClient } from "./github.js";
import type { Catalog, Repository } from "./contracts.js";

/**
 * Agent-facing GitHub tools. Every call resolves an explicit repository from
 * the company's GitHub App catalog; credentials never enter tool parameters.
 */
export function registerAgentTools(
  ctx: PluginContext,
  github: GitHubClient,
  credentials: (companyId: string) => Promise<{ id: string; pem: string }>,
  loadCatalog: (companyId: string, refresh?: boolean) => Promise<Catalog>,
  /** The App user's token for a write when the company writes as its App user; null keeps the App. */
  writeToken: (companyId: string, repository: string | null, request: PluginWriteRequest) => Promise<string | null> = async () => null,
) {
  const schema = (properties: Record<string, unknown>, required: string[] = ["repository"]): Record<string, unknown> => ({
    type: "object", additionalProperties: false, properties: {
      repository: { type: "string", description: "GitHub repository in owner/name form." },
      ...properties,
    }, required,
  });

  const result = (data: unknown, content?: string): ToolResult => ({ data, content: content ?? JSON.stringify(data) });
  const fail = (error: unknown): ToolResult => ({ error: error instanceof Error ? error.message : "GitHub action failed." });

  async function repository(params: Record<string, unknown>, runCtx: ToolRunContext): Promise<{ repo: Repository; auth: { id: string; pem: string } }> {
    if (!runCtx.companyId || !runCtx.agentId || !runCtx.projectId) throw new Error("GitHub tools require a company, project and agent run context.");
    if (params.companyId !== undefined && params.companyId !== runCtx.companyId) throw new Error("This GitHub tool call belongs to another company.");
    const fullName = text(params.repository, "repository", 200);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error("Use a GitHub repository in owner/name form.");
    const catalog = await loadCatalog(runCtx.companyId);
    const repo = catalog.repositories.find(candidate => candidate.fullName.toLowerCase() === fullName.toLowerCase() &&
      (params.repositoryId === undefined || String(candidate.id) === String(params.repositoryId)));
    if (!repo) throw new Error("This repository is not available to the connected GitHub App.");
    return { repo, auth: await credentials(runCtx.companyId) };
  }

  async function run(op: string, params: unknown, runCtx: ToolRunContext, options: { reviewers?: boolean; assignees?: boolean } = {}): Promise<ToolResult> {
    try {
      const input = (params && typeof params === "object" ? { ...(params as Record<string, unknown>) } : {}) as Record<string, unknown>;
      const { repo, auth } = await repository(input, runCtx);
      if (["review", "inline-comment", "merge-pr", "enable-auto-merge", "update-branch"].includes(op)) {
        if (typeof input.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(input.sha)) throw new Error("Provide the current pull request commit SHA before this action.");
      }
      if (options.reviewers && Array.isArray(input.reviewerAgentIds) && input.reviewerAgentIds.length) {
        const endpoints = (await Promise.all((input.reviewerAgentIds as string[]).map(agentId => nativeGitHubEndpoints(ctx, runCtx.companyId, agentId)))).flat();
        const logins = endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login));
        if (logins.length !== new Set(input.reviewerAgentIds as string[]).size) throw nativeConnectorRequiredError();
        input.reviewers = [...new Set([...(Array.isArray(input.reviewers) ? input.reviewers : []), ...logins])];
      }
      if (options.assignees && Array.isArray(input.assigneeAgentIds) && input.assigneeAgentIds.length) {
        const endpoints = (await Promise.all((input.assigneeAgentIds as string[]).map(agentId => nativeGitHubEndpoints(ctx, runCtx.companyId, agentId)))).flat();
        const logins = endpoints.map(endpoint => endpoint.botUsername).filter((login): login is string => Boolean(login));
        if (logins.length !== new Set(input.assigneeAgentIds as string[]).size) throw nativeConnectorRequiredError();
        input.assignees = [...new Set([...(Array.isArray(input.assignees) ? input.assignees : []), ...logins])];
      }
      delete input.repository;
      delete input.repositoryId;
      delete input.companyId;
      delete input.reviewerAgentIds;
      delete input.assigneeAgentIds;
      const userToken = repoWrites.has(op) ? await writeToken(runCtx.companyId, repo.fullName, {
        ...repoWriteAction(op, input), source: "tool", agentId: runCtx.agentId, runId: runCtx.runId ?? null,
        ...(typeof input.number === "number" ? { pullRequest: input.number } : {}), ...(typeof input.sha === "string" ? { expectedHeadSha: input.sha } : {}),
      }) : null;
      const manager = new RepositoryManager(github, auth, repo, undefined, userToken);
      const data = await manager.run(op, input);
      await ctx.activity.log({ companyId: runCtx.companyId, message: `GitHub agent action: ${op}`, metadata: { repository: repo.fullName, agentId: runCtx.agentId, runId: runCtx.runId, identity: userToken ? "user" : "bot", ...(typeof input.number === "number" ? { number: input.number } : {}) } });
      return result(data);
    } catch (error) { return fail(error); }
  }

  const register = (name: string, displayName: string, description: string, parametersSchema: Record<string, unknown>, op: string, options?: { reviewers?: boolean; assignees?: boolean }) => {
    ctx.tools.register(name, { displayName, description, parametersSchema }, (params, runCtx) => run(op, params, runCtx, options));
  };

  register("github_read_issue", "Read GitHub issue", "Read one GitHub issue by its repository and issue number.", schema({ number: { type: "integer", minimum: 1 } }, ["repository", "number"]), "issue");
  register("github_read_pull_request", "Read GitHub pull request", "Read one GitHub pull request by repository and number.", schema({ number: { type: "integer", minimum: 1 } }, ["repository", "number"]), "pull");
  register("github_create_issue", "Create GitHub issue", "Create an issue in an explicitly selected GitHub repository.", schema({ title: { type: "string", minLength: 1, maxLength: 256 }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } }, assigneeAgentIds: { type: "array", items: { type: "string" } } }, ["repository", "title"]), "create-issue", { assignees: true });
  register("github_update_issue", "Update GitHub issue", "Edit or close an existing GitHub issue.", schema({ number: { type: "integer", minimum: 1 }, title: { type: "string", maxLength: 256 }, body: { type: "string" }, state: { enum: ["open", "closed"] }, labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } }, assigneeAgentIds: { type: "array", items: { type: "string" } } }, ["repository", "number"]), "edit-issue", { assignees: true });
  register("github_comment", "Comment on GitHub issue or pull request", "Add a comment to an issue or pull request.", schema({ number: { type: "integer", minimum: 1 }, kind: { enum: ["issue", "pull"] }, body: { type: "string", minLength: 1, maxLength: 65536 } }, ["repository", "number", "body"]), "comment");
  register("github_create_pull_request", "Create GitHub pull request", "Create a pull request from an explicitly selected head and base branch.", schema({ title: { type: "string", minLength: 1, maxLength: 256 }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" }, draft: { type: "boolean" } }, ["repository", "title", "head", "base"]), "create-pr");
  register("github_update_pull_request", "Update GitHub pull request", "Edit or close an existing pull request.", schema({ number: { type: "integer", minimum: 1 }, title: { type: "string", maxLength: 256 }, body: { type: "string" }, base: { type: "string" }, state: { enum: ["open", "closed"] } }, ["repository", "number"]), "edit-pr");
  register("github_inline_comment", "Comment on PR diff", "Add an inline comment to a pull request file and line at the current commit.", schema({ number: { type: "integer", minimum: 1 }, sha: { type: "string" }, path: { type: "string" }, line: { type: "integer", minimum: 1 }, side: { enum: ["LEFT", "RIGHT"] }, body: { type: "string", minLength: 1, maxLength: 65536 } }, ["repository", "number", "sha", "path", "line", "body"]), "inline-comment");
  register("github_reply_review_comment", "Reply to PR review comment", "Reply to an existing pull request review comment.", schema({ number: { type: "integer", minimum: 1 }, commentId: { type: "integer", minimum: 1 }, body: { type: "string", minLength: 1, maxLength: 65536 } }, ["repository", "number", "commentId", "body"]), "reply-review-comment");
  register("github_resolve_review_thread", "Resolve PR review thread", "Resolve a pull request review thread by its GitHub thread ID.", schema({ number: { type: "integer", minimum: 1 }, threadId: { type: "string" } }, ["repository", "number", "threadId"]), "resolve-thread");
  register("github_reopen_review_thread", "Reopen PR review thread", "Reopen a resolved pull request review thread.", schema({ number: { type: "integer", minimum: 1 }, threadId: { type: "string" } }, ["repository", "number", "threadId"]), "unresolve-thread");
  register("github_update_pull_request_branch", "Update PR branch", "Update a pull request branch from its base after checking the current SHA.", schema({ number: { type: "integer", minimum: 1 }, sha: { type: "string" } }, ["repository", "number", "sha"]), "update-branch");
  register("github_convert_pull_request_draft", "Convert PR to draft", "Convert an open pull request to draft state.", schema({ number: { type: "integer", minimum: 1 } }, ["repository", "number"]), "draft-pr");
  register("github_mark_pull_request_ready", "Mark PR ready", "Mark a draft pull request ready for review.", schema({ number: { type: "integer", minimum: 1 } }, ["repository", "number"]), "ready-pr");
  register("github_request_reviewers", "Request GitHub reviewers", "Request GitHub users or teams. Use Paperclip’s native GitHub channel for agent reviewers.", schema({ number: { type: "integer", minimum: 1 }, reviewers: { type: "array", items: { type: "string" } }, teams: { type: "array", items: { type: "string" } }, reviewerAgentIds: { type: "array", items: { type: "string" } } }, ["repository", "number"]), "request-reviewers", { reviewers: true });
  register("github_remove_reviewers", "Remove GitHub reviewers", "Remove requested GitHub users or teams. Use Paperclip’s native GitHub channel for agent identities.", schema({ number: { type: "integer", minimum: 1 }, reviewers: { type: "array", items: { type: "string" } }, teams: { type: "array", items: { type: "string" } }, reviewerAgentIds: { type: "array", items: { type: "string" } } }, ["repository", "number"]), "remove-reviewers", { reviewers: true });
  register("github_submit_review", "Submit GitHub pull request review", "Submit a comment, approval, or change request against the current pull request commit.", schema({ number: { type: "integer", minimum: 1 }, sha: { type: "string" }, event: { enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] }, body: { type: "string" } }, ["repository", "number", "sha", "event"]), "review");
  register("github_rerun_checks", "Rerun GitHub check", "Request GitHub to rerun one check run for a pull request.", schema({ number: { type: "integer", minimum: 1 }, checkRunId: { type: "integer", minimum: 1 } }, ["repository", "number", "checkRunId"]), "rerequest-check");
  register("github_merge_pull_request", "Merge GitHub pull request", "Merge or enable auto-merge for an open pull request after checking its current commit SHA.", schema({ number: { type: "integer", minimum: 1 }, sha: { type: "string" }, method: { enum: ["merge", "squash", "rebase"] }, confirm: { type: "string" } }, ["repository", "number", "sha", "method", "confirm"]), "merge-pr");
  register("github_enable_auto_merge", "Enable GitHub auto-merge", "Enable auto-merge for an open pull request after checking its current commit SHA.", schema({ number: { type: "integer", minimum: 1 }, sha: { type: "string" }, method: { enum: ["merge", "squash", "rebase"] }, confirm: { type: "string" } }, ["repository", "number", "sha", "method", "confirm"]), "enable-auto-merge");
}

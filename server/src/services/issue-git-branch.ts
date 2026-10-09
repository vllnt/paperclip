import { parseObject } from "../adapters/utils.js";
import { renderWorkspaceTemplate, sanitizeBranchName } from "./workspace-runtime.js";

/** The template agent workspaces use when nothing else is configured. */
export const DEFAULT_ISSUE_BRANCH_TEMPLATE = "{{issue.identifier}}-{{slug}}";

export type IssueBranchNameSource = "existing_branch" | "issue_template" | "project_template" | "default";

export interface IssueBranchName {
  name: string;
  /** The template that produced `name`; null when the branch is pinned. */
  template: string | null;
  source: IssueBranchNameSource;
}

export interface BuildIssueBranchNameInput {
  issue: {
    id: string;
    identifier: string | null;
    title: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
  };
  /** The project's `executionWorkspacePolicy`. */
  projectPolicy?: Record<string, unknown> | null;
  agent?: { id: string | null; name: string; companyId: string } | null;
  projectId?: string | null;
}

function strategyOf(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return parseObject(config?.workspaceStrategy);
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The branch name to copy for a task.
 *
 * It reuses the workspace runtime's own renderer, so a person and an agent working the
 * same task get the same name. Precedence matches the runtime: a pinned existing branch,
 * then the task's template, then the project's, then the default.
 */
export function buildIssueBranchName(input: BuildIssueBranchNameInput): IssueBranchName {
  const issueStrategy = strategyOf(input.issue.executionWorkspaceSettings);
  const existingBranch = nonBlank(issueStrategy.existingBranch);
  if (existingBranch) return { name: existingBranch.trim(), template: null, source: "existing_branch" };

  const issueTemplate = nonBlank(issueStrategy.branchTemplate);
  const projectTemplate = nonBlank(strategyOf(input.projectPolicy).branchTemplate);
  const template = issueTemplate ?? projectTemplate ?? DEFAULT_ISSUE_BRANCH_TEMPLATE;
  const source: IssueBranchNameSource = issueTemplate ? "issue_template" : projectTemplate ? "project_template" : "default";

  const rendered = renderWorkspaceTemplate(template, {
    issue: { id: input.issue.id, identifier: input.issue.identifier, title: input.issue.title },
    agent: input.agent ?? { id: null, name: "", companyId: "" },
    projectId: input.projectId ?? null,
    repoRef: null,
  });
  return { name: sanitizeBranchName(rendered), template, source };
}

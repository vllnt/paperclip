import { z } from "zod";

/** Pull request states a task's git panel shows. */
export const ISSUE_GIT_PULL_REQUEST_STATES = ["open", "draft", "merged", "closed"] as const;
export type IssueGitPullRequestState = (typeof ISSUE_GIT_PULL_REQUEST_STATES)[number];

/** How a pull request came to be linked to a task, strongest first. */
export const ISSUE_GIT_LINKED_BY = [
  "manual",
  "workspace_branch",
  "head_ref",
  "keyword",
  "bracket",
  "refs",
  "mention",
] as const;
export type IssueGitLinkedBy = (typeof ISSUE_GIT_LINKED_BY)[number];

/** Which configuration produced the proposed branch name. */
export const ISSUE_GIT_BRANCH_SOURCES = ["existing_branch", "issue_template", "project_template", "default"] as const;
export type IssueGitBranchSource = (typeof ISSUE_GIT_BRANCH_SOURCES)[number];

/** What status automation did, or why it held back, for one linked pull request. */
export interface IssueGitAutomationState {
  applied: { from: string; to: string; at: string } | null;
  /** Why automation chose not to change status, for example `active_run`. */
  deferred: string | null;
  /** Set once someone changes the status by hand; automation then leaves the task alone. */
  suspended: string | null;
}

export interface IssueGitPullRequest {
  workProductId: string;
  provider: "github";
  /** `owner/name`, lowercase. */
  repository: string;
  number: number;
  url: string | null;
  title: string;
  state: IssueGitPullRequestState;
  headRef: string | null;
  baseRef: string | null;
  /** A merge of this pull request may complete the task. */
  closes: boolean;
  /** False for forks and for pull requests whose origin could not be confirmed. */
  verified: boolean;
  linkedBy: IssueGitLinkedBy;
  automation: IssueGitAutomationState;
  updatedAt: string;
}

export interface IssueGitBranch {
  name: string;
  /** The command that starts work on the branch. */
  command: string;
  template: string | null;
  source: IssueGitBranchSource;
}

export interface IssueGitView {
  issueId: string;
  identifier: string | null;
  branch: IssueGitBranch;
  pullRequests: IssueGitPullRequest[];
  statusAutomation: { enabled: boolean };
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Links one pull request to a task: by URL, or by repository and number. */
export const linkIssuePullRequestSchema = z
  .object({
    url: z.string().trim().url().max(2000).optional(),
    repository: z.string().trim().regex(repositoryPattern, "Use owner/name").max(200).optional(),
    number: z.number().int().positive().max(2_000_000_000).optional(),
    /** Defaults to true: linking by hand says this pull request does the task. */
    closes: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.url) !== Boolean(value.repository && value.number), {
    message: "Provide either url, or repository and number",
  });

export type LinkIssuePullRequest = z.infer<typeof linkIssuePullRequestSchema>;

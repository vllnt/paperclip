import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./contracts.js";
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID, apiVersion: 1, version: "0.12.0", displayName: "GitHub",
  description: "Manage GitHub repositories, Projects and synced tasks with Paperclip’s native GitHub channel and review connector.",
  author: "VLLNT", categories: ["connector"],
  capabilities: ["companies.read", "agents.read", "chat.endpoints.read", "issues.create", "issues.update", "issues.wakeup", "jobs.schedule", "events.subscribe", "webhooks.receive", "projects.read", "project.workspaces.read", "issues.read", "plugin.state.read", "plugin.state.write",
    "secrets.read-ref", "secrets.write-own", "skills.managed", "http.outbound", "activity.log.write", "ui.page.register", "ui.sidebar.register",
    "ui.detailTab.register", "ui.action.register", "instance.settings.register", "agent.tools.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  jobs: [{ jobKey: "github-sync", displayName: "Sync GitHub tasks", schedule: "* * * * *" }],
  webhooks: [{ endpointKey: "github", displayName: "GitHub events", description: "Receive issue and pull request events from your GitHub App." }],
  taskCreation: { label: "GitHub", listAction: "task-destinations", publishAction: "publish-task", linksAction: "task-links" },
  projectRepositories: { listAction: "project-repositories", setupPath: "/github-projects", writeIdentityAction: "repository-write-identity", signCommitAction: "repository-sign-commit" },
  skills: [{
    skillKey: "github-review-workflow",
    displayName: "GitHub review workflow",
    slug: "github-review-workflow",
    description: "Editable instructions for agent assignment, review, request-changes, approval, merge and post-merge monitoring.",
    markdown: `# GitHub review workflow

Use the linked Paperclip task as the source of execution state and the GitHub record panel as the source of repository state.

## Before working
- Read the repository and organization policy configured by the operator.
- Work only on tasks assigned to you and keep at most the configured number of active runs.
- Inspect the pull request head SHA and checks before commenting or reviewing.

## Review
- Explain findings with file and line references.
- Use **REQUEST_CHANGES** only for actionable blocking defects.
- Use **APPROVE** only when the current SHA satisfies the repository policy.
- If the PR changes after your review, reassess the new SHA.

## Merge
- Never merge because a task is assigned.
- Merge only when all required bot reviews, human reviews, checks, approvals and branch protections pass.
- Prefer enabling GitHub auto-merge when the repository policy requires queueing.
- After merge, verify the merge event and update the linked Paperclip task with the result.

The operator can edit this skill for each company, repository or organization policy. The GitHub plugin supplies the tools and receipts; this skill supplies the decision policy.`,
  }],
  instanceConfigSchema: {
    type: "object", additionalProperties: false,
    properties: {
      personalToken: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      personalLogin: { type: "string" },
      appId: { type: "string", pattern: "^[1-9][0-9]*$" },
      appSlug: { type: "string" }, appName: { type: "string" },
      webhookSecret: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      privateKey: { type: "object", format: "secret-ref", properties: {
        type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" }
      }, required: ["type", "secretId"], additionalProperties: false },
      // App user identity: the App's client ID and secret, the rotating refresh
      // token the plugin stores back (bind a placeholder secret), and the SSH key
      // agent commits are signed with.
      userClientId: { type: "string", pattern: "^[A-Za-z0-9.]{8,100}$" },
      userClientSecret: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      userRefreshToken: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false },
      signingKey: { type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } }, required: ["type", "secretId"], additionalProperties: false }
    }
  },
  tools: [
    { name: "github_read_issue", displayName: "Read GitHub issue", description: "Read a GitHub issue by repository and number.", parametersSchema: { type: "object" } },
    { name: "github_read_pull_request", displayName: "Read GitHub pull request", description: "Read a GitHub pull request by repository and number.", parametersSchema: { type: "object" } },
    { name: "github_create_issue", displayName: "Create GitHub issue", description: "Create an issue in a GitHub repository.", parametersSchema: { type: "object" } },
    { name: "github_update_issue", displayName: "Update GitHub issue", description: "Edit or close a GitHub issue.", parametersSchema: { type: "object" } },
    { name: "github_comment", displayName: "Comment on GitHub", description: "Comment on a GitHub issue or pull request.", parametersSchema: { type: "object" } },
    { name: "github_create_pull_request", displayName: "Create GitHub pull request", description: "Create a GitHub pull request.", parametersSchema: { type: "object" } },
    { name: "github_update_pull_request", displayName: "Update GitHub pull request", description: "Edit or close a GitHub pull request.", parametersSchema: { type: "object" } },
    { name: "github_inline_comment", displayName: "Comment on PR diff", description: "Add an inline pull request diff comment.", parametersSchema: { type: "object" } },
    { name: "github_reply_review_comment", displayName: "Reply to PR review comment", description: "Reply to a pull request review comment.", parametersSchema: { type: "object" } },
    { name: "github_resolve_review_thread", displayName: "Resolve PR review thread", description: "Resolve a pull request review thread.", parametersSchema: { type: "object" } },
    { name: "github_reopen_review_thread", displayName: "Reopen PR review thread", description: "Reopen a pull request review thread.", parametersSchema: { type: "object" } },
    { name: "github_update_pull_request_branch", displayName: "Update PR branch", description: "Update a pull request branch.", parametersSchema: { type: "object" } },
    { name: "github_convert_pull_request_draft", displayName: "Convert PR to draft", description: "Convert a pull request to draft.", parametersSchema: { type: "object" } },
    { name: "github_mark_pull_request_ready", displayName: "Mark PR ready", description: "Mark a pull request ready for review.", parametersSchema: { type: "object" } },
    { name: "github_request_reviewers", displayName: "Request GitHub reviewers", description: "Request GitHub users or teams; Paperclip native GitHub channels own agent reviewer identity.", parametersSchema: { type: "object" } },
    { name: "github_remove_reviewers", displayName: "Remove GitHub reviewers", description: "Remove requested GitHub users or teams; Paperclip native GitHub channels own agent identity.", parametersSchema: { type: "object" } },
    { name: "github_submit_review", displayName: "Submit GitHub review", description: "Read and sync review state. Formal agent reviews and change requests belong to Paperclip’s native GitHub connector.", parametersSchema: { type: "object" } },
    { name: "github_rerun_checks", displayName: "Rerun GitHub checks", description: "Rerun a GitHub check run for a pull request.", parametersSchema: { type: "object" } },
    { name: "github_merge_pull_request", displayName: "Merge GitHub pull request", description: "Merge an open pull request after checking its current SHA.", parametersSchema: { type: "object" } },
    { name: "github_enable_auto_merge", displayName: "Enable GitHub auto-merge", description: "Enable auto-merge after checking a pull request's current SHA.", parametersSchema: { type: "object" } }
  ],
  ui: { slots: [
    { type: "taskListToolbar", id: "github-task-list", displayName: "GitHub issues", exportName: "GitHubTaskList", entityTypes: ["company", "project"] },
    { type: "page", id: "github", routePath: "github-projects", displayName: "GitHub", exportName: "GitHubPage" },
    { type: "globalToolbarButton", id: "github-task-button", displayName: "GitHub issues", exportName: "GitHubTaskButton" },
    { type: "sidebar", id: "github-link", displayName: "GitHub", exportName: "GitHubLink" },
    { type: "settingsPage", id: "github-settings", displayName: "GitHub connection", exportName: "GitHubPage" },
    { type: "detailTab", id: "github-issues", displayName: "GitHub", exportName: "GitHubIssues", entityTypes: ["project"] },
    { type: "detailTab", id: "github-record", displayName: "GitHub", exportName: "GitHubRecordPanel", entityTypes: ["issue"] },

  ] }
};
export default manifest;

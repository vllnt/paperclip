import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildIssueBranchName } from "../services/issue-git-branch.js";
import { sanitizeBranchName } from "../services/workspace-runtime.js";

const issue = { id: "11111111-1111-4111-8111-111111111111", identifier: "PAP-123", title: "Fix login redirect" };

describe("buildIssueBranchName", () => {
  it("proposes the same name agents get from the default workspace template", () => {
    expect(buildIssueBranchName({ issue })).toEqual({
      name: "PAP-123-fix-login-redirect",
      template: "{{issue.identifier}}-{{slug}}",
      source: "default",
    });
  });

  it("slugs punctuation and symbols the way the workspace runtime does", () => {
    expect(buildIssueBranchName({ issue: { ...issue, identifier: "PAP-5", title: "Fix: auth/login (v2)!" } }).name).toBe(
      "PAP-5-fix-auth-login-v2",
    );
    expect(buildIssueBranchName({ issue: { ...issue, identifier: "PAP-9", title: "???" } }).name).toBe("PAP-9-pap-9");
  });

  it("caps the name at 120 characters and never ends on a separator", () => {
    const name = buildIssueBranchName({ issue: { ...issue, title: "word ".repeat(80) } }).name;
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.startsWith("PAP-123-word-word")).toBe(true);
    expect(name).not.toMatch(/[-/.]$/);
  });

  it("uses the project's branch template when one is set", () => {
    const result = buildIssueBranchName({
      issue,
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "paperclip/{{issue.identifier}}-{{slug}}" } },
    });
    expect(result).toEqual({
      name: "paperclip/PAP-123-fix-login-redirect",
      template: "paperclip/{{issue.identifier}}-{{slug}}",
      source: "project_template",
    });
  });

  it("lets the issue's own template beat the project's", () => {
    const result = buildIssueBranchName({
      issue: {
        ...issue,
        executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", branchTemplate: "wip/{{slug}}" } },
      },
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "paperclip/{{slug}}" } },
    });
    expect(result.name).toBe("wip/fix-login-redirect");
    expect(result.source).toBe("issue_template");
  });

  it("returns a pinned existing branch exactly as configured", () => {
    const result = buildIssueBranchName({
      issue: {
        ...issue,
        executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", existingBranch: "release/2026.10" } },
      },
    });
    expect(result).toEqual({ name: "release/2026.10", template: null, source: "existing_branch" });
  });

  it("falls back to the default when a template is blank", () => {
    const result = buildIssueBranchName({
      issue,
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "   " } },
    });
    expect(result.source).toBe("default");
  });

  it("renders agent and project variables without throwing when there is no agent", () => {
    const result = buildIssueBranchName({
      issue,
      projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{agent.name}}/{{issue.identifier}}" } },
    });
    expect(result.name).toBe("PAP-123");
  });

  describe("git ref safety", () => {
    function gitAccepts(name: string): boolean {
      try {
        execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    }

    const hostileTitles = [
      "release.lock",
      "a..b..c",
      "fix ../../etc/passwd",
      "@{upstream}",
      "-leading dash",
      ".hidden",
      "trailing dot.",
      "control\u0001chars\u007f",
      "tilde~caret^colon:question?star*bracket[backslash\\",
      "emoji 🚀 title",
      "x".repeat(400),
      "...",
      "",
    ];

    it.each(hostileTitles)("makes a valid branch from the title %j", (title) => {
      const name = buildIssueBranchName({ issue: { ...issue, title } }).name;
      expect(gitAccepts(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(120);
    });

    const hostileTemplates = [
      "{{issue.identifier}}.lock",
      "a//b/{{slug}}",
      "feat/.{{slug}}",
      "{{slug}}.lock/x",
      "x..{{slug}}",
      "{{slug}}/",
      "./{{slug}}",
      `${"a/".repeat(80)}{{slug}}.lock`,
    ];

    it.each(hostileTemplates)("makes a valid branch from the template %j", (branchTemplate) => {
      const name = buildIssueBranchName({
        issue,
        projectPolicy: { workspaceStrategy: { type: "git_worktree", branchTemplate } },
      }).name;
      expect(gitAccepts(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(120);
    });

    it("keeps names that are already valid exactly as they were", () => {
      for (const name of ["PAP-123-fix-login-redirect", "paperclip/PAP-1-x", "release/2026.10", "a.b/c_d-e"]) {
        expect(sanitizeBranchName(name)).toBe(name);
      }
    });

    const invalidPins = ["a..b", "release.lock", "-x", "a//b", "a b", "x@{1}", "a/.b", "a.lock/b", "a/", "y".repeat(300)];

    it.each(invalidPins)("falls back to the template when the pinned branch %j is not a valid branch", (existingBranch) => {
      const result = buildIssueBranchName({
        issue: { ...issue, executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree", existingBranch } } },
      });
      expect(result).toEqual({ name: "PAP-123-fix-login-redirect", template: "{{issue.identifier}}-{{slug}}", source: "default" });
    });
  });
});

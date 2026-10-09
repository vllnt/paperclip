import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_PRIVILEGED_TOGGLES,
  DEFAULT_GITHUB_WRITE_IDENTITY_POLICY,
  classifyGitHubCommand,
  describeGitHubPrivilegedScope,
  ghCommandMayWrite,
  isGitHubPrivilegedAllowed,
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

  describe("per-agent grants of editWorkflows and workflowDispatch", () => {
    const dx = "5f0f6f1c-0c63-4a52-9a2d-3f4a8a1d7c01", other = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const parsed = (privileged: unknown) => parseGitHubWriteIdentityPolicy({ ...anthm, privileged }).privileged;

    it("accepts false, true or a list of agents for those two actions, and keeps the legacy values as they were", () => {
      expect(parsed({ editWorkflows: true })).toMatchObject({ editWorkflows: true, workflowDispatch: true });
      expect(parsed({ editWorkflows: false, workflowDispatch: false })).toMatchObject({ editWorkflows: false, workflowDispatch: false });
      expect(parsed({ editWorkflows: { agentIds: [dx] }, workflowDispatch: { agentIds: [dx, other] } }))
        .toMatchObject({ editWorkflows: { agentIds: [dx] }, workflowDispatch: { agentIds: [other, dx].sort() } });
      // An unset action keeps its default, and an empty list grants nobody, which is the same as false.
      expect(parsed({ editWorkflows: { agentIds: [] } })).toMatchObject({ editWorkflows: false, workflowDispatch: true });
      expect(parsed({})).toMatchObject({ editWorkflows: false, workflowDispatch: true });
    });

    it("normalizes the agent IDs, so that saving a saved policy changes nothing", () => {
      const once = parsed({ editWorkflows: { agentIds: [dx.toUpperCase(), dx, other] } });
      expect(once.editWorkflows).toEqual({ agentIds: [other, dx].sort() });
      expect(parseGitHubWriteIdentityPolicy({ ...anthm, privileged: once }).privileged).toEqual(once);
    });

    it("refuses a list on any other action, a list that is not exactly agent IDs, and anything else", () => {
      for (const action of ["adminMerge", "deploymentApproval", "release", "tagPush", "pushToMain", "wiki"]) {
        expect(() => parsed({ [action]: { agentIds: [dx] } }), action).toThrow(new RegExp(action));
      }
      for (const [label, scope] of [
        ["a string", "agent"], ["null", null], ["a number", 1], ["an array", [dx]], ["an unknown key", { agentIds: [dx], companyWide: true }],
        ["no list", {}], ["a list that is no list", { agentIds: dx }], ["an agent name", { agentIds: ["Anthm DX"] }], ["a short ID", { agentIds: ["5f0f6f1c"] }],
        ["a non-string ID", { agentIds: [7] }], ["too many agents", { agentIds: Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`) }],
      ] as const) {
        expect(() => parsed({ editWorkflows: scope }), label).toThrow(/editWorkflows/);
      }
    });

    it("answers for one agent: company-wide values are the same for everyone, a list names its agents, and an unknown agent is never granted", () => {
      const toggles = (editWorkflows: unknown, workflowDispatch: unknown = true) => parsed({ editWorkflows, workflowDispatch });
      for (const agent of [dx, other, null, undefined]) {
        expect(isGitHubPrivilegedAllowed(toggles(true), "editWorkflows", agent), String(agent)).toBe(true);
        expect(isGitHubPrivilegedAllowed(toggles(false), "editWorkflows", agent), String(agent)).toBe(false);
      }
      const scoped = toggles({ agentIds: [dx] });
      expect(isGitHubPrivilegedAllowed(scoped, "editWorkflows", dx)).toBe(true);
      expect(isGitHubPrivilegedAllowed(scoped, "editWorkflows", dx.toUpperCase())).toBe(true);
      expect(isGitHubPrivilegedAllowed(scoped, "editWorkflows", other)).toBe(false);
      expect(isGitHubPrivilegedAllowed(scoped, "editWorkflows", null)).toBe(false);
      expect(isGitHubPrivilegedAllowed(scoped, "editWorkflows", undefined)).toBe(false);
      expect(isGitHubPrivilegedAllowed(scoped, "editWorkflows", "")).toBe(false);
      // The grant is for that action only.
      expect(isGitHubPrivilegedAllowed(scoped, "workflowDispatch", other)).toBe(true);
      expect(isGitHubPrivilegedAllowed(toggles(false, { agentIds: [dx] }), "editWorkflows", dx)).toBe(false);
      expect(isGitHubPrivilegedAllowed(toggles(false, { agentIds: [dx] }), "workflowDispatch", other)).toBe(false);
      // Every other action is a plain switch.
      expect(isGitHubPrivilegedAllowed(scoped, "tagPush", dx)).toBe(false);
      expect(isGitHubPrivilegedAllowed(scoped, "adminMerge", other)).toBe(true);
    });

    it("tells who holds a scope in words", () => {
      expect(describeGitHubPrivilegedScope(true)).toBe("on for every agent");
      expect(describeGitHubPrivilegedScope(false)).toBe("off");
      expect(describeGitHubPrivilegedScope({ agentIds: [dx] })).toBe("granted to 1 agent");
      expect(describeGitHubPrivilegedScope({ agentIds: [dx, other] })).toBe("granted to 2 agents");
    });
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
    expect(classifyGitHubCommand("git", ["push", "origin", "--delete", "feat/a"])).toEqual(write("push"));
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
    expect(classifyGitHubCommand("gh", ["api", "-X", "PATCH", "repos/o/r/git/refs/heads%2Fmain", "-f", "sha=abc"])).toEqual({ ...write("push", "editWorkflows", "pushToMain"), route: "git/refs/heads/main" });
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
    [["api", "-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", "sha=abc"], { ...write("push", "editWorkflows", "pushToMain"), route: "git/refs/heads/main" }],
    [["api", "-X", "DELETE", "repos/o/r/git/refs/heads/feat"], write("push")],
    [["api", "-X", "PUT", "repos/o/r/contents/README.md", "-f", "message=x", "-f", "content=eA=="], write("commit", "pushToMain")],
    [["api", "-X", "PUT", "repos/o/r/contents/README.md", "-f", "branch=docs", "-f", "message=x"], write("commit")],
    [["api", "-X", "PUT", "repos/o/r/contents/.github/workflows/ci.yml", "-f", "branch=docs"], { ...write("commit", "editWorkflows"), route: "contents/.github/workflows/ci.yml" }],
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
      expect(result.denied, body).toMatch(/cannot check the GraphQL mutation|no subscriptions or fragments|separate gh api graphql calls/);
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
    expect(classifyGitHubCommand("gh", ["api", "-X", "DELETE", "repos/o/r/git/refs/heads/main/"])).toEqual(write("push", "pushToMain"));
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
    expect(classifyGitHubCommand("gh", ["api", "graphql", "-f", 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'])).not.toHaveProperty("integrity");
    expect(classifyGitHubCommand("git", ["push", "--tags", "origin"])).not.toHaveProperty("integrity");
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
    expect(push("-fo", "ci.skip", "origin", "HEAD:refs/heads/main")).toEqual(write("push", "pushToMain"));
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

// ---------------------------------------------------------------------------
// The Git Data API: a workflow file can be built object by object and a ref pointed at it, with no `git push` to inspect.
// ---------------------------------------------------------------------------

describe("git data API writes need editWorkflows (a workflow edit without git push)", () => {
  const api = (...args: string[]) => classifyGitHubCommand("gh", ["api", ...args]);
  const needsWorkflows = (action: string, route: string, ...more: string[]) => ({ access: "write", action, privileged: ["editWorkflows", ...more], route });

  it("holds each call of the four-call sequence, on a branch that is not the default branch", () => {
    // 1. a blob, 2. a tree that puts a file (or a symlink, mode 120000) under .github/workflows, 3. a commit on that tree, 4. the ref that uses it.
    expect(api("-X", "POST", "repos/o/r/git/blobs", "-f", "content=on: push", "-f", "encoding=utf-8")).toEqual(needsWorkflows("commit", "git/blobs"));
    expect(api("-X", "POST", "repos/o/r/git/trees", "-f", "tree[][path]=.github/workflows/evil.yml", "-f", "tree[][mode]=100644", "-f", "tree[][type]=blob", "-f", "tree[][sha]=abc")).toEqual(needsWorkflows("commit", "git/trees"));
    expect(api("-X", "POST", "repos/o/r/git/trees", "-f", "tree[][path]=.github/workflows/evil.yml", "-f", "tree[][mode]=120000", "-f", "tree[][type]=blob", "-f", "tree[][sha]=abc")).toEqual(needsWorkflows("commit", "git/trees"));
    expect(api("-X", "POST", "repos/o/r/git/commits", "-f", "message=x", "-f", "tree=abc", "-f", "parents[]=def")).toEqual(needsWorkflows("commit", "git/commits"));
    expect(api("-X", "PATCH", "repos/o/r/git/refs/heads/feature", "-f", "sha=abc")).toEqual(needsWorkflows("push", "git/refs/heads/feature"));
    expect(api("repos/o/r/git/refs", "-f", "ref=refs/heads/feature", "-f", "sha=abc")).toEqual(needsWorkflows("push", "git/refs/heads/feature"));
  });

  it("does not need the body to be readable: a tree sent from a file is held the same", () => {
    expect(api("-X", "POST", "repos/o/r/git/trees", "--input", "tree.json")).toEqual(needsWorkflows("commit", "git/trees"));
    expect(api("-X", "POST", "repos/o/r/git/commits", "-F", "message=@m.txt")).toEqual(needsWorkflows("commit", "git/commits"));
  });

  it("holds every spelling GitHub routes to the same endpoint", () => {
    for (const path of ["repos/o/r/git/trees/", "repos/o/r//git/trees", "repos/o/r/./git/trees", "/repos/o/r/git/%74rees", "https://api.github.com/repos/o/r/git/trees"]) {
      expect(api("-X", "POST", path), path).toMatchObject({ privileged: ["editWorkflows"], route: "git/trees" });
    }
    expect(api("-X", "PATCH", "repos/o/r/git/refs/heads%2Ffeature", "-f", "sha=abc")).toMatchObject({ privileged: ["editWorkflows"], route: "git/refs/heads/feature" });
  });

  it("keeps the default branch's pushToMain next to it, and the other toggles as they were", () => {
    expect(api("-X", "PATCH", "repos/o/r/git/refs/heads/main", "-f", "sha=abc")).toEqual(needsWorkflows("push", "git/refs/heads/main", "pushToMain"));
    expect(api("-X", "POST", "repos/o/r/git/refs", "-f", "ref=refs/heads/main", "-f", "sha=abc")).toEqual(needsWorkflows("push", "git/refs/heads/main", "pushToMain"));
    // A tag ref is held by tagPush (and refused for a release tag); an annotated tag object by tagPush too.
    expect(api("-X", "POST", "repos/o/r/git/refs", "-f", "ref=refs/tags/v1", "-f", "sha=abc")).toEqual({ access: "write", action: "push", privileged: ["tagPush"] });
    expect(api("-X", "PATCH", "repos/o/r/git/refs/tags/v1", "-f", "sha=abc")).toEqual({ access: "write", action: "push", privileged: ["tagPush"] });
    expect(api("-X", "POST", "repos/o/r/git/tags", "-f", "tag=v1", "-f", "object=abc")).toEqual({ access: "write", action: "commit", privileged: ["tagPush"] });
  });

  it("lets a ref be deleted and the objects be read: neither adds content", () => {
    expect(api("-X", "DELETE", "repos/o/r/git/refs/heads/feature")).toEqual({ access: "write", action: "push", privileged: [] });
    for (const path of ["repos/o/r/git/trees/abc?recursive=1", "repos/o/r/git/blobs/abc", "repos/o/r/git/commits/abc", "repos/o/r/git/refs/heads/feature", "repos/o/r/git/matching-refs/heads"]) {
      expect(api(path), path).toEqual({ access: "read", action: null, privileged: [] });
    }
  });

  it("still refuses a ref it cannot read, and a placeholder, whatever the toggles", () => {
    expect(api("-X", "POST", "repos/o/r/git/refs", "-F", "ref=@ref.txt", "-f", "sha=abc").denied).toMatch(/Name the ref|fields with -f/);
    expect(api("-X", "PATCH", "repos/{owner}/{repo}/git/refs/heads/{branch}", "-f", "sha=abc").denied).toMatch(/instead of gh placeholders/);
  });

  it("holds a workflow file written through the contents API with the same receipt", () => {
    expect(api("-X", "PUT", "repos/o/r/contents/.github/workflows/ci.yml", "-f", "branch=docs", "-f", "message=x")).toEqual(needsWorkflows("commit", "contents/.github/workflows/ci.yml"));
    expect(api("-X", "PUT", "repos/o/r/contents/README.md", "-f", "branch=docs", "-f", "message=x")).toEqual({ access: "write", action: "commit", privileged: [] });
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

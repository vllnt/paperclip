import { describe, expect, it } from "vitest";
import { withProtectedBranchFacts } from "../services/github-protected-branches.js";
import {
  classifyGitHubOperation,
  parseGitHubOperation,
  readGitHubOperation,
  registerGitHubWriteIdentityWorkers,
  resolveGitHubWriteIdentityDecision,
} from "../services/github-write-identity.js";

// Destination parsing itself (URLs, scp, local paths, other hosts) is tested with parseGitHubDestination in @paperclipai/shared.
describe("GitHub write identity operations", () => {
  it("prefers an explicit repository over the launcher's remote and normalizes it", () => {
    const remote = "https://github.com/vllnt/origin.git";
    const clean = { touchesWorkflows: false };
    // The launcher reports no remote for a URL target (it pushes there, not to origin).
    expect(classifyGitHubOperation({ program: "git", args: ["push", "git@github.com:acme/fork.git", "HEAD"], remote: null, pushUrls: ["git@github.com:acme/fork.git"], currentBranch: "feat", ...clean }))
      .toMatchObject({ access: "write", action: "push", privileged: [], repository: "acme/fork" });
    // A report naming both a URL target and another remote is ambiguous: refused.
    expect(classifyGitHubOperation({ program: "git", args: ["push", "git@github.com:acme/fork.git", "HEAD"], remote, currentBranch: "feat", ...clean }).denied).toMatch(/cannot tell which repository/);
    expect(classifyGitHubOperation({ program: "git", args: ["push", "-u", "origin", "feature/x"], remote, ...clean }))
      .toMatchObject({ action: "push", repository: "vllnt/origin" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--repo=Acme/Site"], remote }))
      .toMatchObject({ action: "pullRequest", repository: "acme/site" });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "/repos/acme/api/issues/3/comments", "-f", "body=x"], remote }))
      .toMatchObject({ action: "comment", repository: "acme/api" });
    expect(classifyGitHubOperation({ program: "git", args: ["log"], remote })).toMatchObject({ access: "none", action: null });
    expect(classifyGitHubOperation({ program: "git", args: ["fetch"], remote })).toMatchObject({ access: "read", repository: "vllnt/origin" });
    expect(classifyGitHubOperation({ program: "git", args: ["clone", "https://github.com/Acme/Lib.git", "lib"], remote: null }))
      .toMatchObject({ access: "read", repository: "acme/lib" });
  });

  it("folds a wiki remote into its repository and marks it", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "master"], remote: "https://github.com/Anthm-FR/linkzic.wiki.git", currentBranch: "master", touchesWorkflows: false }))
      .toMatchObject({ access: "write", privileged: ["pushToMain", "wiki"], repository: "anthm-fr/linkzic", wiki: true });
  });

  it("extracts the merge target, expected head and Actions run for the guard and the audit", () => {
    const sha = "a".repeat(40);
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "12", "--admin", "--squash", "--match-head-commit", sha], remote: "https://github.com/Anthm-FR/anthm-fr.git" }))
      .toMatchObject({ privileged: ["adminMerge"], repository: "anthm-fr/anthm-fr", pullRequest: 12, expectedHeadSha: sha, target: { pullRequest: 12, headSha: sha } });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "https://github.com/Anthm-FR/anthm-fr/pull/34", "--admin"], remote: null }))
      .toMatchObject({ pullRequest: 34, expectedHeadSha: null });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "PUT", "repos/o/r/pulls/9/merge", "-f", `sha=${sha}`], remote: null }))
      .toMatchObject({ privileged: ["adminMerge"], pullRequest: 9, expectedHeadSha: sha });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "POST", "repos/o/r/actions/runs/777/pending_deployments", "-F", "environment_ids[]=5", "-f", "state=approved", "-f", "comment=ANT-12 approved"], remote: null }))
      .toMatchObject({ privileged: ["deploymentApproval"], repository: "o/r", target: { actionsRunId: "777", state: "approved", comment: "ANT-12 approved" } });
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "feat"], remote: "https://github.com/o/r.git", shas: [sha], touchesWorkflows: false }))
      .toMatchObject({ target: { shas: [sha] } });
  });

  it("denies release tags whatever the policy says", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "engine@1.4.0"], remote: "https://github.com/Anthm-FR/songtrivia.git", refs: { "engine@1.4.0": "refs/tags/engine@1.4.0" } }).denied)
      .toMatch(/release workflow/);
  });

  it("refuses writes whose repository is uncertain (review findings)", () => {
    const clean = { touchesWorkflows: false, currentBranch: "feat" };
    // git pushes to every push URL; two repositories cannot be checked as one.
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "feat"], remote: "https://github.com/o/allowed.git", ...clean,
      pushUrls: ["https://github.com/o/allowed.git", "https://github.com/o/staged.git"] }).denied).toMatch(/cannot tell which repository/);
    // The launcher's resolved push URL wins over a bare remote name.
    expect(classifyGitHubOperation({ program: "git", args: ["push", "--repo", "https://github.com/o/allowed", "staged", "HEAD:x"], remote: "https://github.com/o/allowed.git", ...clean,
      pushUrls: ["https://github.com/o/staged.git"] })).toMatchObject({ repository: "o/staged" });
    expect(classifyGitHubOperation({ program: "git", args: ["push", "https://github.com/o/allowed", "HEAD:x"], remote: null, ...clean, urlRewrites: true }).denied).toMatch(/rewrites GitHub URLs/);
    // gh: the last -R wins, attached forms count, URL selectors name their repository.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "5", "-R", "o/allowed", "-R", "o/staged"], remote: null })).toMatchObject({ repository: "o/staged" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "5", "-Ro/staged"], remote: null })).toMatchObject({ repository: "o/staged" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "https://github.com/o/staged/pull/5"], remote: "https://github.com/o/allowed.git" }))
      .toMatchObject({ repository: "o/staged", pullRequest: 5 });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "https://github.com/o/staged/pull/5", "-R", "o/allowed"], remote: null }).denied).toMatch(/cannot tell/);
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "POST", "https://api.github.com/repos/o/staged/issues"], remote: "https://github.com/o/allowed.git" }))
      .toMatchObject({ repository: "o/staged" });
    // Without -R, gh may pick any remote.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--fill"], remote: "https://github.com/o/allowed.git",
      remotes: ["https://github.com/o/allowed.git", "https://github.com/o/upstream.git"] }).denied).toMatch(/cannot tell/);
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "1"], remote: "https://github.com/o/allowed.git",
      remotes: ["https://github.com/o/allowed.git", "https://github.com/o/upstream.git"] }).denied).toBeUndefined();
    // A command too long to report whole is refused unless it is local.
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "repos/o/r/pulls"], remote: null, truncated: true }).denied).toMatch(/too long/);
    expect(classifyGitHubOperation({ program: "git", args: ["add", "a"], remote: null, truncated: true }).denied).toBeUndefined();
  });

  it("reads an unreadable report as unreadable, not as no report", () => {
    expect(readGitHubOperation({})).toBeNull();
    expect(readGitHubOperation({ operation: { program: "git", args: ["push"], currentBranch: "x".repeat(2000) } })).toBe("unreadable");
    expect(readGitHubOperation({ operation: { program: "git", args: ["push"] } })).toEqual({ program: "git", args: ["push"] });
  });

  it("ignores malformed launcher bodies", () => {
    expect(parseGitHubOperation({})).toBeNull();
    expect(parseGitHubOperation({ operation: { program: "curl", args: [] } })).toBeNull();
    expect(parseGitHubOperation({ operation: { program: "git", args: "push" } })).toBeNull();
    expect(parseGitHubOperation({ operation: { program: "git", args: ["push"], shas: ["not-a-sha"] } })).toBeNull();
    expect(parseGitHubOperation({ operation: { program: "git", args: ["push"] } })).toEqual({ program: "git", args: ["push"] });
  });
});

// ---------------------------------------------------------------------------
// Security review, round 2: each test is an attack the previous classification let through.
// ---------------------------------------------------------------------------

describe("security review round 2 (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";

  it("F1: refuses any destination that is not a github.com repository, reads included", () => {
    const operations = [
      { program: "gh", args: ["api", "https://evil.example/repos/o/r"], remote: origin },
      { program: "gh", args: ["api", "--hostname", "tenant.ghe.com", "user"], remote: origin },
      { program: "gh", args: ["pr", "view", "1", "-R", "tenant.ghe.com/Anthm-FR/songtrivia"], remote: origin },
      { program: "gh", args: ["pr", "view", "1", "--repo=https://evil.example/Anthm-FR/songtrivia"], remote: origin },
      { program: "gh", args: ["pr", "view", "https://tenant.ghe.com/Anthm-FR/songtrivia/pull/1"], remote: origin },
      { program: "gh", args: ["repo", "clone", "github.localhost/Anthm-FR/songtrivia"], remote: null },
      { program: "gh", args: ["pr", "list"], remote: origin, ghRepo: "tenant.ghe.com/Anthm-FR/songtrivia" },
      { program: "gh", args: ["auth", "status", "--hostname", "tenant.ghe.com"], remote: origin },
      { program: "git", args: ["fetch", "https://evil.example/Anthm-FR/songtrivia.git"], remote: null },
      { program: "git", args: ["fetch", "origin"], remote: "https://evil.example/Anthm-FR/songtrivia.git" },
      { program: "git", args: ["clone", "ext::sh -c touch% /tmp/pwned"], remote: null },
      { program: "git", args: ["ls-remote", "git://github.com/Anthm-FR/songtrivia"], remote: null },
      { program: "git", args: ["fetch", "https://github.com/Anthm-FR/songtrivia"], remote: null, urlRewrites: true },
    ];
    for (const operation of operations) {
      expect(classifyGitHubOperation(operation as never).denied, JSON.stringify(operation)).toMatch(/github\.com|rewrites/);
    }
    // A path on this machine needs no GitHub access at all.
    expect(classifyGitHubOperation({ program: "git", args: ["fetch", "../mirror.git"], remote: null })).toMatchObject({ access: "none", repository: null });
    // A push stays a write (round 2c, N4): with no GitHub repository it is refused under an App user policy.
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "feat"], remote: "/srv/mirror.git", pushUrls: ["/srv/mirror.git"], touchesWorkflows: false, currentBranch: "feat" }))
      .toMatchObject({ access: "write", repository: null });
    // gh ignores checkout remotes on other hosts; GitHub ones still count.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "1"], remote: "https://gitlab.com/x/y.git", remotes: ["https://gitlab.com/x/y.git", origin] }))
      .toMatchObject({ repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "1"], remote: origin }).denied).toBeUndefined();
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "repos/{owner}/{repo}/pulls"], remote: origin })).toMatchObject({ access: "read", repository: "anthm-fr/songtrivia" });
  });

  it("F1: names the repository a gh repo or issue transfer command targets, not just the checkout", () => {
    expect(classifyGitHubOperation({ program: "gh", args: ["repo", "sync", "Anthm-FR/linkzic"], remote: origin })).toMatchObject({ repository: "anthm-fr/linkzic" });
    expect(classifyGitHubOperation({ program: "gh", args: ["repo", "edit", "--description", "x", "Anthm-FR/linkzic"], remote: origin })).toMatchObject({ repository: "anthm-fr/linkzic" });
    expect(classifyGitHubOperation({ program: "gh", args: ["issue", "transfer", "5", "Anthm-FR/linkzic"], remote: origin }).denied).toMatch(/cannot tell which repository/);
  });

  it("F3: refuses network plumbing and unknown git commands instead of treating them as local", () => {
    for (const args of [["send-pack", "https://github.com/Anthm-FR/songtrivia", "main"], ["-c", "alias.p=!git send-pack", "p"], ["http-push", "https://github.com/Anthm-FR/songtrivia/"], ["frobnicate"]]) {
      const result = classifyGitHubOperation({ program: "git", args, remote: origin });
      expect(result.denied, args.join(" ")).toMatch(/cannot check where that command connects/);
      expect(result.access, args.join(" ")).not.toBe("none");
    }
  });

  it("F4: refuses a push when any push destination is unknown or elsewhere", () => {
    const base = { program: "git" as const, args: ["push", "origin", "feat"], remote: origin, currentBranch: "feat", touchesWorkflows: false };
    for (const extra of [
      "https://evil.example/Anthm-FR/songtrivia.git", "ext::sh -c cat% .git/config", "git@gitlab.com:x/y.git", "https://github.com/Anthm-FR/songtrivia.git?x=1",
      "ssh://git@ssh.github.com:443/Anthm-FR/songtrivia.git", "https://github.com/not-a-repository", "/srv/mirror.git",
    ]) {
      expect(classifyGitHubOperation({ ...base, pushUrls: [origin, extra] }).denied, extra).toBeDefined();
    }
    expect(classifyGitHubOperation({ ...base, pushUrls: [origin] })).toMatchObject({ access: "write", repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ ...base, pushUrls: [origin] }).denied).toBeUndefined();
  });

  it("F6: passes only a full head SHA to the merge guard", () => {
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "--admin", "--match-head-commit", "aaaaaaa"], remote: origin })).toMatchObject({ expectedHeadSha: null });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "PUT", "repos/o/r/pulls/7/merge", "-f", "sha=aaaaaaaaaa"], remote: null })).toMatchObject({ expectedHeadSha: null });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "--admin", "--match-head-commit", "A".repeat(40)], remote: origin }))
      .toMatchObject({ expectedHeadSha: "a".repeat(40), target: { headSha: "a".repeat(40) } });
  });

  it("F8: marks wiki pushes from the parsed remote; query strings and encodings do not hide them", () => {
    const push = (remote: string) => classifyGitHubOperation({ program: "git", args: ["push", "origin", "feat"], remote, currentBranch: "feat", touchesWorkflows: false });
    for (const remote of ["https://github.com/Anthm-FR/songtrivia.wiki.git", "https://github.com/Anthm-FR/SongTrivia.WIKI.git/", "https://github.com/Anthm-FR/songtrivia%2Ewiki.git",
      "https://github.com/Anthm-FR/songtrivia.wik%69", "git@github.com:Anthm-FR/songtrivia.wiki.git", "ssh://git@github.com/Anthm-FR/songtrivia.wiki"]) {
      expect(push(remote), remote).toMatchObject({ repository: "anthm-fr/songtrivia", wiki: true, privileged: ["wiki"] });
    }
    expect(push("https://github.com/Anthm-FR/songtrivia.wiki.git?x=1").denied).toMatch(/query or fragment/);
    expect(push("https://github.com/Anthm-FR/songtrivia.wiki.evil")).toMatchObject({ repository: "anthm-fr/songtrivia.wiki.evil", wiki: false, privileged: [] });
    expect(push("https://github.com/Anthm-FR/songtrivia-old.wiki.git")).toMatchObject({ repository: "anthm-fr/songtrivia-old", wiki: true });
  });
});

// ---------------------------------------------------------------------------
// Independent review of round 2 (round 2b): each test is a bypass or regression the round-2 code had.
// ---------------------------------------------------------------------------

describe("security review round 2b (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";
  const sha = "a".repeat(40);

  it("R1: names the repository GitHub routes to, not the checkout, and keeps privileged actions on any spelling", () => {
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "POST", "repos//Anthm-FR//linkzic/issues", "-f", "title=x"], remote: origin }))
      .toMatchObject({ access: "write", repository: "anthm-fr/linkzic" });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "PUT", "repos/Anthm-FR/songtrivia/pulls/12/merge/", "-f", `sha=${sha}`], remote: origin }))
      .toMatchObject({ privileged: ["adminMerge"], pullRequest: 12, expectedHeadSha: sha, repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "PUT", "repositories/123/pulls/12/merge"], remote: origin }).denied).toMatch(/repos\/OWNER\/REPO/);
    // gh's :owner/:repo placeholders come from the checkout, like {owner}/{repo}.
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "repos/:owner/:repo/pulls"], remote: origin })).toMatchObject({ access: "read", repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "repos/:owner/:repo/pulls"], remote: origin }).denied).toBeUndefined();
  });

  it("R2: reads git's network options, so a value is never the destination", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["clone", "--depth", "1", "https://evil.example/x/y"], remote: null })).toMatchObject({ denied: expect.stringContaining("evil.example"), integrity: true });
    expect(classifyGitHubOperation({ program: "git", args: ["clone", "-b", "release/1.0", "https://github.com/o/private"], remote: null })).toMatchObject({ access: "read", repository: "o/private" });
    const fetch = classifyGitHubOperation({ program: "git", args: ["fetch", "--shallow-since", "2024-01-01T00:00:00", "origin"], remote: origin });
    expect(fetch).toMatchObject({ access: "read", repository: "anthm-fr/songtrivia" });
    expect(fetch.denied).toBeUndefined();
    // A URL target always counts, even next to a resolved remote.
    expect(classifyGitHubOperation({ program: "git", args: ["fetch", "https://evil.example/x"], remote: origin }).denied).toMatch(/evil\.example/);
  });

  it("R7: refuses -R that the option before it may take as its value, and reads gh pr merge's selector exactly", () => {
    expect(classifyGitHubOperation({ program: "gh", args: ["release", "create", "v1", "-t", "-R", "Anthm-FR/songtrivia"], remote: "https://github.com/Anthm-FR/linkzic.git" }).denied)
      .toMatch(/Put -R OWNER\/REPO right after the command/);
    expect(classifyGitHubOperation({ program: "gh", args: ["release", "create", "-R", "Anthm-FR/songtrivia", "v1", "-t", "Title"], remote: null })).toMatchObject({ repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["release", "create", "-R", "Anthm-FR/songtrivia", "v1", "-t", "Title"], remote: null }).denied).toBeUndefined();
    // --subject takes "7" as its value: gh merges #5.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "--subject", "7", "5", "--admin", "--match-head-commit", sha], remote: origin })).toMatchObject({ pullRequest: 5, expectedHeadSha: sha });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "--admin", "--match-head-commit", sha, "12"], remote: origin })).toMatchObject({ pullRequest: 12, expectedHeadSha: sha });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "--admin", "-R", "Anthm-FR/songtrivia", "12"], remote: null })).toMatchObject({ pullRequest: 12, repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "-ds", "12", "--admin"], remote: origin })).toMatchObject({ pullRequest: 12 });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "12", "--frobnicate", "7", "--admin"], remote: origin }).denied).toMatch(/does not know the gh pr merge option/);
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "-t", "-R", "o/r", "--admin"], remote: origin }).denied).toMatch(/Name one pull request/);
  });

  it("R9: only commit-creating git commands open signing; tag objects are not configured for signing", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["commit", "-m", "x"], remote: origin })).toMatchObject({ signing: true });
    expect(classifyGitHubOperation({ program: "git", args: ["tag", "-s", "v1", "-m", "x"], remote: origin })).not.toHaveProperty("signing");
  });
});

// ---------------------------------------------------------------------------
// Renewed review of round 2b (round 2c).
// ---------------------------------------------------------------------------

describe("security review round 2c (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";

  it("N4: refuses git network options it cannot read, and a push never becomes a local command", () => {
    for (const args of [["push", "--push-o", "x", "https://github.com/o/r2", "HEAD:refs/heads/main"], ["push", "--rep=https://github.com/o/r2"], ["push", "-fx", "origin", "main"]]) {
      expect(classifyGitHubOperation({ program: "git", args, remote: origin, currentBranch: "main", touchesWorkflows: false }), args.join(" "))
        .toMatchObject({ access: "write", denied: expect.stringContaining("does not know the git push option") });
    }
    expect(classifyGitHubOperation({ program: "git", args: ["push", "-fo", "ci.skip", "origin", "HEAD:refs/heads/main"], remote: null, pushUrls: [origin], touchesWorkflows: false }))
      .toMatchObject({ access: "write", privileged: ["pushToMain"], repository: "anthm-fr/songtrivia" });
  });

  it("N1/N6: refuses gh options that hide the command or the repository", () => {
    // A leading -R is gh's own -R (round 2d): it names the repository.
    expect(classifyGitHubOperation({ program: "gh", args: ["-R", "o/other", "pr", "create", "--title", "t", "--body", "b"], remote: origin })).toMatchObject({ access: "write", repository: "o/other" });
    expect(classifyGitHubOperation({ program: "gh", args: ["-X", "PUT", "api", "repos/o/x/contents/y"], remote: origin })).toMatchObject({ integrity: true });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "--body", "x", "merge", "5", "--admin"], remote: origin }).denied).toMatch(/Put the verb right after/);
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "5", "-dRother/repo", "--admin"], remote: origin })).toMatchObject({ integrity: true });
  });

  it("N7: a cut report or a URL rewrite refuses the command for every company", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["fetch", "origin"], remote: origin, urlRewrites: true })).toMatchObject({ denied: expect.stringContaining("rewrites"), integrity: true });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "1"], remote: origin, truncated: true })).toMatchObject({ denied: expect.stringContaining("too long"), integrity: true });
  });
});
// ---------------------------------------------------------------------------
// Third review (round 2d).
// ---------------------------------------------------------------------------

describe("security review round 2d (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";
  const sha = "a".repeat(40);

  it("A: refuses gh pr merge with an empty argument before the verb, for every company", () => {
    for (const args of [["pr", "", "merge", "--admin", "--squash"], ["", "pr", "merge", "--admin", "--squash"]]) {
      expect(classifyGitHubOperation({ program: "gh", args, remote: origin }), JSON.stringify(args)).toMatchObject({ denied: expect.stringContaining("empty argument"), integrity: true });
    }
  });

  it("B: a foreign destination is an integrity refusal even next to an unreadable option", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["fetch", "--dry", "ext::sh -c id"], remote: null })).toMatchObject({ integrity: true });
    expect(classifyGitHubOperation({ program: "git", args: ["push", "ext::sh -c id", "refs/tags/p@1"], remote: null, pushUrls: ["ext::sh -c id"] })).toMatchObject({ integrity: true });
  });

  it("regressions: leading -R, and -R= in gh pr merge", () => {
    expect(classifyGitHubOperation({ program: "gh", args: ["-R", "Anthm-FR/linkzic", "pr", "view", "5"], remote: origin })).toMatchObject({ access: "read", repository: "anthm-fr/linkzic" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "-R=Anthm-FR/songtrivia", "7", "--admin", "--match-head-commit", sha], remote: null }))
      .toMatchObject({ privileged: ["adminMerge"], pullRequest: 7, expectedHeadSha: sha });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "-R=Anthm-FR/songtrivia", "7", "--admin", "--match-head-commit", sha], remote: null }).denied).toBeUndefined();
  });
});
describe("security review round 2e (attack regressions)", () => {
  it("D: does not skip a URL selector that follows a text option another option takes as its value", () => {
    const origin = "https://github.com/Anthm-FR/songtrivia.git";
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "-q", "--body", "https://tenant.ghe.com/o/r/pull/1"], remote: origin }))
      .toMatchObject({ denied: expect.stringContaining("tenant.ghe.com"), integrity: true });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "--title", "--body", "https://tenant.ghe.com/o/r/pull/1"], remote: origin })).toMatchObject({ integrity: true });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "close", "-c", "--body", "https://github.com/victim/repo/pull/1"], remote: origin })).toMatchObject({ repository: "victim/repo" });
    // A body that is a link is still text when it follows a value.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--title", "T", "--body", "https://example.com/preview"], remote: origin }).denied).toBeUndefined();
  });
});


describe("security review round 3 (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";
  it("B2: gh's saved default repository (gh repo set-default) is the repository Paperclip checks", () => {
    for (const args of [["issue", "comment", "1", "-b", "x"], ["pr", "create", "--fill"], ["api", "-X", "POST", "repos/{owner}/{repo}/issues/1/comments", "-f", "body=x"]]) {
      const operation = readGitHubOperation({ operation: { program: "gh", args, remote: origin, ghResolved: ["Anthm-FR/linkzic"] } });
      expect(classifyGitHubOperation(operation!), args.join(" ")).toMatchObject({ access: "write", repository: "anthm-fr/linkzic" });
    }
    // "base" only marks the remote gh uses; -R and GH_REPO come before the saved default.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--fill"], remote: origin, ghResolved: ["base"] })).toMatchObject({ repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--fill", "-R", "Anthm-FR/anthm-fr"], remote: origin, ghResolved: ["Anthm-FR/linkzic"] })).toMatchObject({ repository: "anthm-fr/anthm-fr" });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--fill"], remote: origin, ghRepo: "Anthm-FR/anthm-fr", ghResolved: ["Anthm-FR/linkzic"] })).toMatchObject({ repository: "anthm-fr/anthm-fr" });
    // Two saved defaults: Paperclip cannot tell which one gh uses.
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "create", "--fill"], remote: origin, ghResolved: ["Anthm-FR/linkzic", "Anthm-FR/wordzic"] })).toMatchObject({ denied: expect.stringContaining("cannot tell which repository") });
  });

  it("B1/B3: what the launcher reads from config (tags sent with every push, submodule recursion) reaches the classifier", () => {
    const push = { program: "git", args: ["push", "origin", "feature"], remote: origin, pushUrls: [origin], currentBranch: "feature", refs: {}, shas: ["a".repeat(40)], touchesWorkflows: false };
    expect(classifyGitHubOperation(readGitHubOperation({ operation: { ...push, followTags: true } })!).privileged).toContain("tagPush");
    expect(classifyGitHubOperation(readGitHubOperation({ operation: { ...push, recurseSubmodules: "on-demand" } })!)).toMatchObject({ denied: expect.stringContaining("submodules"), integrity: true });
    expect(classifyGitHubOperation(readGitHubOperation({ operation: push })!)).toMatchObject({ privileged: [] });
    expect(classifyGitHubOperation(readGitHubOperation({ operation: push })!).denied).toBeUndefined();
  });
});

describe("security review round 4 (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";
  it("N3: gh repo verbs without a repository argument are checked against the saved default and remotes, not only GH_REPO", () => {
    for (const args of [["repo", "fork"], ["repo", "fork", "--clone=false"]]) {
      const classified = classifyGitHubOperation({ program: "gh", args, remote: origin, ghRepo: "Anthm-FR/anthm-fr", ghResolved: ["Anthm-FR/linkzic"] });
      expect(classified.denied, args.join(" ")).toMatch(/cannot tell which repository/);
      // Without a saved default, the remote counts as well.
      expect(classifyGitHubOperation({ program: "gh", args, remote: origin, ghRepo: "Anthm-FR/anthm-fr" }).denied, args.join(" ")).toMatch(/cannot tell which repository/);
    }
    // Archiving, unarchiving or editing a repository is refused whichever repository it names, for every company.
    for (const args of [["repo", "edit", "--description", "x"], ["repo", "archive", "--yes"], ["repo", "unarchive", "--yes"]]) {
      expect(classifyGitHubOperation({ program: "gh", args, remote: origin, ghRepo: "Anthm-FR/anthm-fr", ghResolved: ["Anthm-FR/linkzic"] }), args.join(" "))
        .toMatchObject({ denied: expect.stringMatching(/^Denied: agents never/), integrity: true });
    }
    // GH_REPO and the checkout agree, or the repository is named: one repository.
    expect(classifyGitHubOperation({ program: "gh", args: ["repo", "edit", "--description", "x"], remote: origin, ghRepo: "Anthm-FR/songtrivia" })).toMatchObject({ repository: "anthm-fr/songtrivia" });
    expect(classifyGitHubOperation({ program: "gh", args: ["repo", "edit", "Anthm-FR/anthm-fr", "--description", "x"], remote: origin, ghRepo: "Anthm-FR/anthm-fr", ghResolved: ["Anthm-FR/linkzic"] })).toMatchObject({ repository: "anthm-fr/anthm-fr" });
    expect(classifyGitHubOperation({ program: "gh", args: ["repo", "view"], remote: origin, ghRepo: "Anthm-FR/anthm-fr", ghResolved: ["Anthm-FR/linkzic"] })).toMatchObject({ access: "read", repository: null });
  });

  it("P4b: marks every pull request merge, and auto-merge, for the plugin's protected-path guard", () => {
    const sha = "a".repeat(40);
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "--squash", "--match-head-commit", sha], remote: origin })).toMatchObject({ merge: true, pullRequest: 7, expectedHeadSha: sha });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "--auto", "--squash"], remote: origin })).toMatchObject({ merge: true, autoMerge: true });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "--auto=true"], remote: origin })).toMatchObject({ autoMerge: true });
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "merge", "7", "--auto=false", "--match-head-commit", sha], remote: origin })).not.toHaveProperty("autoMerge");
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "-X", "PUT", "repos/Anthm-FR/songtrivia/pulls/7/merge", "-f", `sha=${sha}`], remote: origin })).toMatchObject({ merge: true, pullRequest: 7, expectedHeadSha: sha });
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "repos/Anthm-FR/songtrivia/pulls/7/merge"], remote: origin })).not.toHaveProperty("merge");
    expect(classifyGitHubOperation({ program: "gh", args: ["pr", "view", "7"], remote: origin })).not.toHaveProperty("merge");
  });
});

describe("security review round 5 (attack regressions)", () => {
  const origin = "https://github.com/Anthm-FR/songtrivia.git";
  it("m2: marks every base change of a pull request (gh pr edit, REST); GraphQL updatePullRequest is refused", () => {
    for (const args of [["pr", "edit", "7", "--base", "main"], ["pr", "edit", "7", "--base=main"], ["pr", "edit", "7", "-B", "main"], ["pr", "edit", "7", "-Bmain"],
      ["api", "-X", "PATCH", "repos/Anthm-FR/songtrivia/pulls/7", "-f", "base=main"], ["api", "-X", "PATCH", "repos/Anthm-FR/songtrivia/pulls/7", "--input", "body.json"],
      ["api", "-X", "PATCH", "repos/Anthm-FR/songtrivia/pulls/7", "-F", "base=@branch.txt"]]) {
      expect(classifyGitHubOperation({ program: "gh", args, remote: origin }), args.join(" ")).toMatchObject({ access: "write", retarget: true });
    }
    for (const args of [["pr", "edit", "7", "--title", "x"], ["api", "-X", "PATCH", "repos/Anthm-FR/songtrivia/pulls/7", "-f", "title=x"], ["pr", "create", "--base", "main", "--fill"]]) {
      expect(classifyGitHubOperation({ program: "gh", args, remote: origin }), args.join(" ")).not.toHaveProperty("retarget");
    }
    expect(classifyGitHubOperation({ program: "gh", args: ["api", "graphql", "-f", 'query=mutation{updatePullRequest(input:{pullRequestId:"x",baseRefName:"main"}){clientMutationId}}'], remote: origin }).denied)
      .toMatch(/cannot check the GraphQL mutation updatePullRequest/);
  });

  describe("workflow changes of a push", () => {
    const origin = "https://github.com/Acme/Site.git";
    const sha = "a".repeat(40), parent = "b".repeat(40), side = "c".repeat(40);
    const oid = "d".repeat(40);
    const workflowFiles = [{ path: ".github/workflows/ci.yml", mode: "100644", oid }];
    const workflowCommits = [{ sha, parents: [parent, side], changes: [{ path: ".github/workflows/ci.yml", mode: "100644", oid }, { path: ".github/workflows/old.yml", mode: null, oid: null }] }];
    const workflowEntries = [parent, side];
    const report = { workflowFiles, workflowCommits, workflowEntries };
    const push = (args: string[], extra: Record<string, unknown> = {}) => classifyGitHubOperation({
      program: "git", args, remote: origin, pushUrls: [origin], currentBranch: "feature/x", refs: { "feature/x": "refs/heads/feature/x" },
      shas: [sha], touchesWorkflows: true, ...report, ...extra,
    });
    const expected = { branch: "feature/x", tip: sha, files: workflowFiles, commits: workflowCommits, entries: workflowEntries };

    const githubSaysFeatureXIsNeitherDefaultNorProtected = { repository: "acme/site", defaultBranch: "main", protection: new Map([["feature/x", false]]) };

    it("keeps editWorkflows on the push and hands the plugin its one branch, the commits and the files", async () => {
      await withProtectedBranchFacts(githubSaysFeatureXIsNeitherDefaultNorProtected, async () => {
        for (const args of [["push", "origin", "feature/x"], ["push"], ["push", "origin", "HEAD"], ["push", "-u", "origin", "HEAD:refs/heads/feature/x"], ["push", "origin", "refs/heads/feature/x"],
          ["push", "--force-with-lease", "origin", "+feature/x"], ["push", "origin", "heads/feature/x"]]) {
          const classified = push(args);
          expect(classified, args.join(" ")).toMatchObject({ access: "write", privileged: ["editWorkflows"], workflowPush: expected });
          expect(classified.denied, args.join(" ")).toBeUndefined();
        }
      });
      // A push to another branch name is that branch.
      expect(push(["push", "origin", "HEAD:refs/heads/release/1.2"])).toMatchObject({ workflowPush: { ...expected, branch: "release/1.2" } });
      // A push that only moves the branch to an existing commit has no new commit to list.
      expect(push(["push", "--force", "origin", "feature/x"], { workflowCommits: [], workflowEntries: [sha] })).toMatchObject({ workflowPush: { ...expected, commits: [], entries: [sha] } });
    });

    it("keeps the workflow branch of a forced push, which is refused until GitHub's answer on that branch is read", async () => {
      const args = ["push", "--force-with-lease", "origin", "+feature/x"];
      const unread = push(args);
      expect(unread).toMatchObject({ privileged: ["editWorkflows"], workflowPush: expected, branchRewrites: ["feature/x"] });
      expect(unread.denied).toMatch(/could not read from GitHub whether feature\/x is the default or a protected branch of acme\/site/);
      const protectedOne = { ...githubSaysFeatureXIsNeitherDefaultNorProtected, protection: new Map([["feature/x", true]]) };
      const protectedPush = await withProtectedBranchFacts(protectedOne, async () => push(args));
      expect(protectedPush.denied).toMatch(/feature\/x is a protected branch of acme\/site/);
    });

    it("offers nothing the plugin could check when the push is not exactly one commit to one named branch, or the report is partial", () => {
      const cases: Array<[string, ReturnType<typeof push>]> = [
        ["two commits", push(["push", "origin", "feature/x"], { shas: [sha, "e".repeat(40)] })],
        ["two branches", push(["push", "origin", "feature/x", "other"], { refs: { "feature/x": "refs/heads/feature/x", other: "refs/heads/other" } })],
        ["a tag", push(["push", "origin", "HEAD:refs/tags/v1"])],
        ["every branch", push(["push", "--all", "origin"])],
        ["a pattern", push(["push", "origin", "HEAD:refs/heads/*"])],
        ["config that can push more", push(["push"], { implicitPush: true })],
        ["a deletion", push(["push", "origin", "--delete", "feature/x"])],
        ["a detached HEAD (no branch name)", push(["push", "origin", "HEAD"], { currentBranch: null })],
        ["no files", push(["push", "origin", "feature/x"], { workflowFiles: undefined })],
        ["no commits", push(["push", "origin", "feature/x"], { workflowCommits: undefined })],
        ["no entries", push(["push", "origin", "feature/x"], { workflowEntries: undefined })],
        ["an empty list of entries", push(["push", "origin", "feature/x"], { workflowEntries: [] })],
        ["a push the launcher says has no workflow changes", push(["push", "origin", "feature/x"], { touchesWorkflows: false })],
      ];
      for (const [label, classified] of cases) expect(classified, label).not.toHaveProperty("workflowPush");
      // Without the report the toggle alone decides, as before.
      expect(push(["push", "origin", "feature/x"], { workflowFiles: undefined })).toMatchObject({ privileged: ["editWorkflows"] });
    });

    it("still refuses what the toggles never allow, whatever the push reports", () => {
      const tag = push(["push", "origin", "refs/tags/engine@1.0.0"]);
      expect(tag.denied).toMatch(/Release tags/);
      expect(tag).not.toHaveProperty("workflowPush");
      expect(push(["push", "origin", "feature/x"], { urlRewrites: true }).denied).toMatch(/url\.\*\.insteadOf/);
    });

    it("accepts the report only in the launcher's exact shape and within its bounds", () => {
      const operation = { program: "git", args: ["push", "origin", "feature/x"], remote: origin, shas: [sha], touchesWorkflows: true };
      expect(parseGitHubOperation({ operation: { ...operation, ...report } })).toMatchObject(report);
      const file = workflowFiles[0]!, commit = workflowCommits[0]!;
      for (const [label, bad] of [
        ["a file without a blob", { workflowFiles: [{ path: file.path, mode: "100644" }] }],
        ["a gone file among the files", { workflowFiles: [{ path: file.path, mode: null, oid: null }] }],
        ["a short mode", { workflowFiles: [{ path: file.path, mode: "644", oid }] }],
        ["a bad blob", { workflowFiles: [{ path: file.path, mode: "100644", oid: "xyz" }] }],
        ["a long path", { workflowFiles: [{ path: `.github/workflows/${"x".repeat(300)}.yml`, mode: "100644", oid }] }],
        ["more than 100 files", { workflowFiles: Array.from({ length: 101 }, () => file) }],
        ["a commit without changes", { workflowCommits: [{ ...commit, changes: [] }] }],
        ["a commit with a bad parent", { workflowCommits: [{ ...commit, parents: ["xyz"] }] }],
        ["a commit with too many parents", { workflowCommits: [{ ...commit, parents: Array.from({ length: 17 }, () => parent) }] }],
        ["a commit that is not a hash", { workflowCommits: [{ ...commit, sha: "xyz" }] }],
        ["more than 100 commits", { workflowCommits: Array.from({ length: 101 }, () => commit) }],
        ["more than 400 changes", { workflowCommits: Array.from({ length: 5 }, () => ({ ...commit, changes: Array.from({ length: 100 }, () => commit.changes[0]!) })) }],
        ["more than 8 entries", { workflowEntries: Array.from({ length: 9 }, () => parent) }],
        ["an entry that is not a hash", { workflowEntries: ["xyz"] }],
        ["commits that are not a list", { workflowCommits: "x" }],
      ] as const) {
        expect(readGitHubOperation({ operation: { ...operation, ...report, ...bad } }), label).toBe("unreadable");
      }
    });

    it("sends the plugin the branch, the commit, the files and the entries with the other write-identity parameters", async () => {
      const calls: Array<Record<string, any>> = [];
      registerGitHubWriteIdentityWorkers({ call: async (_plugin: string, _method: string, input: any) => { calls.push(input.params); return { identity: "user", unavailable: "stop here" }; } } as any);
      try {
        const record = { pluginId: "plugin-github", ready: true, policy: "invalid", manifest: { projectRepositories: { writeIdentityAction: "repository-write-identity" } } } as any;
        await resolveGitHubWriteIdentityDecision({} as any, { companyId: "company-1", operation: push(["push", "origin", "feature/x"]) }, record);
        await resolveGitHubWriteIdentityDecision({} as any, { companyId: "company-1", operation: push(["push", "origin", "feature/x"], { workflowFiles: undefined }) }, record);
        expect(calls[0]).toMatchObject({ companyId: "company-1", repository: "acme/site", privileged: ["editWorkflows"], workflowPush: expected });
        expect(calls[1]).not.toHaveProperty("workflowPush");
      } finally { registerGitHubWriteIdentityWorkers(null); }
    });
  });
});

describe("destructive branch operations with an incomplete report (review round 3)", () => {
  const remote = "https://github.com/acme/site.git";
  const clean = { currentBranch: "feature", touchesWorkflows: false };
  const refused = /^Denied: .*never delete or force-push a default or protected branch.*could not tell which repository/s;

  it.each([
    ["force push without remote or pushUrls", ["push", "origin", "--force", "release"]],
    ["delete push without remote or pushUrls", ["push", "origin", "--delete", "release"]],
    ["colon delete refspec without remote", ["push", "origin", ":release"]],
    ["plus refspec without remote", ["push", "origin", "+HEAD:release"]],
    ["force-with-lease without remote", ["push", "--force-with-lease", "origin", "release"]],
  ])("refuses a %s", (_name, args) => {
    const classified = classifyGitHubOperation({ program: "git", args, ...clean });
    expect(classified).toMatchObject({ access: "write", repository: null, integrity: true });
    expect(classified.denied).toMatch(refused);
  });

  it("refuses a rewrite whose report names a remote Paperclip cannot resolve, or a null remote and empty pushUrls", () => {
    for (const operation of [
      { program: "git" as const, args: ["push", "origin", "--force", "release"], remote: null, pushUrls: [], ...clean },
      { program: "git" as const, args: ["push", "origin", "--force", "release"], remote: null, ...clean },
      { program: "gh" as const, args: ["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/release"], remote: null },
      { program: "gh" as const, args: ["repo", "sync", "--force", "--branch", "release"], remote: null },
    ]) {
      expect(classifyGitHubOperation(operation).denied, operation.args.join(" ")).toMatch(/Denied: /);
    }
  });

  it("keeps complete reports and plain pushes working, and refuses a rewrite to a target that only looks like a local path", () => {
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "--force", "release"], remote, pushUrls: [remote], ...clean }))
      .toMatchObject({ repository: "acme/site", branchRewrites: ["release"] });
    expect(classifyGitHubOperation({ program: "git", args: ["push", "origin", "feature"], ...clean }).denied).toBeUndefined();
    expect(classifyGitHubOperation({ program: "git", args: ["push", "../mirror.git", "--force-with-lease", "release"], remote: null, ...clean }).denied).toMatch(refused);
    expect(classifyGitHubOperation({ program: "git", args: ["push", "../mirror.git", "release"], remote: null, ...clean }).denied).toBeUndefined();
  });
});

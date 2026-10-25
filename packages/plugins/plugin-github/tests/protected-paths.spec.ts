import { describe, expect, it } from "vitest";
import { CODEOWNERS_PATHS, MINIMUM_PROTECTED_PATHS, classifyKeptFiles, isCodeownersPath, matchesProtectedPath, parseAgentMergeablePaths, parseJsonWithoutDuplicateKeys, parseProtectedPathPolicy, parseProtectedPaths, policyPaths, protectedFiles, protectedPatterns, releasedByOptIn, requirementsOf, splitReleased, type AgentMergeableRule, type RepositoryPathPolicy } from "../src/protected-paths.js";

/** A repository whose admin protects what a company usually keeps as its control paths. */
const AGENT = "11111111-1111-4111-8111-111111111111", OTHER_AGENT = "22222222-2222-4222-8222-222222222222";
const CONTROL_PATHS = ["paperclip/**", "scripts/**", "ROADMAP.md", "data/company/strategy/**"];
const controlPolicy = (extra: Partial<RepositoryPathPolicy> = {}): RepositoryPathPolicy => ({ repository: "owner/repo", lenses: [], rules: [{ paths: CONTROL_PATHS, action: "refuse" }], ...extra });

describe("protected paths (P4b, round 4)", () => {
  it("reads protectedPaths from a tiers file and nothing else", () => {
    const tiers = "version: 1\ntiers:\n  - id: T0\n    covers:\n      - wording\nprotectedPaths:\n  - paperclip/**\n  # a comment\n  - \"scripts/**\"\n  - 'ROADMAP.md' # trailing\n\n  - data/company/monetisation/**/*goals*\nrules:\n  - x\n";
    expect(parseProtectedPaths(tiers)).toEqual(["paperclip/**", "scripts/**", "ROADMAP.md", "data/company/monetisation/**/*goals*"]);
    for (const bad of ["protectedPaths: [a]\n", "protectedPaths:\n  - &a b\n", "protectedPaths:\n  - path: b\n", "protectedPaths:\n\t- b\n", "x: 1\n", "protectedPaths:\n  - /etc\n", "protectedPaths:\n  - a\n---\nprotectedPaths:\n  - b\n"]) {
      expect(() => parseProtectedPaths(bad), bad).toThrow();
    }
  });

  it("matches gitignore-like globs, parents and any case", () => {
    expect(matchesProtectedPath("paperclip/**", "paperclip/a/b.yaml")).toBe(true);
    expect(matchesProtectedPath("paperclip/**", "PaperClip/a")).toBe(true);
    expect(matchesProtectedPath("paperclip/**", "paperclipx/a")).toBe(false);
    expect(matchesProtectedPath("CODEOWNERS", "docs/CODEOWNERS")).toBe(true);
    expect(matchesProtectedPath(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(matchesProtectedPath("data/company/monetisation/**/*goals*", "data/company/monetisation/q4-goals.md")).toBe(true);
    expect(matchesProtectedPath("data/products/*/knowledge/wiki-history/**", "data/products/linkzic/knowledge/wiki-history/x.md")).toBe(true);
    expect(matchesProtectedPath("data/products/*/knowledge/wiki-history/**", "data/products/linkzic/knowledge/other/x.md")).toBe(false);
    expect(matchesProtectedPath("scripts", "scripts/deploy.sh")).toBe(true);
    expect(matchesProtectedPath("ROADMAP.md", "README.md")).toBe(false);
  });

  it("protects .github and CODEOWNERS everywhere, plus a tiers file's paths and the paths of the repository's policy rules, and no built-in control list", () => {
    expect(protectedPatterns(null)).toEqual([".github/**", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);
    expect(protectedPatterns(null, null)).not.toContain("paperclip/**");
    expect(protectedPatterns([])).not.toContain("paperclip/**");
    expect(protectedPatterns(["x/**"])).toEqual([".github/**", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", "x/**"]);
    expect(protectedPatterns(["x/**"], controlPolicy())).toEqual(expect.arrayContaining([...CONTROL_PATHS, "x/**", ".github/**", "CODEOWNERS"]));
    expect(protectedFiles([{ filename: "b.ts", previousFilename: "scripts/a.ts" }, { filename: "ok.ts" }], ["scripts/**"])).toEqual(["scripts/a.ts"]);
  });
});

describe("protected paths (round 5)", () => {
  it("m5: x/** covers x itself", () => {
    expect(matchesProtectedPath("paperclip/**", "paperclip")).toBe(true);
    expect(matchesProtectedPath(".github/**", ".github")).toBe(true);
    expect(matchesProtectedPath("data/company/strategy/**", "data/company/strategy")).toBe(true);
    expect(matchesProtectedPath("paperclip/**", "paperclips")).toBe(false);
  });

  it("m3: reads JSON strictly, refusing a duplicate key", () => {
    expect(parseJsonWithoutDuplicateKeys('{"a":[1,{"b":"x\\"y"}],"c":null}')).toEqual({ a: [1, { b: 'x"y' }], c: null });
    for (const bad of ['{"owner":"evil","owner":"anthm"}', '{"a":{"b":1,"b":2}}', '{"a":1,}', '{"a":1} x', "{'a':1}"]) expect(() => parseJsonWithoutDuplicateKeys(bad), bad).toThrow();
    expect(Object.getPrototypeOf(parseJsonWithoutDuplicateKeys('{"__proto__":{"x":1}}'))).toBe(Object.prototype);
  });
});

describe("the opt-in that releases some protected paths for agent merges", () => {
  const rule = (extra: Partial<AgentMergeableRule> = {}): AgentMergeableRule => ({ repository: "owner/repo", allow: [".github/**"], exclude: [], ...extra });

  it("keeps the minimum list as it was: .github/** and the three CODEOWNERS paths", () => {
    expect([...MINIMUM_PROTECTED_PATHS]).toEqual([".github/**", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);
    expect([...CODEOWNERS_PATHS]).toEqual(["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);
  });

  it("knows a CODEOWNERS path at any depth and in any case, and nothing near it", () => {
    for (const path of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", "a/b/CODEOWNERS", ".github/codeowners", "Docs/CodeOwners"]) expect(isCodeownersPath(path), path).toBe(true);
    // A directory named like the file covers what is below it, as it does in the protected list (the cautious reading).
    expect(isCodeownersPath(".github/codeowners/readme.md")).toBe(true);
    for (const path of [".github/workflows/ci.yml", "CODEOWNERS.md", "docs/CODEOWNERS-guide.md", ".github/OWNERS"]) expect(isCodeownersPath(path), path).toBe(false);
  });

  it("reads a valid config: lower-cases the repository, defaults exclude to none, keeps the order", () => {
    expect(parseAgentMergeablePaths([{ repository: "Owner/Repo", allow: [".github/workflows/**"] }, { repository: "o/b", allow: [".github/**"], exclude: ["x"] }]))
      .toEqual({ rules: [{ repository: "owner/repo", allow: [".github/workflows/**"], exclude: [] }, { repository: "o/b", allow: [".github/**"], exclude: ["x"] }], problems: [] });
    for (const none of [undefined, null, []]) expect(parseAgentMergeablePaths(none)).toEqual({ rules: [], problems: [] });
  });

  it("drops an invalid entry whole, keeps the valid ones, and says why", () => {
    const parsed = parseAgentMergeablePaths([
      { repository: "owner/one", allow: [".github/**"] },
      { repository: "owner/two", allow: ["CODEOWNERS"] },
      { repository: "owner/three", allow: [".github/**", ".github/CODEOWNERS"] },
      { repository: "owner/four", allow: ["scripts/**"] },
      { repository: "owner/five", allow: [".github/**"], exclude: ["../x"] },
      { repository: "owner/six", allow: [".github/**"], extra: 1 },
      "text", null, [],
    ]);
    expect(parsed.rules.map(entry => entry.repository)).toEqual(["owner/one"]);
    expect(parsed.problems).toHaveLength(8);
    expect(parsed.problems.join("\n")).toMatch(/cannot name CODEOWNERS/);
    expect(parsed.problems.join("\n")).toMatch(/only release paths under \.github\//);
  });

  it("releases nothing for a repository that is listed twice, and for a list that is too long or not a list", () => {
    expect(parseAgentMergeablePaths([{ repository: "o/r", allow: [".github/**"] }, { repository: "O/R", allow: [".github/workflows/**"] }, { repository: "o/other", allow: [".github/**"] }]).rules.map(entry => entry.repository)).toEqual(["o/other"]);
    expect(parseAgentMergeablePaths(Array.from({ length: 51 }, (_, n) => ({ repository: `o/r${n}`, allow: [".github/**"] }))).rules).toEqual([]);
    for (const bad of ["yes", 7, true, { repository: "o/r", allow: [".github/**"] }]) expect(parseAgentMergeablePaths(bad).rules, JSON.stringify(bad)).toEqual([]);
  });

  it("releases a path only when allow covers it, no exclusion does, and it is not a CODEOWNERS, control or tiers path", () => {
    const r = rule({ exclude: [".github/workflows/release.yml", "**/deploy.*"] });
    expect(releasedByOptIn(r, ".github/workflows/ci.yml", null)).toBe(true);
    expect(releasedByOptIn(r, ".github/workflows/release.yml", null)).toBe(false);
    expect(releasedByOptIn(r, ".GitHub/Workflows/Release.yml", null)).toBe(false);
    expect(releasedByOptIn(r, ".github/actions/x/deploy.sh", null)).toBe(false);
    expect(releasedByOptIn(rule({ allow: [".github/workflows/**"] }), ".github/dependabot.yml", null)).toBe(false);
    for (const path of CODEOWNERS_PATHS) expect(releasedByOptIn(rule({ allow: [".github/**", path] }), path, null), path).toBe(false);
    expect(releasedByOptIn(r, ".github/workflows/ci.yml", [".github/workflows/ci.yml"])).toBe(false);
    // A path that a policy rule of the repository names stays with the policy, whatever the rule's action is.
    const reviewed = controlPolicy({ lenses: [{ name: "security", aliases: [], agents: [AGENT] }], rules: [{ paths: [".github/workflows/deploy.yml"], action: "require", lenses: ["security"], allowAdmin: false, codeowners: false }] });
    expect(releasedByOptIn(rule(), ".github/workflows/ci.yml", null, reviewed)).toBe(true);
    expect(releasedByOptIn(rule(), ".github/workflows/deploy.yml", null)).toBe(true);
    expect(releasedByOptIn(rule(), ".github/workflows/deploy.yml", null, reviewed)).toBe(false);
    expect(releasedByOptIn(r, "src/ok.ts", null)).toBe(false);
  });

  it("splits the protected files of a pull request, and releases nothing for a repository with a tiers file", () => {
    const r = rule({ exclude: [".github/workflows/release.yml"] });
    const touched = [".github/CODEOWNERS", ".github/dependabot.yml", ".github/workflows/ci.yml", ".github/workflows/release.yml"];
    expect(splitReleased(touched, r, null)).toEqual({ released: [".github/dependabot.yml", ".github/workflows/ci.yml"], kept: [".github/CODEOWNERS", ".github/workflows/release.yml"] });
    expect(splitReleased(touched, null, null)).toEqual({ released: [], kept: touched });
    expect(splitReleased(touched, r, [])).toEqual({ released: [], kept: touched });
    expect(splitReleased(touched, r, ["paperclip/**"])).toEqual({ released: [], kept: touched });
    // A tiers value that is not exactly null (a caller's `undefined`) releases nothing.
    expect(splitReleased(touched, r, undefined as unknown as null)).toEqual({ released: [], kept: touched });
    expect(splitReleased([], r, null)).toEqual({ released: [], kept: [] });
  });

  it("lets a repository with control paths in its policy opt in when it has no tiers file, and keeps its control paths and CODEOWNERS refused", () => {
    const policy = controlPolicy();
    const files = [".github/workflows/ci.yml", ".github/CODEOWNERS", "paperclip/gates.yaml", "scripts/build.sh"].map(filename => ({ filename }));
    const touched = protectedFiles(files, protectedPatterns(null, policy));
    expect(touched).toEqual([".github/CODEOWNERS", ".github/workflows/ci.yml", "paperclip/gates.yaml", "scripts/build.sh"]);
    expect(splitReleased(touched, rule(), null, policy)).toEqual({ released: [".github/workflows/ci.yml"], kept: [".github/CODEOWNERS", "paperclip/gates.yaml", "scripts/build.sh"] });
    // With a tiers file on its base branch the same repository cannot opt in.
    expect(splitReleased(touched, rule(), ["paperclip/**"], policy)).toEqual({ released: [], kept: touched });
  });

  it("never releases a control path, a CODEOWNERS path or a path outside its normal form, in any repository and whatever the rule allows", () => {
    // `splitReleased` takes no repository: no repository name can change the answer. The second rule is wider than the config
    // accepts (see parseAgentMergeablePaths), to show that these refusals hold without the validation.
    const refusedPaths = ["paperclip/gates.yaml", "scripts/build.sh", "ROADMAP.md", "data/company/strategy/plan.md", "CODEOWNERS", ".github/CODEOWNERS", ".github/../scripts/x", ".github/./CODEOWNERS", ".github//workflows/ci.yml"];
    const policy = controlPolicy();
    for (const r of [rule(), rule({ allow: ["**"] })]) {
      for (const path of refusedPaths) expect(splitReleased([path], r, null, policy), `${r.allow} ${path}`).toEqual({ released: [], kept: [path] });
      // Next to a released file they keep the refusal for the whole pull request.
      expect(splitReleased([".github/workflows/ci.yml", ...refusedPaths], r, null, policy), `${r.allow}`).toEqual({ released: [".github/workflows/ci.yml"], kept: refusedPaths });
    }
  });

  it("covers a rename by both of its names", () => {
    const files = [{ filename: ".github/workflows/ci.yml", previousFilename: ".github/workflows/release.yml" }];
    const touched = protectedFiles(files, protectedPatterns(null));
    expect(splitReleased(touched, rule({ exclude: [".github/workflows/release.yml"] }), null).kept).toEqual([".github/workflows/release.yml"]);
  });
});

describe("protectedPathPolicy: per-path rules that refuse or require reviewer approvals", () => {
  const lenses = [{ name: "security", aliases: ["Security"], agents: [AGENT] }, { name: "dx", aliases: ["Agents & DX"], agents: [OTHER_AGENT] }];
  const entry = (extra: Record<string, unknown> = {}) => ({
    repository: "Owner/Repo", lenses,
    rules: [{ paths: ["paperclip/**"], action: "refuse" }, { paths: ["scripts/**", ".github/**"], action: "require", lenses: ["security", "dx"], allowAdmin: true }, { paths: ["CODEOWNERS", ".github/CODEOWNERS"], action: "require", lenses: ["security"], codeowners: true }],
    ...extra,
  });

  it("reads nothing as no policy, and a valid entry with its defaults", () => {
    for (const none of [undefined, null, []]) expect(parseProtectedPathPolicy(none)).toEqual({ policies: [], problems: [] });
    const { policies, problems } = parseProtectedPathPolicy([entry()]);
    expect(problems).toEqual([]);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.repository).toBe("owner/repo");
    expect(policies[0]!.rules[1]).toEqual({ paths: ["scripts/**", ".github/**"], action: "require", lenses: ["security", "dx"], allowAdmin: true, codeowners: false });
    expect(policies[0]!.rules[2]).toMatchObject({ allowAdmin: false, codeowners: true });
    expect(policyPaths(policies[0]!)).toEqual(["paperclip/**", "scripts/**", ".github/**", "CODEOWNERS", ".github/CODEOWNERS"]);
    expect(policyPaths(null)).toEqual([]);
  });

  it("reads a rule with no action as a refuse rule, and still refuses a rule with no action that carries what only a require rule has", () => {
    const parsed = parseProtectedPathPolicy([entry({ rules: [{ paths: ["a/**"] }] })]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.policies[0]!.rules).toEqual([{ paths: ["a/**"], action: "refuse" }]);
    for (const extra of [{ lenses: ["security"] }, { allowAdmin: true }, { codeowners: true }]) {
      const bad = parseProtectedPathPolicy([entry({ rules: [{ paths: ["a/**"], ...extra }] })]);
      expect(bad.policies, JSON.stringify(extra)).toEqual([]);
      expect(bad.problems).toEqual([{ repository: "owner/repo", message: expect.stringMatching(/refuse rule takes no lenses/) }]);
    }
  });

  it.each([
    ["a config that is not a list", { repository: "o/r" }, null],
    ["more than 50 repositories", Array.from({ length: 51 }, (_, n) => entry({ repository: `o/r${n}` })), null],
    ["an entry that is not an object", ["text"], null],
    ["an unknown key", [entry({ release: true })], "owner/repo"],
    ["a repository with a wildcard", [entry({ repository: "o/*" })], null],
    ["no rules", [entry({ rules: [] })], "owner/repo"],
    ["an unknown action", [entry({ rules: [{ paths: ["a/**"], action: "allow" }] })], "owner/repo"],
    ["a refuse rule with lenses", [entry({ rules: [{ paths: ["a/**"], action: "refuse", lenses: ["security"] }] })], "owner/repo"],
    ["a refuse rule with allowAdmin", [entry({ rules: [{ paths: ["a/**"], action: "refuse", allowAdmin: true }] })], "owner/repo"],
    ["a require rule without lenses", [entry({ rules: [{ paths: ["a/**"], action: "require", lenses: [] }] })], "owner/repo"],
    ["a require rule with a lens nobody defined", [entry({ rules: [{ paths: ["a/**"], action: "require", lenses: ["performance"] }] })], "owner/repo"],
    ["a require rule with a flag that is not a boolean", [entry({ rules: [{ paths: ["a/**"], action: "require", lenses: ["security"], allowAdmin: "yes" }] })], "owner/repo"],
    ["a path that climbs out", [entry({ rules: [{ paths: ["../a"], action: "refuse" }] })], "owner/repo"],
    ["an absolute path", [entry({ rules: [{ paths: ["/a"], action: "refuse" }] })], "owner/repo"],
    ["a doubled slash", [entry({ rules: [{ paths: ["a//b"], action: "refuse" }] })], "owner/repo"],
    ["a path with a space", [entry({ rules: [{ paths: ["a b"], action: "refuse" }] })], "owner/repo"],
    ["more than 50 rules", [entry({ rules: Array.from({ length: 51 }, (_, n) => ({ paths: [`a${n}/**`], action: "refuse" })) })], "owner/repo"],
    ["more than 50 paths in a rule", [entry({ rules: [{ paths: Array.from({ length: 51 }, (_, n) => `a${n}/**`), action: "refuse" }] })], "owner/repo"],
    ["a lens without agents", [entry({ lenses: [{ name: "security", agents: [] }], rules: [{ paths: ["a/**"], action: "refuse" }] })], "owner/repo"],
    ["a lens agent that is not an agent ID", [entry({ lenses: [{ name: "security", agents: ["reviewer-1"] }], rules: [{ paths: ["a/**"], action: "refuse" }] })], "owner/repo"],
    ["a lens name used twice", [entry({ lenses: [{ name: "security", agents: [AGENT] }, { name: "Security", agents: [OTHER_AGENT] }] })], "owner/repo"],
    ["an alias that is another lens's name", [entry({ lenses: [{ name: "security", agents: [AGENT] }, { name: "dx", aliases: ["SECURITY"], agents: [OTHER_AGENT] }] })], "owner/repo"],
    ["an unknown key on a lens", [entry({ lenses: [{ name: "security", agents: [AGENT], any: true }] })], "owner/repo"],
  ])("reads %s as a problem, with no policy for it", (_name, value, repository) => {
    const parsed = parseProtectedPathPolicy(value);
    expect(parsed.problems.length).toBeGreaterThan(0);
    expect(parsed.problems.some(problem => problem.repository === repository)).toBe(true);
    expect(parsed.policies.filter(policy => policy.repository === "owner/repo")).toEqual([]);
  });

  it("drops a repository listed twice and keeps the others", () => {
    const parsed = parseProtectedPathPolicy([entry(), entry({ repository: "OWNER/repo" }), entry({ repository: "owner/other" })]);
    expect(parsed.policies.map(policy => policy.repository)).toEqual(["owner/other"]);
    expect(parsed.problems).toEqual([{ repository: "owner/repo", message: expect.stringContaining("listed more than once") }]);
  });

  it("sorts kept files by the first rule that covers them: refuse rules, no rule, CODEOWNERS without the flag and odd paths stay refused", () => {
    const policy = parseProtectedPathPolicy([entry()]).policies[0]!;
    const result = classifyKeptFiles(["paperclip/tiers.yaml", "scripts/build.sh", ".github/workflows/ci.yml", "docs/readme.md", ".github/CODEOWNERS", "sub/CODEOWNERS", ".github/../paperclip/x"], policy);
    // `CODEOWNERS` in a rule covers the file at any depth, as in the protected list.
    expect(result.governed).toEqual([{ path: "scripts/build.sh", ruleIndex: 1 }, { path: ".github/workflows/ci.yml", ruleIndex: 1 }, { path: ".github/CODEOWNERS", ruleIndex: 2 }, { path: "sub/CODEOWNERS", ruleIndex: 2 }]);
    expect(result.refused).toEqual(["paperclip/tiers.yaml", "docs/readme.md", ".github/../paperclip/x"]);
    expect(classifyKeptFiles(["scripts/build.sh"], null)).toEqual({ refused: ["scripts/build.sh"], governed: [] });
    // `.github/**` covers .github/CODEOWNERS, but only the rule that opts in with `codeowners` may govern it.
    const broad = parseProtectedPathPolicy([entry({ rules: [{ paths: [".github/**"], action: "require", lenses: ["security"] }] })]).policies[0]!;
    expect(classifyKeptFiles([".github/CODEOWNERS", ".github/workflows/ci.yml"], broad)).toEqual({ refused: [".github/CODEOWNERS"], governed: [{ path: ".github/workflows/ci.yml", ruleIndex: 0 }] });
    // An earlier refuse rule keeps a path out of a later require rule.
    const shadowed = parseProtectedPathPolicy([entry({ rules: [{ paths: ["scripts/deploy.sh"], action: "refuse" }, { paths: ["scripts/**"], action: "require", lenses: ["security"] }] })]).policies[0]!;
    expect(classifyKeptFiles(["scripts/deploy.sh", "scripts/build.sh"], shadowed)).toEqual({ refused: ["scripts/deploy.sh"], governed: [{ path: "scripts/build.sh", ruleIndex: 1 }] });
  });

  it("adds up what the governed files ask for: each lens once, the rules used, and the rules that do not allow --admin", () => {
    const policy = parseProtectedPathPolicy([entry()]).policies[0]!;
    const needs = requirementsOf([{ path: "scripts/a.sh", ruleIndex: 1 }, { path: ".github/CODEOWNERS", ruleIndex: 2 }, { path: ".github/x.yml", ruleIndex: 1 }], policy);
    expect(needs.lenses).toEqual(["security", "dx"]);
    expect(needs.rules.map(rule => [rule.index, rule.files])).toEqual([[1, ["scripts/a.sh", ".github/x.yml"]], [2, [".github/CODEOWNERS"]]]);
    expect(needs.withoutAdmin).toEqual([2]);
    expect(() => requirementsOf([{ path: "paperclip/a", ruleIndex: 0 }], policy)).toThrow();
  });
});

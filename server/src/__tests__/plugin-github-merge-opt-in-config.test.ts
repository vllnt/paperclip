import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";
import manifest from "../../../packages/plugins/plugin-github/src/manifest.js";
import { parseAgentMergeablePaths, parseProtectedPathPolicy } from "../../../packages/plugins/plugin-github/src/protected-paths.js";

// The GitHub plugin's `agentMergeablePaths` config lets an instance admin release some protected paths for agent merges. The host
// validates the plugin's instanceConfigSchema when the config is saved (POST /api/plugins/:id/config), and the plugin reads and
// validates the config again at every merge. These tests run the host's own validator on the plugin's real schema: what the
// schema lets through, the plugin's reader accepts; what could widen a release beyond .github/ or touch CODEOWNERS is refused
// at save. No mocks.

const schema = manifest.instanceConfigSchema as Parameters<typeof validateInstanceConfig>[1];
const save = (agentMergeablePaths: unknown) => validateInstanceConfig({ agentMergeablePaths } as Record<string, unknown>, schema);
const entry = (extra: Record<string, unknown> = {}) => ({ repository: "owner/repo", allow: [".github/**"], ...extra });
const errorsOf = (value: unknown) => (save(value).errors ?? []).map(error => `${error.field} ${error.message}`).join("; ");

describe("agentMergeablePaths: what the host accepts when the config is saved", () => {
  it.each([
    ["nothing at all (the default)", undefined],
    ["an empty list", []],
    ["one repository, all of .github", [entry()]],
    ["exclusions, plain and globbed", [entry({ exclude: [".github/workflows/release.yml", "**/deploy.yml", ".github/actions/*/publish.yml"] })]],
    ["a narrower allow, several repositories, dots and dashes in names", [entry({ allow: [".github/workflows/**", ".github/actions/*/action.yml"] }), entry({ repository: "Some-Org/repo.name_2", exclude: [] })]],
  ])("accepts %s, and the plugin's reader reads it the same way", (_name, value) => {
    expect(save(value), errorsOf(value)).toEqual({ valid: true });
    const parsed = parseAgentMergeablePaths(value);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rules).toHaveLength(Array.isArray(value) ? value.length : 0);
  });

  it.each([
    ["a list that is not a list", { repository: "owner/repo", allow: [".github/**"] }],
    ["a text", "yes"],
    ["an entry with no allow", [{ repository: "owner/repo" }]],
    ["an entry with an empty allow", [entry({ allow: [] })]],
    ["an entry with an unknown key", [entry({ release: true })]],
    ["a repository without an owner", [entry({ repository: "repo" })]],
    ["a repository with a wildcard", [entry({ repository: "owner/*" })]],
    ["a repository with three parts", [entry({ repository: "a/b/c" })]],
    ["more than 50 repositories", Array.from({ length: 51 }, (_, n) => entry({ repository: `owner/repo-${n}` }))],
    ["more than 50 allow paths", [entry({ allow: Array.from({ length: 51 }, (_, n) => `.github/w${n}/**`) })]],
    ["more than 100 exclusions", [entry({ exclude: Array.from({ length: 101 }, (_, n) => `x${n}`) })]],
  ])("refuses %s", (_name, value) => {
    expect(save(value).valid).toBe(false);
    expect(parseAgentMergeablePaths(value).rules).toEqual([]);
  });

  it.each([
    ["CODEOWNERS at the root", "CODEOWNERS"],
    ["the CODEOWNERS file under .github", ".github/CODEOWNERS"],
    ["the CODEOWNERS file under docs", "docs/CODEOWNERS"],
    ["CODEOWNERS in another case", ".github/codeowners"],
    ["CODEOWNERS at any depth under .github", ".github/**/CODEOWNERS"],
    ["a glob that spells CODEOWNERS", ".github/CODEOWNERS*"],
    ["everything", "**"],
    ["a path outside .github", "scripts/**"],
    ["a protected path outside .github", "ROADMAP.md"],
    ["an absolute path", "/.github/**"],
    ["a path that climbs out of .github", ".github/../scripts/**"],
    ["only the .github directory name", ".github/"],
    ["another case of the directory name", ".GitHub/**"],
    ["a doubled slash", ".github//workflows/**"],
    ["a space", ".github/work flows/**"],
    ["a command", ".github/$(id)"],
    ["no text", ""],
  ])("refuses an allow path that is %s, and so does the plugin's reader", (_name, path) => {
    const value = [entry({ allow: [path] })];
    expect(save(value).valid, errorsOf(value)).toBe(false);
    expect(parseAgentMergeablePaths(value).rules).toEqual([]);
    // One bad path next to a good one still refuses the whole save.
    const mixed = [entry({ allow: [".github/**", path] })];
    expect(save(mixed).valid).toBe(false);
    expect(parseAgentMergeablePaths(mixed).rules).toEqual([]);
  });

  it.each([
    ["a path that climbs out", "../escape"],
    ["an absolute path", "/etc/passwd"],
    ["a doubled slash", ".github//x"],
    ["a space", "a b"],
    ["a command", "$(id)"],
  ])("refuses an exclusion that is %s", (_name, path) => {
    const value = [entry({ exclude: [path] })];
    expect(save(value).valid).toBe(false);
    expect(parseAgentMergeablePaths(value).rules).toEqual([]);
  });

  it("refuses a non-list exclusion and a non-text path", () => {
    expect(save([entry({ exclude: ".github/x" })]).valid).toBe(false);
    expect(save([entry({ allow: [7] })]).valid).toBe(false);
    expect(save([entry({ exclude: [null] })]).valid).toBe(false);
  });

  it("does not change what the rest of the config accepts", () => {
    expect(validateInstanceConfig({ appId: "12", personalLogin: "someone" }, schema)).toEqual({ valid: true });
    expect(validateInstanceConfig({ appId: "0" }, schema).valid).toBe(false);
    expect(validateInstanceConfig({ release: true } as Record<string, unknown>, schema).valid).toBe(false);
  });

  it("says in the schema's own help text that an exclusion is a speed bump, and where the real boundary is", () => {
    const description = String((manifest.instanceConfigSchema as { properties: Record<string, { description?: string }> }).properties.agentMergeablePaths?.description);
    expect(description).toMatch(/speed bump, not a boundary/);
    expect(description).toMatch(/environment protection/);
    expect(description).toMatch(/CODEOWNERS/);
    expect(description).toMatch(/instance administrator/);
  });
});

// The `protectedPathPolicy` config names, per repository, the paths a merge by an agent may not touch (`refuse`, the default) or
// may touch once reviewer agents approved the exact head (`require`). The same two layers check it: the host's schema at save,
// the plugin's reader at every merge.
const AGENT = "11111111-1111-4111-8111-111111111111";
const lens = (extra: Record<string, unknown> = {}) => ({ name: "security", aliases: ["Security reviewer"], agents: [AGENT], ...extra });
const policy = (extra: Record<string, unknown> = {}) => ({
  repository: "owner/repo", lenses: [lens()],
  rules: [{ paths: ["scripts/**"], action: "require", lenses: ["security"], allowAdmin: true }, { paths: ["data/**"], action: "refuse" }],
  ...extra,
});
const savePolicy = (protectedPathPolicy: unknown) => validateInstanceConfig({ protectedPathPolicy } as Record<string, unknown>, schema);
const policyErrors = (value: unknown) => (savePolicy(value).errors ?? []).map(error => `${error.field} ${error.message}`).join("; ");

describe("protectedPathPolicy: what the host accepts when the config is saved", () => {
  it.each([
    ["nothing at all (the default)", undefined],
    ["an empty list", []],
    ["a refuse rule alone, with no reviewers", [{ repository: "owner/repo", rules: [{ paths: ["paperclip/**"], action: "refuse" }] }]],
    ["a refuse rule that spells the default", [{ repository: "owner/repo", rules: [{ paths: ["a"] }] }]],
    ["a rule that requires reviewers, with and without --admin", [policy()]],
    ["a CODEOWNERS rule that opts in", [policy({ rules: [{ paths: ["CODEOWNERS"], action: "require", lenses: ["security"], codeowners: true }] })]],
    ["several repositories and several lenses", [policy(), policy({ repository: "Some-Org/repo.name_2", lenses: [lens(), lens({ name: "agents & dx", aliases: [], agents: [AGENT] })], rules: [{ paths: ["x/**"], action: "require", lenses: ["security", "agents & dx"] }] })]],
  ])("accepts %s, and the plugin's reader reads it the same way", (_name, value) => {
    expect(savePolicy(value), policyErrors(value)).toEqual({ valid: true });
    const parsed = parseProtectedPathPolicy(value);
    expect(parsed.problems).toEqual([]);
    expect(parsed.policies).toHaveLength(Array.isArray(value) ? value.length : 0);
  });

  it.each([
    ["a list that is not a list", policy()],
    ["a text", "yes"],
    ["an entry with no repository", [{ rules: [{ paths: ["a"], action: "refuse" }] }]],
    ["an entry with no rules", [{ repository: "owner/repo" }]],
    ["an entry with an empty rule list", [policy({ rules: [] })]],
    ["a repository with a wildcard", [policy({ repository: "owner/*" })]],
    ["an entry with an unknown key", [policy({ release: true })]],
    ["a rule with an unknown key", [policy({ rules: [{ paths: ["a"], action: "refuse", note: "x" }] })]],
    ["a rule with no paths", [policy({ rules: [{ paths: [], action: "refuse" }] })]],
    ["a rule with an unknown action", [policy({ rules: [{ paths: ["a"], action: "allow" }] })]],
    ["a require rule with no lens", [policy({ rules: [{ paths: ["a"], action: "require" }] })]],
    ["a rule with no action that names lenses", [policy({ rules: [{ paths: ["a"], lenses: ["security"] }] })]],
    ["a rule with no action that allows --admin", [policy({ rules: [{ paths: ["a"], allowAdmin: true }] })]],
    ["a require rule with an empty lens list", [policy({ rules: [{ paths: ["a"], action: "require", lenses: [] }] })]],
    ["a refuse rule that names lenses", [policy({ rules: [{ paths: ["a"], action: "refuse", lenses: ["security"] }] })]],
    ["a refuse rule that allows --admin", [policy({ rules: [{ paths: ["a"], action: "refuse", allowAdmin: true }] })]],
    ["a refuse rule that sets codeowners", [policy({ rules: [{ paths: ["a"], action: "refuse", codeowners: true }] })]],
    ["a lens with no agent", [policy({ lenses: [lens({ agents: [] })] })]],
    ["a lens agent that is not an id", [policy({ lenses: [lens({ agents: ["security-reviewer"] })] })]],
    ["a lens name with a control character", [policy({ lenses: [lens({ name: "security\nBLOCK" })] })]],
    ["a lens name that starts with a space", [policy({ lenses: [lens({ name: " security" })] })]],
    ["a path that climbs out", [policy({ rules: [{ paths: ["../escape"], action: "refuse" }] })]],
    ["an absolute path", [policy({ rules: [{ paths: ["/etc/passwd"], action: "refuse" }] })]],
    ["a path with a command", [policy({ rules: [{ paths: ["$(id)"], action: "refuse" }] })]],
    ["more than 50 repositories", Array.from({ length: 51 }, (_, n) => policy({ repository: `owner/repo-${n}` }))],
    ["more than 50 rules", [policy({ rules: Array.from({ length: 51 }, (_, n) => ({ paths: [`p${n}`], action: "refuse" })) })]],
    ["more than 50 paths in a rule", [policy({ rules: [{ paths: Array.from({ length: 51 }, (_, n) => `p${n}`), action: "refuse" }] })]],
    ["more than 10 lenses", [policy({ lenses: Array.from({ length: 11 }, (_, n) => lens({ name: `lens${n}`, aliases: [] })) })]],
    ["more than 20 agents for a lens", [policy({ lenses: [lens({ agents: Array.from({ length: 21 }, (_, n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`) })] })]],
  ])("refuses %s", (_name, value) => {
    expect(savePolicy(value).valid, "save").toBe(false);
    expect(parseProtectedPathPolicy(value).policies).toEqual([]);
    expect(parseProtectedPathPolicy(value).problems.length).toBeGreaterThan(0);
  });

  it("leaves to the plugin's reader what a schema cannot say: an undefined lens, a repeated repository, a repeated lens name", () => {
    // These pass the save (a JSON schema cannot compare two parts of the document) and then fail closed for the repository at the merge.
    for (const value of [
      [policy({ rules: [{ paths: ["a"], action: "require", lenses: ["performance"] }] })],
      [policy(), policy()],
      [policy({ lenses: [lens(), lens({ aliases: [] })] })],
    ]) {
      const parsed = parseProtectedPathPolicy(value);
      expect(parsed.problems.length, JSON.stringify(value)).toBeGreaterThan(0);
      expect(parsed.problems.every(problem => problem.repository === "owner/repo")).toBe(true);
      expect(parsed.policies).toEqual([]);
    }
  });

  it("does not change what the rest of the config accepts, and keeps the opt-in for agentMergeablePaths on its own key", () => {
    expect(validateInstanceConfig({ appId: "12", personalLogin: "someone", protectedPathPolicy: [policy()], agentMergeablePaths: [entry()] } as Record<string, unknown>, schema)).toEqual({ valid: true });
    expect(validateInstanceConfig({ appId: "0", protectedPathPolicy: [policy()] } as Record<string, unknown>, schema).valid).toBe(false);
  });

  it("says in the schema's own help text what refuse and require do, that refuse is the default, and who may change it", () => {
    const description = String((manifest.instanceConfigSchema as { properties: Record<string, { description?: string }> }).properties.protectedPathPolicy?.description);
    expect(description).toMatch(/refuse/i);
    expect(description).toMatch(/require/i);
    expect(description).toMatch(/default/i);
    expect(description).toMatch(/exact head/i);
    expect(description).toMatch(/instance administrator/i);
  });
});

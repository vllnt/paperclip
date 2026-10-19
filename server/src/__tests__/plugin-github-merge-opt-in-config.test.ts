import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";
import manifest from "../../../packages/plugins/plugin-github/src/manifest.js";
import { parseAgentMergeablePaths } from "../../../packages/plugins/plugin-github/src/protected-paths.js";

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

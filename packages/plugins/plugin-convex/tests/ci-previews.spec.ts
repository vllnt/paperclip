import { describe, expect, it } from "vitest";
import { compileTemplate, parseCiPreview, supersedes, type CiEntry } from "../src/ci-previews.js";

describe("compileTemplate", () => {
  it.each([
    ["no placeholder", /must contain \{pr\}/],
    ["pr{pr}-{foo}", /may only use/],
    ["pr{pr}-{pr}", /more than once/],
    ["pr{pr}-run{run}-r{run}", /more than once/],
    ["pr{pr}[-run{run}[x]]", /only one flat optional/],
    ["pr{pr}[-run{run}", /\[ without a matching \]/],
    ["pr{pr}-run{run}]", /\] without a matching \[/],
    ["pr{pr}[]", /empty optional/],
    ["[pr{pr}]", /cannot be in an optional/],
    ["pr{pr}}", /\} without a matching \{/],
    ["pr{pr", /may only use/],
    ["", /1 to 200 characters/],
    ["x".repeat(201), /1 to 200 characters/],
    // two numbers next to each other cannot be told apart: "12345" could be pr 1234 and run 5
    ["pr{pr}{run}", /next to each other/],
    ["pr{pr}0{run}", /next to each other/],
    ["[-run{run}]{pr}", /next to each other/],
    ["pr{pr}[{run}]", /next to each other/],
    ["pr{pr}-{run}{shard}", /next to each other/],
    ["pr{pr}[-x]{run}", /next to each other/],
    ["pr{pr}[-x1]{run}", /next to each other/],
    // a template of digits only would turn any all-digit name into a pull request
    ["{pr}", /letter/],
    ["-{pr}", /letter/],
    ["12{pr}", /letter/],
  ])("rejects %j", (template, message) => {
    expect(() => compileTemplate(template)).toThrow(message);
  });

  it.each(["pr{pr}", "pr-{pr}", "pr{pr}-run{run}", "pr{pr}[-run{run}]-s{shard}-a{attempt}", "preview-{pr}-r{run}", "pr{pr}[-x]-{run}"])("accepts %j", template => {
    expect(() => compileTemplate(template)).not.toThrow();
  });

  it("compiles to literals and bounded digit groups, so it cannot backtrack badly", () => {
    const source = compileTemplate("pr{pr}[-run{run}]-s{shard}-a{attempt}").source;
    expect(source).toBe("^pr(?<pr>\\d{1,15})(?:-run(?<run>\\d{1,15}))?-s(?<shard>\\d{1,15})-a(?<attempt>\\d{1,15})$");
    expect(source).not.toMatch(/[*+]/);
  });
});

describe("parseCiPreview", () => {
  const template = "pr{pr}-run{run}-s{shard}-a{attempt}";
  it("reads the numbers from a matching name", () => {
    expect(parseCiPreview(template, "pr4320-run101-s2-a3")).toEqual({ pr: 4320, run: 101, shard: 2, attempt: 3 });
    expect(parseCiPreview("pr{pr}[-run{run}]-s{shard}", "pr7-s1")).toEqual({ pr: 7, run: null, shard: 1, attempt: null });
  });

  it("matches the whole name, never a part of it", () => {
    for (const name of ["x-pr4320-run1-s1-a1", "pr4320-run1-s1-a1-extra", "pr4320-run1-s1", "PR4320-run1-s1-a1", "pr-run1-s1-a1", "pr12345678901234567-run1-s1-a1"]) expect(parseCiPreview(template, name), name).toBeNull();
  });

  it("treats literal characters as literals, not as regular expression syntax", () => {
    expect(parseCiPreview("pr{pr}.x+y", "pr12.x+y")).toMatchObject({ pr: 12 });
    expect(parseCiPreview("pr{pr}.x+y", "pr12Zx+y")).toBeNull();
    expect(parseCiPreview("pr{pr}.x+y", "pr12.xxy")).toBeNull();
  });

  it("returns null without a template or a name, and for names longer than 200 characters", () => {
    expect(parseCiPreview(null, "pr1-run1-s1-a1")).toBeNull();
    expect(parseCiPreview(template, null)).toBeNull();
    expect(parseCiPreview("pr{pr}", `pr${"1".repeat(250)}`)).toBeNull();
  });
});

describe("supersedes", () => {
  const entry = (extra: Partial<CiEntry>): CiEntry => ({ pr: 1, run: null, shard: 1, attempt: null, at: 0, ...extra });
  it("a later run replaces an earlier one of the same shard, and a later attempt of the same run replaces an earlier attempt", () => {
    expect(supersedes(entry({ run: 2, attempt: 1 }), entry({ run: 1, attempt: 5 }))).toBe(true);
    expect(supersedes(entry({ run: 2, attempt: 2 }), entry({ run: 2, attempt: 1 }))).toBe(true);
    expect(supersedes(entry({ run: 2, attempt: 1 }), entry({ run: 2, attempt: 1 }))).toBe(false);
    expect(supersedes(entry({ run: 1, attempt: 1 }), entry({ run: 2, attempt: 1 }))).toBe(false);
  });

  it("never replaces across pull requests or shards", () => {
    expect(supersedes(entry({ run: 2, pr: 2 }), entry({ run: 1 }))).toBe(false);
    expect(supersedes(entry({ run: 2, shard: 2 }), entry({ run: 1 }))).toBe(false);
  });

  it("without run numbers a later attempt replaces, and unnumbered previews cannot be ordered", () => {
    expect(supersedes(entry({ attempt: 2 }), entry({ attempt: 1 }))).toBe(true);
    expect(supersedes(entry({ attempt: 1 }), entry({ attempt: 2 }))).toBe(false);
    expect(supersedes(entry({ at: 9000 }), entry({ at: 1 }))).toBe(false);
    expect(supersedes(entry({ attempt: 3 }), entry({ attempt: null }))).toBe(false);
  });

  it("never compares a numbered run with an unnumbered one, whatever the attempts say", () => {
    expect(supersedes(entry({ run: null, attempt: 9 }), entry({ run: 1, attempt: 1 }))).toBe(false);
    expect(supersedes(entry({ run: 9, attempt: 1 }), entry({ run: null, attempt: 1 }))).toBe(false);
    expect(supersedes(entry({ run: 9, attempt: 9 }), entry({ run: null, attempt: 1 }))).toBe(false);
  });
});

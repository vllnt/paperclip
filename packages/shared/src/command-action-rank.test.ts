import { describe, expect, it } from "vitest";
import {
  FRECENCY_HALF_LIFE_MS,
  rankCommandActions,
  recordCommandActionUse,
  scoreTextMatch,
  type CommandActionUsage,
  type RankableCommandAction,
} from "./command-action-rank.js";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const NONE: ReadonlySet<string> = new Set();

function action(id: string, title: string, extra: Partial<RankableCommandAction> = {}): RankableCommandAction {
  return { id, title, keywords: [], ...extra };
}

describe("scoreTextMatch", () => {
  it("orders exact > prefix > substring > secondary > subsequence > no match", () => {
    const exact = scoreTextMatch("tasks", "", "tasks");
    const prefix = scoreTextMatch("tasks board", "", "tasks");
    const substring = scoreTextMatch("my tasks", "", "tasks");
    const secondary = scoreTextMatch("work", "tasks issues", "tasks");
    const subsequence = scoreTextMatch("t-a-s-k-s", "", "tasks");
    const none = scoreTextMatch("agents", "", "tasks");

    expect(exact).toBe(1000);
    expect(prefix).toBeGreaterThan(substring ?? 0);
    expect(substring).toBeGreaterThan(secondary ?? 0);
    expect(secondary).toBeGreaterThan(subsequence ?? 0);
    expect(subsequence).toBe(200);
    expect(none).toBeNull();
  });

  it("keeps a long prefix match above every substring match", () => {
    const longPrefix = scoreTextMatch(`tasks ${"x".repeat(400)}`, "", "tasks");
    const earlySubstring = scoreTextMatch("atasks", "", "tasks");
    expect(longPrefix).toBeGreaterThan(earlySubstring ?? 0);
  });

  it("is case-insensitive", () => {
    expect(scoreTextMatch("Dashboard", "", "DASH")).toBe(scoreTextMatch("dashboard", "", "dash"));
  });
});

describe("rankCommandActions", () => {
  const actions = [
    action("nav.dashboard", "Dashboard", { keywords: ["home", "overview"] }),
    action("nav.tasks", "Tasks", { keywords: ["issues"] }),
    action("nav.agents", "Agents"),
    action("issue.focus-comment", "Focus comment composer"),
  ];

  it("drops actions that do not match a query", () => {
    const ranked = rankCommandActions({ query: "dash", actions, contextualIds: NONE, usage: {}, now: NOW });
    expect(ranked.map((entry) => entry.action.id)).toEqual(["nav.dashboard"]);
  });

  it("matches keywords", () => {
    const ranked = rankCommandActions({ query: "issues", actions, contextualIds: NONE, usage: {}, now: NOW });
    expect(ranked.map((entry) => entry.action.id)).toEqual(["nav.tasks"]);
  });

  it("keeps catalog order for an empty query with no contextual action or usage", () => {
    const ranked = rankCommandActions({ query: "  ", actions, contextualIds: NONE, usage: {}, now: NOW });
    expect(ranked.map((entry) => entry.action.id)).toEqual(actions.map((entry) => entry.id));
  });

  it("puts the current page's contextual actions first", () => {
    const ranked = rankCommandActions({ query: "", actions, contextualIds: new Set(["issue.focus-comment"]), usage: {}, now: NOW });
    expect(ranked[0]?.action.id).toBe("issue.focus-comment");
  });

  it("lets a recently used action outrank an unused one with the same match", () => {
    const usage: Record<string, CommandActionUsage> = {
      "nav.agents": { count: 5, lastUsedAt: NOW - 60_000 },
    };
    const ranked = rankCommandActions({ query: "", actions, contextualIds: NONE, usage, now: NOW });
    expect(ranked[0]?.action.id).toBe("nav.agents");
  });

  it("decays old usage by half every half-life", () => {
    const fresh = rankCommandActions({
      query: "",
      actions: [actions[2]!],
      contextualIds: NONE,
      usage: { "nav.agents": { count: 3, lastUsedAt: NOW } },
      now: NOW,
    })[0]!.score;
    const old = rankCommandActions({
      query: "",
      actions: [actions[2]!],
      contextualIds: NONE,
      usage: { "nav.agents": { count: 3, lastUsedAt: NOW - FRECENCY_HALF_LIFE_MS } },
      now: NOW,
    })[0]!.score;
    expect(old).toBeCloseTo(fresh / 2, 5);
  });

  it("does not let usage lift a keyword match above a title prefix match", () => {
    const usage: Record<string, CommandActionUsage> = {
      "nav.org": { count: 1_000_000, lastUsedAt: NOW },
    };
    const ranked = rankCommandActions({
      query: "agen",
      actions: [...actions, action("nav.org", "Org chart", { keywords: ["agents"] })],
      contextualIds: NONE,
      usage,
      now: NOW,
    });
    expect(ranked.map((entry) => entry.action.id)).toEqual(["nav.agents", "nav.org"]);
  });

  it("ranks 200 actions within a 2 ms median", () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      action(`a.${index}`, `Action number ${index} for the board`, { keywords: ["alpha", "beta"] }));
    const contextualIds = new Set(many.filter((_, index) => index % 7 === 0).map((entry) => entry.id));
    const usage = Object.fromEntries(many.slice(0, 50).map((entry, index) => [entry.id, { count: index + 1, lastUsedAt: NOW - index * 3_600_000 }]));
    const timings: number[] = [];
    for (let run = 0; run < 50; run += 1) {
      const start = performance.now();
      rankCommandActions({ query: run % 2 === 0 ? "act" : "", actions: many, contextualIds, usage, now: NOW });
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    expect(timings[Math.floor(timings.length / 2)]).toBeLessThan(2);
  });
});

describe("recordCommandActionUse", () => {
  it("counts uses and keeps the most recent entries within the limit", () => {
    let usage: Record<string, CommandActionUsage> = {};
    usage = recordCommandActionUse(usage, "a", NOW - 3, 2);
    usage = recordCommandActionUse(usage, "a", NOW - 2, 2);
    usage = recordCommandActionUse(usage, "b", NOW - 1, 2);
    usage = recordCommandActionUse(usage, "c", NOW, 2);

    expect(Object.keys(usage).sort()).toEqual(["b", "c"]);
    expect(usage.c).toEqual({ count: 1, lastUsedAt: NOW });
  });

  it("does not mutate its input", () => {
    const usage: Record<string, CommandActionUsage> = { a: { count: 1, lastUsedAt: NOW - 1 } };
    recordCommandActionUse(usage, "a", NOW);
    expect(usage.a).toEqual({ count: 1, lastUsedAt: NOW - 1 });
  });
});

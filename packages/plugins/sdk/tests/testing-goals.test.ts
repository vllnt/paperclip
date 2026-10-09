import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { Goal, PaperclipPluginManifestV1 } from "../src/types.js";

const manifest = {
  id: "paperclip.test-goals",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Goals",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["goals.read", "goals.update"],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

function goal(values: Partial<Goal> & Pick<Goal, "id" | "title">): Goal {
  const now = new Date("2026-10-09T12:00:00.000Z");
  return {
    companyId: "company-1",
    description: null,
    level: "task",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    kind: "goal",
    horizon: null,
    targetDate: null,
    successCriteria: null,
    createdAt: now,
    updatedAt: now,
    ...values,
  };
}

describe("createTestHarness goals", () => {
  it("refuses a plugin update of a goal the company focus shows, as the host does", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      goals: [
        goal({ id: "focus", title: "Land PRs", horizon: "short" }),
        goal({ id: "milestone", title: "First half", kind: "milestone", parentId: "focus" }),
        goal({ id: "plain", title: "Plain" }),
      ],
    });

    await expect(harness.ctx.goals.update("focus", { title: "x" }, "company-1")).rejects.toThrow(/only the board/i);
    await expect(harness.ctx.goals.update("milestone", { status: "achieved" }, "company-1")).rejects.toThrow(/only the board/i);
    await expect(harness.ctx.goals.update("plain", { title: "Renamed" }, "company-1")).resolves.toMatchObject({ title: "Renamed" });
  });
});

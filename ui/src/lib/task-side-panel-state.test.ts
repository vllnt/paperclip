// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  readTaskSidePanelState,
  taskPanelDocumentTab,
  taskPanelPluginRecordTab,
  taskPanelFilesTab,
  taskPanelPropertiesTab,
  taskPanelSkillTab,
  taskPanelSubtasksTab,
  writeTaskSidePanelState,
  shouldSuppressTaskPanelUntilPlan,
  openSkillPanelState,
} from "./task-side-panel-state";

describe("task side-panel persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips an intentionally empty task state", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [], activeTabId: null },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    expect(readTaskSidePanelState("user-1", "company-1", "task-1", true)).toMatchObject({
      state: { tabs: [], activeTabId: null },
      userInteracted: true,
    });
  });

  it("persists and restores a skill tab", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-skill", {
      state: { tabs: [taskPanelPropertiesTab(), taskPanelSkillTab("skill-1", "Release helper")], activeTabId: "skill:skill-1" },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    expect(readTaskSidePanelState("user-1", "company-1", "task-skill", true)?.state).toMatchObject({
      activeTabId: "skill:skill-1",
      tabs: [{ id: "properties" }, { id: "skill:skill-1", payload: { kind: "skill", skillId: "skill-1" } }],
    });
  });

  it("keeps an onboarding panel open after skill acknowledgement", () => {
    const before = { panelBeforePlanOverrideIssueId: null };
    const opened = openSkillPanelState(before, { id: "skill-1", name: "Release helper" }, "task-1", true);
    expect(opened.panelBeforePlanOverrideIssueId).toBe("task-1");
    const acknowledged = { ...opened, skill: null };
    expect(shouldSuppressTaskPanelUntilPlan({ deferredPlanAvailable: false, panelBeforePlanOverride: acknowledged.panelBeforePlanOverrideIssueId === "task-1" })).toBe(false);
  });

  it("isolates account and company state", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" },
      launcherOpen: false,
      userInteracted: false,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    expect(readTaskSidePanelState("user-2", "company-1", "task-1", true)).toBeNull();
    expect(readTaskSidePanelState("user-1", "company-2", "task-1", true)).toBeNull();
  });

  it("drops file tabs when the experiment is disabled while keeping documents", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: {
        tabs: [taskPanelPropertiesTab(), taskPanelFilesTab(), taskPanelDocumentTab("plan", "Plan")],
        activeTabId: "files",
      },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    const restored = readTaskSidePanelState("user-1", "company-1", "task-1", false);
    expect(restored?.state.tabs.map((tab) => tab.id)).toEqual(["properties", "document:plan"]);
    expect(restored?.state.activeTabId).toBe("properties");
  });

  it("round-trips the Streamlined UI subtasks tab", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: {
        tabs: [taskPanelPropertiesTab(), taskPanelSubtasksTab()],
        activeTabId: "subtasks",
      },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });

    const restored = readTaskSidePanelState("user-1", "company-1", "task-1", false);
    expect(restored?.state.tabs.map((tab) => tab.id)).toEqual(["properties", "subtasks"]);
    expect(restored?.state.activeTabId).toBe("subtasks");
  });

  it("round-trips issue and PR tabs with account, company and task isolation", () => {
    const issueTab = taskPanelPluginRecordTab({ pluginId: "github", recordId: "repo:issue:1", recordKind: "issue", label: "Issue #1" });
    const prTab = taskPanelPluginRecordTab({ pluginId: "github", recordId: "repo:pull:2", recordKind: "pull", label: "PR #2" });
    writeTaskSidePanelState("u1", "c1", "t1", { state: { tabs: [issueTab, prTab], activeTabId: prTab.id }, launcherOpen: false, userInteracted: true, autoPlanHandled: false, updatedAt: 1 });
    expect(readTaskSidePanelState("u1", "c1", "t1", false)?.state).toEqual({ tabs: [issueTab, prTab], activeTabId: prTab.id });
    expect(readTaskSidePanelState("u2", "c1", "t1", false)).toBeNull();
    expect(readTaskSidePanelState("u1", "c2", "t1", false)).toBeNull();
    expect(readTaskSidePanelState("u1", "c1", "t2", false)).toBeNull();
  });

  it.each([{ recordId: "" }, { pluginId: "" }, { recordId: "x".repeat(513) }, { recordKind: "arbitrary" }])("drops malformed persisted source payloads %j", invalid => {
    const tab = taskPanelPluginRecordTab({ pluginId: "github", recordId: "issue:1", recordKind: "issue", label: "Issue #1" });
    writeTaskSidePanelState("u1", "c1", "t1", { state: { tabs: [taskPanelPropertiesTab(), { ...tab, payload: { ...tab.payload, ...invalid } as any }], activeTabId: tab.id }, launcherOpen: false, userInteracted: true, autoPlanHandled: false, updatedAt: 1 });
    expect(readTaskSidePanelState("u1", "c1", "t1", false)?.state.tabs).toEqual([taskPanelPropertiesTab()]);
  });

  it("retains only the 50 most recently written tasks", () => {
    for (let index = 0; index < 52; index += 1) {
      writeTaskSidePanelState("user-1", "company-1", `task-${index}`, {
        state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" },
        launcherOpen: false,
        userInteracted: false,
        autoPlanHandled: false,
        updatedAt: index,
      });
    }
    expect(readTaskSidePanelState("user-1", "company-1", "task-0", true)).toBeNull();
    expect(readTaskSidePanelState("user-1", "company-1", "task-51", true)).not.toBeNull();
  });
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubTaskList } from "../src/ui/task-list.js";
import { TaskSyncDetail } from "../src/ui/task-detail.js";
import { AutomationSettings } from "../src/ui/automation.js";
import { GitHubRecordPanel } from "../src/ui/task-record.js";

// "Sync now" only queues a request for the scheduled job. These tests check that every control says so: queued, not started and
// not finished, and that opening a page or focusing the window reads the status and starts nothing.

const mocks = vi.hoisted(() => ({ actions: new Map<string, ReturnType<typeof vi.fn>>() }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostContext: () => ({ userId: "test-user" }),
  usePluginAction: (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key); },
  useHostNavigation: () => ({ navigate: vi.fn(), linkProps: (path: string) => ({ href: path }) }),
}));
vi.mock("../src/ui/management-repository.js", () => ({
  RepositoryWorkspace: () => null, RecordDetail: () => null, RecordDialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const action = (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key)!; };
const context = { companyId: "c1", companyPrefix: "ACME", userId: "u1", projectId: null, entityId: null, entityType: null };
const QUEUED = "Sync queued. It runs with the next scheduled sync.";
const settings = { enabled: true, rules: [] };
const synced = { configured: true, settings, busy: false, queued: false, queuedAt: null, report: { at: new Date().toISOString(), warnings: [] }, pendingCount: 0 };
const queuedStatus = { ...synced, queued: true, queuedAt: "2026-10-10T12:00:00.000Z" };
const answer = { queued: true, queuedAt: "2026-10-10T12:00:00.000Z", busy: false, lastRunAt: null };

beforeEach(() => {
  mocks.actions.clear();
  action("sync-status").mockResolvedValue(synced);
  action("sync-now").mockResolvedValue(answer);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the GitHub control of the Tasks toolbar", () => {
  it("reads the status when the page opens and when the window gets focus, and starts no sync", async () => {
    render(<GitHubTaskList context={context} />);
    await screen.findByText("GitHub synced");
    const reads = action("sync-status").mock.calls.length;

    await act(async () => { window.dispatchEvent(new Event("focus")); });

    await waitFor(() => expect(action("sync-status").mock.calls.length).toBeGreaterThan(reads));
    expect(action("sync-now")).not.toHaveBeenCalled();
  });

  it("shows Sync now as queued, not as synced, and keeps the button off", async () => {
    action("sync-status").mockResolvedValueOnce(synced).mockResolvedValue(queuedStatus);
    render(<GitHubTaskList context={context} />);
    await screen.findByText("GitHub synced");
    fireEvent.click(screen.getByText("GitHub", { selector: "summary" }));

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await screen.findByText("GitHub sync queued");
    expect(action("sync-now")).toHaveBeenCalledWith({ companyId: "c1", refresh: true });
    expect(screen.queryByText("GitHub synced")).toBeNull();
    expect(screen.getByText(/Sync requested/).textContent).toContain("It runs with the next scheduled sync.");
    expect((screen.getByRole("button", { name: "Sync queued" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("GitHub", { selector: "summary" }).getAttribute("aria-label")).toBe("GitHub sync queued");
  });

  it("shows a request that was made elsewhere as queued", async () => {
    action("sync-status").mockResolvedValue(queuedStatus);
    render(<GitHubTaskList context={context} />);

    await screen.findByText("GitHub sync queued");

    expect((screen.getByRole("button", { name: "Sync queued" }) as HTMLButtonElement).disabled).toBe(true);
    expect(action("sync-now")).not.toHaveBeenCalled();
  });

  it("says syncing, not queued, while a run is in progress", async () => {
    action("sync-status").mockResolvedValue({ ...queuedStatus, busy: true });
    render(<GitHubTaskList context={context} />);

    await screen.findByText("Syncing GitHub…");

    expect(screen.queryByText("GitHub sync queued")).toBeNull();
    expect(screen.queryByText(/Sync requested/)).toBeNull();
  });
});

describe("the other Sync now controls", () => {
  it("the task detail says the sync is queued", async () => {
    action("task-sync-detail").mockResolvedValue({ link: null, pending: false, repositories: [] });
    render(<TaskSyncDetail companyId="c1" issueId="i1" />);
    await waitFor(() => expect(action("task-sync-detail")).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect((await screen.findByRole("status")).textContent).toBe(QUEUED);
    expect(action("sync-now")).toHaveBeenCalledWith({ companyId: "c1", refresh: true });
  });

  it("the task record panel says the sync is queued", async () => {
    action("management-options").mockResolvedValue({ repositories: [{ id: 22, fullName: "acme/repo", name: "repo", url: "https://github.com/acme/repo", installationId: 33, owner: "acme", private: true }] });
    action("task-sync-detail").mockResolvedValue({ link: null, pending: false, repositories: [] });
    render(<GitHubRecordPanel context={{ ...context, taskRecordId: "22:issue:4", entityId: "i1", entityType: "issue" } as any} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect((await screen.findByRole("status")).textContent).toBe(QUEUED);
    expect(action("sync-now")).toHaveBeenCalledWith({ companyId: "c1", refresh: true });
  });

  it("Retry sync on the settings page says the sync is queued", async () => {
    action("sync-status").mockResolvedValue({ ...synced, report: { at: new Date().toISOString(), warnings: ["Denied"] } });
    action("automation-options").mockResolvedValue({ agents: [], repositories: [] });
    action("github-workflow-skill-status").mockResolvedValue({ status: "Installed" });
    render(<AutomationSettings companyId="c1" />);
    fireEvent.click(await screen.findByText(/Sync needs attention/));

    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }));

    await screen.findByText(QUEUED);
    expect(action("sync-now")).toHaveBeenCalledWith({ companyId: "c1", refresh: true });
    expect(screen.queryByText(/Sync started/)).toBeNull();
  });
});

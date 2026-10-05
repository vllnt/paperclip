// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubTaskList, PullRequestBrowser } from "../src/ui/task-list.js";
const mocks = vi.hoisted(() => ({ actions: new Map<string, ReturnType<typeof vi.fn>>(), navigate: vi.fn() }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({ useHostContext: () => ({ userId: "test-user" }),
  usePluginAction: (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key); },
  useHostNavigation: () => ({ navigate: mocks.navigate, linkProps: (path: string) => ({ href: path }) }),
}));
const action = (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key)!; };
const repository = { id: 22, fullName: "acme/repo", name: "repo", url: "https://github.com/acme/repo", installationId: 33, owner: "acme", private: true, permissions: { pull_requests: "write" } };
const context = { companyId: "c1", companyPrefix: "ACME", userId: "u1", projectId: null, entityId: null, entityType: null };
beforeEach(() => {
  mocks.actions.clear(); mocks.navigate.mockReset();
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  action("sync-status").mockResolvedValue({ configured: true, settings: { enabled: true }, busy: false, report: { at: new Date().toISOString(), warnings: [] }, pendingCount: 0 });
  action("sync-now").mockResolvedValue({ started: true });
  action("linked-repositories").mockResolvedValue({ repositories: [repository], warnings: [] });
  action("manage-repository").mockImplementation(async (params: any) => params.op === "pulls" ? { rows: [{ id: 20, number: 2, title: "Fix bug", state: params.state, user: { login: "alex" } }], nextPage: params.page === 1 ? 2 : null } : { rows: [], nextPage: null });
  action("open-record-task").mockResolvedValue({ id: "native-pr", panel: { recordId: "22:pull:2" } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("pull requests in native Tasks", () => {
  it("opens the PR browser from company Tasks without requiring project context", async () => {
    render(<GitHubTaskList context={context} />);
    await screen.findByText("GitHub synced");
    fireEvent.click(screen.getByText("GitHub", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));
    await screen.findByRole("dialog", { name: "GitHub pull requests" });
    await screen.findByRole("button", { name: "#2 Fix bug" });
    expect(action("linked-repositories")).toHaveBeenCalledWith({ companyId: "c1", refresh: false });
  });
  it("keeps filters and pagination, then opens a stable native task panel", async () => {
    const close = vi.fn(); render(<PullRequestBrowser companyId="c1" projectId="project-1" onClose={close} />);
    await screen.findByRole("button", { name: "#2 Fix bug" });
    expect(action("linked-repositories")).toHaveBeenCalledWith({ companyId: "c1", projectId: "project-1", refresh: false });
    fireEvent.change(screen.getByLabelText("GitHub state"), { target: { value: "closed" } });
    await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ state: "closed", page: 1 })));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ state: "closed", page: 2 })));
    fireEvent.click(screen.getByRole("button", { name: "#2 Fix bug" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/issues/native-pr?taskPlugin=vllnt.paperclip-github&taskRecord=22%3Apull%3A2"));
    expect(action("open-record-task")).toHaveBeenCalledWith({ companyId: "c1", projectId: "project-1", repositoryId: 22, kind: "pull", number: 2 });
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps a failed task association recoverable without navigating away", async () => {
    action("open-record-task").mockRejectedValueOnce(new Error("Task unavailable"));
    render(<PullRequestBrowser companyId="c1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "#2 Fix bug" }));
    await screen.findByText("Task unavailable");
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "#2 Fix bug" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(action("manage-repository").mock.calls.some(([p]) => p.op === "create-pr")).toBe(false);
  });
  it("shows repository failures and retries catalog discovery", async () => {
    action("linked-repositories").mockRejectedValueOnce(new Error("Access revoked"));
    render(<PullRequestBrowser companyId="c1" onClose={() => {}} />);
    await screen.findByText("Access revoked");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "#2 Fix bug" });
    expect(action("linked-repositories")).toHaveBeenLastCalledWith({ companyId: "c1", refresh: true });
  });
});

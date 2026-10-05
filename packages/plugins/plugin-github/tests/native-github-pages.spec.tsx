// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubIssues, GitHubPage, legacyRecord } from "../src/ui/index.js";
const mocks = vi.hoisted(() => ({ actions: new Map<string, ReturnType<typeof vi.fn>>(), navigate: vi.fn(), projects: vi.fn() }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({ useHostContext: () => ({ userId: "test-user" }),
  useHostLocation: () => ({ search: window.location.search, pathname: window.location.pathname }),
  useHostNavigation: () => ({ navigate: mocks.navigate, resolveHref: (p: string) => `/GIT${p}`, linkProps: (p: string) => ({ href: `/GIT${p}` }) }),
  usePluginAction: (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key); }
}));
vi.mock("../src/ui/api.js", () => ({ ensureCanConfigure: vi.fn(), hostApi: vi.fn(), saveConfiguration: vi.fn(), saveCredentials: vi.fn(async () => ({ appId: "12", appSlug: "", appName: "App" })) }));
vi.mock("../src/ui/automation.js", () => ({ AutomationSettings: () => <div>Automations</div> }));
vi.mock("../src/ui/connection-access.js", () => ({ ConnectionAccess: () => null }));
vi.mock("../src/ui/task-detail.js", () => ({ TaskSyncDetail: ({ issueId }: any) => <div>Task sync {issueId}</div> }));
vi.mock("../src/ui/task-record.js", () => ({ GitHubRecordPanel: () => null }));
vi.mock("../src/ui/management-repository.js", () => ({ RepositoryWorkspace: () => <div>Repository browser</div>, GitHubRecordPanel: () => null }));
vi.mock("../src/ui/management-projects.js", () => ({ ProjectsWorkspace: (props: any) => { mocks.projects(props); return <div>Project management<button onClick={() => props.openRecord(props.repositories[0], "pull", 7)}>Open project PR</button></div>; } }));
const action = (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key)!; };
const context = { companyId: "c1", companyPrefix: "GIT", userId: "u1", entityId: null, entityType: null, projectId: null } as any;
const repo = { id: 22, name: "repo", owner: "org", fullName: "org/repo", url: "https://github.com/org/repo" };
const catalog = { app: { id: "12", slug: "app", name: "App" }, repositories: [repo], installations: [{ login: "org", accountType: "Organization", suspended: false }], warnings: [], truncated: false };
beforeEach(() => { window.history.replaceState({}, "", "/GIT/github-projects"); sessionStorage.clear(); mocks.actions.clear(); mocks.navigate.mockReset(); mocks.projects.mockReset(); action("status").mockResolvedValue({ configured: false, app: null }); action("catalog").mockResolvedValue(catalog); });
afterEach(cleanup);
describe("native GitHub locations", () => {
  it.each(["issue", "pull"])("opens legacy %s record URLs in the native task panel", async kind => {
    window.history.replaceState({}, "", `/GIT/github-projects?repository=22&kind=${kind}&number=7`);
    action("open-record-task").mockResolvedValue({ id: "task-1" });
    render(<GitHubPage context={context} />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(`/issues/task-1?taskPlugin=vllnt.paperclip-github&taskRecord=22%3A${kind}%3A7`));
    expect(action("open-record-task")).toHaveBeenCalledWith({ companyId: "c1", repositoryId: 22, kind, number: 7 });
    expect(action("status")).not.toHaveBeenCalled();
  });
  it("retries access failures without accepting query navigation targets", async () => {
    window.history.replaceState({}, "", "/GIT/github-projects?repository=22&kind=pull&number=7&redirect=https://evil.test");
    action("open-record-task").mockRejectedValueOnce(new Error("Approve PR access")).mockResolvedValueOnce({ id: "task-1" });
    render(<GitHubPage context={context} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Approve PR access");
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    expect(action("open-record-task")).toHaveBeenLastCalledWith({ companyId: "c1", repositoryId: 22, kind: "pull", number: 7, refresh: true });
  });
  it.each(["?repository=22&kind=issue&number=1e2", "?repository=0&kind=pull&number=7", "?repository=9007199254740992&kind=pull&number=7", "?repository=22&kind=bad&number=7", "?repository=22&kind=issue"])("rejects invalid record links %s", search => {
    expect(legacyRecord(search)).toEqual({ error: "This GitHub record link is invalid." });
    window.history.replaceState({}, "", `/GIT/github-projects${search}`);
    render(<GitHubPage context={context} />);
    expect(screen.getByRole("alert").textContent).toContain("invalid");
    expect(action("open-record-task")).not.toHaveBeenCalled();
  });
  it("keeps installation and App callbacks in onboarding", async () => {
    expect(legacyRecord("?code=abc&state=s&repository=22&kind=issue&number=7")).toBeNull();
    window.history.replaceState({}, "", "/GIT/github-projects?installation_id=33&setup_action=install&repository=22&kind=issue&number=7");
    render(<GitHubPage context={context} />);
    await screen.findByRole("button", { name: "Create GitHub App" });
    expect(action("status")).toHaveBeenCalledWith({ companyId: "c1" });
    expect(action("open-record-task")).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("installation_id");
  });
  it("finishes an App creation callback before considering any record query", async () => {
    window.history.replaceState({}, "", "/GIT/github-projects?code=abc&state=s&repository=22&kind=issue&number=7");
    const returnUrl = `${window.location.origin}/GIT/github-projects`;
    sessionStorage.setItem("vllnt.paperclip-github:c1:u1", JSON.stringify({ state: "s", returnUrl }));
    action("complete-setup").mockResolvedValue({ id: "12", slug: "", name: "App", privateKey: "fixture" });
    render(<GitHubPage context={context} />);
    await waitFor(() => expect(action("complete-setup")).toHaveBeenCalledWith({ companyId: "c1", code: "abc", state: "s", returnUrl }));
    await screen.findByText("Automations");
    expect(action("open-record-task")).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("code=");
  });
  it("keeps the settings page free of record browsers", async () => {
    action("status").mockResolvedValue({ configured: true, app: catalog.app });
    render(<GitHubPage context={context} />);
    await screen.findByText("Automations");
    expect(screen.queryByText("Repository browser")).toBeNull();
    expect(screen.queryByText("Project management")).toBeNull();
  });
  it("shows setup guidance in native project detail before GitHub is connected", async () => {
    render(<GitHubIssues context={{ ...context, entityType: "project", entityId: "p1", projectId: "p1" }} />);
    expect(await screen.findByText("Connect a GitHub App in the GitHub plugin first.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open GitHub settings" }).getAttribute("href")).toBe("/GIT/github-projects");
    expect(action("status")).toHaveBeenCalledWith({ companyId: "c1" });
    expect(action("management-options")).not.toHaveBeenCalled();
    expect(action("linked-repositories")).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows GitHub Projects in native project detail and opens their records as tasks", async () => {
    action("status").mockResolvedValue({ configured: true, app: catalog.app });
    action("management-options").mockResolvedValue({ ...catalog, personal: null });
    action("linked-repositories").mockResolvedValue({ repositories: [repo], warnings: [] });
    action("open-record-task").mockResolvedValue({ id: "task-1" });
    render(<GitHubIssues context={{ ...context, entityType: "project", entityId: "p1", projectId: "p1" }} />);
    await screen.findByText("Project management");
    expect(action("linked-repositories")).toHaveBeenCalledWith({ companyId: "c1", projectId: "p1" });
    expect(mocks.projects).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: "c1", owner: { login: "org", type: "Organization" }, repositories: [repo] }));
    expect(action("issues")).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open project PR" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/issues/task-1?taskPlugin=vllnt.paperclip-github&taskRecord=22%3Apull%3A7"));
    expect(action("open-record-task")).toHaveBeenCalledWith({ companyId: "c1", projectId: "p1", repositoryId: 22, kind: "pull", number: 7 });
  });
  it("retains task sync controls for native issue detail", () => {
    render(<GitHubIssues context={{ ...context, entityType: "issue", entityId: "t1" }} />);
    expect(screen.getByText("Task sync t1")).toBeTruthy();
    expect(action("management-options")).not.toHaveBeenCalled();
  });
});

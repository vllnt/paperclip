// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubPage, GitHubIssues, GitHubTaskButton, GitHubLink, GitHubTaskList } from "../src/ui/index.js";
import { PAGE_PATH, PLUGIN_ID } from "../src/contracts.js";
import { saveCredentials, saveConfiguration } from "../src/ui/api.js";
const mocks = vi.hoisted(() => ({ actions: new Map<string, ReturnType<typeof vi.fn>>(), navigate: vi.fn() }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({ useHostContext: () => ({ userId: "test-user" }),
  usePluginAction: (key: string) => {
    if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn());
    return mocks.actions.get(key);
  },
  useHostLocation: () => ({ pathname: window.location.pathname }),
  useHostNavigation: () => ({ resolveHref: (p: string) => "/ACME" + p, linkProps: (p: string) => ({ href: "/ACME" + p }), navigate: mocks.navigate })
}));
const context = { companyId: "c1", companyPrefix: "ACME", userId: "u1", projectId: null, entityId: null, entityType: null };
const app = { id: "12", name: "My App", slug: "my-app" };
const repository = { id: 22, fullName: "acme/repo", name: "repo", url: "https://github.com/acme/repo", installationId: 33, owner: "acme", private: true };
const action = (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key)!; };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { mocks.actions.clear(); mocks.navigate.mockReset(); sessionStorage.clear(); window.history.replaceState({}, "", "/ACME" + PAGE_PATH);
  action("sync-now").mockResolvedValue({ queued: true, queuedAt: "2026-10-10T12:00:00.000Z", busy: false, lastRunAt: null });
  action("sync-status").mockResolvedValue({ configured: true, settings: { enabled: true, rules: [] }, busy: false, report: { at: "now", warnings: [] }, pendingCount: 0 });
  action("automation-options").mockResolvedValue({ agents: [], repositories: [] });
  action("task-sync-detail").mockResolvedValue({ link: null, pending: false, repositories: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("minimal setup UI", () => {
  it("shows one primary create action with optional fields collapsed", async () => {
    action("status").mockResolvedValue({ configured: false, app: null });
    render(<GitHubPage context={context} />);
    await waitFor(() => expect(screen.queryByText("Working…")).toBeNull());
    expect(screen.getByRole("button", { name: "Create GitHub App" })).toBeTruthy();
    expect(screen.getByText("App name and owner (optional)").closest("details")?.open).toBe(false);
    expect(screen.getByLabelText("App name").getAttribute("value")).toMatch(/^Paperclip-ACME-/);
  });
  it("posts the manifest directly to GitHub and stores only browser setup state", async () => {
    action("status").mockResolvedValue({ configured: false });
    action("start-setup").mockResolvedValue({ state: "random", actionUrl: "https://github.com/settings/apps/new?state=random", manifest: { default_permissions: { metadata: "read", issues: "read" } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ deploymentMode: "local_trusted" })).mockResolvedValueOnce(json(null)));
    let manifest = "";
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function(this: HTMLFormElement) {
      manifest = new FormData(this).get("manifest") as string;
      expect(this.method).toBe("post"); expect(this.action).toBe("https://github.com/settings/apps/new?state=random");
    });
    render(<GitHubPage context={context} />);
    await waitFor(() => expect(screen.queryByText("Working…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create GitHub App" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(JSON.parse(manifest).default_permissions.issues).toBe("read");
    expect(JSON.parse(sessionStorage.getItem(`${PLUGIN_ID}:c1:u1`)!).state).toBe("random");
  });
  it("rejects a callback from another browser before exchanging its code and clears URL secrets", async () => {
    window.history.replaceState({}, "", `/ACME${PAGE_PATH}?code=sensitive-code&state=unknown`);
    render(<GitHubPage context={context} />);
    await screen.findByText(/started in another browser/);
    expect(action("complete-setup")).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
  it("completes a valid callback, saves the key automatically and clears browser state", async () => {
    const returnUrl = new URL("/ACME" + PAGE_PATH, window.location.origin).href;
    sessionStorage.setItem(`${PLUGIN_ID}:c1:u1`, JSON.stringify({ state: "valid-state", returnUrl }));
    window.history.replaceState({}, "", `/ACME${PAGE_PATH}?code=conversion-code&state=valid-state`);
    action("complete-setup").mockResolvedValue({ ...app, slug: "", privateKey: "one-time-pem" });
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [], repositories: [], warnings: [], truncated: false });
    action("projects").mockResolvedValue({ projects: [], truncated: false });
    const fetcher = vi.fn().mockResolvedValueOnce(json({ deploymentMode: "local_trusted" })).mockResolvedValueOnce(json(null))
      .mockResolvedValueOnce(json({ id: "s1" })).mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetcher);
    render(<GitHubPage context={context} />);
    await screen.findByText("My App");
    await waitFor(() => expect(screen.queryByText("Working…")).toBeNull());
    expect(action("complete-setup")).toHaveBeenCalledWith({ companyId: "c1", code: "conversion-code", state: "valid-state", returnUrl });
    expect(fetcher.mock.calls[2][1].body).toContain("one-time-pem");
    expect(fetcher.mock.calls[3][0]).toBe(`/api/plugins/${PLUGIN_ID}/config?companyId=c1`);
    expect(fetcher.mock.calls[4][1].body).not.toContain("one-time-pem");
    expect(fetcher.mock.calls[4][0]).toBe(`/api/plugins/${PLUGIN_ID}/config`);
    expect(fetcher.mock.calls[5][0]).toBe(`/api/plugins/${PLUGIN_ID}/actions/company-app.connect`);
    expect(sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain("one-time-pem");
    expect(window.location.search).toBe("");
  });
  it("does not replay a saved vault reference automatically after reload", async () => {
    const config = { appId: "12", appName: app.name, appSlug: app.slug, privateKey: { type: "secret_ref", secretId: "s1", version: "latest" } };
    sessionStorage.setItem(`${PLUGIN_ID}:c1:u1:saved`, JSON.stringify(config));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    action("status").mockResolvedValue({ configured: false, app: null });
    render(<GitHubPage context={context} />);
    await screen.findByRole("button", { name: "Create GitHub App" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(action("company-app.connect")).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`${PLUGIN_ID}:c1:u1:saved`)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry saving connection" })).toBeTruthy();
  });
  it("restores the previous config, including unrelated secrets, when the connect action fails", async () => {
    const config = { appId: "12", appName: app.name, appSlug: app.slug, privateKey: { type: "secret_ref", secretId: "s1", version: "latest" } };
    const previous = { appId: "9", appSlug: "old", appName: "Old", privateKey: { type: "secret_ref", secretId: "old-key", version: "latest" },
      personalToken: { type: "secret_ref", secretId: "pat", version: "latest" }, personalLogin: "octo",
      webhookSecret: { type: "secret_ref", secretId: "hook", version: "latest" } };
    sessionStorage.setItem(`${PLUGIN_ID}:c1:u1:saved`, JSON.stringify(config));
    action("status").mockResolvedValue({ configured: false, app: null });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ companyId: "c1", configJson: previous }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ error: "connect failed" }, 502))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetcher);
    render(<GitHubPage context={context} />);
    await screen.findByText(/waiting to be completed/);
    fireEvent.click(screen.getByRole("button", { name: "Retry saving connection" }));
    await screen.findByText(/could not save this change/);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/plugins/${PLUGIN_ID}/config?companyId=c1`);
    expect(fetcher.mock.calls[1][0]).toBe(`/api/plugins/${PLUGIN_ID}/config`);
    // A different App never inherits the old App's webhook secret.
    const { webhookSecret: _oldAppHook, ...unrelated } = previous;
    expect(JSON.parse(fetcher.mock.calls[1][1].body).configJson).toEqual({ ...unrelated, ...config });
    expect(fetcher.mock.calls[2][0]).toBe(`/api/plugins/${PLUGIN_ID}/actions/company-app.connect`);
    expect(fetcher.mock.calls[3][0]).toBe(`/api/plugins/${PLUGIN_ID}/config`);
    expect(JSON.parse(fetcher.mock.calls[3][1].body).configJson).toEqual(previous);
    expect(sessionStorage.getItem(`${PLUGIN_ID}:c1:u1:saved`)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry saving connection" })).toBeTruthy();
  });
  it("keeps the webhook secret reference when reconnecting the same App", async () => {
    const config = { appId: "12", appName: app.name, appSlug: app.slug, privateKey: { type: "secret_ref", secretId: "s2", version: "latest" } };
    const previous = { appId: "12", appSlug: app.slug, appName: app.name, privateKey: { type: "secret_ref", secretId: "s1", version: "latest" },
      webhookSecret: { type: "secret_ref", secretId: "hook", version: "latest" } };
    sessionStorage.setItem(`${PLUGIN_ID}:c1:u1:saved`, JSON.stringify(config));
    action("status").mockResolvedValue({ configured: false, app: null });
    const fetcher = vi.fn().mockResolvedValueOnce(json({ companyId: "c1", configJson: previous })).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ error: "connect failed" }, 502)).mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetcher);
    render(<GitHubPage context={context} />);
    await screen.findByText(/waiting to be completed/);
    fireEvent.click(screen.getByRole("button", { name: "Retry saving connection" }));
    await screen.findByText(/could not save this change/);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).configJson).toEqual({ ...previous, ...config });
  });
  it("drops a stale saved setup when the company is already connected", async () => {
    const config = { appId: "12", appName: app.name, appSlug: app.slug, privateKey: { type: "secret_ref", secretId: "s1", version: "latest" } };
    sessionStorage.setItem(`${PLUGIN_ID}:c1:u1:saved`, JSON.stringify(config));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [{ id: 33, login: "acme" }], repositories: [repository], warnings: [], truncated: false });
    render(<GitHubPage context={context} />);
    await screen.findByText("Connected");
    expect(screen.queryByRole("button", { name: "Retry saving connection" })).toBeNull();
    expect(screen.queryByText(/waiting to be completed/)).toBeNull();
    expect(sessionStorage.getItem(`${PLUGIN_ID}:c1:u1:saved`)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(action("company-app.connect")).not.toHaveBeenCalled();
  });
  it("disconnects through the company action without rewriting the plugin config", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [{ id: 33, login: "acme" }], repositories: [repository], warnings: [], truncated: false });
    action("company-app.disconnect").mockResolvedValue({ configured: false, app: null, allowedOwners: [] });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    render(<GitHubPage context={context} />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect…", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect GitHub", hidden: true }));
    await screen.findByRole("button", { name: "Create GitHub App" });
    expect(action("company-app.disconnect")).toHaveBeenCalledWith({ companyId: "c1" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("marks verified access green and separates destructive actions from their explanation", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [{ id: 33, login: "acme" }], repositories: [repository], warnings: [], truncated: false });
    render(<GitHubPage context={context} />);
    const connected = await screen.findByText("Connected");
    expect(connected.getAttribute("data-connected")).toBe("true");
    const disconnect = screen.getByRole("button", { name: "Disconnect…", hidden: true });
    expect(disconnect.className).toContain("danger");
    expect(disconnect.closest(".footer")).toBeTruthy();
    fireEvent.click(disconnect);
    expect(screen.getByRole("button", { name: "Disconnect GitHub", hidden: true }).className).toContain("danger");
    fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
    expect(action("status")).toHaveBeenCalledTimes(1);
  });
  it("sends connected users to native Projects without a duplicate creation form", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [{ id: 33, login: "acme" }], repositories: [repository], warnings: [], truncated: false });
    render(<GitHubPage context={context} />);
    const link = await screen.findByRole("link", { name: "Open Projects" });
    expect(link.getAttribute("href")).toBe("/ACME/projects");
    expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
    expect(screen.queryByLabelText("Paperclip project")).toBeNull();
    expect(action("projects")).not.toHaveBeenCalled();
  });
});

describe("secret persistence", () => {
  it("writes PEM only to the encrypted vault and sends only references to config", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ id: "s1" })).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch", fetcher);
    const config = await saveCredentials("c1", { ...app, privateKey: "test-pem" });
    await saveConfiguration("c1", config);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ value: "test-pem", provider: "local_encrypted" });
    expect(fetcher.mock.calls[1][1].body).not.toContain("test-pem");
    expect(JSON.parse(fetcher.mock.calls[1][1].body).configJson.privateKey).toMatchObject({ secretId: "s1", type: "secret_ref" });
  });
  it("does not expose provider or secret values in save errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "private-key-in-server-error" }, 500)));
    await expect(saveCredentials("c1", { ...app, privateKey: "test" })).rejects.not.toThrow("private-key-in-server-error");
  });
});

describe("task GitHub issues", () => {
  beforeEach(() => { action("status").mockResolvedValue({ configured: true, app }); });
  it("shows actionable SDK bridge errors, which are plain objects", async () => {
    action("linked-repositories").mockRejectedValue({ message: "Connect a GitHub App in the GitHub plugin first." });
    render(<GitHubIssues context={{ ...context, entityId: "i1", entityType: "project" }} />);
    await screen.findByText("Connect a GitHub App in the GitHub plugin first.");
  });
  it("shows partial access failures even when no repositories are available", async () => {
    action("linked-repositories").mockResolvedValue({ repositories: [], warnings: ["acme/private: grant access"], truncated: false });
    render(<GitHubIssues context={{ ...context, entityId: "i1", entityType: "project" }} />);
    await screen.findByRole("alert");
    expect(screen.getByText("acme/private: grant access")).toBeTruthy();
    expect(action("linked-repositories")).toHaveBeenCalledWith({ companyId: "c1", projectId: "i1" });
  });
  it("keeps project issues in Tasks and offers GitHub Projects in project details", async () => {
    action("linked-repositories").mockResolvedValue({ repositories: [repository], warnings: [], truncated: false });
    action("management-options").mockResolvedValue({ installations: [], repositories: [repository] });
    render(<GitHubIssues context={{ ...context, entityId: "i1", entityType: "project" }} />);
    await screen.findByRole("heading", { name: "GitHub Projects" });
    expect(action("issues")).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Load more issues" })).toBeNull();
  });
});


describe("current task layout toolbar", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); } });
  });
  it("resolves a task identifier through the host before loading its repository issues", async () => {
    window.history.replaceState({}, "", "/ACME/issues/ACME-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ id: "i1", companyId: "c1", projectId: "p1" })));
    action("task-sync-detail").mockResolvedValue({ link: null, pending: false, repositories: [] });
    render(<GitHubTaskButton context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub issues" }));
    await waitFor(() => expect(action("task-sync-detail")).toHaveBeenCalledWith({ companyId: "c1", issueId: "i1" }));
    expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("rejects a task in another company before invoking the plugin worker", async () => {
    window.history.replaceState({}, "", "/ACME/issues/ACME-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ id: "i1", companyId: "foreign", projectId: "p1" })));
    render(<GitHubTaskButton context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub issues" }));
    await screen.findByText(/Select this task’s company/);
    expect(action("task-sync-detail")).not.toHaveBeenCalled();
  });
});


describe("sidebar navigation", () => {
  it("marks the company GitHub page active and updates on navigation", () => {
    const { rerender } = render(<GitHubLink context={context} />);
    const link = screen.getByRole("link", { name: "GitHub" });
    expect(link.getAttribute("href")).toBe("/ACME/github-projects");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    window.history.replaceState({}, "", "/ACME/projects");
    rerender(<GitHubLink context={context} />);
    expect(link.getAttribute("aria-current")).toBeNull();
  });
});


describe("native task sync status", () => {
  it("shows the sync status without starting a sync or a second issue listing", async () => {
    render(<GitHubTaskList context={context} />);
    await screen.findByText("GitHub synced");
    expect(action("sync-now")).not.toHaveBeenCalled();
    expect(screen.queryByRole("list")).toBeNull();
    expect(action("task-issues")).not.toHaveBeenCalled();
  });
  it("points partial failures to the plugin configuration", async () => {
    action("sync-status").mockResolvedValue({ configured: true, settings: { enabled: true, rules: [] }, busy: false, report: { warnings: ["Denied"] }, pendingCount: 0 });
    render(<GitHubTaskList context={context} />);
    await screen.findByText("GitHub needs attention");
    fireEvent.click(screen.getByText("GitHub", { selector: "summary" }));
    expect(screen.getByRole("link", { name: "Review GitHub sync" }).getAttribute("href")).toBe("/ACME/github-projects");
  });
  it("discards requests from the previous company", async () => {
    let finish: (value: unknown) => void = () => {};
    action("sync-status").mockImplementation(({ companyId }: any) => companyId === "c1" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ configured: false }));
    const { rerender } = render(<GitHubTaskList context={context} />);
    rerender(<GitHubTaskList context={{ ...context, companyId: "c2" }} />);
    finish({ configured: true, settings: { enabled: true }, report: { warnings: [] }, pendingCount: 0 });
    await waitFor(() => expect(screen.queryByText("GitHub synced")).toBeNull());
  });
});

describe("connected account shortcuts", () => {
  it("opens organizations and the App owner profile directly, and removes green status after a failed refresh", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValueOnce({ app: { ...app, owner: "my-user" }, installations: [{ id: 33, login: "acme" }], repositories: [repository], warnings: [], truncated: false })
      .mockRejectedValueOnce({ message: "Access revoked" });
    render(<GitHubPage context={context} />);
    await screen.findByText("Connected");
    expect(screen.getByRole("link", { name: "Open acme on GitHub" }).getAttribute("href")).toBe("https://github.com/acme");
    expect(screen.getByRole("link", { name: "Open my-user on GitHub" }).getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Access revoked");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText("Check access")).toBeTruthy();
  });
});

describe("native task sync controls", () => {
  it("shows the specific GitHub issue and explicit conflict choices", async () => {
    action("task-sync-detail").mockResolvedValue({ link: { number: 4, url: `${repository.url}/issues/4`, conflicts: ["title"] }, pending: false, repositories: [repository] });
    action("resolve-task-sync").mockResolvedValue({ ok: true });
    render(<GitHubIssues context={{ ...context, entityType: "issue", entityId: "i1" }} />);
    await screen.findByRole("link", { name: /Open GitHub issue #4/ });
    fireEvent.click(screen.getByRole("button", { name: "Use GitHub" }));
    await waitFor(() => expect(action("resolve-task-sync")).toHaveBeenCalledWith({ companyId: "c1", issueId: "i1", keep: "github" }));
  });
  it("shows SDK error messages when publication fails", async () => {
    action("task-sync-detail").mockResolvedValue({ link: null, pending: false, repositories: [{ ...repository, issuesWrite: true }] });
    action("publish-task").mockRejectedValue({ message: "Repository access was revoked." });
    render(<GitHubIssues context={{ ...context, entityType: "issue", entityId: "i1" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create GitHub issue from task" }));
    await screen.findByText("Repository access was revoked.");
  });
  it("saves a customizable assignee-to-agent rule only when Save is clicked", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [], repositories: [repository], warnings: [], truncated: false });
    action("automation-options").mockResolvedValue({ agents: [{ id: "a1", name: "Engineer" }], repositories: [repository.fullName] });
    action("save-sync-settings").mockImplementation(({ settings }: any) => Promise.resolve(settings));
    render(<GitHubPage context={context} />);
    fireEvent.click(await screen.findByText("Sync & automations"));
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("GitHub assignee"), { target: { value: "alex" } });
    fireEvent.change(screen.getByLabelText("Assign to agent"), { target: { value: "a1" } });
    expect(action("save-sync-settings")).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved");
    expect(action("save-sync-settings")).toHaveBeenCalledWith({ companyId: "c1", settings: { enabled: true, rules: [expect.objectContaining({ if: { assignee: "alex", state: "open" }, then: { agentId: "a1", status: "todo", wake: false } })] } });
  });
  it("saves a per-action write identity with a repository override and previews it", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [], repositories: [repository], warnings: [], truncated: false });
    action("write-identity.get").mockResolvedValue({ companyId: "c1", policy: null });
    action("write-identity.set").mockImplementation(({ policy }: any) => Promise.resolve({ companyId: "c1", policy }));
    render(<GitHubPage context={context} />);
    fireEvent.click(await screen.findByText("Write identity · Default"));
    expect(screen.getByText(/writes as my-app\[bot\]/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Choose the identity per action"));
    fireEvent.change(screen.getByLabelText("Comments and reviews"), { target: { value: "bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    fireEvent.change(screen.getByLabelText("Repositories"), { target: { value: "vllnt/*" } });
    fireEvent.change(screen.getAllByLabelText("Pushes")[1]!, { target: { value: "bot" } });
    fireEvent.change(screen.getByLabelText("Preview a repository"), { target: { value: "vllnt/site" } });
    const preview = screen.getByRole("list", { name: "Write identity preview" });
    expect(preview.textContent).toContain("Pushes: As the App");
    expect(preview.textContent).toContain("Commits: As the user");
    expect(action("write-identity.set")).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save write identity" }));
    await screen.findByText("Saved");
    // Fields the panel does not edit (kill switch, allowlist, privileged toggles…) keep their values.
    expect(action("write-identity.set")).toHaveBeenCalledWith({ companyId: "c1", policy: expect.objectContaining({
      default: { commit: "user", push: "user", pullRequest: "user", comment: "bot" },
      overrides: [{ match: "vllnt/*", push: "bot" }],
      missingUserConnection: "fail",
      enabled: true,
      privileged: expect.objectContaining({ release: false, tagPush: false }),
    }) });
  });
  it("opens the managed workflow skill for policy edits", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app, installations: [], repositories: [repository], warnings: [], truncated: false });
    action("github-workflow-skill-status").mockResolvedValue({ status: "resolved", skillId: "skill-1" });
    render(<GitHubPage context={context} />);
    fireEvent.click(await screen.findByText("Sync & automations"));
    fireEvent.click(await screen.findByRole("button", { name: "Open / edit skill" }));
    expect(mocks.navigate).toHaveBeenCalledWith("/skills/studio/skill-1");
  });
  it("shows PR and Projects permission upgrades even when Issues write was already approved", async () => {
    action("status").mockResolvedValue({ configured: true, app });
    action("catalog").mockResolvedValue({ app: { ...app, issuesWrite: true, permissions: { issues: "write", metadata: "read" }, settingsUrl: "https://github.com/settings/apps/my-app/permissions" }, installations: [{ id: 33, login: "acme", accountType: "Organization", issuesWrite: true, permissions: { issues: "write", metadata: "read" }, settingsUrl: "https://github.com/organizations/acme/settings/installations/33" }], repositories: [repository], warnings: [], truncated: false });
    render(<GitHubPage context={context} />);
    const guide = await screen.findByText("Enable PRs & Projects");
    expect(guide.closest("details")?.open).toBe(false);
    fireEvent.click(guide);
    expect((await screen.findByRole("link", { name: /Edit permissions/ })).getAttribute("href")).toContain("/permissions");
    expect(screen.getByRole("link", { name: /Approve for acme/ }).getAttribute("href")).toContain("/installations/33");
  });
});

 it("shows manual sync errors, bypasses cache, and keeps warnings inside the toolbar disclosure", async () => {
   render(<GitHubTaskList context={context} />);
   await screen.findByText("GitHub synced");
   const summary = screen.getByText("GitHub", { selector: "summary" });
   expect(summary.closest("details")?.open).toBe(false);
   await waitFor(() => expect(summary.getAttribute("aria-label")).toBe("GitHub synced"));
   expect(summary.querySelector("[data-connected=true]")).toBeTruthy();
   fireEvent.click(summary);
   action("sync-now").mockRejectedValueOnce({ message: "Access revoked" });
   fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
   expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Access revoked");
   expect(action("sync-now")).toHaveBeenLastCalledWith({ companyId: "c1", refresh: true });
   expect(summary.querySelector("[data-connected=true]")).toBeNull();
   fireEvent.keyDown(document, { key: "Escape" }); expect(summary.closest("details")?.open).toBe(false);
 });

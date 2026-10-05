// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GitHubWorkspace, PersonalProjectAccess } from "../src/ui/management.js";
import { RepositoryWorkspace } from "../src/ui/management-repository.js";
import { ProjectsWorkspace } from "../src/ui/management-projects.js";
import { ActionForm } from "../src/ui/management-common.js";
const mocks = vi.hoisted(() => ({ actions: new Map<string, ReturnType<typeof vi.fn>>() }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({ useHostContext: () => ({ userId: "test-user" }), useHostLocation: () => ({ search: window.location.search }), useHostNavigation: () => ({ linkProps: (p: string) => ({ href: "/GIT" + p }) }), usePluginAction: (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key); } }));
const action = (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key)!; };
const permissions = { metadata: "read", issues: "write", contents: "write", pull_requests: "write", organization_projects: "write" };
const repo = { id: 22, name: "repo", fullName: "org/repo", owner: "org", url: "https://github.com/org/repo", installationId: 33, private: true, permissions };
const pr = { id: 7, number: 7, title: "Improve feature", body: "Description", state: "open", draft: false, user: { login: "alex" }, head: { sha: "abc123", label: "org:feature" }, base: { ref: "main", label: "org:main" }, assignees: [], labels: [], mergeable: true, mergeable_state: "clean" };
const project = { id: "P", number: 1, title: "Roadmap", fields: [{ id: "F", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "todo", name: "Todo" }, { id: "done", name: "Done" }] }], public: false, closed: false };
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => { sessionStorage.clear(); HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; window.history.replaceState({}, "", "/"); mocks.actions.clear(); action("manage-repository").mockImplementation(async p => p.op === "pull" || p.op === "issue" ? pr : { rows: [], nextPage: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function openSummary(name: string) { if (screen.queryByText(name, { selector: "summary" })) { fireEvent.click(screen.getByText(name, { selector: "summary" })); return; } if (!screen.queryByRole("button", { name })) fireEvent.click(screen.getByRole("button", { name: "Actions" })); fireEvent.click(screen.getByRole("button", { name })); }

describe("GitHub management controls", () => {
  it("keeps workspace selection minimal and lists PRs inside Paperclip", async () => {
    action("manage-repository").mockResolvedValue({ rows: [pr], nextPage: null });
    render(<GitHubWorkspace companyId="c1" catalog={{ app: { id: "12", slug: "app", name: "App" }, repositories: [repo], installations: [], warnings: [], truncated: false }} />);
    expect(action("manage-repository")).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Pull requests" }));
    expect(await screen.findByRole("button", { name: "#7 Improve feature" })).toBeTruthy();
    expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c1", repositoryId: 22, op: "pulls" }));
  });
  it("requires the exact merge confirmation and submits the reviewed SHA", async () => {
    render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
    await screen.findByRole("heading", { name: "#7 Improve feature" }); openSummary("Merge");
    const button = screen.getByRole("button", { name: "Confirm merge" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirm action"), { target: { value: "org/repo#7" } });
    expect(button.disabled).toBe(false); fireEvent.click(button);
    await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "merge-pr", number: 7, sha: "abc123", method: "squash", confirm: "org/repo#7" })));
  });
  it("preserves a retry identity and displays provider failure instead of success", async () => {
    action("manage-repository").mockImplementation(async p => { if (p.op === "merge-pr") throw { message: "The PR changed. Refresh." }; return p.op === "pull" || p.op === "issue" ? pr : { rows: [] }; });
    render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
    await screen.findByRole("heading", { name: "#7 Improve feature" }); openSummary("Merge");
    fireEvent.change(screen.getByLabelText("Confirm action"), { target: { value: "org/repo#7" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" })); await screen.findByText("The PR changed. Refresh.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(action("manage-repository").mock.calls.filter(([p]) => p.op === "merge-pr")).toHaveLength(2));
    const calls = action("manage-repository").mock.calls.filter(([p]) => p.op === "merge-pr"); expect(calls[0][0].requestId).toBe(calls[1][0].requestId);
  });
  it("allows clearing assignees and labels without an invalid required input", async () => {
    render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
    await screen.findByRole("heading", { name: "#7 Improve feature" }); openSummary("Assignees, labels & milestone");
    const panel = screen.getByRole("dialog", { name: "Assignees, labels & milestone" });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "edit-issue", assignees: [], labels: [], milestone: null })));
  });
  it("shows diffs and submits an inline comment tied to its path and SHA", async () => {
    action("manage-repository").mockImplementation(async p => p.op === "files" ? { rows: [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }], nextPage: null } : p.op === "pull" || p.op === "issue" ? pr : { rows: [] });
    render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
    await screen.findByRole("heading", { name: "#7 Improve feature" }); fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await screen.findByRole("heading", { name: "src/a.ts · +1 −1" }); fireEvent.click(screen.getByRole("button", { name: "Comment on line" }));
    fireEvent.change(screen.getByLabelText("Line number"), { target: { value: "1" } }); fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Please explain." } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Comment on line" })).getByRole("button", { name: "Comment on line" }));
    await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "inline-comment", path: "src/a.ts", sha: "abc123", line: 1, side: "RIGHT", body: "Please explain." })));
  });
  it("renders GitHub Markdown safely in the Conversation view", async () => {
    const markdown = "## Release\n\n- [x] ship it\n- [ ] document it\n\n| Field | Value |\n| --- | --- |\n| Version | `1.0` |\n\n[Safe](https://github.com/org/repo) [Unsafe](javascript:alert(1))\n\n```ts\nconst ok = true;\n```";
    action("manage-repository").mockImplementation(async p => p.op === "issue" ? { ...pr, body: markdown } : { rows: [] });
    render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
    expect(await screen.findByRole("heading", { name: "#7 Improve feature" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Release" })).toBeTruthy();
    expect(screen.getByText("ship it")).toBeTruthy();
    expect(screen.getByText("Version")).toBeTruthy();
    expect(screen.getByText("const ok = true;")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Safe" }).getAttribute("href")).toBe("https://github.com/org/repo");
    expect(screen.getByText("Unsafe").closest("a")).toBeNull();
  });
  it("disables new PR submission when App permissions are read-only", async () => {
    render(<RepositoryWorkspace companyId="c1" repository={{ ...repo, permissions: { ...permissions, pull_requests: "read" } }} repositories={[repo]} kind="pull" />);
    openSummary("New pull request");
    expect((screen.getByRole("button", { name: "Create pull request" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Enable Pull requests read\/write/)).toBeTruthy();
  });
  it("browses project items and changes a single-select field with its real option ID", async () => {
    action("manage-project").mockImplementation(async p => p.op === "list" ? { rows: [project], nextCursor: null } : p.op === "detail" ? project : p.op === "items" ? { rows: [{ id: "ITEM", content: { title: "Build feature", __typename: "Issue", number: 7, repository: { nameWithOwner: "org/repo" } }, fieldValues: { nodes: [{ field: { id: "F", name: "Status" }, name: "Todo", optionId: "todo" }] } }], nextCursor: null } : {});
    render(<ProjectsWorkspace companyId="c1" owner={{ login: "org", type: "Organization" }} repositories={[repo]} openRecord={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "#1 Roadmap" }));
    fireEvent.click(await screen.findByText(/#7 Build feature/, { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "done" } });
    expect(action("manage-project").mock.calls.some(([p]) => p.op === "set-field")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Set Status" }));
    await waitFor(() => expect(action("manage-project")).toHaveBeenCalledWith(expect.objectContaining({ op: "set-field", projectNumber: 1, itemId: "ITEM", fieldId: "F", value: "done", owner: "org" })));
  });
  it("stores personal access only in the vault and preserves existing App config", async () => {
    const config = { appId: "12", privateKey: { type: "secret_ref", secretId: "app-key" } };
    action("verify-personal").mockResolvedValue({ login: "me" });
    const fetcher = vi.fn(async (path: string, opts?: RequestInit) => path.endsWith("/health") ? json({ deploymentMode: "local_trusted" }) : path.endsWith("/secrets") ? json({ id: "personal-key" }) : json({ configJson: config }));
    vi.stubGlobal("fetch", fetcher);
    render(<PersonalProjectAccess companyId="c1" />); fireEvent.click(screen.getByText(/Personal Projects access/, { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "secret-personal-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect personal Projects" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([path, options]) => path.endsWith("/config") && options?.method === "POST")).toBe(true));
    const saved = fetcher.mock.calls.find(([path, options]) => path.endsWith("/config") && options?.method === "POST")!;
    expect(JSON.parse(String(saved[1]?.body)).configJson).toEqual({ ...config, personalLogin: "me", personalToken: { type: "secret_ref", secretId: "personal-key", version: "latest" } });
    expect(String(saved[1]?.body)).not.toContain("secret-personal-token");
    await waitFor(() => expect((screen.getByLabelText("Personal access token") as HTMLInputElement).value).toBe(""));
  });
  it("does not submit a destructive form before exact confirmation", async () => {
    const run = vi.fn().mockResolvedValue({}); render(<ActionForm submit="Delete" confirmation="Roadmap" destructive run={run} />);
    fireEvent.change(screen.getByLabelText("Confirm action"), { target: { value: "roadmap" } }); fireEvent.click(screen.getByRole("button", { name: "Delete" })); expect(run).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm action"), { target: { value: "Roadmap" } }); fireEvent.click(screen.getByRole("button", { name: "Delete" })); await waitFor(() => expect(run).toHaveBeenCalledWith({ confirm: "Roadmap" }));
  });
});

it("preserves successful-write feedback when refreshing the view fails", async () => {
  const run = vi.fn().mockResolvedValue({});
  render(<ActionForm submit="Post" run={run} onDone={async () => { throw new Error("Read failed"); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  expect(await screen.findByText("Saved, but the view could not refresh. Refresh before making another change.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Saved"); expect(run).toHaveBeenCalledTimes(1);
});

it("delegates a PR review to a linked native project with optional wake", async () => {
  action("pr-task-options").mockResolvedValue({ projects: [{ id: "p1", name: "API" }], agents: [{ id: "a1", name: "Reviewer", githubLogin: "review-bot", githubEnabled: true }] });
  action("manage-agent-reviewers").mockResolvedValue({ reviewers: [{ agentId: "a1", login: "review-bot" }] });
  action("review-pr-task").mockResolvedValue({ id: "task-1", identifier: "GIT-2", tasks: [{ id: "task-1", identifier: "GIT-2", agentId: "a1", agentName: "Reviewer" }] });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" }); openSummary("Delegate review to a Paperclip agent");
  fireEvent.click(await screen.findByRole("checkbox", { name: "Reviewer" }));
  fireEvent.click(screen.getByRole("button", { name: "Assign reviewers" }));
  await waitFor(() => expect(action("review-pr-task")).toHaveBeenCalledWith({ companyId: "c1", repositoryId: 22, number: 7, sha: "abc123", projectId: "p1", agentIds: ["a1"], reviewerAgentIds: ["a1"], wake: false }));
  expect((await screen.findByRole("link", { name: "Open GIT-2" })).getAttribute("href")).toBe("/GIT/issues/task-1");
});

it("links issues to their native task in both list and detail and explicitly refreshes cached reads", async () => {
  const issue = { ...pr, paperclipTask: { id: "task-1", identifier: "GIT-9", status: "todo" }, cache: { fetchedAt: "2026-10-04T12:00:00Z" } };
  action("manage-repository").mockImplementation(async p => p.op === "issue" ? issue : { rows: [issue], nextPage: null, cache: issue.cache });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" />);
  expect((await screen.findByRole("link", { name: "Open GIT-9" })).getAttribute("href")).toBe("/GIT/issues/task-1");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenLastCalledWith(expect.objectContaining({ op: "issues", refresh: true })));
  fireEvent.click(screen.getByRole("button", { name: "#7 Improve feature" }));
  expect((await screen.findByRole("link", { name: "Open GIT-9" })).getAttribute("href")).toBe("/GIT/issues/task-1");
});

it("opens a linked PR directly from its Paperclip URL", async () => {
  window.history.replaceState({}, "", "/?repository=22&kind=pull&number=7");
  render(<GitHubWorkspace companyId="c1" catalog={{ app: { id: "12", slug: "app", name: "App" }, repositories: [repo], installations: [], warnings: [], truncated: false }} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c1", repositoryId: 22, op: "pull", number: 7 }));
  expect(screen.getByRole("tab", { name: "Pull requests" }).getAttribute("aria-selected")).toBe("true");
});

it("shows Conversation and a GitHub composer without collapsible controls", async () => {
  action("manage-repository").mockImplementation(async p => p.op === "issue" ? pr : p.op === "comments" ? { rows: [{ id: 2, body: "Later", user: { login: "sam" }, created_at: "2026-10-04T12:00:00Z" }, { id: 1, body: "Earlier", user: { login: "alex" }, created_at: "2026-10-04T11:00:00Z" }], nextPage: null } : {});
  const view = render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  await screen.findByText("Earlier");
  expect(view.container.querySelectorAll("details,summary")).toHaveLength(0);
  expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("Description")).toBeTruthy();
  const text = view.container.textContent!; expect(text.indexOf("Earlier")).toBeLessThan(text.indexOf("Later"));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "**Ready** to ship" } });
  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.getByText("Ready").tagName).toBe("STRONG");
  expect(screen.getByText(/Comment on GitHub/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "comment", body: "**Ready** to ship", number: 7 })));
});

it("retains the comment draft and exposes provider failure", async () => {
  action("manage-repository").mockImplementation(async p => { if (p.op === "comment") throw new Error("GitHub refused the comment"); return p.op === "issue" ? pr : { rows: [], nextPage: null }; });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "GitHub refused the comment");
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep this draft");
});

it("disables PR commenting without Pull requests write permission", async () => {
  render(<RepositoryWorkspace companyId="c1" repository={{ ...repo, permissions: { ...permissions, pull_requests: "read" } }} repositories={[repo]} kind="pull" initialNumber={7} />);
  expect((await screen.findByLabelText("Comment") as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Post comment" }) as HTMLButtonElement).disabled).toBe(true);
  expect(action("manage-repository").mock.calls.some(([p]) => p.op === "comment")).toBe(false);
});

it("keeps a GitHub comment draft when switching PR tabs and closes dialogs with Escape", async () => {
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
  fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Keep while inspecting files" } });
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
  expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep while inspecting files");
  const trigger = screen.getByRole("button", { name: "Actions" });
  fireEvent.click(trigger);
  fireEvent(screen.getByRole("dialog", { name: "Actions" }), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog", { name: "Actions" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps comment drafts and retry receipts across native record unmounts", async () => {
  let loseResponse = true;
  action("manage-repository").mockImplementation(async p => { if (p.op === "comment" && loseResponse) throw new Error("Connection lost"); return p.op === "issue" ? pr : { rows: [], nextPage: null }; });
  const mount = (companyId = "c1") => render(<RepositoryWorkspace companyId={companyId} repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  const first = mount();
  fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "One comment only" } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await screen.findByText("Connection lost");
  const firstId = action("manage-repository").mock.calls.find(([p]) => p.op === "comment")![0].requestId;
  first.unmount();
  const remounted = mount();
  expect((await screen.findByLabelText("Comment") as HTMLTextAreaElement).value).toBe("One comment only");
  loseResponse = false; fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(action("manage-repository").mock.calls.filter(([p]) => p.op === "comment")).toHaveLength(2));
  const secondId = action("manage-repository").mock.calls.filter(([p]) => p.op === "comment")[1][0].requestId;
  expect(secondId).toBe(firstId);
  await waitFor(() => expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe(""));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "One comment only" } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(action("manage-repository").mock.calls.filter(([p]) => p.op === "comment")).toHaveLength(3));
  expect(action("manage-repository").mock.calls.filter(([p]) => p.op === "comment")[2][0].requestId).not.toBe(firstId);
  remounted.unmount();
  mount("another-company");
  expect((await screen.findByLabelText("Comment") as HTMLTextAreaElement).value).toBe("");
});

it("keeps inline review text across Files tab unmounts without persisting confirmations", async () => {
  action("manage-repository").mockImplementation(async p => p.op === "files" ? { rows: [{ filename: "src/a.ts", patch: "+hello", additions: 1, deletions: 0 }], nextPage: null } : p.op === "pull" || p.op === "issue" ? pr : { rows: [], nextPage: null });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Comment on line" }));
  fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Explain this line" } });
  fireEvent.change(screen.getByLabelText("Line number"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Close Comment on line" }));
  fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Comment on line" }));
  expect((screen.getByLabelText("Review comment") as HTMLTextAreaElement).value).toBe("Explain this line");
  expect((screen.getByLabelText("Line number") as HTMLInputElement).value).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Close Comment on line" }));
  openSummary("Merge");
  fireEvent.change(screen.getByLabelText("Confirm action"), { target: { value: "org/repo#7" } });
  fireEvent.click(screen.getByRole("button", { name: "Close Merge" }));
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  expect((screen.getByLabelText("Confirm action") as HTMLInputElement).value).toBe("");
});

it("allows PR commenting with Pull requests write and Issues read", async () => {
  render(<RepositoryWorkspace companyId="c1" repository={{ ...repo, permissions: { ...permissions, issues: "read", pull_requests: "write" } }} repositories={[repo]} kind="pull" initialNumber={7} />);
  const composer = await screen.findByLabelText("Comment") as HTMLTextAreaElement;
  expect(composer.disabled).toBe(false);
  fireEvent.change(composer, { target: { value: "PR comment" } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "comment", kind: "pull", body: "PR comment" })));
});

it("opens review comments from unified diff rows with safe coordinates and captured SHA", async () => {
  action("manage-repository").mockImplementation(async p => p.op === "files" ? { rows: [{ filename: "src/a.ts", patch: "@@ -10,2 +20,2 @@\n-old\n+new\n context", additions: 1, deletions: 1 }], nextPage: null } : p.op === "pull" || p.op === "issue" ? pr : { rows: [], nextPage: null });
  const view = render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Comment on old line 10" }));
  expect((screen.getByLabelText("Line number") as HTMLInputElement).value).toBe("10");
  expect((screen.getByLabelText("Side") as HTMLSelectElement).value).toBe("LEFT");
  fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Why remove this?" } });
  fireEvent.click(within(screen.getByRole("dialog", { name: "Comment on old line 10" })).getByRole("button", { name: "Comment on line" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "inline-comment", path: "src/a.ts", line: 10, side: "LEFT", sha: "abc123", body: "Why remove this?" })));
  expect(view.container.querySelector('[data-kind="added"]')?.textContent).toContain("new");
  expect(view.container.querySelectorAll("details,summary")).toHaveLength(0);
});

it("only closes the top nested record dialog on Escape", async () => {
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  openSummary("Edit details");
  fireEvent(screen.getByRole("dialog", { name: "Edit details" }), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog", { name: "Edit details" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Actions" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit details" }));
});

it("re-runs a GitHub check when Checks write access is granted", async () => {
  action("manage-repository").mockImplementation(async p => {
    if (p.op === "pull") return pr;
    if (p.op === "checks") return { sha: "abc123", checks: [{ id: 21, name: "CI", status: "completed", conclusion: "failure", html_url: "https://github.com/org/repo/actions/runs/21" }], statuses: [], warnings: [] };
    return { rows: [], nextPage: null };
  });
  render(<RepositoryWorkspace companyId="c1" repository={{ ...repo, permissions: { ...permissions, checks: "write" } }} repositories={[repo]} kind="pull" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
  fireEvent.click(await screen.findByRole("button", { name: "Re-run" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "rerequest-check", checkRunId: 21, number: 7 })));
});

it("shows review thread replies and preserves the thread action", async () => {
  action("manage-repository").mockImplementation(async p => {
    if (p.op === "pull") return pr;
    if (p.op === "threads") return { node: { reviewThreads: { nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [{ id: 10, body: "Root review", path: "src/a.ts", line: 3 }, { id: 11, body: "Follow-up reply", path: "src/a.ts", line: 3 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return { rows: [], nextPage: null };
  });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="pull" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  fireEvent.click(screen.getByRole("tab", { name: "Reviews" }));
  expect(await screen.findByText("Root review")).toBeTruthy();
  expect(screen.getByText("Follow-up reply")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Acknowledged" } });
  fireEvent.click(screen.getByRole("button", { name: "Reply to thread" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "reply-review-comment", commentId: 10, body: "Acknowledged" })));
});

it("renders GitHub reaction colors and posts the selected reaction", async () => {
  action("manage-repository").mockImplementation(async p => {
    if (p.op === "issue") return pr;
    if (p.op === "comments") return { rows: [{ id: 9, body: "Ship it", user: { login: "sam" }, reactions: { "+1": 2, heart: 1, rocket: 0 } }], nextPage: null };
    return {};
  });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  await screen.findByText("Ship it");
  expect(screen.getByRole("button", { name: "Like reaction, 2 currently" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Heart reaction, 1 currently" })).toBeTruthy();
  fireEvent.click(within(screen.getByLabelText("Comment reactions")).getByRole("button", { name: "Add reaction" }));
  const dialog = await screen.findByRole("dialog", { name: "Add reaction" });
  expect(within(dialog).getByRole("button", { name: "Add Rocket reaction" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Add Rocket reaction" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "react-comment", commentId: 9, content: "rocket" })));
});

it("keeps an existing native bot assignee selected when editing", async () => {
  action("pr-task-options").mockResolvedValue({ agents: [{ id: "a1", name: "Reviewer", githubLogin: "review-bot", githubEnabled: true }] });
  action("manage-repository").mockImplementation(async p => p.op === "issue" ? { ...pr, assignees: [{ login: "review-bot" }] } : p.op === "assignees" ? { rows: [{ login: "alex" }] } : { rows: [] });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  openSummary("Assignees, labels & milestone");
  const checkbox = within(screen.getByRole("dialog", { name: "Assignees, labels & milestone" })).getByRole("checkbox", { name: "Reviewer · @review-bot" }) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
});

it("shows native channel bots in the same issue assignee picker and submits agent IDs", async () => {
  action("pr-task-options").mockResolvedValue({ agents: [{ id: "a1", name: "Reviewer", githubLogin: "review-bot", githubEnabled: true }] });
  action("manage-repository").mockImplementation(async p => p.op === "issue" ? { ...pr, assignees: [] } : p.op === "assignees" ? { rows: [{ login: "alex" }] } : { rows: [] });
  render(<RepositoryWorkspace companyId="c1" repository={repo} repositories={[repo]} kind="issue" initialNumber={7} />);
  await screen.findByRole("heading", { name: "#7 Improve feature" });
  openSummary("Assignees, labels & milestone");
  const dialog = screen.getByRole("dialog", { name: "Assignees, labels & milestone" });
  expect(within(dialog).getByText("Bot")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Reviewer · @review-bot" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action("manage-repository")).toHaveBeenCalledWith(expect.objectContaining({ op: "edit-issue", assigneeAgentIds: ["a1"], assignees: [], milestone: null })));
});

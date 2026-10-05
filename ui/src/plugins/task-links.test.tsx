// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { TaskLinksProvider, TaskLinkCells, TaskLinksSidebar, parseTaskLinks, useTaskLinkColumns } from "./task-links";
import { IssueRow } from "@/components/IssueRow";
const mocks = vi.hoisted(() => ({ list: vi.fn(), action: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { listUiContributions: mocks.list, bridgePerformAction: mocks.action } }));
vi.mock("@/lib/router", () => ({ useActiveCompanyPrefix: () => "GIT", Link: ({ to, children, onClickCapture, className, ...props }: any) => <a {...props} href={to} className={className} onClick={e => { e.preventDefault(); mocks.navigate(to); }} onClickCapture={onClickCapture}>{children}</a> }));
const plugin = { pluginId: "p", pluginKey: "github", displayName: "GitHub", version: "1", uiEntryFile: "index.js", slots: [], launchers: [], projectRepositories: { listAction: "repos", setupPath: "/github" }, taskCreation: { label: "GitHub", listAction: "destinations", publishAction: "publish", linksAction: "links" } };
const issue = { id: "t1", companyId: "c1", identifier: "PC-1", title: "Fix it", status: "todo", originKind: "plugin:github:issue" } as unknown as Issue;
const links = { issueId: "t1", issue: { url: "https://github.com/org/repo/issues/1", label: "#1", viewPath: "/github?kind=issue&number=1" }, pullRequests: [{ url: "https://github.com/org/repo/pull/2", label: "#2", state: "merged", viewPath: "/github?kind=pull&number=2" }], pullRequestsStatus: "ready", details: [{ label: "Assignees", value: "alex" }, { label: "Labels", value: "bug" }] };
let root: Root, container: HTMLDivElement, client: QueryClient;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise(resolve => setTimeout(resolve, 30));
async function render(children: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)); await act(flush); await act(flush); }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); mocks.list.mockResolvedValue([plugin]); mocks.action.mockResolvedValue({ data: { tasks: [links] } }); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
describe("native task links", () => {
  it.each(["task", "legacy"] as const)("keeps direct links separate from native navigation in %s rows", async presentation => {
    await render(<TaskLinksProvider companyId="c1" tasks={[issue]} collectionKey="tasks"><IssueRow issue={issue} presentation={presentation} /></TaskLinksProvider>);
    const external = container.querySelector<HTMLAnchorElement>('a[href="https://github.com/org/repo/issues/1"]')!;
    expect(container.querySelectorAll('[data-column="source-issue"]')).toHaveLength(2);
    expect(external).toBeTruthy(); expect(external.target).toBe("_blank"); expect(external.parentElement?.closest("a")).toBeNull();
    expect(container.querySelector('[aria-label="Open GitHub pull request #2"]')).toBeTruthy();
    await act(async () => external.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });
  it("opens declared issue and PR panels on the native task from list cells", async () => {
    mocks.list.mockResolvedValue([{ ...plugin, slots: [{ id: "record", type: "detailTab", entityTypes: ["issue"] }] }]);
    mocks.action.mockResolvedValue({ data: { tasks: [{ ...links, issue: { ...links.issue, panel: { slotId: "record", recordId: "repo:issue:1" } }, pullRequests: [{ ...links.pullRequests[0], panel: { slotId: "record", recordId: "repo:pull:2" } }] }] } });
    await render(<TaskLinksProvider companyId="c1" tasks={[issue]} collectionKey="tasks"><TaskLinkCells issueId="t1" /></TaskLinksProvider>);
    const issueLink = container.querySelector<HTMLAnchorElement>('a[aria-label="View GitHub issue #1"]')!;
    const prLink = container.querySelector<HTMLAnchorElement>('a[aria-label="View GitHub pull request #2"]')!;
    expect(issueLink.getAttribute("href")).toBe("/GIT/issues/t1?taskPlugin=github&taskRecord=repo%3Aissue%3A1");
    expect(prLink.getAttribute("href")).toBe("/GIT/issues/t1?taskPlugin=github&taskRecord=repo%3Apull%3A2");
    await act(async () => issueLink.click());
    expect(mocks.navigate).toHaveBeenLastCalledWith(issueLink.getAttribute("href"));
  });

  it.each([{ slotId: "foreign", recordId: "issue:1" }, { slotId: "record", recordId: "" }, { slotId: "record", recordId: "x".repeat(513) }])("rejects undeclared or malformed panel references %j", panel => {
    const declared = { ...plugin, slots: [{ id: "record", type: "detailTab", entityTypes: ["issue"] }] } as any;
    const rows = parseTaskLinks({ tasks: [{ ...links, issue: { ...links.issue, panel } }] }, ["t1"], declared);
    expect(rows[0].issue?.panel).toBeUndefined();
    expect(rows[0].issue?.url).toBe(links.issue.url);
  });

  it("does not accept a panel slot declared only for another entity", () => {
    const declared = { ...plugin, slots: [{ id: "record", type: "detailTab", entityTypes: ["project"] }] } as any;
    const rows = parseTaskLinks({ tasks: [{ ...links, issue: { ...links.issue, panel: { slotId: "record", recordId: "issue:1" } } }] }, ["t1"], declared);
    expect(rows[0].issue?.panel).toBeUndefined();
  });

  it("requests bounded batches scoped to the selected company", async () => {
    const tasks = Array.from({ length: 205 }, (_, n) => ({ ...issue, id: `task-${n}` }));
    await render(<TaskLinksProvider companyId="c1" tasks={tasks} collectionKey="tasks"><TaskLinkCells issueId="task-0" /></TaskLinksProvider>);
    expect(mocks.action).toHaveBeenCalledTimes(3);
    expect(mocks.action.mock.calls.map(c => c[2].issueIds.length)).toEqual([100,100,5]);
    expect(mocks.action.mock.calls.every(c => c[3] === "c1")).toBe(true);
  });
  it("shows provider details and an in-app PR view in the sidebar", async () => {
    await render(<TaskLinksSidebar issue={issue} />);
    expect(container.textContent).toContain("Assigneesalex"); expect(container.textContent).toContain("Labelsbug");
    expect(container.querySelector('a[href="/GIT/github?kind=pull&number=2"]')?.textContent).toBe("View PR");
    expect(mocks.action).toHaveBeenCalledWith("p", "links", { issueIds: ["t1"], detail: true }, "c1");
  });
  it("shows an access warning rather than reporting no PRs, and renders retry failures", async () => {
    mocks.action.mockResolvedValue({ data: { tasks: [{ ...links, pullRequests: [], pullRequestsStatus: "access_required", message: "Approve PR access" }] } });
    await render(<TaskLinksSidebar issue={issue} />); expect(container.textContent).toContain("Approve PR access"); expect(container.textContent).not.toContain("No linked pull requests");
    expect(container.querySelector('a[href="/GIT/github"]')).toBeTruthy();
  });
  it("remembers hidden columns per company and collection", async () => {
    function Toggle() { const ctx = useTaskLinkColumns(); return <button onClick={() => ctx?.toggle("issue", false)}>Hide</button>; }
    const view = (companyId: string) => <TaskLinksProvider companyId={companyId} tasks={[issue]} collectionKey="tasks"><Toggle /><TaskLinkCells issueId="t1" /></TaskLinksProvider>;
    await render(view("c1")); await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[data-column="source-issue"]')).toBeNull();
    await render(view("c2")); expect(container.querySelector('[data-column="source-issue"]')).toBeTruthy();
    await render(view("c1")); expect(container.querySelector('[data-column="source-issue"]')).toBeNull();
  });
  it("rejects unsafe links, foreign task rows and unrelated internal paths", () => {
    const rows = parseTaskLinks({ tasks: [{ ...links, issue: { label: "bad", url: "javascript:alert(1)" }, pullRequests: [{ label: "#1", url: "https://github.com/org/repo/pull/1", viewPath: "/settings" }] }, { ...links, issueId: "foreign" }] }, ["t1"], plugin);
    expect(rows).toHaveLength(1); expect(rows[0].issue).toBeUndefined(); expect(rows[0].pullRequests?.[0].viewPath).toBeUndefined();
  });
});

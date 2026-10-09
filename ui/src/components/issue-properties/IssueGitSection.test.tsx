// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueGitView } from "@paperclipai/shared";
import { IssueGitSection } from "./IssueGitSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockIssuesApi = vi.hoisted(() => ({
  getGit: vi.fn(),
  linkPullRequest: vi.fn(),
  unlinkPullRequest: vi.fn(),
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
const copyMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copyMock }));

const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const PRODUCT_ID = "77777777-7777-4777-8777-777777777777";

function makeView(overrides: Partial<IssueGitView> = {}): IssueGitView {
  return {
    issueId: ISSUE_ID,
    identifier: "PAP-12",
    branch: { name: "PAP-12-fix-login", command: "git switch -c PAP-12-fix-login", template: "{{issue.identifier}}-{{slug}}", source: "default" },
    pullRequests: [],
    statusAutomation: { enabled: false },
    ...overrides,
  };
}

const openPr = {
  workProductId: PRODUCT_ID,
  provider: "github" as const,
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  title: "Fix login",
  state: "open" as const,
  headRef: "PAP-12-fix-login",
  baseRef: "main",
  closes: true,
  verified: true,
  linkedBy: "head_ref" as const,
  automation: { applied: { from: "todo", to: "in_review", at: "2026-10-09T10:00:00.000Z" }, deferred: null, suspended: null },
  updatedAt: "2026-10-09T10:00:00.000Z",
};

describe("IssueGitSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IssueGitSection issueId={ISSUE_ID} />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const text = () => container.textContent ?? "";
  const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockIssuesApi.getGit.mockResolvedValue(makeView());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the branch name and copies the name and the command", async () => {
    await render();

    expect(text()).toContain("PAP-12-fix-login");
    await act(async () => { byLabel("Copy branch name")!.click(); });
    await act(async () => { byLabel("Copy git command")!.click(); });

    expect(copyMock).toHaveBeenNthCalledWith(1, "PAP-12-fix-login");
    expect(copyMock).toHaveBeenNthCalledWith(2, "git switch -c PAP-12-fix-login");
  });

  it("explains how a pull request gets linked when there is none", async () => {
    await render();

    expect(text()).toContain("No pull requests linked");
    expect(text()).toContain("PAP-12");
  });

  it("lists a linked pull request with its state, closing mode and what automation did", async () => {
    mockIssuesApi.getGit.mockResolvedValue(makeView({ pullRequests: [openPr] }));
    await render();

    const link = container.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/app/pull/7"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("acme/app#7");
    expect(link!.rel).toContain("noopener");
    expect(text()).toContain("Open");
    expect(text()).toContain("Closes");
    expect(text()).toContain("todo");
    expect(text()).toContain("in review");
    expect(text()).not.toContain("Unverified");
  });

  it("labels refs-only, unverified and held pull requests", async () => {
    mockIssuesApi.getGit.mockResolvedValue(makeView({
      pullRequests: [{
        ...openPr, closes: false, verified: false, state: "merged",
        automation: { applied: null, deferred: "active_run", suspended: null },
      }],
    }));
    await render();

    expect(text()).toContain("Refs only");
    expect(text()).toContain("Unverified");
    expect(text()).toContain("Merged");
    expect(text()).toContain("an agent run is active");
  });

  it("links a pull request from a URL, then refreshes", async () => {
    mockIssuesApi.linkPullRequest.mockResolvedValue(makeView({ pullRequests: [openPr] }));
    await render();

    await act(async () => { byLabel("Link a pull request")!.click(); });
    await type(container.querySelector<HTMLInputElement>("input")!, "https://github.com/acme/app/pull/7");
    await act(async () => { container.querySelector<HTMLFormElement>("form")!.requestSubmit(); });

    expect(mockIssuesApi.linkPullRequest).toHaveBeenCalledWith(ISSUE_ID, { url: "https://github.com/acme/app/pull/7" });
    await settle();
    expect(text()).toContain("acme/app#7");
  });

  it("accepts owner/repo#number", async () => {
    mockIssuesApi.linkPullRequest.mockResolvedValue(makeView());
    await render();

    await act(async () => { byLabel("Link a pull request")!.click(); });
    await type(container.querySelector<HTMLInputElement>("input")!, "acme/app#7");
    await act(async () => { container.querySelector<HTMLFormElement>("form")!.requestSubmit(); });

    expect(mockIssuesApi.linkPullRequest).toHaveBeenCalledWith(ISSUE_ID, { repository: "acme/app", number: 7 });
  });

  it("rejects text that is not a pull request without calling the API", async () => {
    await render();

    await act(async () => { byLabel("Link a pull request")!.click(); });
    await type(container.querySelector<HTMLInputElement>("input")!, "hello");
    await act(async () => { container.querySelector<HTMLFormElement>("form")!.requestSubmit(); });

    expect(mockIssuesApi.linkPullRequest).not.toHaveBeenCalled();
    expect(text()).toContain("github.com pull request URL");
  });

  it("shows the server's message when linking fails and keeps the input", async () => {
    mockIssuesApi.linkPullRequest.mockRejectedValue(new Error("Agents can only link pull requests on tasks assigned to them"));
    await render();

    await act(async () => { byLabel("Link a pull request")!.click(); });
    await type(container.querySelector<HTMLInputElement>("input")!, "acme/app#7");
    await act(async () => { container.querySelector<HTMLFormElement>("form")!.requestSubmit(); });
    await settle();

    expect(text()).toContain("Agents can only link pull requests");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("acme/app#7");
  });

  it("unlinks a pull request", async () => {
    mockIssuesApi.getGit.mockResolvedValue(makeView({ pullRequests: [openPr] }));
    mockIssuesApi.unlinkPullRequest.mockResolvedValue(undefined);
    await render();

    await act(async () => { byLabel("Unlink acme/app#7")!.click(); });

    expect(mockIssuesApi.unlinkPullRequest).toHaveBeenCalledWith(ISSUE_ID, PRODUCT_ID);
  });

  it("shows a retry when the git view cannot be loaded", async () => {
    mockIssuesApi.getGit.mockRejectedValueOnce(new Error("boom"));
    await render();

    expect(text()).toContain("Could not load git details");
    mockIssuesApi.getGit.mockResolvedValue(makeView());
    await act(async () => { byLabel("Retry loading git details")!.click(); });
    await settle();

    expect(text()).toContain("PAP-12-fix-login");
  });
});

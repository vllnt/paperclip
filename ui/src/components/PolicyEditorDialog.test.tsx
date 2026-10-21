// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyPolicy } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPolicyPatch, PolicyEditorDialog, type PolicyEditorForm } from "./PolicyEditorDialog";
import { ProjectPoliciesSection } from "./ProjectPoliciesSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const policiesCreateMock = vi.hoisted(() => vi.fn());
const policiesListMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/policies", () => ({
  policiesApi: {
    list: policiesListMock,
    create: policiesCreateMock,
    update: vi.fn(),
    remove: vi.fn(),
    revisions: vi.fn(async () => []),
  },
}));
vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Builder", status: "idle" }]) },
}));
vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => [{ id: "project-1", name: "Website" }]) },
}));
vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: vi.fn(async () => ({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Rae", email: null, image: null } }],
    })),
  },
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("./MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function policy(overrides: Partial<CompanyPolicy> = {}): CompanyPolicy {
  return {
    id: "policy-1",
    companyId: "company-1",
    projectId: null,
    key: "code-review",
    title: "Code review",
    summary: "Every change gets a review.",
    body: "Ask another agent.",
    status: "active",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    documentId: "document-1",
    latestRevisionId: "revision-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-10-21T00:00:00Z"),
    updatedAt: new Date("2026-10-21T00:00:00Z"),
    ...overrides,
  };
}

function form(current: CompanyPolicy, overrides: Partial<PolicyEditorForm> = {}): PolicyEditorForm {
  return {
    title: current.title,
    body: current.body,
    summary: current.summary ?? "",
    status: current.status,
    projectId: current.projectId,
    owner: current.ownerAgentId ? `agent:${current.ownerAgentId}` : current.ownerUserId ? `user:${current.ownerUserId}` : "none",
    changeSummary: "",
    ...overrides,
  };
}

describe("buildPolicyPatch", () => {
  it("sends nothing when nothing changed", () => {
    const current = policy();
    expect(buildPolicyPatch(current, form(current))).toEqual({});
  });

  it("sends the base revision and the change note only with a title or body change", () => {
    const current = policy();
    expect(buildPolicyPatch(current, form(current, { body: "Ask two agents.", changeSummary: " Two reviewers " }))).toEqual({
      body: "Ask two agents.",
      baseRevisionId: "revision-2",
      changeSummary: "Two reviewers",
    });
    expect(buildPolicyPatch(current, form(current, { status: "archived", changeSummary: "Retire" }))).toEqual({
      status: "archived",
    });
  });

  it("clears an emptied summary and moves the policy to a project", () => {
    const current = policy();
    expect(buildPolicyPatch(current, form(current, { summary: "  ", projectId: "project-1" }))).toEqual({
      summary: null,
      projectId: "project-1",
    });
  });

  it("switches the owner between an agent, a person and no owner", () => {
    const current = policy();
    expect(buildPolicyPatch(current, form(current, { owner: "user:user-1" }))).toEqual({ ownerUserId: "user-1" });
    expect(buildPolicyPatch(current, form(current, { owner: "none" }))).toEqual({ ownerAgentId: null, ownerUserId: null });
    const userOwned = policy({ ownerAgentId: null, ownerUserId: "user-1" });
    expect(buildPolicyPatch(userOwned, form(userOwned, { owner: "agent:agent-1" }))).toEqual({ ownerAgentId: "agent-1" });
  });
});

describe("policy editor components", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    policiesCreateMock.mockReset();
    policiesListMock.mockReset();
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    queryClient.clear();
  });

  async function render(node: ReactNode) {
    if (!root) root = createRoot(container);
    await act(() => root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>));
    await flush();
  }

  function button(name: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);
  }

  it("clears a failed save's error when the dialog opens again", async () => {
    policiesCreateMock.mockRejectedValue(new Error('A policy with the key "code-review" already exists'));
    const dialog = (open: boolean, current: CompanyPolicy | null) => (
      <PolicyEditorDialog companyId="company-1" open={open} policy={current} onOpenChange={() => undefined} />
    );

    await render(dialog(true, null));
    const title = document.body.querySelector<HTMLInputElement>("#policy-title")!;
    await act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(title, "Code review");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => button("Create policy")!.click());
    await flush();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("already exists");

    await render(dialog(false, null));
    await render(dialog(true, policy()));
    expect(document.body.textContent).toContain("Edit policy");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("hides New policy on an archived project but still lists its policies", async () => {
    policiesListMock.mockResolvedValue([policy({ projectId: "project-1", key: "release", title: "Release" })]);

    await render(<ProjectPoliciesSection companyId="company-1" projectId="project-1" canCreate={false} />);

    expect(container.textContent).toContain("Release");
    expect(button("New policy")).toBeUndefined();
  });
});

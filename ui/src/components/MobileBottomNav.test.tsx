// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const mockAttentionApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockInboxBadge = vi.hoisted(() => ({ inbox: 0, failedRuns: 0 }));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/dashboard", search: "", hash: "" }),
  NavLink: ({ to, children, className }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className}>
      {typeof children === "function" ? children({ isActive: false }) : children}
    </a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../api/attention", () => ({ attentionApi: mockAttentionApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));

vi.mock("../hooks/useInboxBadge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useInboxBadge")>()),
  useInboxBadge: () => mockInboxBadge,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInboxBadge.inbox = 0;
    mockAttentionApi.list.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  async function renderNav() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MobileBottomNav visible />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function inboxLinks() {
    return [...container.querySelectorAll("a")].filter((anchor) => anchor.getAttribute("href")?.startsWith("/inbox"));
  }

  it("shows one Inbox entry whose badge adds open decisions to the Inbox count", async () => {
    mockInboxBadge.inbox = 2;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableDecisions: true });
    mockAttentionApi.list.mockResolvedValue({
      items: [],
      countsBySourceKind: { decision: 3, approval: 9 },
    });
    const root = await renderNav();

    await vi.waitFor(() => {
      expect(inboxLinks()).toHaveLength(1);
      expect(inboxLinks()[0]?.textContent).toContain("5");
    });
    expect(container.textContent).not.toContain("Decisions");

    flushSync(() => root.unmount());
  });

  it("keeps the Inbox count alone and never polls attention while Decisions is off", async () => {
    mockInboxBadge.inbox = 2;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableDecisions: false });
    const root = await renderNav();

    expect(inboxLinks()).toHaveLength(1);
    expect(inboxLinks()[0]?.textContent).toContain("2");
    expect(mockAttentionApi.list).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });
});

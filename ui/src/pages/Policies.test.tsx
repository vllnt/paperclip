// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { CompanyPolicy } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Policies } from "./Policies";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const policiesListMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("../api/policies", () => ({ policiesApi: { list: policiesListMock } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/PolicyEditorDialog", () => ({
  PolicyEditorDialog: ({ open, policy }: { open: boolean; policy: CompanyPolicy | null }) => (
    <div data-testid="editor">{open ? `open:${policy?.key ?? "new"}` : "closed"}</div>
  ),
}));

function policy(key: string, overrides: Partial<CompanyPolicy> = {}): CompanyPolicy {
  return {
    id: `id-${key}`,
    companyId: "company-1",
    projectId: null,
    key,
    title: key,
    summary: null,
    body: "",
    status: "active",
    ownerAgentId: null,
    ownerUserId: null,
    documentId: "document-1",
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Policies page policy:// deep link", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    policiesListMock.mockResolvedValue([policy("code-review"), policy("old-rule", { status: "archived" })]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAt(url: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[url]}>
            <Policies />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("opens the linked policy, even an archived one, and drops the key from the url", async () => {
    await renderAt("/policies?key=old-rule");

    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe("open:old-rule");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/policies");
  });

  it("leaves the editor closed for a key that names no policy, and still drops the key", async () => {
    await renderAt("/policies?key=missing");

    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe("closed");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/policies");
  });

  it("opens nothing without a key", async () => {
    await renderAt("/policies");

    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe("closed");
  });
});

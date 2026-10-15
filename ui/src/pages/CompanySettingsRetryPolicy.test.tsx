// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const SELECTED_COMPANY = {
  id: "company-1",
  name: "Acme Robotics",
  description: null,
  status: "active",
  issuePrefix: "ACM",
  brandColor: null,
  logoUrl: null,
  attachmentMaxBytes: null,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
  transientRetryPolicy: {},
};

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadCompanyLogo: vi.fn() } }));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [SELECTED_COMPANY],
    selectedCompany: SELECTED_COMPANY,
    selectedCompanyId: SELECTED_COMPANY.id,
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));
vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanySettings transient retry policy", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps a just-entered rate when suppression is toggled before the first save returns", async () => {
    const releases: Array<() => void> = [];
    mockCompaniesApi.update.mockImplementation(
      (_id: string, data: unknown) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ...SELECTED_COMPANY, ...(data as object) }));
        }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: null });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="company-settings-transient-retry-input"]',
    )!;
    const checkbox = container.querySelector<HTMLInputElement>(
      '[data-testid="company-settings-transient-retry-suppress-blocked"]',
    )!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => {
      checkbox.click();
    });

    // Saves are serialized: the second waits for the first.
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", {
      transientRetryPolicy: { perIssuePerHour: 5 },
    });

    await act(async () => {
      releases[0]();
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(2);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", {
      transientRetryPolicy: { perIssuePerHour: 5, suppressWhenBlocked: true },
    });

    await act(async () => {
      releases[1]();
    });
    await act(async () => root.unmount());
  });
});

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
const OTHER_COMPANY = { ...SELECTED_COMPANY, id: "company-2", name: "Beta", issuePrefix: "BET" };
const companyState = vi.hoisted(() => ({ selectedId: "company-1" }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => {
    const companies = [SELECTED_COMPANY, OTHER_COMPANY];
    const selectedCompany = companies.find((company) => company.id === companyState.selectedId)!;
    return {
      companies,
      selectedCompany,
      selectedCompanyId: selectedCompany.id,
      setSelectedCompanyId: vi.fn(),
    };
  },
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
    companyState.selectedId = "company-1";
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

  function renderSettings() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: null });
    const root = createRoot(container);
    const render = () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    return { root, render };
  }

  const rateInput = () =>
    container.querySelector<HTMLInputElement>('[data-testid="company-settings-transient-retry-input"]')!;
  const suppressBox = () =>
    container.querySelector<HTMLInputElement>('[data-testid="company-settings-transient-retry-suppress-blocked"]')!;
  async function enterRate(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(rateInput(), value);
      rateInput().dispatchEvent(new Event("input", { bubbles: true }));
      rateInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  }

  it("sends a queued save to the company it was edited on after switching companies", async () => {
    const releases: Array<() => void> = [];
    mockCompaniesApi.update.mockImplementation(
      (id: string, data: unknown) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ...SELECTED_COMPANY, id, ...(data as object) }));
        }),
    );
    const { root, render } = renderSettings();
    await act(async () => render());

    await enterRate("5");
    await act(async () => {
      suppressBox().click();
    });
    companyState.selectedId = "company-2";
    await act(async () => render());
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

  it("keeps newer queued edits when an earlier save fails", async () => {
    const settlers: Array<{ ok: () => void; fail: () => void }> = [];
    mockCompaniesApi.update.mockImplementation(
      (_id: string, data: unknown) =>
        new Promise((resolve, reject) => {
          settlers.push({
            ok: () => resolve({ ...SELECTED_COMPANY, ...(data as object) }),
            fail: () => reject(new Error("offline")),
          });
        }),
    );
    const { root, render } = renderSettings();
    await act(async () => render());

    await enterRate("5");
    await act(async () => {
      suppressBox().click();
    });
    await act(async () => {
      settlers[0].fail();
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(2);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", {
      transientRetryPolicy: { suppressWhenBlocked: true },
    });

    await enterRate("6");
    await act(async () => {
      settlers[1].ok();
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(3);
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", {
      transientRetryPolicy: { suppressWhenBlocked: true, perIssuePerHour: 6 },
    });

    await act(async () => {
      settlers[2].ok();
    });
    await act(async () => root.unmount());
  });

  it("clears the save error once a later save succeeds", async () => {
    const settlers: Array<{ ok: () => void; fail: () => void }> = [];
    mockCompaniesApi.update.mockImplementation(
      (_id: string, data: unknown) =>
        new Promise((resolve, reject) => {
          settlers.push({
            ok: () => resolve({ ...SELECTED_COMPANY, ...(data as object) }),
            fail: () => reject(new Error("Rate save failed")),
          });
        }),
    );
    const { root, render } = renderSettings();
    await act(async () => render());

    await enterRate("5");
    await enterRate("6");
    await act(async () => {
      settlers[0].fail();
    });
    expect(container.textContent).toContain("Rate save failed");

    await act(async () => {
      settlers[1].ok();
    });
    expect(container.textContent).not.toContain("Rate save failed");
    expect(mockCompaniesApi.update).toHaveBeenLastCalledWith("company-1", {
      transientRetryPolicy: { perIssuePerHour: 6 },
    });
    await act(async () => root.unmount());
  });
});

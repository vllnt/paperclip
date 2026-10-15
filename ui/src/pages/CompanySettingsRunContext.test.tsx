// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
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

const SAVE_TEST_ID = "company-settings-run-context-save";
const MAX_COMMENTS_TEST_ID = "company-settings-run-context-base-maxComments";

describe("CompanySettings run context save", () => {
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

  function byTestId<T extends HTMLElement>(testId: string): T | null {
    return container.querySelector<T>(`[data-testid="${testId}"]`);
  }

  async function editMaxComments(value: string) {
    const input = byTestId<HTMLInputElement>(MAX_COMMENTS_TEST_ID);
    if (!input) throw new Error("max comments input missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  }

  it("keeps an edit made while the save is pending", async () => {
    let resolveSave: (company: typeof SELECTED_COMPANY) => void = () => {};
    mockCompaniesApi.update.mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    await editMaxComments("30");
    await act(async () => {
      byTestId<HTMLButtonElement>(SAVE_TEST_ID)?.click();
    });
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", {
      runContextPolicy: { maxComments: 30 },
    });

    await editMaxComments("40");
    await act(async () => {
      resolveSave(SELECTED_COMPANY);
    });

    expect(byTestId(SAVE_TEST_ID)).not.toBeNull();
    expect(byTestId<HTMLInputElement>(MAX_COMMENTS_TEST_ID)?.value).toBe("40");

    await act(async () => root.unmount());
  });

  it("clears the draft when nothing changed during the save", async () => {
    mockCompaniesApi.update.mockResolvedValue(SELECTED_COMPANY);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    await editMaxComments("30");
    await act(async () => {
      byTestId<HTMLButtonElement>(SAVE_TEST_ID)?.click();
    });

    expect(byTestId(SAVE_TEST_ID)).toBeNull();

    await act(async () => root.unmount());
  });
});

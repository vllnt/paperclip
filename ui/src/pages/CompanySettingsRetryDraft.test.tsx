// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { CompanyProvider, useCompany } from "@/context/CompanyContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const INPUT = '[data-testid="company-settings-transient-retry-input"]';
const companies = ["a", "b"].map((id) => ({
  id,
  name: id.toUpperCase(),
  status: "active",
  issuePrefix: id.toUpperCase().repeat(3),
  transientRetryPolicy: {},
}));

let selectCompany: (id: string) => void = () => {};
function Harness() {
  selectCompany = useCompany().setSelectedCompanyId;
  return <CompanySettings />;
}

describe("CompanySettings retry input with the real CompanyProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("does not carry one company's unsaved draft into another company", async () => {
    const patches: string[] = [];
    const releases: Array<() => void> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(url);
        return new Promise<Response>((resolve) =>
          releases.push(() => resolve(new Response(init.body as string, { status: 200 }))),
        );
      }
      if (url.includes("/companies")) return new Response(JSON.stringify(companies), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    qc.setQueryData(queryKeys.auth.session, { user: { id: "user" } });
    qc.setQueryData(queryKeys.companies.list("user"), { companies, unauthorized: false });
    qc.setQueryData(queryKeys.health, { status: "ok", cloud: null });
    qc.setQueryData(queryKeys.instance.generalSettings, {});
    localStorage.setItem("paperclip.selectedCompanyId", "a");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <CompanyProvider>
            <BreadcrumbProvider>
              <TooltipProvider>
                <MemoryRouter>
                  <Harness />
                </MemoryRouter>
              </TooltipProvider>
            </BreadcrumbProvider>
          </CompanyProvider>
        </QueryClientProvider>,
      ),
    );

    const first = container.querySelector<HTMLInputElement>(INPUT)!;
    await act(async () => {
      first.value = "5";
      first.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => selectCompany("b"));

    const second = container.querySelector<HTMLInputElement>(INPUT)!;
    const draft = second.value;
    await act(async () => second.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await act(async () => releases.forEach((release) => release()));
    await act(async () => root.unmount());
    qc.clear();

    expect(draft).toBe("0");
    expect(patches).toEqual(["/api/companies/a"]);
  });
});

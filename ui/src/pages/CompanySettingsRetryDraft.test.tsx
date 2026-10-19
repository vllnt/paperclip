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

const ERROR = '[data-testid="company-settings-transient-retry-error"]';
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

async function mount(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  initialCompanies = companies,
) {
  vi.stubGlobal("fetch", fetchImpl);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  qc.setQueryData(queryKeys.auth.session, { user: { id: "user" } });
  qc.setQueryData(queryKeys.companies.list("user"), { companies: initialCompanies, unauthorized: false });
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
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      qc.clear();
    },
  };
}

const readResponse = (url: string) =>
  new Response(url.includes("/companies") ? JSON.stringify(companies) : "{}", { status: 200 });

const blur = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
};

async function flushMutation(action: () => void) {
  await act(async () => action());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountRunContext() {
  const savedCompanies = companies.map((company) => ({
    ...company,
    runContextPolicy: { maxComments: 8 },
  }));
  const patches: Array<{ url: string; body: unknown }> = [];
  let finishSave: (error?: string) => void = () => { throw new Error("No pending save"); };
  const view = await mount(async (url, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(init.body as string);
      patches.push({ url, body });
      return new Promise<Response>((resolve) => {
        finishSave = (error) => {
          if (error) {
            resolve(new Response(JSON.stringify({ error }), { status: 500 }));
            return;
          }
          const company = savedCompanies.find((entry) => url === `/api/companies/${entry.id}`)!;
          Object.assign(company, body);
          resolve(new Response(JSON.stringify(company), { status: 200 }));
        };
      });
    }
    return new Response(url.includes("/companies") ? JSON.stringify(savedCompanies) : "{}", { status: 200 });
  }, savedCompanies);
  return {
    ...view,
    patches,
    finishSave: (error?: string) => finishSave(error),
    input: () => view.container.querySelector<HTMLInputElement>('[data-testid="company-settings-run-context-base-maxComments"]')!,
    save: () => view.container.querySelector<HTMLButtonElement>('[data-testid="company-settings-run-context-save"]'),
  };
}

describe("CompanySettings drafts with the real CompanyProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("does not carry one company's unsaved draft into another company", async () => {
    const patches: string[] = [];
    const releases: Array<() => void> = [];
    const { container, cleanup } = await mount(async (url, init) => {
      if (init?.method === "PATCH") {
        patches.push(url);
        return new Promise<Response>((resolve) =>
          releases.push(() => resolve(new Response(init.body as string, { status: 200 }))),
        );
      }
      if (url.includes("/companies")) return new Response(JSON.stringify(companies), { status: 200 });
      return readResponse(url);
    });

    await act(async () => blur(container.querySelector<HTMLInputElement>(INPUT)!, "5"));
    await act(async () => selectCompany("b"));

    const second = container.querySelector<HTMLInputElement>(INPUT)!;
    const draft = second.value;
    await act(async () => second.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await act(async () => releases.forEach((release) => release()));
    await cleanup();

    expect(draft).toBe("0");
    expect(patches).toEqual(["/api/companies/a"]);
  });

  it("shows a company-scoped error and reverts the input when the retry save fails", async () => {
    const { container, cleanup } = await mount(async (url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "Retry policy save failed" }), { status: 500 });
      }
      return readResponse(url);
    });

    await act(async () => blur(container.querySelector<HTMLInputElement>(INPUT)!, "5"));
    await act(async () => {});
    const afterFailure = {
      value: container.querySelector<HTMLInputElement>(INPUT)!.value,
      error: container.querySelector(ERROR)?.textContent,
    };
    await act(async () => selectCompany("b"));
    const otherCompanyError = container.querySelector(ERROR);
    await act(async () => selectCompany("a"));
    const backOnA = container.querySelector(ERROR)?.textContent;
    await cleanup();

    expect(afterFailure).toEqual({ value: "0", error: "Retry policy save failed" });
    expect(otherCompanyError).toBeNull();
    expect(backOnA).toBe("Retry policy save failed");
  });

  it("clears the retry error when the next edit starts", async () => {
    let fail = true;
    const { container, cleanup } = await mount(async (url, init) => {
      if (init?.method === "PATCH") {
        return fail
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
          : new Response(init.body as string, { status: 200 });
      }
      return readResponse(url);
    });

    await act(async () => blur(container.querySelector<HTMLInputElement>(INPUT)!, "5"));
    await act(async () => {});
    const shown = container.querySelector(ERROR) !== null;
    fail = false;
    await act(async () => blur(container.querySelector<HTMLInputElement>(INPUT)!, "3"));
    await act(async () => {});
    const after = container.querySelector(ERROR);
    await cleanup();

    expect(shown).toBe(true);
    expect(after).toBeNull();
  });

  it("shows an error when the hiring approval toggle fails to save", async () => {
    const { container, cleanup } = await mount(async (url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "Hiring save failed" }), { status: 500 });
      }
      return readResponse(url);
    });

    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-testid="company-settings-team-approval-toggle"]')!
        .click(),
    );
    await act(async () => {});
    const section = container.querySelector('[data-testid="company-settings-team-section"]')!;
    const text = section.textContent;
    await act(async () => selectCompany("b"));
    const other = container.querySelector('[data-testid="company-settings-team-section"]')!.textContent;
    await cleanup();

    expect(text).toContain("Hiring save failed");
    expect(other).not.toContain("Hiring save failed");
  });

  it("keeps run-context drafts and save payloads owned by their company", async () => {
    const view = await mountRunContext();
    try {
      await act(async () => blur(view.input(), "30"));
      await act(async () => selectCompany("b"));
      expect(view.input().value).toBe("8");
      expect(view.save()).toBeNull();

      await act(async () => blur(view.input(), "40"));
      await flushMutation(() => view.save()!.click());
      expect(view.patches).toEqual([{ url: "/api/companies/b", body: { runContextPolicy: { maxComments: 40 } } }]);
      await flushMutation(() => view.finishSave());
      expect(view.input().value).toBe("40");
      expect(view.save()).toBeNull();

      await act(async () => selectCompany("a"));
      expect(view.input().value).toBe("30");
      await flushMutation(() => view.save()!.click());
      expect(view.patches[1]).toEqual({ url: "/api/companies/a", body: { runContextPolicy: { maxComments: 30 } } });
      await flushMutation(() => view.finishSave());
      expect(view.save()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it.each([undefined, "Run context save failed"])(
    "preserves B's draft when A's pending save finishes with %s",
    async (error) => {
      const view = await mountRunContext();
      try {
        await act(async () => selectCompany("b"));
        // Clearing the policy is also a draft and must survive A's save.
        await act(async () => blur(view.input(), ""));
        await act(async () => selectCompany("a"));
        await act(async () => blur(view.input(), "30"));
        await flushMutation(() => view.save()!.click());
        expect(view.input().matches(":disabled")).toBe(true);
        await act(async () => selectCompany("b"));
        await flushMutation(() => view.finishSave(error));

        expect(view.input().value).toBe("");
        expect(view.save()?.disabled).toBe(false);
        expect(view.container.textContent).not.toContain("Run context save failed");
        await act(async () => selectCompany("a"));
        expect(view.input().value).toBe("30");
        if (error) {
          expect(view.container.textContent).toContain(error);
          expect(view.save()?.disabled).toBe(false);
          await flushMutation(() => view.save()!.click());
          await flushMutation(() => view.finishSave());
        }
        expect(view.save()).toBeNull();

        await act(async () => selectCompany("b"));
        await flushMutation(() => view.save()!.click());
        expect(view.patches.at(-1)).toEqual({ url: "/api/companies/b", body: { runContextPolicy: null } });
        await flushMutation(() => view.finishSave());
        expect(view.save()).toBeNull();
      } finally {
        await view.cleanup();
      }
    },
  );

  it("does not reuse focused run-context input across companies with the same saved policy", async () => {
    const view = await mountRunContext();
    try {
      await act(async () => {
        view.input().focus();
        view.input().value = "30";
      });
      await act(async () => selectCompany("b"));
      expect(view.input().value).toBe("8");
      expect(view.save()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});

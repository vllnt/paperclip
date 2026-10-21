// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { ThemeProvider } from "../context/ThemeContext";
import { ToastProvider } from "../context/ToastContext";

const COMPANY_ID = "company-1";
const ROUTINE_ID = "routine-1";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, issuePrefix: "ACM" } }),
  useOptionalCompany: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A routine as the server returns it, with every optional field at its stored shape.
function routineFixture(overrides: Record<string, unknown>) {
  return {
    id: ROUTINE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: "Nightly sweep",
    description: null,
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    steps: [],
    env: null,
    automationWakeSettings: {},
    runContextPolicy: null,
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    project: null,
    assignee: null,
    parentIssue: null,
    triggers: [],
    recentRuns: [],
    activeIssue: null,
    ...overrides,
  };
}

function createFetchStub(routine: Record<string, unknown>) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/routines/${ROUTINE_ID}`) return json(routine);
    if (url.includes("/experimental")) return json({ enableStreamlinedUi: true });
    return json([]);
  });
}

const VARIANTS = [
  { name: "streamlined", load: async () => (await import("./RoutineDetail")).RoutineDetail },
  { name: "production", load: async () => (await import("./RoutineDetail.production")).RoutineDetail },
];

// The stored description or step description is what the user wrote; the rich editor spells some of
// it differently on import (a `-` list becomes `*`), which must not read as an edit.
const BULLETS = "- first\n- second";

const ROUTINES: Array<{ name: string; routine: Record<string, unknown>; sections: string[] }> = [
  { name: "no description and no steps", routine: routineFixture({}), sections: ["overview"] },
  {
    name: "a plain description",
    routine: routineFixture({ description: "Check the queue." }),
    sections: ["overview"],
  },
  {
    name: "a description with a dash list",
    routine: routineFixture({ description: BULLETS }),
    sections: ["overview"],
  },
  {
    name: "a description with an asterisk list",
    routine: routineFixture({ description: "* first\n* second" }),
    sections: ["overview"],
  },
  {
    name: "a description with angle brackets",
    routine: routineFixture({ description: "Use <name> as the owner." }),
    sections: ["overview"],
  },
  {
    name: "a template variable",
    routine: routineFixture({
      description: "Sweep {{region}} now.",
      variables: [
        { name: "region", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ],
    }),
    sections: ["overview"],
  },
  {
    name: "steps with a dash list in their description",
    routine: routineFixture({
      steps: [
        { key: "step-1", title: "Collect", description: BULLETS, after: [] },
        { key: "step-2", title: "Report", description: "Write the **report**.", after: ["step-1"] },
      ],
    }),
    sections: ["overview", "steps"],
  },
];

describe.each(VARIANTS)("RoutineDetail opens clean ($name)", ({ load }) => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  // The first dynamic import of a page transforms its whole module graph; keep that out of the test timeout.
  beforeAll(async () => {
    await load();
  }, 60_000);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  async function render(routine: Record<string, unknown>, section: string) {
    vi.stubGlobal("fetch", createFetchStub(routine));
    const RoutineDetail = await load();
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <TooltipProvider>
              <ToastProvider>
                <BreadcrumbProvider>
                  <MemoryRouter initialEntries={[`/routines/${ROUTINE_ID}/${section}`]}>
                    <Routes>
                      <Route path="/routines/:routineId/:section" element={<RoutineDetail />} />
                    </Routes>
                  </MemoryRouter>
                </BreadcrumbProvider>
              </ToastProvider>
            </TooltipProvider>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
    const edit = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Edit routine"),
    );
    if (edit) {
      await act(async () => edit.click());
      await settle();
    }
  }

  for (const { name, routine, sections } of ROUTINES) {
    for (const section of sections) {
      it(`shows no unsaved change on open with ${name} (${section})`, async () => {
        await render(routine, section);
        expect(container.textContent ?? "").toContain("Nightly sweep");
        expect(container.textContent ?? "").not.toMatch(/unsaved change/);
      });
    }
  }
});

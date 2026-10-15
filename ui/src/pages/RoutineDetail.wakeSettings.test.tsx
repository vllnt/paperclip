// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { ToastProvider } from "../context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-1";
const ROUTINE_ID = "routine-1";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, issuePrefix: "ACM" } }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type WakeSettings = { minSecondsBetweenAutomationWakes?: number };

// An in-memory routines backend behind `fetch`: the real API client and page run unchanged.
function createBackend(initialWake: WakeSettings) {
  const state = { wake: initialWake, title: "Nightly sweep", revision: 1, patches: [] as Array<Record<string, unknown>> };
  const routine = () => ({
    id: ROUTINE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: state.title,
    description: null,
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
    automationWakeSettings: state.wake,
    latestRevisionId: `revision-${state.revision}`,
    latestRevisionNumber: state.revision,
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
  });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `/api/routines/${ROUTINE_ID}` && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.patches.push(body);
      // Mirrors the server: a wake-settings edit based on a stale value is a conflict.
      if (
        body.baseAutomationWakeSettings !== undefined &&
        JSON.stringify(body.baseAutomationWakeSettings) !== JSON.stringify(state.wake)
      ) {
        return new Response(JSON.stringify({ error: "Routine automation wake settings were updated by someone else" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (typeof body.title === "string") state.title = body.title;
      if (body.automationWakeSettings) state.wake = body.automationWakeSettings as WakeSettings;
      state.revision += 1;
      return json(routine());
    }
    if (url === `/api/routines/${ROUTINE_ID}`) return json(routine());
    if (url.includes("/experimental")) return json({ enableStreamlinedUi: true });
    return json([]);
  });
  return { state, fetchStub };
}

const VARIANTS = [
  { name: "streamlined", load: async () => (await import("./RoutineDetail")).RoutineDetail },
  { name: "production", load: async () => (await import("./RoutineDetail.production")).RoutineDetail },
];

describe.each(VARIANTS)("RoutineDetail wake settings save ($name)", ({ load }) => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

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

  async function render(backend: ReturnType<typeof createBackend>, section = "overview") {
    vi.stubGlobal("fetch", backend.fetchStub);
    const RoutineDetail = await load();
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ToastProvider>
              <BreadcrumbProvider>
                <MemoryRouter initialEntries={[`/routines/${ROUTINE_ID}/${section}`]}>
                  <Routes>
                    <Route path="/routines/:routineId" element={<RoutineDetail />} />
                    <Route path="/routines/:routineId/:section" element={<RoutineDetail />} />
                    <Route path="/:companyPrefix/routines/:routineId" element={<RoutineDetail />} />
                    <Route path="/:companyPrefix/routines/:routineId/:section" element={<RoutineDetail />} />
                  </Routes>
                </MemoryRouter>
              </BreadcrumbProvider>
            </ToastProvider>
          </TooltipProvider>
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

  function setField(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function editTitle(value: string) {
    const title = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Routine title"]')
      ?? container.querySelector<HTMLInputElement>('input[placeholder="Routine title"]');
    expect(title).not.toBeNull();
    await act(async () => setField(title!, value));
  }

  async function editWindow(value: string) {
    const input = container.querySelector<HTMLInputElement>("#routine-automation-wake-window");
    expect(input).not.toBeNull();
    await act(async () => setField(input!, value));
  }

  async function refetchRoutine() {
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(ROUTINE_ID) });
    });
    await settle();
  }

  async function save() {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    });
    await settle();
  }

  it("does not resend stale wake settings when only the title was edited", async () => {
    const backend = createBackend({});
    await render(backend);
    await editTitle("Renamed sweep");
    // Someone else sets a window while this edit is open; the refetch keeps the dirty draft.
    backend.state.wake = { minSecondsBetweenAutomationWakes: 600 };
    await refetchRoutine();
    await save();

    expect(backend.state.patches).toHaveLength(1);
    expect(backend.state.patches[0]).toMatchObject({ title: "Renamed sweep" });
    expect(backend.state.patches[0]).not.toHaveProperty("automationWakeSettings");
    expect(backend.state.patches[0]).not.toHaveProperty("baseAutomationWakeSettings");
    expect(backend.state.wake).toEqual({ minSecondsBetweenAutomationWakes: 600 });
  });

  it("sends the original edit base with an edited window, not the refetched value", async () => {
    const backend = createBackend({});
    await render(backend, "delivery");
    await editWindow("300");
    backend.state.wake = { minSecondsBetweenAutomationWakes: 600 };
    await refetchRoutine();
    await save();

    expect(backend.state.patches).toHaveLength(1);
    expect(backend.state.patches[0]).toMatchObject({
      automationWakeSettings: { minSecondsBetweenAutomationWakes: 300 },
      baseAutomationWakeSettings: {},
    });
  });

  it("uses the saved settings as the base of the next save", async () => {
    const backend = createBackend({});
    await render(backend, "delivery");
    await editWindow("300");
    await save();
    await editWindow("120");
    await save();

    expect(backend.state.patches).toHaveLength(2);
    expect(backend.state.patches[1]).toMatchObject({
      automationWakeSettings: { minSecondsBetweenAutomationWakes: 120 },
      baseAutomationWakeSettings: { minSecondsBetweenAutomationWakes: 300 },
    });
  });

  async function clickButton(label: string, scope: ParentNode = document) {
    const button = Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
    await settle();
  }

  // Someone else changed the window while this edit was open and the editor refetched.
  async function openStaleWindowEdit(backend: ReturnType<typeof createBackend>) {
    await render(backend, "delivery");
    await editWindow("300");
    backend.state.wake = { minSecondsBetweenAutomationWakes: 600 };
    await refetchRoutine();
  }

  it("rebases on the latest settings after a conflict and Reload latest", async () => {
    const backend = createBackend({});
    await openStaleWindowEdit(backend);
    await save();
    expect(backend.state.patches).toHaveLength(1);
    expect(backend.state.wake).toEqual({ minSecondsBetweenAutomationWakes: 600 });

    await clickButton("Reload latest");
    expect(container.querySelector<HTMLInputElement>("#routine-automation-wake-window")?.value).toBe("600");
    await editWindow("120");
    await save();

    expect(backend.state.patches).toHaveLength(2);
    expect(backend.state.patches[1]).toMatchObject({
      automationWakeSettings: { minSecondsBetweenAutomationWakes: 120 },
      baseAutomationWakeSettings: { minSecondsBetweenAutomationWakes: 600 },
    });
    expect(backend.state.wake).toEqual({ minSecondsBetweenAutomationWakes: 120 });
  });

  it("does not report phantom wake-settings edits after Discard", async () => {
    const backend = createBackend({});
    await openStaleWindowEdit(backend);
    await clickButton("Discard");
    await clickButton("Discard changes");

    const labels = Array.from(document.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(labels.some((label) => label?.startsWith("Save changes"))).toBe(false);
    expect(container.querySelector<HTMLInputElement>("#routine-automation-wake-window")?.value).toBe("600");
  });

  it("does not report phantom wake-settings edits after Discard on the History tab", async () => {
    const backend = createBackend({});
    await openStaleWindowEdit(backend);
    const historyLink = Array.from(document.querySelectorAll("a, button")).find(
      (candidate) => candidate.textContent?.trim() === "History",
    );
    expect(historyLink).toBeDefined();
    await act(async () => (historyLink as HTMLElement).click());
    await settle();
    await clickButton("Discard changes");

    const labels = Array.from(document.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(labels).not.toContain("Discard changes");
    expect(labels.some((label) => label?.startsWith("Save changes"))).toBe(false);
  });
});

// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineDetailContext, type RoutineDetailContextValue } from "@/components/routine-sections/context";
import { RoutineTriggers } from "./RoutineTriggers";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  listSources: vi.fn(),
}));
const params = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock("@/api/routines", () => ({
  routinesApi: {
    get: api.get,
    createTrigger: api.createTrigger,
    updateTrigger: api.updateTrigger,
    deleteTrigger: api.deleteTrigger,
  },
}));
vi.mock("@/api/eventSources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/eventSources")>()),
  eventSourcesApi: { list: api.listSources },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useSearchParams: () => [
    params.current,
    (next: Record<string, string>) => {
      params.current = new URLSearchParams(next);
    },
  ],
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: () => {} }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_ID = "3f0c5f6e-0000-4000-8000-000000000001";
const eventTrigger = {
  id: "t-event",
  routineId: "routine-1",
  kind: "event",
  enabled: true,
  setupPending: false,
  label: null,
  eventSourceId: SOURCE_ID,
  eventMatch: { types: ["disk.*"], minSeverity: "warning" },
  eventGrouping: {
    groupKey: "{{source}}:{{dedupeKey}}",
    repeatCommentCooldownSec: 900,
    rewakeOnSeverityIncrease: true,
    onRecovery: "comment_and_wake",
    issueMode: "group",
  },
  fallback: false,
};
const routine = {
  id: "routine-1",
  companyId: "company-1",
  title: "Handle alerts",
  status: "active",
  triggers: [eventTrigger],
};

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(routineOverride: Record<string, unknown> = routine) {
  api.get.mockResolvedValue(routineOverride);
  const context = { routine: routineOverride, routineId: "routine-1", companyId: "company-1" } as unknown as RoutineDetailContextValue;
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RoutineDetailContext.Provider value={context}>
          <RoutineTriggers />
        </RoutineDetailContext.Provider>
      </QueryClientProvider>,
    ),
  );
  await flush();
  await flush();
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}"`);
  return match as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  await act(async () => {
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function field(label: string) {
  const match = [...container.querySelectorAll("label")].find((item) => item.textContent?.trim() === label);
  return container.querySelector(`[id="${CSS.escape(match!.htmlFor)}"]`) as HTMLInputElement | HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  params.current = new URLSearchParams();
  api.listSources.mockResolvedValue([
    { id: SOURCE_ID, name: "Gatus", enabled: true, archived: false },
  ]);
  api.createTrigger.mockResolvedValue({ trigger: { id: "t-new" } });
  api.updateTrigger.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("Event triggers on the routine page", () => {
  it("shows an event trigger with its source and what it listens for", async () => {
    await render();
    const card = container.querySelector('section[aria-label="Event trigger"]')!;
    expect(card.textContent).toContain("Event · Gatus");
    expect(card.textContent).toContain("disk.* · Warning and above");
    expect(api.listSources).toHaveBeenCalledWith("company-1");
  });

  it("edits an event trigger and saves the full match and grouping", async () => {
    await render();
    await click(button("Edit event"));
    expect((field("Event source") as HTMLSelectElement).value).toBe(SOURCE_ID);
    expect((field("Group key") as HTMLInputElement).value).toBe("{{source}}:{{dedupeKey}}");

    await setValue(field("Group key") as HTMLInputElement, "{{source}}:{{labels.host_id}}:{{dedupeKey}}");
    await setValue(field("Repeat comment cooldown (minutes)") as HTMLInputElement, "30");
    await click(button("Save event trigger"));

    expect(api.updateTrigger).toHaveBeenCalledWith("t-event", {
      eventSourceId: SOURCE_ID,
      eventMatch: { types: ["disk.*"], minSeverity: "warning" },
      eventGrouping: {
        groupKey: "{{source}}:{{labels.host_id}}:{{dedupeKey}}",
        repeatCommentCooldownSec: 1800,
        rewakeOnSeverityIncrease: true,
        onRecovery: "comment_and_wake",
        issueMode: "group",
      },
      fallback: false,
    });
  });

  it("does not save an event trigger with an unknown groupKey placeholder", async () => {
    await render();
    await click(button("Edit event"));
    await setValue(field("Group key") as HTMLInputElement, "{{nope}}");
    await click(button("Save event trigger"));
    expect(api.updateTrigger).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("{{nope}}");
  });

  it("creates an event trigger from the wizard", async () => {
    params.current = new URLSearchParams("triggerSetup=new");
    await render({ ...routine, triggers: [] });

    const kind = [...container.querySelectorAll<HTMLInputElement>('input[name="trigger-kind"]')].at(-1)!;
    await click(kind);
    await click(button("Continue"));
    await setValue(field("Event source") as HTMLSelectElement, SOURCE_ID);
    await click(button("Continue"));
    await click(button("Add event trigger"));

    expect(api.createTrigger).toHaveBeenCalledWith("routine-1", {
      kind: "event",
      eventSourceId: SOURCE_ID,
      eventMatch: {},
      eventGrouping: {
        groupKey: "{{source}}:{{dedupeKey}}",
        repeatCommentCooldownSec: 900,
        rewakeOnSeverityIncrease: true,
        onRecovery: "comment_and_wake",
        issueMode: "group",
      },
      fallback: false,
    });
  });
});

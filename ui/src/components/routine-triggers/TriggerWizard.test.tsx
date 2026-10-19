// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventSource } from "@/api/eventSources";
import type { EventSourcesState } from "./EventTriggerFields";
import {
  defaultTriggerDraft,
  RoutineTriggerWizard,
  webhookAgentInstructions,
  type TriggerDraft,
} from "./TriggerWizard";

const { setBreadcrumbs } = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: () => {} }) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("offers the shared app flow without a Fireflies-specific sender", async () => {
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook" }} routineTitle="Process meetings" routineId="routine-1" onSaveExit={() => {}} onFinish={() => {}} />));
  expect(container.textContent).toContain("Another app or script");
  expect(container.textContent).not.toContain("Fireflies");
  expect(container.textContent).toContain("publicly reachable HTTPS");
});

it("resumes generic setup with a signing secret and preserves the draft", async () => {
  const onSaveExit = vi.fn();
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook", created: true, step: 1, availableStep: 1 }} routineTitle="Process meetings" routineId="routine-1" webhookUrl="https://paperclip.example/api/routine-triggers/public/test/fire" webhookSecret="test-signing-secret" onSaveExit={onSaveExit} onFinish={() => {}} />));
  expect(container.textContent).toContain("Secret key");
  expect(container.textContent).toContain("signing secret field");
  expect(container.textContent).not.toContain("Fireflies");
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save & exit"))!;
  await act(async () => save.click());
  expect(onSaveExit).toHaveBeenCalledWith(expect.objectContaining({ sender: "custom", step: 1, created: true }));
});

it("explains both supported app authentication methods", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "signing-secret");
  expect(instructions).toContain("Secret key: signing-secret");
  expect(instructions).toContain("X-Hub-Signature");
  expect(instructions).toContain("Authorization: Bearer signing-secret");
  expect(instructions).toContain("They do not start the routine");
  expect(instructions).not.toContain("Fireflies");
});

it("keeps legacy bearer setup instructions accurate", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "secret", true, "bearer");
  expect(instructions).toContain("Authorization: Bearer secret");
  expect(instructions).not.toContain("HMAC-SHA256");
});

// --- Event trigger kind ---------------------------------------------------

const SOURCE_ID = "3f0c5f6e-0000-4000-8000-000000000001";
const eventSources: EventSourcesState = {
  status: "ready",
  sources: [
    {
      id: SOURCE_ID,
      name: "Gatus",
      enabled: true,
      archived: false,
    } as EventSource,
  ],
};

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}"`);
  return match as HTMLButtonElement;
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
  if (!match?.htmlFor) throw new Error(`No field "${label}"`);
  return container.querySelector(`[id="${CSS.escape(match.htmlFor)}"]`) as HTMLInputElement | HTMLSelectElement;
}

async function renderEvent(overrides: Partial<TriggerDraft> = {}, props: Record<string, unknown> = {}) {
  const onFinish = vi.fn();
  const onSaveExit = vi.fn();
  await act(async () =>
    root.render(
      <RoutineTriggerWizard
        initialDraft={{ ...defaultTriggerDraft, kind: "event", ...overrides }}
        routineTitle="Handle alerts"
        routineId="routine-1"
        eventSources={eventSources}
        onSaveExit={onSaveExit}
        onFinish={onFinish}
        {...props}
      />,
    ),
  );
  return { onFinish, onSaveExit };
}

it("offers an Event trigger kind and starts its own flow", async () => {
  await act(async () =>
    root.render(
      <RoutineTriggerWizard
        initialDraft={defaultTriggerDraft}
        routineTitle="Handle alerts"
        routineId="routine-1"
        eventSources={eventSources}
        onSaveExit={() => {}}
        onFinish={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("When a monitoring alert arrives");

  const radio = [...container.querySelectorAll<HTMLInputElement>('input[name="trigger-kind"]')].at(-1)!;
  await act(async () => radio.click());
  await act(async () => button("Continue").click());

  expect(container.textContent).toContain("Choose which events to react to");
  expect(container.textContent).toContain("Match events");
  expect(container.textContent).toContain("Group alerts");
  // The webhook-only "public HTTPS" warning must not leak into the event flow.
  expect(container.textContent).not.toContain("publicly reachable HTTPS");
});

it("blocks the match step until an event source is chosen", async () => {
  await renderEvent({ step: 1, availableStep: 1 });
  await act(async () => button("Continue").click());
  expect(container.textContent).toContain("Choose which events to react to");
  expect(container.textContent).toContain("Choose the event source this trigger listens to.");

  await setValue(field("Event source") as HTMLSelectElement, SOURCE_ID);
  await act(async () => button("Continue").click());
  expect(container.textContent).toContain("Group repeated alerts");
});

it("points to Event sources when none exist yet", async () => {
  await renderEvent({ step: 1, availableStep: 1 }, { eventSources: { status: "ready", sources: [] } });
  expect(container.textContent).toContain("No event sources yet");
  expect(container.querySelector('a[href$="/company/settings/event-sources"]')).not.toBeNull();
});

it("collects filter values and sends them with the finished draft", async () => {
  const { onFinish } = await renderEvent({ step: 1, availableStep: 1 });
  await setValue(field("Event source") as HTMLSelectElement, SOURCE_ID);

  const types = field("Event types") as HTMLInputElement;
  await setValue(types, "disk.*");
  await act(async () => types.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(container.textContent).toContain("disk.*");

  await setValue(field("Minimum severity") as HTMLSelectElement, "warning");
  await act(async () => button("Add label filter").click());
  await setValue(container.querySelector('input[aria-label="Label 1 name"]') as HTMLInputElement, "host_id");
  const values = container.querySelector('input[aria-label="Label 1 values"]') as HTMLInputElement;
  await setValue(values, "example-host, vm142");

  await act(async () => button("Continue").click());
  await act(async () => button("Add event trigger").click());

  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(onFinish.mock.calls[0]![0].event).toMatchObject({
    sourceId: SOURCE_ID,
    types: ["disk.*"],
    minSeverity: "warning",
    labels: [expect.objectContaining({ key: "host_id", values: ["example-host", "vm142"] })],
  });
});

it("rejects an unknown groupKey placeholder inline and does not finish", async () => {
  const { onFinish } = await renderEvent({
    step: 2,
    availableStep: 2,
    event: { ...defaultTriggerDraft.event, sourceId: SOURCE_ID },
  });
  const groupKey = field("Group key") as HTMLInputElement;
  expect(groupKey.value).toBe("{{source}}:{{dedupeKey}}");

  await setValue(groupKey, "{{source}}:{{hostname}}");
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("{{hostname}}");
  expect(groupKey.getAttribute("aria-invalid")).toBe("true");

  await act(async () => button("Add event trigger").click());
  expect(onFinish).not.toHaveBeenCalled();

  await setValue(groupKey, "{{source}}:{{labels.host_id}}:{{dedupeKey}}");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button("Add event trigger").click());
  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(onFinish.mock.calls[0]![0].event.groupKey).toBe("{{source}}:{{labels.host_id}}:{{dedupeKey}}");
});

it("warns, without blocking, when the groupKey drops dedupeKey", async () => {
  const { onFinish } = await renderEvent({
    step: 2,
    availableStep: 2,
    event: { ...defaultTriggerDraft.event, sourceId: SOURCE_ID },
  });
  await setValue(field("Group key") as HTMLInputElement, "{{source}}:{{type}}");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("{{dedupeKey}}");
  await act(async () => button("Add event trigger").click());
  expect(onFinish).toHaveBeenCalledTimes(1);
});

it("offers placeholder shortcuts and a reset for the groupKey", async () => {
  await renderEvent({
    step: 2,
    availableStep: 2,
    event: { ...defaultTriggerDraft.event, sourceId: SOURCE_ID, groupKey: "{{source}}" },
  });
  await act(async () => button("{{severity}}").click());
  expect((field("Group key") as HTMLInputElement).value).toBe("{{source}}{{severity}}");
  await act(async () => button("Reset to default").click());
  expect((field("Group key") as HTMLInputElement).value).toBe("{{source}}:{{dedupeKey}}");
});

it("validates the cooldown and the append-to-issue ID", async () => {
  const { onFinish } = await renderEvent({
    step: 2,
    availableStep: 2,
    event: { ...defaultTriggerDraft.event, sourceId: SOURCE_ID },
  });
  await setValue(field("Repeat comment cooldown (minutes)") as HTMLInputElement, "-3");
  await act(async () => button("Add event trigger").click());
  expect(container.textContent).toContain("Enter 0 or more minutes.");
  expect(onFinish).not.toHaveBeenCalled();
  await setValue(field("Repeat comment cooldown (minutes)") as HTMLInputElement, "5");

  const append = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) =>
    item.textContent?.includes("Append to a standing issue"),
  )!;
  await act(async () => append.click());
  await act(async () => button("Add event trigger").click());
  expect(container.textContent).toContain("Enter the issue ID");
  expect(onFinish).not.toHaveBeenCalled();
});

it("keeps the event settings when saving and exiting", async () => {
  const { onSaveExit } = await renderEvent({ step: 1, availableStep: 1 });
  await setValue(field("Event source") as HTMLSelectElement, SOURCE_ID);
  await act(async () => button("Save & exit").click());
  expect(onSaveExit).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "event", event: expect.objectContaining({ sourceId: SOURCE_ID }) }),
  );
});

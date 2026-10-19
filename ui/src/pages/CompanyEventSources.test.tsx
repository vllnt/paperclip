// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { eventSourcesApi, EventSource, EventTestResult } from "@/api/eventSources";
import { CompanyEventSources } from "./CompanyEventSources";

const api = vi.hoisted(() => ({
  list: vi.fn<typeof eventSourcesApi.list>(),
  create: vi.fn<typeof eventSourcesApi.create>(),
  update: vi.fn<typeof eventSourcesApi.update>(),
  archive: vi.fn<typeof eventSourcesApi.archive>(),
  rotateSecret: vi.fn<typeof eventSourcesApi.rotateSecret>(),
  test: vi.fn<typeof eventSourcesApi.test>(),
  deliveries: vi.fn<typeof eventSourcesApi.deliveries>(),
}));
const copyText = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());
const searchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock("@/api/eventSources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/eventSources")>()),
  eventSourcesApi: api,
}));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copyText }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useSearchParams: () => [
    searchParamsState.current,
    (next: Record<string, string>) => {
      searchParamsState.current = new URLSearchParams(next);
    },
  ],
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = "pcs_live_super_secret_value_123";
const INGRESS_URL = "https://paperclip.example/api/event-sources/public/abc123/events";

function makeSource(overrides: Partial<EventSource> = {}): EventSource {
  return {
    id: "src-1",
    companyId: "company-1",
    name: "Gatus",
    enabled: true,
    archived: false,
    publicId: "abc123",
    ingressUrl: INGRESS_URL,
    secretId: "secret-1",
    signingMode: "hmac_sha256",
    replayWindowSec: 300,
    normalizer: "generic_v1",
    normalizerConfig: null,
    pinnedLabels: {},
    rateLimitPerMinute: 600,
    maxNewIssuesPerHour: 20,
    retentionDays: 30,
    lastRotatedAt: null,
    createdByAgentId: null,
    createdByUserId: "board",
    updatedByAgentId: null,
    updatedByUserId: "board",
    lastDeliveryAt: null,
    lastResult: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  searchParamsState.current = new URLSearchParams();
  api.list.mockResolvedValue([makeSource()]);
  api.deliveries.mockResolvedValue({ items: [], nextCursor: null });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyEventSources />
      </QueryClientProvider>,
    ),
  );
  // The list loads first; children such as the deliveries table query after it.
  await flush();
  await flush();
}

/** Radix dialogs portal into `document.body`, so look there. */
function pageText() {
  return document.body.textContent ?? "";
}

function findButton(label: string) {
  const match = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}" in: ${pageText().slice(0, 400)}`);
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

describe("event sources list", () => {
  it("lists sources with their ingest URL and state, and never a secret", async () => {
    await renderPage();
    expect(pageText()).toContain("Gatus");
    expect(pageText()).toContain(INGRESS_URL);
    expect(pageText()).toContain("Active");
    expect(pageText()).toContain("HMAC-SHA256");
    expect(pageText()).toContain("No events received yet");
    expect(pageText()).not.toContain(SECRET);
  });

  it("shows an empty state that offers to create the first source", async () => {
    api.list.mockResolvedValue([]);
    await renderPage();
    expect(pageText()).toContain("No event sources yet");
    expect(document.body.querySelectorAll("button").length).toBeGreaterThan(0);
    expect([...document.body.querySelectorAll("button")].some((item) => item.textContent?.includes("New event source"))).toBe(
      true,
    );
  });

  it("hides archived sources until asked", async () => {
    api.list.mockResolvedValue([makeSource(), makeSource({ id: "src-2", name: "Old relay", archived: true, enabled: false })]);
    await renderPage();
    expect(api.list).toHaveBeenCalledWith("company-1", { includeArchived: true });
    expect(pageText()).not.toContain("Old relay");
    await click(document.body.querySelector("#show-archived-sources")!);
    expect(pageText()).toContain("Old relay");
    expect(pageText()).toContain("Archived");
  });
});

describe("creating a source and the one-time secret", () => {
  async function createSource() {
    api.create.mockResolvedValue({
      source: makeSource({ id: "src-new", name: "Upkeep relay" }),
      secretMaterial: { ingressUrl: INGRESS_URL, secret: SECRET },
    });
    await renderPage();
    await click(findButton("New event source"));
    const name = document.body.querySelector('input[placeholder^="Gatus"]') as HTMLInputElement;
    await setValue(name, "Upkeep relay");
    await click(findButton("Create event source"));
  }

  it("validates the name before calling the API", async () => {
    await renderPage();
    await click(findButton("New event source"));
    await click(findButton("Create event source"));
    expect(api.create).not.toHaveBeenCalled();
    expect(pageText()).toContain("Give the event source a name.");
  });

  it("shows the URL and secret once, with a warning and a copy button", async () => {
    await createSource();
    expect(api.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Upkeep relay", signingMode: "hmac_sha256", normalizer: "generic_v1" }),
    );
    expect(pageText()).toContain("is ready");
    expect(pageText()).toContain(SECRET);
    expect(pageText()).toContain(INGRESS_URL);
    expect(pageText()).toContain("Copy the secret now.");
    expect(pageText()).toContain("shown only once");

    const copy = document.body.querySelector('button[aria-label="Copy Signing secret"]')!;
    await click(copy);
    expect(copyText).toHaveBeenCalledWith(SECRET);
  });

  it("cannot be dismissed until the secret is confirmed saved, and is gone afterwards", async () => {
    await createSource();
    const done = findButton("Done");
    expect(done.disabled).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(pageText()).toContain(SECRET);

    await click(document.body.querySelector("#event-source-secret-saved")!);
    expect(findButton("Done").disabled).toBe(false);
    await click(findButton("Done"));

    expect(pageText()).not.toContain(SECRET);
    expect(pageText()).not.toContain("Copy the secret now.");
    // The secret is never cached by the query layer either.
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET);
  });

  it("shows a bearer token as an Authorization header value", async () => {
    api.create.mockResolvedValue({
      source: makeSource({ id: "src-b", name: "Gatus", signingMode: "bearer" }),
      secretMaterial: { ingressUrl: INGRESS_URL, secret: SECRET },
    });
    await renderPage();
    await click(findButton("New event source"));
    await setValue(document.body.querySelector('input[placeholder^="Gatus"]') as HTMLInputElement, "Gatus");
    await click(findButton("Create event source"));
    expect(pageText()).toContain("Authorization header value");
    expect(pageText()).toContain(`Bearer ${SECRET}`);
  });

  it("surfaces an API failure without revealing anything", async () => {
    api.create.mockRejectedValue(new Error("Name already in use"));
    await renderPage();
    await click(findButton("New event source"));
    await setValue(document.body.querySelector('input[placeholder^="Gatus"]') as HTMLInputElement, "Gatus");
    await click(findButton("Create event source"));
    expect(pageText()).toContain("Name already in use");
    expect(pageText()).not.toContain("is ready");
  });
});

describe("rotating, disabling and archiving", () => {
  it.each(["hmac_sha256", "bearer"] as const)("confirms before rotating %s, then shows the new secret once", async (signingMode) => {
    api.rotateSecret.mockResolvedValue({
      source: makeSource({ signingMode }),
      secretMaterial: { ingressUrl: INGRESS_URL, secret: SECRET },
    });
    await renderPage();
    await click(findButton("Rotate secret"));
    expect(api.rotateSecret).not.toHaveBeenCalled();
    expect(pageText()).toContain("stops working immediately");

    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (item) => item.textContent?.trim() === "Rotate secret",
    )!;
    await click(confirm);
    expect(api.rotateSecret).toHaveBeenCalledWith("src-1");
    expect(pageText()).toContain("New secret for");
    expect(pageText()).toContain(INGRESS_URL);
    expect(pageText()).toContain(signingMode === "bearer" ? `Bearer ${SECRET}` : SECRET);
    expect(pageText()).toContain(signingMode === "bearer" ? "Authorization header value" : "Signing secret");

    await click(document.body.querySelector("#event-source-secret-saved")!);
    await click(findButton("Done"));
    expect(pageText()).not.toContain(SECRET);
  });


  it("surfaces rotation failure without showing a secret", async () => {
    api.rotateSecret.mockRejectedValue(new Error("Rotation unavailable"));
    await renderPage();
    await click(findButton("Rotate secret"));
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (item) => item.textContent?.trim() === "Rotate secret",
    )!;
    await click(confirm);
    expect(pageText()).toContain("Rotation unavailable");
    expect(pageText()).not.toContain(SECRET);
    expect(pageText()).not.toContain("New secret for");
  });

  it("does not rotate when the confirmation is cancelled", async () => {
    await renderPage();
    await click(findButton("Rotate secret"));
    await click(findButton("Cancel"));
    expect(api.rotateSecret).not.toHaveBeenCalled();
    expect(pageText()).not.toContain(SECRET);
  });

  it("archives after confirmation", async () => {
    api.archive.mockResolvedValue(makeSource({ archived: true, enabled: false }));
    await renderPage();
    await click(findButton("Archive"));
    expect(api.archive).not.toHaveBeenCalled();
    expect(pageText()).toContain("senders get 404");

    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (item) => item.textContent?.trim() === "Archive",
    )!;
    await click(confirm);
    expect(api.archive).toHaveBeenCalledWith("src-1");
  });

  it("disables a source with one click", async () => {
    api.update.mockResolvedValue(makeSource({ enabled: false }));
    await renderPage();
    await click(findButton("Disable"));
    expect(api.update).toHaveBeenCalledWith("src-1", { enabled: false });
  });
});

describe("source detail: test send and deliveries", () => {
  // PR144 service.dryRun returns one result per routine, with all matching trigger IDs.
  const dryRun: EventTestResult = {
    event: {
      source: "upkeep",
      type: "disk.usage",
      severity: "critical",
      state: "problem",
      dedupeKey: "example-host/disk.usage:/",
      title: "example-worker: / at 93%",
      labels: { host_id: "example-host" },
      eventId: null,
      summary: "",
      occurredAt: "2026-10-18T10:00:00Z",
      url: null,
    },
    validationErrors: [],
    wouldBe: "dispatched",
    matched: [
      {
        triggerIds: ["t1", "t2"],
        routineId: "r1",
        routineTitle: "Disk watch",
        assigneeAgentId: "a1",
        issueId: null,
        groupKey: "upkeep:example-host/disk.usage:/",
        action: "new_issue",
      },
    ],
    fallback: [],
  };

  beforeEach(() => {
    searchParamsState.current = new URLSearchParams("source=src-1");
  });

  it("runs the dry run and shows matched triggers, group key and predicted action", async () => {
    api.test.mockResolvedValue(dryRun);
    await renderPage();
    expect(pageText()).toContain("Test an event");

    await click(findButton("Run dry run"));
    expect(api.test).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({ schema: "paperclip.event.v1", source: "upkeep", type: "disk.usage" }),
    );
    const result = document.body.querySelector('[aria-label="Dry run result"]')!;
    expect(result.textContent).toContain("Matched triggers");
    expect(result.textContent).toContain("Disk watch");
    expect(result.textContent).toContain("Agent assigned");
    expect(result.textContent).toContain("2 matching triggers");
    expect(result.querySelectorAll("li")).toHaveLength(1);
    expect(result.textContent).toContain("upkeep:example-host/disk.usage:/");
    expect(result.textContent).toContain("Opens a new issue and wakes the agent");
  });

  it("explains an unrouted event", async () => {
    api.test.mockResolvedValue({ ...dryRun, matched: [], wouldBe: "unrouted" });
    await renderPage();
    await click(findButton("Run dry run"));
    expect(pageText()).toContain("Unrouted.");
    expect(pageText()).toContain("nobody would be woken");
  });

  it("lists validation errors from the dry run", async () => {
    api.test.mockResolvedValue({ event: null, validationErrors: ["severity must be one of info, warning, critical"], matched: [], fallback: [], wouldBe: "invalid" });
    await renderPage();
    await click(findButton("Run dry run"));
    expect(pageText()).toContain("would be rejected (422)");
    expect(pageText()).toContain("severity must be one of");
  });


  it.each([
    ["new_issue", "dispatched", "Opens a new issue and wakes the agent", "Dispatched"],
    ["comment", "dispatched", "Comments on the open issue", "Dispatched"],
    ["comment_and_wake", "dispatched", "Comments on the open issue and wakes the agent", "Dispatched"],
    ["silent", "grouped_silent", "Counted silently, no comment or wake", "Grouped"],
    ["recovery_comment", "dispatched", "Adds a recovery comment", "Dispatched"],
    ["recovery_without_issue", "recovery_without_issue", "Recovery with no open issue, nothing happens", "Recovery, no issue"],
    ["recovery_ignored", "recovery_without_issue", "Recovery ignored, no comment or wake", "Recovery, no issue"],
    ["storm_folded", "storm_folded", "Folded into the storm issue", "Storm folded"],
  ] as const)("shows the %s action and predicted delivery status", async (action, wouldBe, label, status) => {
    api.test.mockResolvedValue({
      ...dryRun,
      wouldBe,
      matched: [{ ...dryRun.matched[0], action, issueId: "issue-1" }],
    });
    await renderPage();
    await click(findButton("Run dry run"));
    const result = document.body.querySelector('[aria-label="Dry run result"]')!;
    expect(result.textContent).toContain(label);
    expect(result.textContent).toContain(`Predicted delivery: ${status}`);
    expect(result.querySelector('a[href="/issues/issue-1"]')).not.toBeNull();
  });

  it("shows fallback routines when no regular routine matches", async () => {
    api.test.mockResolvedValue({
      ...dryRun,
      matched: [],
      fallback: [{ ...dryRun.matched[0], routineTitle: "Fallback watch", triggerIds: ["fallback-1"], assigneeAgentId: null }],
    });
    await renderPage();
    await click(findButton("Run dry run"));
    const result = document.body.querySelector('[aria-label="Dry run result"]')!;
    expect(result.textContent).toContain("Fallback triggers");
    expect(result.textContent).toContain("Fallback watch");
    expect(result.textContent).toContain("1 matching trigger");
    expect(result.textContent).toContain("No agent assigned");
    expect(result.textContent).not.toContain("Unrouted.");
    expect(result.textContent).not.toContain("Matched triggers");
  });

  it("surfaces a dry-run request failure and can retry", async () => {
    api.test.mockRejectedValueOnce(new Error("Source unavailable"));
    api.test.mockResolvedValueOnce(dryRun);
    await renderPage();
    await click(findButton("Run dry run"));
    expect(pageText()).toContain("Source unavailable");
    expect(document.body.querySelector('[aria-label="Dry run result"]')).toBeNull();
    await click(findButton("Run dry run"));
    expect(pageText()).not.toContain("Source unavailable");
    expect(pageText()).toContain("Disk watch");
  });

  it("renders and filters aggregate rejected deliveries", async () => {
    api.deliveries.mockResolvedValue({
      items: [{
        id: "rejected-1", companyId: "company-1", sourceId: "src-1", status: "rejected_aggregate",
        receivedAt: "2026-10-18T10:00:00Z", claimedAt: null, httpStatus: null, latencyMs: null,
        attempts: 0, event: null, matchedTriggerIds: [], routineRunIds: [], issueIds: [],
        routineOutcomes: {}, error: null, rejectCounts: { unauthorized: 3, duplicate: 2 },
        firstIp: null, lastIp: null,
      }],
      nextCursor: null,
    });
    await renderPage();
    const select = [...document.body.querySelectorAll("select")].find((item) =>
      [...item.options].some((option) => option.value === "invalid"),
    )!;
    expect([...select.options].map((option) => option.value)).toEqual([
      "all", "processing", "dispatched", "grouped_silent", "invalid", "unrouted", "storm_folded",
      "recovery_without_issue", "failed", "rejected_aggregate",
    ]);
    await setValue(select, "rejected_aggregate");
    await flush();
    expect(api.deliveries).toHaveBeenLastCalledWith("src-1", expect.objectContaining({ status: "rejected_aggregate" }));
    await click(document.body.querySelector('button[aria-label="Show delivery details"]')!);
    expect(pageText()).toContain("unauthorized: 3");
    expect(pageText()).toContain("duplicate: 2");
  });

  it("surfaces delivery loading errors", async () => {
    api.deliveries.mockRejectedValue(new Error("Could not fetch delivery history"));
    await renderPage();
    expect(pageText()).toContain("Could not fetch delivery history");
  });

  it("rejects a malformed raw JSON payload locally", async () => {
    await renderPage();
    const rawTab = [...document.body.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Raw JSON")!;
    // Radix Tabs activates on mousedown.
    await act(async () => {
      rawTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    const json = document.body.querySelector("#" + CSS.escape(rawTab.getAttribute("aria-controls") ?? "") + " textarea") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(json, "{ nope");
    await act(async () => json.dispatchEvent(new Event("input", { bubbles: true })));
    await click(findButton("Run dry run"));
    expect(pageText()).toContain("isn’t valid JSON");
    expect(api.test).not.toHaveBeenCalled();
  });

  it("filters deliveries by status", async () => {
    api.deliveries.mockResolvedValue({
      items: [
        {
          id: "d1",
          companyId: "company-1",
          sourceId: "src-1",
          claimedAt: null,
          rejectCounts: null,
          firstIp: null,
          lastIp: null,
          status: "dispatched",
          receivedAt: "2026-10-18T10:00:00Z",
          httpStatus: 202,
          latencyMs: 41,
          attempts: 1,
          event: { source: "upkeep", type: "disk.usage", severity: "critical", state: "problem", dedupeKey: "k", title: "Disk almost full", labels: {} },
          matchedTriggerIds: [],
          routineRunIds: [],
          issueIds: [],
          routineOutcomes: {},
          error: null,
        },
      ],
      nextCursor: null,
    });
    await renderPage();
    expect(pageText()).toContain("Disk almost full");
    expect(api.deliveries).toHaveBeenLastCalledWith("src-1", expect.objectContaining({ status: "all" }));

    api.deliveries.mockResolvedValue({ items: [], nextCursor: null });
    const select = [...document.body.querySelectorAll("select")].find((item) =>
      [...item.options].some((option) => option.value === "invalid"),
    ) as HTMLSelectElement;
    await setValue(select, "invalid");
    await flush();
    expect(api.deliveries).toHaveBeenLastCalledWith("src-1", expect.objectContaining({ status: "invalid" }));
    expect(pageText()).toContain("No invalid deliveries.");
  });

  it("says so when the source is gone", async () => {
    api.list.mockResolvedValue([]);
    await renderPage();
    expect(pageText()).toContain("no longer exists");
  });
});

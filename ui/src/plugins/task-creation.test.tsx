// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTaskWithDestination, listTaskDestinations, TaskDestinationPicker, useTaskDestination } from "./task-creation";
const mocks = vi.hoisted(() => ({ list: vi.fn(), action: vi.fn(), create: vi.fn() }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { listUiContributions: mocks.list, bridgePerformAction: mocks.action } }));
vi.mock("@/api/issues", () => ({ issuesApi: { create: mocks.create } }));
const destination = { key: "plugin:22", pluginId: "plugin", action: "publish", id: "22", label: "org/repo", provider: "GitHub" };
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); mocks.list.mockResolvedValue([{ pluginId: "plugin", taskCreation: { label: "GitHub", listAction: "destinations", publishAction: "publish" } }]); mocks.action.mockResolvedValue({ data: { destinations: [{ id: "22", label: "org/repo" }] } }); mocks.create.mockResolvedValue({ id: "task", identifier: "PC-1" }); });
afterEach(() => { document.body.innerHTML = ""; });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("preserves ordinary Paperclip creation without calling a plugin", async () => {
  await createTaskWithDestination("c1", { title: "Internal", status: "todo" }, null);
  expect(mocks.create).toHaveBeenCalledWith("c1", { title: "Internal", status: "todo" }); expect(mocks.action).not.toHaveBeenCalled();
});
it("uses the selected company and native task, and keeps the same retry key after a lost plugin response", async () => {
  mocks.action.mockRejectedValueOnce(new Error("Network lost")).mockResolvedValueOnce({ data: { url: "https://github.com/org/repo/issues/1" } });
  const input = { title: "Publish", projectId: "p1", idempotencyKey: "stable" };
  await expect(createTaskWithDestination("c1", input, destination)).rejects.toThrow("PC-1 was saved");
  await createTaskWithDestination("c1", input, destination);
  expect(mocks.create.mock.calls[0]).toEqual(mocks.create.mock.calls[1]);
  expect(mocks.action).toHaveBeenLastCalledWith("plugin", "publish", { issueId: "task", destinationId: "22" }, "c1");
});
it("prevents writes when access is missing and surfaces durable publication warnings", async () => {
  await expect(createTaskWithDestination("c1", {}, { ...destination, disabledReason: "Approve permissions" })).rejects.toThrow("Approve permissions");
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.action.mockResolvedValueOnce({ data: { warning: "Rate limited; sync will retry" } });
  expect((await createTaskWithDestination("c1", {}, destination)).warning).toContain("Rate limited");
});
it("validates provider destinations and scopes discovery", async () => {
  expect(await listTaskDestinations("c1", "p1")).toEqual([destination]);
  expect(mocks.action).toHaveBeenCalledWith("plugin", "destinations", { projectId: "p1" }, "c1");
  mocks.action.mockResolvedValueOnce({ data: { destinations: [{ id: 42 }] } });
  await expect(listTaskDestinations("c1", "p1")).rejects.toThrow("invalid destination");
});
function Form({ companyId, projectId }: { companyId: string; projectId: string }) {
  const destination = useTaskDestination(companyId, projectId, true);
  return <><TaskDestinationPicker value={destination} /><button disabled={destination.blocked}>Create</button></>;
}
it("defaults to Paperclip, remembers the choice per project and prevents silently publishing to an unavailable destination", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (projectId: string) => <QueryClientProvider client={client}><Form companyId="c1" projectId={projectId} /></QueryClientProvider>;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));
  await act(async () => { root.render(view("p1")); });
  await act(flush);
  const picker = container.querySelector("select")!;
  expect(picker.value).toBe("");
  await act(async () => { picker.value = "plugin:22"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => root.render(view("p2"))); await act(flush);
  expect(container.querySelector("select")?.value).toBe("");
  await act(async () => root.render(view("p1"))); await act(flush);
  expect(container.querySelector("select")?.value).toBe("plugin:22");
  mocks.action.mockResolvedValue({ data: { destinations: [] } });
  await act(async () => { await client.invalidateQueries({ queryKey: ["plugins", "task-destinations", "c1", "p1"] }); });
  await act(flush);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
  expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => root.unmount()); client.clear();
});

describe("TaskDestinationPicker discoverability", () => {
  it("explains that a project is required before a GitHub repository can be chosen", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Form companyId="c1" projectId="" />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.textContent).toContain("Select a project above to enable GitHub issue creation.");
    await act(async () => root.unmount());
    client.clear();
  });
});

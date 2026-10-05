// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { readTaskRecordSelection, writeTaskRecordSelection, TaskRecordPanelContent, useTaskRecordPanels } from "./task-record-panels";
const mocks = vi.hoisted(() => ({ links: { rows: new Map(), loading: false, error: false, retry: vi.fn() }, slots: { slots: [] as any[], isLoading: false, errorMessage: null }, mount: vi.fn() }));
vi.mock("./task-links", () => ({ useTaskLinks: () => mocks.links }));
vi.mock("./slots", () => ({ usePluginSlots: () => mocks.slots, PluginSlotMount: (props: any) => { mocks.mount(props); return <div>Mounted record {props.context.taskRecordId}</div>; } }));
vi.mock("@/lib/router", () => ({ useActiveCompanyPrefix: () => "GIT" }));
const issue = { id: "t1", companyId: "c1", projectId: "project-1", originKind: "plugin:github:issue" } as unknown as Issue;
const slot = { id: "github-record", pluginId: "p1" };
const record = { pluginId: "p1", pluginKey: "github", recordId: "issue:1", kind: "issue" as const, link: { url: "https://github.com/a/b/issues/1", label: "#1" }, slot } as any;
let root: Root, container: HTMLDivElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { vi.clearAllMocks(); mocks.links.rows = new Map(); mocks.links.loading = false; mocks.links.error = false; mocks.slots.slots = []; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const payload = { kind: "plugin-record" as const, pluginId: "p1", recordId: "issue:1", recordKind: "issue" as const };
async function render(data: any, overrides = {}) { await act(async () => root.render(<TaskRecordPanelContent issue={issue} payload={{ ...payload, ...overrides }} data={data} />)); }
describe("task record panel routing", () => {
  it("round-trips opaque references while retaining task query state", () => {
    const search = writeTaskRecordSelection("?other=kept&file=a&line=1&browse=1&q=old", { pluginId: "github", recordId: "repo:pull:2/a b" });
    expect(readTaskRecordSelection(search)).toEqual({ pluginId: "github", recordId: "repo:pull:2/a b" });
    expect(new URLSearchParams(search).get("other")).toBe("kept");
    expect(new URLSearchParams(search).has("file")).toBe(false);
    expect(writeTaskRecordSelection(search, null)).toBe("?other=kept");
  });
  it.each(["file=src%2Fapp.tsx", "browse=1"])("gives file navigation priority over stale record keys: %s", fileSelection => {
    expect(readTaskRecordSelection(`?taskPlugin=github&taskRecord=issue%3A1&${fileSelection}`)).toBeNull();
  });
  it.each(["?taskPlugin=p", "?taskRecord=r", `?taskPlugin=${"x".repeat(201)}&taskRecord=r`, `?taskPlugin=p&taskRecord=${"x".repeat(513)}`])("rejects incomplete or oversized selection %s", search => expect(readTaskRecordSelection(search)).toBeNull());
  it("only resolves declared slots belonging to the current source plugin", async () => {
    mocks.links.rows.set("t1", { pluginId: "p1", pluginKey: "github", issue: { ...record.link, panel: { slotId: "github-record", recordId: "issue:1" } }, pullRequests: [{ ...record.link, panel: { slotId: "foreign-slot", recordId: "pull:2" } }] });
    mocks.slots.slots = [slot, { id: "foreign-slot", pluginId: "p2" }];
    let data: any;
    function Probe() { data = useTaskRecordPanels(issue); return null; }
    await act(async () => root.render(<Probe />));
    expect(data.records).toHaveLength(1); expect(data.records[0]).toMatchObject({ pluginId: "p1", recordId: "issue:1" });
  });
  it("mounts a current linked record with the native company and task context", async () => {
    await render({ records: [record], loading: false, error: null, retry: mocks.links.retry });
    expect(mocks.mount).toHaveBeenCalledWith(expect.objectContaining({ slot, context: { companyId: "c1", companyPrefix: "GIT", projectId: "project-1", entityId: "t1", entityType: "issue", taskRecordId: "issue:1" } }));
  });
  it.each([{ pluginId: "foreign" }, { recordId: "unlinked" }])("does not mount arbitrary records %j", async invalid => {
    await render({ records: [record], loading: false, error: null, retry: mocks.links.retry }, invalid);
    expect(mocks.mount).not.toHaveBeenCalled(); expect(container.textContent).toContain("no longer available");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); expect(mocks.links.retry).toHaveBeenCalledOnce();
  });
  it("replaces a revoked record with the access error instead of keeping it mounted", async () => {
    await render({ records: [record], loading: false, error: null, retry: mocks.links.retry });
    mocks.mount.mockClear();
    await render({ records: [], loading: false, error: "Approve repository access", retry: mocks.links.retry });
    expect(mocks.mount).not.toHaveBeenCalled(); expect(container.textContent).toContain("Approve repository access"); expect(container.textContent).not.toContain("Mounted record");
  });
  it("shows loading without mounting a restored record before authorization resolves", async () => {
    await render({ records: [], loading: true, error: null, retry: mocks.links.retry });
    expect(container.textContent).toContain("Loading source record"); expect(mocks.mount).not.toHaveBeenCalled(); expect(container.querySelector("button")).toBeNull();
  });
});

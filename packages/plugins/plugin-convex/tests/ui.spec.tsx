// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexPage } from "../src/ui/index.js";

const mocks = vi.hoisted(() => ({ actions: new Map<string, ReturnType<typeof vi.fn>>() }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginAction: (key: string) => {
    if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn());
    return mocks.actions.get(key);
  },
}));
const action = (key: string) => { if (!mocks.actions.has(key)) mocks.actions.set(key, vi.fn()); return mocks.actions.get(key)!; };
const context = { companyId: "c1", companyPrefix: "ACME", userId: "u1", projectId: null, entityId: null, entityType: null };
const guards = { activityHours: 24, maxDeletesPerRun: 10, callsPerMinute: 30, dryRunOnly: false };
const status = {
  connection: "connected", teamId: "1", credentials: { teamToken: true, github: true }, grants: 2,
  projects: [{ convexProjectId: "100", name: "app", repository: "org/app", reserved: true }],
  guards, reaper: { enabled: false, ttlHours: 36, quota: 300, alertPercent: 80 },
};
// What the worker returns for an invalid config: everything it cannot know is null.
const invalidConfigStatus = { connection: "not-configured", configError: "projects[0].repository must be owner/name.", teamId: null, projects: [], credentials: null, grants: null, guards: null, reaper: null, lastReport: null };
const project = { convexProjectId: "100", name: "app", previews: 12, delete: [{ name: "happy-owl-123", previewIdentifier: "feat/old-login", reason: "pull request closed" }], setExpiry: [{ name: "calm-fox-456", from: null, to: Date.parse("2026-10-10T12:00:00.000Z") }], kept: 11, deleted: [], expirySet: [], failed: [], skipped: [] };
const report = {
  at: "2026-10-09T12:00:00.000Z", trigger: "schedule", dryRun: true, errors: [] as string[],
  quota: { count: 250, quota: 300, percent: 83.3, partial: false, alert: true },
  projects: [project],
};
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const ready = () => screen.findByRole("heading", { level: 2, name: "Connection" });
const live = () => screen.getAllByRole("status").map(node => node.textContent).join(" | ");

beforeEach(() => { mocks.actions.clear(); action("status").mockResolvedValue(status); action("reaper.report").mockResolvedValue(report); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Convex page", () => {
  it("shows the connection, the mapped projects and the last reaper report, without any secret", async () => {
    render(<ConvexPage context={context} />);
    await waitFor(() => expect(screen.getByText("Connected", { selector: "strong" })).toBeTruthy());
    expect(screen.getByText("app (100)")).toBeTruthy();
    expect(screen.getByText("org/app")).toBeTruthy();
    expect(screen.getByText(/Off, dry run only/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Last reaper report" }).textContent).toMatch(/250.*of 300.*83\.3%/);
    expect(screen.getByText(/at or above the alert threshold/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret_ref|secretId|token value/i);
  });

  it("runs a dry run for the selected company and refreshes", async () => {
    action("reaper.run").mockResolvedValue(report);
    render(<ConvexPage context={context} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Run a dry run now" }));
    await waitFor(() => expect(action("reaper.run")).toHaveBeenCalledWith({ companyId: "c1", dryRun: true }));
    await waitFor(() => expect(action("status").mock.calls.length).toBeGreaterThan(1));
  });

  it("surfaces an action error and a config problem", async () => {
    action("status").mockResolvedValue({ ...status, connection: "not-configured", configError: "projects[0].repository must be owner/name.", projects: [] });
    action("connection.connect").mockRejectedValue(new Error("Instance administrator access is required for this Convex change."));
    render(<ConvexPage context={context} />);
    await waitFor(() => expect(screen.getByText(/projects\[0\]\.repository must be owner\/name/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Instance administrator/));
    expect(screen.getByRole("button", { name: "Verify and connect" }).getAttribute("aria-busy")).toBe("false");
  });

  it("asks for a company when none is selected", () => {
    render(<ConvexPage context={{ ...context, companyId: null }} />);
    expect(screen.getByText("Select a company to manage Convex.")).toBeTruthy();
  });
});

describe("loading and load failure", () => {
  it("announces loading as a status while the first call is pending", async () => {
    const pending = deferred<typeof status>();
    action("status").mockReturnValue(pending.promise);
    render(<ConvexPage context={context} />);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    pending.resolve(status);
    await ready();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("shows only the error and a Retry button when the first call fails, never Loading… next to it", async () => {
    action("status").mockRejectedValueOnce(new Error("Open this plugin as a Paperclip board user."));
    render(<ConvexPage context={context} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/board user/));
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("also fails closed when the report call is the one that rejects", async () => {
    action("reaper.report").mockRejectedValueOnce(new Error("Worker is not running."));
    render(<ConvexPage context={context} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Worker is not running/));
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("page structure", () => {
  it("has one h1 for the page and h2 sections, and names every region and table", async () => {
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.getAllByRole("heading", { level: 1 }).map(node => node.textContent)).toEqual(["Convex"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map(node => node.textContent)).toEqual(["Connection", "Reaper", "Last reaper report"]);
    for (const name of ["Connection", "Reaper", "Last reaper report"]) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Mapped Convex projects" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Reaper results by project" })).toBeTruthy();
  });

  it("wraps each table in a focusable horizontal scroll region so a phone does not cut columns off", async () => {
    render(<ConvexPage context={context} />);
    await ready();
    for (const name of ["Mapped Convex projects", "Reaper results by project"]) {
      const region = screen.getByRole("region", { name });
      expect(region.getAttribute("tabindex")).toBe("0");
      expect(within(region).getByRole("table")).toBeTruthy();
    }
    const css = document.querySelector("style")!.textContent!;
    expect(css).toMatch(/\.pcx-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.pcx\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("points to the plugin settings and gives the exact CLI alternative once", async () => {
    action("status").mockResolvedValue({ ...status, projects: [], reaper: { ...status.reaper } });
    render(<ConvexPage context={context} />);
    await ready();
    expect(document.body.textContent).toMatch(/Map projects in the plugin settings/);
    expect(document.body.textContent).toMatch(/Turn on reaper\.enabled in the plugin settings/);
    expect(document.body.textContent).not.toMatch(/plugin config(?!:)/);
    const commands = document.querySelectorAll("code");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.textContent).toBe(`paperclipai plugin config:set vllnt.paperclip-convex -C <companyId> --payload-json '{"configJson":{...}}'`);
  });

  it("gives the scoped styles real buttons, a heading hierarchy and wrapping for long text", async () => {
    render(<ConvexPage context={context} />);
    await ready();
    const css = document.querySelector("style")!.textContent!;
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.[\]()]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule(".pcx button")).toMatch(/border:[^;]*solid[^;]*;/);
    expect(rule(".pcx button")).toMatch(/padding:/);
    expect(rule(".pcx button")).toMatch(/border-radius:/);
    expect(rule(".pcx button:disabled, .pcx button[aria-disabled=\"true\"]")).toMatch(/opacity:\s*\.5[^}]*cursor:\s*not-allowed/);
    // The pointer cursor must not apply to a disabled or busy button.
    expect(css).not.toMatch(/\.pcx button\s*\{[^}]*cursor:\s*pointer/);
    expect(css).toMatch(/\.pcx button:not\(:disabled\):not\(\[aria-disabled="true"\]\)\s*\{\s*cursor:\s*pointer/);
    expect(rule(".pcx h1")).toMatch(/font-size:\s*1\.5rem[^}]*font-weight:\s*650/);
    expect(rule(".pcx h2")).toMatch(/font-size:\s*1\.125rem[^}]*font-weight:\s*600/);
    expect(rule(".pcx .pcx-error")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".pcx th, .pcx td")).toMatch(/overflow-wrap:\s*anywhere/);
    // Column headers must not break mid-word when a long project name squeezes the table.
    expect(rule(".pcx th")).toMatch(/white-space:\s*nowrap/);
  });
});

describe("keyboard and feedback", () => {
  it("keeps focus on the pressed button, shows Running… and announces the dry run result", async () => {
    const run = deferred<typeof report>();
    action("reaper.run").mockReturnValue(run.promise);
    render(<ConvexPage context={context} />);
    await ready();
    const button = screen.getByRole("button", { name: "Run a dry run now" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Running…"));
    // A disabled button would drop the keyboard focus to <body>; aria-disabled keeps it.
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("button", { name: "Verify and connect" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(action("reaper.run")).toHaveBeenCalledTimes(1);

    run.resolve(report);
    await waitFor(() => expect(live()).toMatch(/Dry run finished at .+: 1 would be deleted, 1 expiry would be set/));
    expect(button.textContent).toBe("Run a dry run now");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(button);
    for (const node of screen.getAllByRole("status")) expect(node.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps focus, shows Connecting… and announces the result of Verify and connect", async () => {
    action("status").mockResolvedValue({ ...status, connection: "not-connected" });
    const connect = deferred<{ projects: string[] }>();
    action("connection.connect").mockReturnValue(connect.promise);
    render(<ConvexPage context={context} />);
    await ready();
    const button = screen.getByRole("button", { name: "Verify and connect" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Connecting…"));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);

    action("status").mockResolvedValue(status);
    connect.resolve({ projects: ["100"] });
    await waitFor(() => expect(live()).toMatch(/Connected at .+: 1 project verified/));
    expect(button.textContent).toBe("Verify and connect");
    expect(document.activeElement).toBe(button);
  });

  it("surfaces a failed dry run as an alert and clears the busy state", async () => {
    action("reaper.run").mockRejectedValue(new Error("Convex is not connected for this company."));
    render(<ConvexPage context={context} />);
    await ready();
    const button = screen.getByRole("button", { name: "Run a dry run now" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not connected/));
    expect(button.textContent).toBe("Run a dry run now");
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(live()).not.toMatch(/Dry run finished/);
  });

  it("explains why the dry run is unavailable until connected, and does not run", async () => {
    action("status").mockResolvedValue({ ...status, connection: "not-connected" });
    render(<ConvexPage context={context} />);
    await ready();
    const button = screen.getByRole("button", { name: "Run a dry run now" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)!.textContent).toMatch(/Available once Convex is connected/);
    fireEvent.click(button);
    expect(action("reaper.run")).not.toHaveBeenCalled();
  });

  it("says next to Verify and connect that it needs an instance administrator", async () => {
    render(<ConvexPage context={context} />);
    await ready();
    const button = screen.getByRole("button", { name: "Verify and connect" });
    expect(document.getElementById(button.getAttribute("aria-describedby")!)!.textContent).toBe("Needs an instance administrator.");
  });
});

describe("dry run versus live", () => {
  const modes: Array<[string, { enabled: boolean }, { dryRunOnly: boolean }, RegExp, RegExp]> = [
    ["off", { enabled: false }, { dryRunOnly: false }, /Off, dry run only/, /Turn on reaper\.enabled/],
    ["enabled but held to dry run by the guards", { enabled: true }, { dryRunOnly: true }, /Enabled, but held to dry run/, /dryRunOnly is on.*deletes nothing/],
    ["live", { enabled: true }, { dryRunOnly: false }, /Live\./, /Deletes finished previews every hour, at most 10 per run/],
  ];
  it.each(modes)("shows the %s state", async (_name, reaper, guardOverride, headline, detail) => {
    action("status").mockResolvedValue({ ...status, reaper: { ...status.reaper, ...reaper }, guards: { ...guards, ...guardOverride } });
    render(<ConvexPage context={context} />);
    await ready();
    const section = screen.getByRole("region", { name: "Reaper" });
    for (const [other, , , otherHeadline] of modes) {
      if (otherHeadline === headline) expect(within(section).getByText(headline)).toBeTruthy();
      else expect(within(section).queryByText(otherHeadline), other).toBeNull();
    }
    expect(section.textContent).toMatch(detail);
  });

  it("never claims live when the guards are unknown", async () => {
    action("status").mockResolvedValue({ ...status, reaper: { ...status.reaper, enabled: true }, guards: null });
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.queryByText(/Live\./)).toBeNull();
    expect(screen.getByText(/Enabled, but held to dry run/)).toBeTruthy();
  });
});

describe("what a dry run would do", () => {
  it("lists the names, preview identifiers and reasons inline, with nothing only in a title", async () => {
    render(<ConvexPage context={context} />);
    await ready();
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    const details = screen.getByRole("region", { name: "Last reaper report" }).querySelector("details")!;
    expect(details.querySelector("summary")!.textContent).toBe("app (would delete 1, would set expiry 1)");
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.textContent).toContain("happy-owl-123 (preview feat/old-login): pull request closed");
    expect(details.textContent).toMatch(/calm-fox-456: expiry to /);
  });

  it("lists skipped and failed items and the names actually deleted after a live pass", async () => {
    action("reaper.report").mockResolvedValue({
      ...report, dryRun: false,
      projects: [{ ...project, delete: [], setExpiry: [], deleted: ["happy-owl-123"], expirySet: ["calm-fox-456"], skipped: [{ name: "slow-ant-9", previewIdentifier: "feat/wip", reason: "Deletion limit of 10 reached for this run." }], failed: [{ name: "odd-cat-7", error: "Convex returned 500." }] }],
    });
    render(<ConvexPage context={context} />);
    await ready();
    const details = screen.getByRole("region", { name: "Last reaper report" }).querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.textContent).toContain("happy-owl-123");
    expect(details.textContent).toContain("calm-fox-456");
    expect(details.textContent).toContain("slow-ant-9 (preview feat/wip): Deletion limit of 10 reached for this run.");
    expect(details.textContent).toContain("odd-cat-7: Convex returned 500.");
    expect(screen.getByRole("columnheader", { name: "Deleted" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Expiry set" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "1 failed, 1 skipped" })).toBeTruthy();
  });

  it("shows no details when nothing is planned", async () => {
    action("reaper.report").mockResolvedValue({ ...report, projects: [{ ...project, delete: [], setExpiry: [] }] });
    render(<ConvexPage context={context} />);
    await ready();
    expect(document.querySelector("details")).toBeNull();
    expect(screen.getByRole("cell", { name: "none" })).toBeTruthy();
  });

  it("says so when the report checked no mapped project", async () => {
    action("reaper.report").mockResolvedValue({ ...report, projects: [] });
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.getByText("No mapped projects were checked.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Reaper results by project" })).toBeNull();
  });

  it("shows a visible note above the lists when the pass stopped early", async () => {
    action("reaper.report").mockResolvedValue({ ...report, incomplete: "the time budget was spent" });
    render(<ConvexPage context={context} />);
    await ready();
    const region = screen.getByRole("region", { name: "Last reaper report" });
    const note = within(region).getByText("This pass stopped early: the time budget was spent. The next hourly pass continues.");
    expect(note.compareDocumentPosition(region.querySelector("details")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(region.querySelector("table")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not warn about duplicate keys when the same error repeats", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    action("reaper.report").mockResolvedValue({ ...report, errors: ["Quota check failed: timeout", "Quota check failed: timeout"] });
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.getAllByText("Quota check failed: timeout")).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("says there is no run yet", async () => {
    action("reaper.report").mockResolvedValue(null);
    render(<ConvexPage context={context} />);
    await ready();
    expect(within(screen.getByRole("region", { name: "Last reaper report" })).getByText("No reaper run yet.")).toBeTruthy();
  });
});

describe("connection states", () => {
  it("does not claim credentials, grants or a reaper mode when the config is invalid", async () => {
    action("status").mockResolvedValue(invalidConfigStatus);
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.getByText(/Config problem: projects\[0\]\.repository must be owner\/name\./)).toBeTruthy();
    expect(screen.getByText("Fix the config in the plugin settings, then reload this page.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Grants/);
    expect(document.body.textContent).not.toMatch(/GitHub token/);
    expect(document.body.textContent).not.toMatch(/team token (not )?set/);
    expect(within(screen.getByRole("region", { name: "Reaper" })).queryByText(/Off, dry run only|Enabled, but|Live\./)).toBeNull();
    expect(document.body.textContent).not.toMatch(/not-configured|not-connected/);
  });

  it.each([
    ["not-configured", "Not configured", /Map at least one Convex project and set the team token or a project token in the plugin settings\./],
    ["not-connected", "Not connected", /An instance administrator must press Verify and connect\./],
    ["disconnected", "Disconnected", /An instance administrator can press Verify and connect to reconnect\./],
  ])("states the next step for %s instead of a raw token", async (connection, label, next) => {
    action("status").mockResolvedValue({ ...status, connection });
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Connection" }).textContent).toMatch(next);
    expect(document.body.textContent).not.toContain(connection);
  });

  it("shows credentials and grants when the config is valid", async () => {
    render(<ConvexPage context={context} />);
    await ready();
    expect(screen.getByText(/Credentials: team token set, GitHub token set\. Grants: 2\./)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const status = {
  connection: "connected", teamId: "1", credentials: { teamToken: true, github: true }, grants: 2,
  projects: [{ convexProjectId: "100", name: "app", repository: "org/app", reserved: true }],
  reaper: { enabled: false, ttlHours: 36, quota: 300, alertPercent: 80 },
};
const report = {
  at: "2026-10-09T12:00:00.000Z", trigger: "schedule", dryRun: true, errors: [],
  quota: { count: 250, quota: 300, percent: 83.3, partial: false, alert: true },
  projects: [{ convexProjectId: "100", name: "app", previews: 12, delete: [{ name: "old-1", previewIdentifier: "old-1", reason: "closed" }], setExpiry: [], kept: 11, deleted: [], expirySet: [], failed: [], skipped: [],
    dev: { listed: 9, delete: [{ name: "dev-old", previewIdentifier: "dev/ship-1", reason: "dev deployment unused for 12 days (limit 7)" }], deleted: [], kept: 8, failed: [], skipped: [], executed: false } }],
};

beforeEach(() => { mocks.actions.clear(); action("status").mockResolvedValue(status); action("reaper.report").mockResolvedValue(report); });
afterEach(() => cleanup());

describe("Convex settings page", () => {
  it("shows the connection, the mapped projects and the last reaper report, without any secret", async () => {
    render(<ConvexPage context={context} />);
    await waitFor(() => expect(screen.getByText("connected")).toBeTruthy());
    expect(screen.getByText("app (100)")).toBeTruthy();
    expect(screen.getByText("org/app")).toBeTruthy();
    expect(screen.getByText(/Dry run: reports what it would do/)).toBeTruthy();
    expect(screen.getByLabelText("Last reaper report").textContent).toMatch(/250.*of 300.*83\.3%/);
    expect(screen.getByText(/at or above the alert threshold/)).toBeTruthy();
    expect(screen.getByLabelText("Last reaper report").textContent).toMatch(/Dev deployments.*9 listed.*1 would be deleted/s);
    expect(document.body.textContent).not.toMatch(/secret_ref|secretId|token value/i);
  });

  it("runs a dry run for the selected company and refreshes", async () => {
    action("reaper.run").mockResolvedValue(report);
    render(<ConvexPage context={context} />);
    await waitFor(() => expect(screen.getByText("connected")).toBeTruthy());
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
  });

  it("asks for a company when none is selected", () => {
    render(<ConvexPage context={{ ...context, companyId: null }} />);
    expect(screen.getByText("Select a company to manage Convex.")).toBeTruthy();
  });
});

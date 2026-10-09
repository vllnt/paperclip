import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConvexCommands } from "../commands/client/convex.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BASE = ["--api-base", "http://localhost:3100", "--api-key", "board-token"];
const URL = (key: string) => `http://localhost:3100/api/plugins/vllnt.paperclip-convex/actions/${key}`;

function program(): Command {
  const root = new Command();
  root.exitOverride();
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerConvexCommands(root);
  return root;
}
const respond = (data: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }));
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(fetchMock.mock.calls[0][1].body as string);

describe("paperclipai convex", () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("requires a company", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PAPERCLIP_COMPANY_ID", "");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(program().parseAsync(["convex", "deployments", "list", ...BASE], { from: "user" })).rejects.toThrow(/exit/);
    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
    vi.unstubAllEnvs();
  });

  it("lists deployments with project and type filters", async () => {
    const fetchMock = respond({ truncated: false, deployments: [{ name: "feat-x", environment: "preview", deploymentType: "preview", previewIdentifier: "feat-x", lastDeployTime: 1791367200000, expiresAt: null }] });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "list", "-C", COMPANY_ID, "--project", "100", "--type", "preview", ...BASE], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(URL("deployments.list"), expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { convexProjectId: "100", deploymentType: "preview" } });
    expect(out.join("\n")).toContain("feat-x");
  });

  it("reap --dry-run sends dryRun true and prints the plan", async () => {
    const report = { at: "2026-10-09T12:00:00.000Z", dryRun: true, errors: [], quota: { count: 250, quota: 300, percent: 83.3, alert: true, partial: false },
      projects: [{ name: "app", previews: 3, ciMatched: 2, delete: [{ name: "old-1", reason: "pull request #1 is merged" }, { name: "old-2", reason: "superseded by pr4320-run101-s1-a2" }], deleted: [], setExpiry: [1], expirySet: [], kept: 2, failed: [], skipped: [],
        dev: { listed: 4, delete: [{ name: "dev-old", reason: "dev deployment unused for 12 days (limit 7)" }], deleted: [], kept: 3, failed: [], skipped: [], executed: false } }] };
    const fetchMock = respond(report);
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "reap", "--dry-run", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(URL("reaper.run"), expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { dryRun: true } });
    const text = out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("would delete old-1: pull request #1 is merged");
    expect(text).toContain("83.3%");
    expect(text).toContain("would delete old-2: superseded by pr4320-run101-s1-a2");
    expect(text).toContain("CI template matched 2 of 3 previews");
    expect(text).toContain("dev: 4 listed");
    expect(text).toContain("would delete dev-old: dev deployment unused for 12 days (limit 7)");
  });

  it("reap without --dry-run asks for a live run", async () => {
    const fetchMock = respond({ at: "2026-10-09T12:00:00.000Z", dryRun: false, errors: [], quota: null, projects: [] });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "reap", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(fetchMock).params).toEqual({ dryRun: false });
  });

  it("delete-preview passes the name and dry-run flag, and prints JSON on request", async () => {
    const fetchMock = respond({ dryRun: true, wouldDelete: true, deleted: false });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "delete-preview", "feat-x", "--dry-run", "--json", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(URL("deployments.delete-preview"), expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { name: "feat-x", dryRun: true } });
  });

  it("status and report use the matching actions", async () => {
    const status = respond({ connection: "connected" });
    vi.stubGlobal("fetch", status);
    await program().parseAsync(["convex", "status", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(status).toHaveBeenCalledWith(URL("status"), expect.anything());
    const report = respond(null);
    vi.stubGlobal("fetch", report);
    await program().parseAsync(["convex", "report", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(report).toHaveBeenCalledWith(URL("reaper.report"), expect.anything());
    expect(out.join("\n")).toContain("No reaper run yet.");
  });
});

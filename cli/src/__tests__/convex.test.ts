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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; });

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

  const row = { name: "feat-x", environment: "preview", deploymentType: "preview", previewIdentifier: "feat-x", lastDeployTime: 1791367200000, expiresAt: null };
  const project = { name: "app", previews: 3, delete: [], deleted: [], setExpiry: [], expirySet: [], kept: 3, failed: [], skipped: [] };
  const reportOf = (over: Record<string, unknown> = {}) => ({ at: "2026-10-09T12:00:00.000Z", dryRun: false, errors: [], quota: null, projects: [project], ...over });

  it("lists deployments with project and type filters and sends no paging by default", async () => {
    const fetchMock = respond({ truncated: false, total: 1, nextCursor: null, deployments: [row] });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "list", "-C", COMPANY_ID, "--project", "100", "--type", "preview", ...BASE], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(URL("deployments.list"), expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { convexProjectId: "100", deploymentType: "preview" } });
    const text = out.join("\n");
    expect(text).toContain("feat-x");
    expect(text).toContain("1 listed, 1 in total.");
    expect(text).not.toContain("--cursor");
  });

  it("pages deployments with --limit and --cursor and prints how to continue", async () => {
    const fetchMock = respond({ truncated: true, total: 120, nextCursor: "c-50", deployments: [row] });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "list", "--limit", "50", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(fetchMock).params).toEqual({ limit: 50 });
    const first = out.join("\n");
    expect(first).toContain("119 more, rerun with --cursor c-50");
    expect(first).not.toContain("filter with --project");

    out.length = 0;
    const next = respond({ truncated: true, total: 120, nextCursor: "c-100", deployments: [row] });
    vi.stubGlobal("fetch", next);
    await program().parseAsync(["convex", "deployments", "list", "--limit", "50", "--cursor", "c-50", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(next).params).toEqual({ limit: 50, cursor: "c-50" });
    expect(out.join("\n")).toContain("rerun with --cursor c-100");
  });

  it("lists the last page without a continuation hint", async () => {
    vi.stubGlobal("fetch", respond({ truncated: false, total: 51, nextCursor: null, deployments: [row] }));
    await program().parseAsync(["convex", "deployments", "list", "--cursor", "c-50", "-C", COMPANY_ID, ...BASE], { from: "user" });
    const text = out.join("\n");
    expect(text).toContain("1 listed, 51 in total.");
    expect(text).not.toContain("rerun with --cursor");
  });

  it("prints the compact page as JSON including nextCursor", async () => {
    const page = { truncated: true, total: 2, nextCursor: "c-1", deployments: [row] };
    vi.stubGlobal("fetch", respond(page));
    await program().parseAsync(["convex", "deployments", "list", "--json", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(JSON.parse(out.join("\n"))).toEqual(page);
  });

  it.each(["0", "201", "1.5", "abc", "-3"])("rejects --limit %s before any request", async limit => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(program().parseAsync(["convex", "deployments", "list", "--limit", limit, "-C", COMPANY_ID, ...BASE], { from: "user" })).rejects.toThrow(/exit 1/);
    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("reap without a flag is a dry run and says so before it sends", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect(out.join("\n")).toContain("Dry run");
      return new Response(JSON.stringify({ data: reportOf({ dryRun: true }) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "reap", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL("reaper.run"), expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { dryRun: true } });
    expect(process.exitCode).toBeUndefined();
  });

  it("reap --dry-run sends dryRun true and prints the plan", async () => {
    const report = { at: "2026-10-09T12:00:00.000Z", dryRun: true, errors: [], quota: { count: 250, quota: 300, percent: 83.3, alert: true, partial: false },
      projects: [{ name: "app", previews: 3, ciMatched: 2, delete: [{ name: "old-1", reason: "pull request #1 is merged" }, { name: "old-2", reason: "superseded by pr4320-run101-s1-a2" }], deleted: [], setExpiry: [1], expirySet: [], kept: 2, failed: [], skipped: [],
        dev: { listed: 4, delete: [{ name: "dev-old", reason: "dev deployment unused for 12 days (limit 7)" }], deleted: [], kept: 3, failed: [], skipped: [], executed: false } }] };
    const fetchMock = respond(report);
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "reap", "--dry-run", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { dryRun: true } });
    const text = out.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("would delete old-1: pull request #1 is merged");
    expect(text).toContain("83.3%");
    expect(text).toContain("would delete old-2: superseded by pr4320-run101-s1-a2");
    expect(text).toContain("CI template matched 2 of 3 previews");
    expect(text).toContain("dev: 4 listed");
    expect(text).toContain("would delete dev-old: dev deployment unused for 12 days (limit 7)");
    expect(process.exitCode).toBeUndefined();
  });

  it("reap --live sends dryRun false and announces LIVE before it sends", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect(out.join("\n")).toContain("LIVE");
      return new Response(JSON.stringify({ data: reportOf() }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "reap", "--live", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(fetchMock).params).toEqual({ dryRun: false });
    expect(process.exitCode).toBeUndefined();
  });

  it("reap refuses --live together with --dry-run", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(program().parseAsync(["convex", "deployments", "reap", "--live", "--dry-run", "-C", COMPANY_ID, ...BASE], { from: "user" })).rejects.toThrow(/exit 1/);
    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("reap --json keeps stdout parseable", async () => {
    vi.stubGlobal("fetch", respond(reportOf({ dryRun: true })));
    await program().parseAsync(["convex", "deployments", "reap", "--json", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(JSON.parse(out.join("\n")).dryRun).toBe(true);
  });

  describe("reap exit code", () => {
    const run = async (args: string[], report: unknown) => {
      vi.stubGlobal("fetch", respond(report));
      await program().parseAsync(["convex", "deployments", "reap", ...args, "-C", COMPANY_ID, ...BASE], { from: "user" });
    };

    it("is 1 on a live run with report errors", async () => {
      await run(["--live"], reportOf({ errors: ["Quota check failed: boom"] }));
      expect(process.exitCode).toBe(1);
    });
    it("is 1 on a live run with a project error", async () => {
      await run(["--live"], reportOf({ projects: [{ ...project, error: "GitHub unreachable" }] }));
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).toContain("error: GitHub unreachable");
    });
    it("is 1 on a live run with a failed delete", async () => {
      await run(["--live"], reportOf({ projects: [{ ...project, failed: [{ name: "old-1", error: "Convex said no" }] }] }));
      expect(process.exitCode).toBe(1);
    });
    it("is 1 on a dry run with a report error or a project error", async () => {
      await run([], reportOf({ dryRun: true, errors: ["Quota check failed: boom"] }));
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      await run([], reportOf({ dryRun: true, projects: [{ ...project, error: "GitHub unreachable" }] }));
      expect(process.exitCode).toBe(1);
    });
    it("stays 0 on a dry run whose only problem is a failed entry", async () => {
      await run([], reportOf({ dryRun: true, projects: [{ ...project, failed: [{ name: "old-1", error: "x" }] }] }));
      expect(process.exitCode).toBeUndefined();
    });
    it("is 1 with --json too, and an incomplete pass is shown", async () => {
      await run(["--live", "--json"], reportOf({ errors: ["x"], incomplete: "delete cap reached" }));
      expect(process.exitCode).toBe(1);
      vi.stubGlobal("fetch", respond(reportOf({ incomplete: "delete cap reached" })));
      out.length = 0;
      process.exitCode = undefined;
      await program().parseAsync(["convex", "deployments", "reap", "--live", "-C", COMPANY_ID, ...BASE], { from: "user" });
      expect(out.join("\n")).toContain("Incomplete: delete cap reached");
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("delete-preview without a flag sends dryRun true and says dry run before it sends", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect(out.join("\n")).toContain("Dry run");
      return new Response(JSON.stringify({ data: { dryRun: true, wouldDelete: true, deleted: false } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "delete-preview", "feat-x", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(fetchMock).toHaveBeenCalledWith(URL("deployments.delete-preview"), expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { name: "feat-x", dryRun: true } });
  });

  it("delete-preview --dry-run still sends dryRun true and prints JSON on request", async () => {
    const fetchMock = respond({ dryRun: true, wouldDelete: true, deleted: false });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "delete-preview", "feat-x", "--dry-run", "--json", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { name: "feat-x", dryRun: true } });
    expect(JSON.parse(out.join("\n")).wouldDelete).toBe(true);
  });

  it("delete-preview --live sends dryRun false and announces LIVE before it sends", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect(out.join("\n")).toContain("LIVE");
      return new Response(JSON.stringify({ data: { dryRun: false, wouldDelete: true, deleted: true } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await program().parseAsync(["convex", "deployments", "delete-preview", "feat-x", "--live", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(bodyOf(fetchMock)).toEqual({ companyId: COMPANY_ID, params: { name: "feat-x", dryRun: false } });
  });

  it("says so when --live was turned into a dry run by the plugin", async () => {
    vi.stubGlobal("fetch", respond({ dryRun: true, wouldDelete: true, deleted: false }));
    await program().parseAsync(["convex", "deployments", "delete-preview", "feat-x", "--live", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(out.join("\n")).toContain("--live was requested, but the plugin ran a dry run");
    out.length = 0;
    vi.stubGlobal("fetch", respond(reportOf({ dryRun: true })));
    await program().parseAsync(["convex", "deployments", "reap", "--live", "-C", COMPANY_ID, ...BASE], { from: "user" });
    expect(out.join("\n")).toContain("--live was requested, but the plugin ran a dry run");
  });

  it("documents the dry-run default in --help", () => {
    const deployments = program().commands.find(command => command.name() === "convex")!.commands.find(command => command.name() === "deployments")!;
    for (const name of ["reap", "delete-preview"]) {
      const help = deployments.commands.find(command => command.name() === name)!.helpInformation();
      expect(help, name).toContain("--live");
      expect(help, name).toMatch(/dry run is the default/i);
    }
    expect(deployments.commands.find(command => command.name() === "list")!.helpInformation()).toMatch(/--limit <n>[\s\S]*--cursor <cursor>/);
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

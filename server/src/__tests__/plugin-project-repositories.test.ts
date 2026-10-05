import { describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { listPluginProjectRepositories, mergeRepositoryOptions } from "../services/plugin-project-repositories.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "test.repositories", apiVersion: 1, version: "1.0.0", displayName: "Own GitHub App", author: "Test", description: "Test", categories: ["connector"],
  capabilities: ["ui.action.register"], entrypoints: { worker: "dist/worker.js", ui: "dist/ui" },
  projectRepositories: { listAction: "repositories", setupPath: "/github-settings" },
  ui: { slots: [{ id: "setup", type: "page", routePath: "github-settings", displayName: "Setup", exportName: "Setup" }] },
};
const plugin = { id: "plugin-id", status: "ready", manifestJson: manifest };
const repo = { id: "12", fullName: "org/repo", url: "https://github.com/org/repo", private: true };
const catalog = { repositories: [repo], connectionCount: 1, failedConnectionCount: 0 };
const worker = (call = vi.fn().mockResolvedValue(catalog)) => ({ call } as unknown as Pick<PluginWorkerManager, "call">);

describe("plugin project repositories", () => {
  it("passes immutable company and user scope to the declared action, without credentials", async () => {
    const call = vi.fn().mockResolvedValue(catalog);
    const result = await listPluginProjectRepositories([plugin], worker(call), "company", "alice");
    expect(call).toHaveBeenCalledWith("plugin-id", "performAction", {
      key: "repositories", params: { companyId: "company" }, companyId: "company",
      actorContext: { type: "user", userId: "alice", agentId: null, runId: null, companyId: "company" },
    }, 30_000);
    expect(result).toMatchObject({ ...catalog, setupPath: "/github-settings", repositories: [{ ...repo, connections: ["Own GitHub App"] }] });
  });
  it("merges built-in and plugin sources without duplicate repository identities", async () => {
    const contributed = await listPluginProjectRepositories([plugin], worker(), "company", null);
    const result = mergeRepositoryOptions({ ...catalog, repositories: [{ ...repo, connections: ["Existing connection"] }] }, contributed);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0].connections).toEqual(["Existing connection", "Own GitHub App"]);
    expect(result.connectionCount).toBe(2);
  });
  it("does not invoke disabled, undeclared or capability-less providers", async () => {
    const call = vi.fn();
    const result = await listPluginProjectRepositories([
      { ...plugin, status: "disabled" },
      { ...plugin, manifestJson: { ...manifest, projectRepositories: undefined } },
      { ...plugin, manifestJson: { ...manifest, capabilities: [] } },
    ], worker(call), "company", "alice");
    expect(call).not.toHaveBeenCalled(); expect(result.repositories).toEqual([]);
  });
  it("keeps successful sources usable and sanitizes failed or malformed responses", async () => {
    for (const invalid of [new Error("secret-value"), { ...catalog, repositories: [{ ...repo, url: "https://evil.test/org/repo" }] }, { ...catalog, repositories: [{ ...repo, id: "forged" }] }]) {
      const call = vi.fn().mockResolvedValueOnce(catalog);
      if (invalid instanceof Error) call.mockRejectedValueOnce(invalid); else call.mockResolvedValueOnce(invalid);
      const result = await listPluginProjectRepositories([plugin, { ...plugin, id: "bad" }], worker(call), "company", "alice");
      expect(result.repositories).toHaveLength(1);
      expect(result.failedConnectionCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain("secret-value");
      expect(JSON.stringify(result)).not.toContain("evil.test");
    }
  });
  it("keeps disconnected companies empty and carries setup and partial-result notices", async () => {
    const call = vi.fn().mockResolvedValueOnce({ repositories: [], connectionCount: 0, failedConnectionCount: 0 })
      .mockResolvedValueOnce({ ...catalog, warnings: ["Repository results limited"] });
    expect(await listPluginProjectRepositories([plugin], worker(call), "disconnected", null)).toMatchObject({ repositories: [], connectionCount: 0, setupPath: "/github-settings" });
    expect((await listPluginProjectRepositories([plugin], worker(call), "connected", null)).warnings).toEqual(["Repository results limited"]);
  });
  it("validates manifest capability and restricts setup links to declared page routes", () => {
    expect(pluginManifestV1Schema.parse(manifest).projectRepositories).toEqual(manifest.projectRepositories);
    expect(pluginManifestV1Schema.safeParse({ ...manifest, capabilities: ["projects.read"] }).success).toBe(false);
    for (const setupPath of ["https://evil.test", "//evil.test", "/not-declared"]) {
      expect(pluginManifestV1Schema.safeParse({ ...manifest, projectRepositories: { listAction: "repositories", setupPath } }).success).toBe(false);
    }
  });
});


describe("plugin task-list capability", () => {
  it("requires the existing detail UI capability before registering a task-list section", () => {
    const validator = pluginCapabilityValidator();
    expect(validator.checkUiSlot(manifest, "taskListToolbar").allowed).toBe(false);
    expect(validator.checkUiSlot({ ...manifest, capabilities: ["ui.detailTab.register"] }, "taskListToolbar").allowed).toBe(true);
    expect(validator.checkUiSlot(manifest, "taskListSection").allowed).toBe(false);
    expect(validator.checkUiSlot({ ...manifest, capabilities: ["ui.detailTab.register"] }, "taskListSection").allowed).toBe(true);
  });
});

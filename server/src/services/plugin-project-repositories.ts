import { z } from "zod";
import type { PaperclipPluginManifestV1, ProjectRepositoryOptions } from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { mergeProjectRepository, normalizeProjectRepositoryUrl } from "./project-repositories.js";

// Keep the existing Projects contract: numeric GitHub IDs and canonical GitHub URLs.
const catalogSchema = z.object({
  repositories: z.array(z.object({
    id: z.string().regex(/^[1-9]\d*$/),
    fullName: z.string().max(300),
    url: z.string().max(500),
    private: z.boolean().optional(),
  })).max(10_000),
  connectionCount: z.number().int().min(0).max(1000),
  failedConnectionCount: z.number().int().min(0).max(1000),
  warnings: z.array(z.string().max(1000)).max(100).optional(),
}).refine(value => value.failedConnectionCount <= value.connectionCount
  && (value.connectionCount > 0 || value.repositories.length === 0));

type RepositoryPlugin = { id: string; status: string; manifestJson: unknown };

/** Called only after route company access checks, with the authenticated board actor. */
export async function listPluginProjectRepositories(
  plugins: RepositoryPlugin[],
  workers: Pick<PluginWorkerManager, "call">,
  companyId: string,
  userId: string | null,
): Promise<ProjectRepositoryOptions> {
  let result: ProjectRepositoryOptions = { repositories: [], connectionCount: 0, failedConnectionCount: 0 };
  for (const plugin of plugins) {
    const manifest = plugin.manifestJson as PaperclipPluginManifestV1;
    const source = manifest.projectRepositories;
    if (plugin.status !== "ready" || !source || !manifest.capabilities.includes("ui.action.register")) continue;
    const setupPath = source.setupPath && manifest.ui?.slots?.some(slot => slot.type === "page" && `/${slot.routePath}` === source.setupPath)
      ? source.setupPath : undefined;
    try {
      const raw = await workers.call(plugin.id, "performAction", {
        key: source.listAction, params: { companyId }, companyId,
        actorContext: { type: "user", userId, agentId: null, runId: null, companyId },
      }, 30_000);
      const data = catalogSchema.parse(raw);
      const repositories = data.repositories.map(repo => {
        const canonical = normalizeProjectRepositoryUrl(repo.url);
        if (canonical.fullName !== repo.fullName) throw new Error("Repository name and URL disagree");
        return { ...repo, url: canonical.url, connections: [manifest.displayName] };
      });
      result = mergeRepositoryOptions(result, { ...data, repositories, setupPath });
    } catch {
      // Provider errors may include credentials; expose only a safe source label.
      result = mergeRepositoryOptions(result, { repositories: [], connectionCount: 1, failedConnectionCount: 1,
        warnings: [`${manifest.displayName}: could not load repositories. Check the connection and retry.`], setupPath });
    }
  }
  return result;
}

export function mergeRepositoryOptions(...sources: ProjectRepositoryOptions[]): ProjectRepositoryOptions {
  const repositories = new Map<string, ProjectRepositoryOptions["repositories"][number]>();
  for (const source of sources) for (const repo of source.repositories) {
    for (const connection of repo.connections) mergeProjectRepository(repositories, repo, connection);
  }
  const warnings = sources.flatMap(source => source.warnings ?? []);
  const setupPath = sources.find(source => source.setupPath)?.setupPath;
  return {
    repositories: [...repositories.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    connectionCount: sources.reduce((sum, source) => sum + source.connectionCount, 0),
    failedConnectionCount: sources.reduce((sum, source) => sum + source.failedConnectionCount, 0),
    ...(warnings.length ? { warnings } : {}), ...(setupPath ? { setupPath } : {}),
  };
}

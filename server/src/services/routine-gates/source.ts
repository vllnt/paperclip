import { and, asc, eq, inArray } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import { ROUTINE_GATE_LIMITS, type RoutineGate } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { githubBotCredentials, githubBotRequest } from "../chat-github-client.js";
import { mintNativeGitHubInstallationToken } from "../github-installation-tokens.js";
import { instanceSettingsService } from "../instance-settings.js";
import { gateScriptSha } from "./command.js";

/**
 * Why a gate script could not be loaded. `refused` is a property of the config (repo not allowed,
 * commit not merged, file missing): saving it must fail. `unavailable` is GitHub or the
 * connection being down, which a retry can fix.
 */
export class GateSourceError extends Error {
  constructor(
    message: string,
    readonly kind: "refused" | "unavailable",
    readonly code: string,
  ) {
    super(message);
    this.name = "GateSourceError";
  }
}

export interface GateScript {
  content: string;
  sha256: string;
}

export interface GateScriptSourceDeps {
  /** Lowercase `owner/name` entries that may host gate scripts. */
  allowedRepos: () => Promise<string[]>;
  /** A short-lived, read-only token for one repository. */
  mintToken: (companyId: string, repo: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const CACHE_LIMIT = 64;

function refused(code: string, message: string): GateSourceError {
  return new GateSourceError(message, "refused", code);
}

function unavailable(message: string): GateSourceError {
  return new GateSourceError(message, "unavailable", "gate_github_unavailable");
}

function providerStatus(error: unknown): number | null {
  if (error instanceof HttpError) {
    const details = error.details as { providerStatus?: unknown } | null | undefined;
    if (typeof details?.providerStatus === "number") return details.providerStatus;
  }
  return null;
}

/**
 * Loads a gate script from GitHub for a pinned commit and checks what makes "changed only by PR"
 * hold: the repo is on the instance allowlist, and the commit is reachable from the repo's
 * default branch. With a no-bypass ruleset on that repo (PR and review required), reachability
 * from the default branch means the code was merged through a reviewed PR. A commit that is only
 * on an unmerged PR branch is `ahead` of or `diverged` from the default branch and is refused.
 */
export function createGateScriptSource(deps: GateScriptSourceDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // The content of a commit never changes, so a verified (repo, sha, path) is cached for the process.
  const cache = new Map<string, GateScript>();

  async function github<T>(token: string, path: string): Promise<T> {
    try {
      return await githubBotRequest<T>(fetchImpl, token, path);
    } catch (error) {
      const status = providerStatus(error);
      if (status === 404 || status === 422) {
        throw refused("gate_script_not_found", "The repository, commit or file was not found with the GitHub App's access");
      }
      if (status === 401 || status === 403) {
        throw refused("gate_github_access_denied", "The GitHub App cannot read this repository");
      }
      throw unavailable("GitHub is temporarily unavailable. Retry.");
    }
  }

  async function load(
    companyId: string,
    gate: Pick<RoutineGate, "repo" | "path" | "commitSha">,
  ): Promise<GateScript> {
    const repoKey = gate.repo.toLowerCase();
    if (!(await deps.allowedRepos()).includes(repoKey)) {
      throw refused("gate_repo_not_allowed", `Repository ${gate.repo} is not on the gate repository allowlist`);
    }
    const cacheKey = `${repoKey}@${gate.commitSha}:${gate.path}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let token: string;
    try {
      token = await deps.mintToken(companyId, gate.repo);
    } catch (error) {
      if (error instanceof GateSourceError) throw error;
      const status = providerStatus(error);
      if (
        (status !== null && status >= 500) ||
        (error instanceof HttpError && error.status === 422 && status === null && /temporarily unavailable/i.test(error.message))
      ) {
        throw unavailable("GitHub is temporarily unavailable. Retry.");
      }
      throw refused(
        "gate_github_not_connected",
        error instanceof Error ? error.message : "Connect a GitHub App to this company before pinning gate scripts",
      );
    }

    const [owner, name] = repoKey.split("/") as [string, string];
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const repoInfo = await github<{ default_branch?: unknown }>(token, repoPath);
    const defaultBranch = typeof repoInfo.default_branch === "string" ? repoInfo.default_branch : null;
    if (!defaultBranch) throw unavailable("GitHub did not report the default branch");

    const comparison = await github<{ status?: unknown }>(
      token,
      `${repoPath}/compare/${encodeURIComponent(defaultBranch)}...${gate.commitSha}`,
    );
    if (comparison.status !== "identical" && comparison.status !== "behind") {
      throw refused(
        "gate_commit_not_on_default_branch",
        `Commit ${gate.commitSha.slice(0, 12)} is not reachable from ${gate.repo}@${defaultBranch}. Merge the script by pull request first`,
      );
    }

    const encodedPath = gate.path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    const file = await github<{ type?: unknown; size?: unknown; encoding?: unknown; content?: unknown }>(
      token,
      `${repoPath}/contents/${encodedPath}?ref=${gate.commitSha}`,
    );
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
      throw refused("gate_script_not_found", `${gate.path} is not a file at commit ${gate.commitSha.slice(0, 12)}`);
    }
    if (typeof file.size === "number" && file.size > ROUTINE_GATE_LIMITS.scriptMaxBytes) {
      throw refused("gate_script_too_large", `${gate.path} is larger than ${ROUTINE_GATE_LIMITS.scriptMaxBytes} bytes`);
    }
    const buffer = Buffer.from(file.content.replace(/\s+/g, ""), "base64");
    if (buffer.byteLength > ROUTINE_GATE_LIMITS.scriptMaxBytes) {
      throw refused("gate_script_too_large", `${gate.path} is larger than ${ROUTINE_GATE_LIMITS.scriptMaxBytes} bytes`);
    }
    const content = buffer.toString("utf8");
    const script: GateScript = { content, sha256: gateScriptSha(content) };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, script);
    return script;
  }

  return { load, clearCache: () => cache.clear() };
}

export type GateScriptSource = ReturnType<typeof createGateScriptSource>;

/** The allowlist: instance general settings plus the operator's `PAPERCLIP_ROUTINE_GATE_REPOS`. */
export function createGateRepoAllowlist(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return async (): Promise<string[]> => {
    const fromEnv = (env.PAPERCLIP_ROUTINE_GATE_REPOS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const general = await instanceSettingsService(db).getGeneral().catch(() => null);
    const fromSettings = (general?.routineGateRepos ?? []).map((entry) => entry.toLowerCase());
    return [...new Set([...fromEnv, ...fromSettings])];
  };
}

/**
 * Mints a read-only token for one repository through the company's active GitHub App connection
 * (the same App credentials the GitHub chat bot uses). Contents and metadata read only.
 */
export function createGateTokenMinter(db: Db, fetchImpl: typeof fetch = fetch) {
  return async (companyId: string, repo: string): Promise<string> => {
    const endpoint = await db
      .select({ id: chatEndpoints.id })
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.companyId, companyId),
          eq(chatEndpoints.provider, "github"),
          inArray(chatEndpoints.status, ["active", "verifying"]),
        ),
      )
      .orderBy(asc(chatEndpoints.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!endpoint) {
      throw new Error("Connect a GitHub App to this company (a GitHub chat connection) before pinning gate scripts");
    }
    const credentials = await githubBotCredentials(db, companyId, endpoint.id);
    if (!credentials.connection.enabled || credentials.connection.status !== "active") {
      throw new Error("The company's GitHub connection is not active");
    }
    if (!credentials.credentials.installationId) {
      throw new Error("Verify the GitHub App installation first");
    }
    return mintNativeGitHubInstallationToken(
      db,
      {
        companyId,
        appId: credentials.credentials.appId,
        installationId: credentials.credentials.installationId,
        repositories: [repo],
        permissions: { contents: "read", metadata: "read" },
      },
      async (call) => {
        const issued = await githubBotRequest<{ token?: string }>(fetchImpl, credentials.appJwt, call.path, {
          method: "POST",
          body: call.body,
        });
        if (!issued.token) throw new Error("GitHub did not issue an installation token");
        return issued.token;
      },
    );
  };
}

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import {
  GITHUB_PRIVILEGED_ACTIONS,
  GITHUB_WRITE_ACTIONS,
  GITHUB_WRITE_IDENTITY_STATE,
  gitHubInstallationRepositories,
  isGitHubRepositoryAllowed,
  normalizeGitHubRepository,
  parseGitHubWriteIdentityPolicy,
  resolveGitHubWriteIdentity,
  resolveGitHubWriteIdentityForOther,
  type GitHubOperationAction,
  type GitHubPrivilegedAction,
  type GitHubSignDecision,
  type GitHubWriteAction,
  type GitHubWriteIdentityDecision,
  type GitHubWriteIdentityPolicy,
  type GitHubWriteIdentityRequest,
  type GitHubWriteSurface,
} from "@paperclipai/shared/github-write-identity";
import { boardScope, requireInstanceAdmin } from "./setup.js";
import { GitHubError, type GitHubClient } from "./github.js";
import { SKILLS_LOCK_FILE, TIERS_FILE, parseProtectedPaths, protectedFiles, protectedPatterns, skillsLockException, type ChangedFile } from "./protected-paths.js";
import type { Catalog, Repository } from "./contracts.js";
import { UserAuthorization, UserAuthorizationError, type FenceStatus } from "./user-authorization.js";
import { checkGitObjectForSigning, parseSshSigningKey, sshSign, type SshSigningKey } from "./ssh-signature.js";

const policyKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, ...GITHUB_WRITE_IDENTITY_STATE });
const BOT_PERMISSIONS = ["contents", "pull_requests", "issues"] as const;
const READ_PERMISSIONS = ["contents", "issues", "pull_requests", "actions", "checks", "statuses"] as const;
const BOT_USER_TTL_MS = 24 * 60 * 60 * 1000;
const READ_TOKEN_TTL_MS = 50 * 60_000;
const SIGNING_KEY_TTL_MS = 5 * 60_000;
/** Writes stop when the last successful fence check is older than this. */
const FENCE_MAX_AGE_MS = 3 * 60 * 60_000;
const FENCE_CHECK_INTERVAL_MS = 60 * 60_000;
const MAX_SIGN_PAYLOAD_BYTES = 1024 * 1024;
/** A full commit SHA (SHA-1 or SHA-256 repositories), lowercase as GitHub reports it. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** GitHub lists at most 3,000 files of a pull request, 100 per page: a longer list is cut, and the merge is refused. */
const MAX_PULL_REQUEST_FILE_PAGES = 30;
/** Pages read for a fence or merge check; a list that still has a next page after this fails closed. */
const MAX_PAGES = 10;
/** The conclusions of a finished check run that pass a required check, as GitHub counts them. */
const PASSING_CONCLUSIONS = ["success", "skipped"];

/** Reads every page of a paginated GitHub list, or throws when it has more than {@link MAX_PAGES} pages. */
async function allPages<T>(read: (page: number) => Promise<{ items: T[]; next: boolean }>, what: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await read(page);
    items.push(...response.items);
    if (!response.next) return items;
  }
  throw new PagesExceeded(`GitHub returned more than ${MAX_PAGES} pages of ${what}; Paperclip cannot check them all.`);
}
class PagesExceeded extends Error {}

type Auth = { id: string; pem: string };
type StoredPolicy = { policy: GitHubWriteIdentityPolicy } | { invalid: true } | null;
/** A plugin-side write (sync, board actions, agent tools): the App, or the App user's token. */
export type PluginWriteRequest = {
  action: GitHubOperationAction;
  privileged?: GitHubPrivilegedAction[];
  pullRequest?: number;
  expectedHeadSha?: string;
  /** A pull request merge (the protected-path guard checks it), or one that enables auto-merge (refused). */
  merge?: boolean;
  autoMerge?: boolean;
  /** Changes an open pull request's base branch (refused). */
  retarget?: boolean;
  source: "sync" | "board" | "tool";
  agentId?: string | null;
  runId?: string | null;
};

/**
 * Sliding-window write budget per GitHub user (GitHub's secondary limits are
 * per user, shared with that person's own activity).
 */
export class WriteThrottle {
  private hits = new Map<string, number[]>();
  /** Records one write, or returns the seconds to wait when the budget is spent. */
  take(key: string, limits: { perMinute: number; perHour: number }, now = Date.now()): number | null {
    const recent = (this.hits.get(key) ?? []).filter(at => at > now - 3_600_000);
    const lastMinute = recent.filter(at => at > now - 60_000);
    if (lastMinute.length >= limits.perMinute) return Math.ceil((lastMinute[0]! + 60_000 - now) / 1000);
    if (recent.length >= limits.perHour) return Math.ceil((recent[0]! + 3_600_000 - now) / 1000);
    recent.push(now);
    this.hits.set(key, recent);
    return null;
  }
}

class Denied extends Error {
  evidence?: Record<string, unknown>;
  constructor(message: string, evidence?: Record<string, unknown>) { super(message); this.evidence = evidence; }
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "secret_ref" && typeof (value as { secretId?: unknown }).secretId === "string";
}

/**
 * Write identity: who acts on GitHub for this company.
 *
 * With `userSource: "run"` a `user` write defers to the run's own identity,
 * which the Paperclip server resolves. With `userSource: "app"` the plugin
 * answers every managed operation itself: reads get a read-only installation
 * token for one repository, writes get the authorizing person's App user
 * token after the kill switch, allowlist, privileged toggles, fence and
 * throttle checks. There is never a fallback identity for a denied write.
 */
export function registerWriteIdentity(
  ctx: PluginContext,
  github: GitHubClient,
  credentials: (companyId: string) => Promise<Auth>,
  loadCatalog: (companyId: string) => Promise<Catalog>,
  now: () => number = () => Date.now(),
  /** Drops the company's cached GitHub reads (catalog included) when its policy changes. */
  invalidate: (companyId: string) => void = () => {},
) {
  const botUsers = new Map<string, { userId: string; expires: number }>();
  const readTokens = new Map<string, { token: string; expires: number }>();
  const signingKeys = new Map<string, { secretId: string; key: SshSigningKey; expires: number }>();
  const throttle = new WriteThrottle();
  const users = new UserAuthorization(ctx, github, now);

  async function stored(companyId: string): Promise<StoredPolicy> {
    const value = await ctx.state.get(policyKey(companyId));
    if (value === null || value === undefined) return null;
    try { return { policy: parseGitHubWriteIdentityPolicy(value) }; } catch {
      // Only write-identity.set writes this key, after validation. Fail closed.
      ctx.logger.warn("Stored GitHub write identity is invalid; GitHub access is stopped", { companyId });
      return { invalid: true };
    }
  }

  async function policy(companyId: string): Promise<GitHubWriteIdentityPolicy | null> {
    const current = await stored(companyId);
    if (!current) return null;
    if ("invalid" in current) throw new Denied("The saved GitHub write identity is invalid. An instance administrator must save it again.");
    return current.policy;
  }

  /**
   * Bumped by every policy change, per company. Cached read tokens are keyed by
   * it, and a token minted while it changed is revoked instead of cached or handed out.
   */
  const policyVersions = new Map<string, number>();
  const policyVersion = (companyId: string) => policyVersions.get(companyId) ?? 0;

  /** Every token or catalog cached under the previous policy is dropped, so a switch to the App user applies at once. */
  function policyChanged(companyId: string) {
    policyVersions.set(companyId, policyVersion(companyId) + 1);
    readTokens.clear();
    invalidate(companyId);
  }

  async function savePolicy(companyId: string, next: GitHubWriteIdentityPolicy) {
    await ctx.state.set(policyKey(companyId), next);
    policyChanged(companyId);
    // Under the App user the App never writes (I-RO): revoke the App write tokens this worker minted in the last hour.
    if (next.userSource === "app") {
      try { await github.revokeWriteTokens((await credentials(companyId)).id); }
      catch { ctx.logger.warn("Could not revoke the GitHub App's recent write tokens after the switch to the App user", { companyId }); }
    }
  }

  function identityKind(current: GitHubWriteIdentityPolicy | null, repository: string | null, action: GitHubOperationAction, surface: GitHubWriteSurface) {
    return action === "other" || action === "project"
      ? resolveGitHubWriteIdentityForOther(current, { repository, surface })
      : resolveGitHubWriteIdentity(current, { repository, action, surface });
  }

  async function botUserId(slug: string, token: string): Promise<string> {
    const cached = botUsers.get(slug);
    if (cached && cached.expires > now()) return cached.userId;
    const { data } = await github.request<{ id?: unknown }>(`/users/${encodeURIComponent(`${slug}[bot]`)}`, token);
    if (!Number.isSafeInteger(data.id)) throw new Error("GitHub did not return the App's bot account.");
    const userId = String(data.id);
    botUsers.set(slug, { userId, expires: now() + BOT_USER_TTL_MS });
    return userId;
  }

  /** A write token for one repository, limited to what the App's installation was granted. */
  async function botCredential(companyId: string, repository: Repository): Promise<{ token: string; login: string; userId: string }> {
    const auth = await credentials(companyId);
    const catalog = await loadCatalog(companyId);
    const granted = repository.permissions ?? {};
    const permissions: Record<string, string> = { metadata: "read" };
    for (const key of BOT_PERMISSIONS) if (granted[key] === "write" || granted[key] === "read") permissions[key] = granted[key];
    const token = await github.scopedToken(auth.id, auth.pem, repository.installationId, permissions, repository.id);
    return { token, login: `${catalog.app.slug}[bot]`, userId: await botUserId(catalog.app.slug, token) };
  }

  async function repositoryFor(companyId: string, fullName: string): Promise<Repository | undefined> {
    const name = normalizeGitHubRepository(fullName)?.repository;
    return name ? (await loadCatalog(companyId)).repositories.find(repo => repo.fullName.toLowerCase() === name) : undefined;
  }

  /**
   * A read-only installation token for one fenced repository, or for all of
   * them when the command names none (GraphQL, search). Either carries org
   * Projects read when the installation grants it: `gh project` runs inside a
   * checkout, which names its repository. Cached for 50 minutes; installation
   * tokens last one hour.
   */
  async function readToken(companyId: string, current: GitHubWriteIdentityPolicy, repository: string | null): Promise<string> {
    const catalog = await loadCatalog(companyId);
    const fence = gitHubInstallationRepositories(current);
    const readable = catalog.repositories.filter(repo => fence.includes(repo.fullName.toLowerCase()));
    const targets = repository ? readable.filter(repo => repo.fullName.toLowerCase() === repository) : readable;
    if (!targets.length) throw new Denied(repository ? `${repository} is outside this company's GitHub fence.` : "No fenced repository is available to the company's GitHub App.");
    const installationId = targets[0]!.installationId;
    const scoped = targets.filter(repo => repo.installationId === installationId);
    const ids = scoped.map(repo => repo.id).sort((a, b) => a - b);
    const version = policyVersion(companyId);
    const key = `${version}:${companyId}:${installationId}:${repository ? ids[0] : "*"}`;
    const cached = readTokens.get(key);
    if (cached && cached.expires > now()) return cached.token;
    const granted = catalog.installations.find(installation => installation.id === installationId)?.permissions ?? targets[0]!.permissions ?? {};
    const permissions: Record<string, string> = { metadata: "read" };
    for (const name of READ_PERMISSIONS) if (granted[name]) permissions[name] = "read";
    if (granted.organization_projects) permissions.organization_projects = "read";
    const auth = await credentials(companyId);
    // One repository by ID, or the fenced repositories by name; never the whole installation (I-RO).
    const token = await github.scopedToken(auth.id, auth.pem, installationId, permissions, repository ? [ids[0]!] : scoped.map(repo => repo.fullName).sort());
    if (version !== policyVersion(companyId)) {
      // The fence may have narrowed while GitHub minted this token: never cache or use it.
      await github.revokeInstallationToken(token);
      throw new Denied("The company's GitHub write identity changed while this command was checked; run it again.");
    }
    readTokens.set(key, { token, expires: now() + READ_TOKEN_TTL_MS });
    return token;
  }

  async function signingKey(companyId: string): Promise<SshSigningKey | null> {
    const ref = (await ctx.config.get(companyId)).signingKey;
    if (!isSecretRef(ref)) return null;
    const cached = signingKeys.get(companyId);
    if (cached && cached.secretId === ref.secretId && cached.expires > now()) return cached.key;
    const key = parseSshSigningKey(await ctx.secrets.resolve(ref, { companyId, configPath: "signingKey" }));
    signingKeys.set(companyId, { secretId: ref.secretId, key, expires: now() + SIGNING_KEY_TTL_MS });
    return key;
  }

  /** The authorizing person, once the fence was verified recently. Throws a user-facing reason otherwise. */
  async function fencedUser(companyId: string): Promise<{ login: string; userId: string }> {
    const state = await users.state(companyId);
    if (!state) throw new Denied("Authorize the GitHub user for this company first (user-authorization.start).");
    if (state.needsReauthorization) throw new Denied(state.needsReauthorization);
    const fence = state.fence;
    if (!fence?.ok) throw new Denied(`The GitHub fence check has not passed${fence?.reason ? `: ${fence.reason}` : ""}.`);
    if (now() - Date.parse(fence.checkedAt) > FENCE_MAX_AGE_MS) throw new Denied("The GitHub fence check is out of date; writes resume after the next successful check.");
    return { login: state.login, userId: state.userId };
  }

  async function userToken(companyId: string): Promise<string> {
    try { return await users.accessToken(companyId); }
    catch (error) { throw new Denied(error instanceof UserAuthorizationError ? error.message : "The GitHub user token is temporarily unavailable."); }
  }

  /**
   * Compares what the user token can reach at GitHub with the policy:
   * the user, the one installation, its repository selection, repositories and
   * permissions. Any difference turns writes off (fail closed).
   */
  async function checkFence(companyId: string): Promise<FenceStatus> {
    const current = await policy(companyId);
    if (!current || current.userSource !== "app") throw new Error("Choose the App user identity (userSource app) first.");
    const state = await users.state(companyId);
    if (!state) throw new Error("Authorize the GitHub user for this company first.");
    const checkedAt = new Date(now()).toISOString();
    let status: FenceStatus;
    try {
      const token = await users.accessToken(companyId);
      const { data: user } = await github.request<{ login?: unknown; id?: unknown }>("/user", token);
      const login = typeof user.login === "string" ? user.login : "";
      const installations = await allPages(async page => {
        const response = await github.request<{ installations?: Array<Record<string, any>> }>(`/user/installations?per_page=100&page=${page}`, token);
        return { items: response.data.installations ?? [], next: response.next };
      }, "App installations");
      const catalog = await loadCatalog(companyId);
      const installation = installations[0];
      const problems: string[] = [];
      if (login.toLowerCase() !== current.userLogin?.toLowerCase() || String(user.id) !== state.userId) problems.push(`the token belongs to ${login || "an unknown account"}, not ${current.userLogin}`);
      if (installations.length !== 1 || !installation) problems.push(`the token reaches ${installations.length} App installations; expected exactly one`);
      else {
        if (!catalog.installations.some(candidate => candidate.id === installation.id)) problems.push(`installation ${installation.id} is not one of the company's allowed owners`);
        if (installation.repository_selection !== "selected") problems.push("the installation covers all repositories; select only the fenced ones");
        const permissions = (installation.permissions ?? {}) as Record<string, string>;
        if (permissions.statuses && permissions.statuses !== "read") problems.push("the App holds statuses write and could forge required checks");
        const approved = current.installationPermissions ?? {};
        const differences = [...new Set([...Object.keys(permissions), ...Object.keys(approved)])].sort()
          .filter(name => permissions[name] !== approved[name]).map(name => `${name}: ${permissions[name] ?? "none"} (approved ${approved[name] ?? "none"})`);
        if (differences.length) problems.push(`installation permissions differ: ${differences.join(", ")}`);
        // The App's own permissions include account permissions (for example SSH or GPG keys)
        // that a user token carries beyond the installation; they must match the approved set too.
        const appPermissions = (catalog.app.permissions ?? {}) as Record<string, string>;
        const appDifferences = [...new Set([...Object.keys(appPermissions), ...Object.keys(approved)])].sort()
          .filter(name => appPermissions[name] !== approved[name]).map(name => `${name}: ${appPermissions[name] ?? "none"} (approved ${approved[name] ?? "none"})`);
        if (appDifferences.length) problems.push(`App permissions differ: ${appDifferences.join(", ")}`);
        const listed = await allPages(async page => {
          const response = await github.request<{ repositories?: Array<{ full_name?: unknown; id?: unknown }> }>(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token);
          return { items: (response.data.repositories ?? []).map(repo => ({ name: typeof repo.full_name === "string" ? repo.full_name.toLowerCase() : "(unnamed)", id: Number.isSafeInteger(repo.id) ? Number(repo.id) : null })), next: response.next };
        }, "installation repositories");
        const repositories = listed.map(repo => repo.name);
        const expected = gitHubInstallationRepositories(current);
        const extra = repositories.filter(name => !expected.includes(name)), missing = expected.filter(name => !repositories.includes(name));
        if (extra.length || missing.length) problems.push(`installation repositories differ from the fence${extra.length ? `; extra: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
        // The fence is by name; the repository behind a name is pinned by ID (GitHub's view through the user and the App must agree).
        const pinned = state.fence?.repositoryIds ?? {};
        const ids: Record<string, number> = {};
        for (const repo of listed) {
          if (repo.id === null) continue;
          ids[repo.name] = repo.id;
          const app = catalog.repositories.find(candidate => candidate.fullName.toLowerCase() === repo.name);
          if (pinned[repo.name] !== undefined && pinned[repo.name] !== repo.id) problems.push(`${repo.name} is now a different repository (ID ${repo.id}, was ${pinned[repo.name]})`);
          else if (app && app.id !== repo.id) problems.push(`${repo.name} has ID ${repo.id} for the user but ${app.id} for the App`);
        }
        status = { ok: problems.length === 0, checkedAt, installationId: Number(installation.id), repositories: repositories.sort(), permissions,
          repositoryIds: problems.length ? { ...ids, ...pinned } : { ...pinned, ...ids }, ...(problems.length ? { reason: problems.join("; ") } : {}) };
      }
      status ??= { ok: false, checkedAt, reason: problems.join("; ") };
    } catch (error) {
      if (UserAuthorization.rejected(error)) await users.revoked(companyId, "GitHub rejected the user token (authorization revoked). Authorize the GitHub user again.");
      const reason = error instanceof UserAuthorizationError || error instanceof PagesExceeded ? error.message
        : UserAuthorization.rejected(error) ? "GitHub rejected the user token (authorization revoked)."
        : "GitHub could not be reached to check the fence.";
      // A network failure is not drift: writes pause (the check is not ok) and resume after the next good check.
      // A list too long to read whole is drift: writes stop until an administrator re-enables them.
      status = { ok: false, checkedAt, reason, ...(error instanceof UserAuthorizationError || error instanceof PagesExceeded || UserAuthorization.rejected(error) ? {} : { transient: true }) };
    }
    // A failed check keeps the pinned repository IDs: only an administrator saving the policy re-pins them.
    await users.updateState(companyId, latest => ({ ...latest, fence: { ...status, repositoryIds: status.repositoryIds ?? latest.fence?.repositoryIds } }));
    if (!status.ok && !status.transient) {
      // Drift or revocation: switch user-identity writes off until an administrator re-enables them.
      const latest = await policy(companyId);
      if (latest?.enabled) {
        await savePolicy(companyId, { ...latest, enabled: false });
        await ctx.activity.log({ companyId, message: "github.fence_violation", metadata: { reason: status.reason ?? "unknown", writesDisabled: true } });
      }
    }
    return status;
  }

  /**
   * P4b: a merge as the App user goes ahead only when its diff touches no
   * protected path. The protected list is read from the base branch (never the
   * head): the plugin's minimum list plus `protectedPaths` of paperclip/tiers.yaml
   * at the base commit. The files are every file of the pull request at the
   * expected head (renames count both names, deletions count), read whole;
   * a cut list, an unreadable tiers file or a head that moves refuses. The merge
   * itself names the head SHA, so a push after this check fails it.
   */
  async function protectedPathEvidence(companyId: string, current: GitHubWriteIdentityPolicy, repository: string, pullRequest: number | null | undefined, expectedHeadSha: string | null | undefined) {
    const human = `a human must merge it: ${current.userLogin ?? "the App user"} in the GitHub web UI`;
    expectedHeadSha = expectedHeadSha?.toLowerCase() ?? null;
    if (!pullRequest || !expectedHeadSha || !FULL_SHA.test(expectedHeadSha)) {
      throw new Denied("A merge needs the pull request number and its full expected head commit SHA (gh pr merge <number> --match-head-commit <40-character sha>), so a push after Paperclip's check fails the merge.");
    }
    const token = await readToken(companyId, current, repository);
    const readPullRequest = async () => (await github.request<any>(`/repos/${repository}/pulls/${pullRequest}`, token)).data;
    const pr = await readPullRequest();
    const headSha = String(pr?.head?.sha ?? ""), baseSha = String(pr?.base?.sha ?? "");
    const evidence: Record<string, unknown> = { pullRequest, headSha, baseSha };
    if (pr?.state !== "open") throw new Denied(`Pull request #${pullRequest} is not open.`, evidence);
    if (!FULL_SHA.test(headSha) || headSha !== expectedHeadSha) throw new Denied(`Pull request #${pullRequest} head is ${headSha.slice(0, 12)}, not the expected ${expectedHeadSha.slice(0, 12)}.`, evidence);
    if (!FULL_SHA.test(baseSha)) throw new Denied(`GitHub did not report the base commit of pull request #${pullRequest}; ${human}.`, evidence);
    const file = async (path: string, ref: string): Promise<string | null> => {
      try {
        const { data } = await github.request<any>(`/repos/${repository}/contents/${path}?ref=${ref}`, token);
        if (data?.type !== "file" || data?.encoding !== "base64" || typeof data?.content !== "string") throw new Error("not a readable file");
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null;
        throw error;
      }
    };
    let tiers: string[] | null;
    try {
      const text = await file(TIERS_FILE, baseSha);
      tiers = text === null ? null : parseProtectedPaths(text);
    } catch (error) {
      throw new Denied(`Paperclip cannot read ${TIERS_FILE} on the base branch${error instanceof Error && !(error instanceof GitHubError) ? ` (${error.message})` : ""}, so it cannot tell which paths are protected; ${human}.`, evidence);
    }
    const patterns = protectedPatterns(repository, tiers);
    const files: ChangedFile[] = [];
    for (let page = 1; ; page += 1) {
      if (page > MAX_PULL_REQUEST_FILE_PAGES) throw new Denied(`Pull request #${pullRequest} changes more files than GitHub lists (3,000), so Paperclip cannot check them all; ${human}.`, evidence);
      const response = await github.request<any[]>(`/repos/${repository}/pulls/${pullRequest}/files?per_page=100&page=${page}`, token);
      for (const entry of Array.isArray(response.data) ? response.data : []) {
        if (typeof entry?.filename !== "string") throw new Denied(`GitHub reported a changed file without a name; ${human}.`, evidence);
        files.push({ filename: entry.filename, previousFilename: typeof entry.previous_filename === "string" ? entry.previous_filename : null });
      }
      if (!response.next) break;
    }
    if (files.length >= 3000 || !Number.isSafeInteger(pr.changed_files) || files.length !== pr.changed_files) {
      throw new Denied(`GitHub listed ${files.length} of the ${Number(pr.changed_files) || "?"} files pull request #${pullRequest} changes, so Paperclip cannot check them all; ${human}.`, evidence);
    }
    // The list belongs to this head: the pull request must not have moved meanwhile.
    const again = await readPullRequest();
    if (again?.head?.sha !== headSha || again?.base?.sha !== baseSha) throw new Denied(`Pull request #${pullRequest} changed while Paperclip checked it; run the merge again.`, evidence);
    const touched = protectedFiles(files, patterns);
    if (!touched.length) return { ...evidence, files: files.length, protectedPaths: patterns.length };
    if (touched.length === 1 && touched[0] === SKILLS_LOCK_FILE) {
      const [baseLock, headLock] = await Promise.all([file(SKILLS_LOCK_FILE, baseSha), file(SKILLS_LOCK_FILE, headSha)]).catch(() => [null, null]);
      const reason = baseLock === null || headLock === null ? `${SKILLS_LOCK_FILE} could not be read at both ends` : skillsLockException({ baseLock, headLock, files, patterns });
      if (reason === null) return { ...evidence, files: files.length, protectedPaths: patterns.length, skillsLockSnapshotOnly: true };
      throw new Denied(`This pull request changes the protected path ${SKILLS_LOCK_FILE} beyond skill snapshot hashes (${reason}); agents cannot merge it, ${human}.`, { ...evidence, protectedFiles: touched });
    }
    const listed = touched.slice(0, 20).join(", ") + (touched.length > 20 ? `, and ${touched.length - 20} more` : "");
    throw new Denied(`This pull request changes protected paths (${listed}); agents cannot merge it, ${human}.`, { ...evidence, protectedFiles: touched });
  }

  /**
   * An `--admin` merge goes ahead only for the head SHA the caller expects,
   * only on a base branch whose classic protection binds administrators and
   * requires at least one check, and only when every required check on that
   * head concluded `success` (read with the App's read-only token). GitHub's
   * branch read never includes `enforce_admins` (that needs the Administration
   * permission); it reports administrators as bound by
   * `required_status_checks.enforcement_level: "everyone"`. When administrators
   * are not bound, `--admin` skips every rule of the branch; without a required
   * check, nothing bounds what is merged.
   */
  async function adminMergeEvidence(companyId: string, current: GitHubWriteIdentityPolicy, repository: string, pullRequest: number | null | undefined, expectedHeadSha: string | null | undefined) {
    expectedHeadSha = expectedHeadSha?.toLowerCase() ?? null;
    if (!pullRequest || !expectedHeadSha || !FULL_SHA.test(expectedHeadSha)) {
      throw new Denied("An admin merge needs the pull request number and its full expected head commit SHA (gh pr merge <number> --admin --match-head-commit <40-character sha>).");
    }
    const token = await readToken(companyId, current, repository);
    const { data: pr } = await github.request<any>(`/repos/${repository}/pulls/${pullRequest}`, token);
    const headSha = String(pr?.head?.sha ?? "");
    const evidence: Record<string, unknown> = { pullRequest, expectedHeadSha, headSha, base: pr?.base?.ref ?? null };
    if (pr?.state !== "open") throw new Denied(`Pull request #${pullRequest} is not open.`, evidence);
    // Exact equality of full SHAs: a prefix would let another commit with the same prefix through.
    if (!FULL_SHA.test(headSha) || headSha !== expectedHeadSha) {
      throw new Denied(`Pull request #${pullRequest} head is ${headSha.slice(0, 12)}, not the expected ${expectedHeadSha.slice(0, 12)}.`, evidence);
    }
    const base = encodeURIComponent(String(pr.base.ref));
    const elsewhere = "Merge it without --admin (gh pr merge) or in the GitHub web UI";
    // Only classic protection that binds administrators holds --admin to its rules: ruleset bypass actors are hidden from the read-only token.
    let branch: any;
    try { branch = (await github.request<any>(`/repos/${repository}/branches/${base}`, token)).data; } catch {
      throw new Denied("Paperclip cannot read the base branch protection, so it cannot tell whether --admin would bypass it; an admin merge is refused.", evidence);
    }
    const protection = branch?.protection;
    // enforcement_level "everyone" is how the branch read reports enforce_admins. An explicit level decides; enforce_admins counts
    // only when the level is absent, and enforce_admins reported off always refuses: contradictory data fails closed.
    const level = protection?.required_status_checks?.enforcement_level, enforceAdmins = protection?.enforce_admins?.enabled;
    evidence.enforcementLevel = typeof level === "string" ? level : null;
    if (typeof enforceAdmins === "boolean") evidence.enforceAdmins = enforceAdmins;
    const bound = typeof level === "string" ? level === "everyone" : enforceAdmins === true;
    if (protection?.enabled !== true || enforceAdmins === false || !bound) {
      const state = [`branch protection ${protection?.enabled === true ? "on" : "off"}`, `enforcement_level ${evidence.enforcementLevel ?? "not reported"}`,
        ...(typeof enforceAdmins === "boolean" ? [`enforce_admins ${enforceAdmins ? "on" : "off"}`] : [])].join(", ");
      throw new Denied(`The base branch lets administrators bypass its protection (${state}; Paperclip needs enforcement_level "everyone"), so --admin would skip its rules; an admin merge is refused. ${elsewhere}, or turn on "Do not allow bypassing the above settings" for the base branch.`, evidence);
    }
    // Every page of rules, check runs and statuses is read, or the merge is refused.
    const pages = async <T>(read: (page: number) => Promise<{ items: T[]; next: boolean }>, what: string) => {
      try { return await allPages(read, what); } catch (error) {
        if (error instanceof PagesExceeded) throw new Denied(error.message, evidence);
        throw error;
      }
    };
    // Required checks come from rulesets and from classic branch protection.
    const rules = await pages(async page => {
      const response = await github.request<any[]>(`/repos/${repository}/rules/branches/${base}?per_page=100&page=${page}`, token);
      return { items: Array.isArray(response.data) ? response.data : [], next: response.next };
    }, "branch rules");
    const classic = protection?.required_status_checks ?? {};
    const required = [
      ...(Array.isArray(rules) ? rules : []).filter(rule => rule?.type === "required_status_checks")
        .flatMap(rule => (rule.parameters?.required_status_checks ?? []) as Array<{ context?: unknown; integration_id?: unknown }>)
        .map(check => ({ context: check.context, integrationId: check.integration_id })),
      ...((classic.checks ?? []) as Array<{ context?: unknown; app_id?: unknown }>).map(check => ({ context: check.context, integrationId: check.app_id })),
      ...((classic.contexts ?? []) as unknown[]).map(context => ({ context, integrationId: null })),
    ].filter(check => typeof check.context === "string")
      .map(check => ({ context: String(check.context), integrationId: Number.isSafeInteger(check.integrationId) && Number(check.integrationId) > 0 ? Number(check.integrationId) : null }));
    evidence.requiredChecks = [...new Set(required.map(check => check.context))];
    // Reported checks are whatever happened to run on the head (a slow check may not have started), so they never stand in for required ones.
    if (!required.length) throw new Denied(`The base branch requires no status check, so nothing bounds an admin merge; an admin merge is refused. ${elsewhere}, or require a status check on the base branch.`, { ...evidence, failing: [] });
    const all = await pages(async page => {
      const response = await github.request<{ check_runs?: any[] }>(`/repos/${repository}/commits/${headSha}/check-runs?per_page=100&page=${page}`, token);
      return { items: (response.data.check_runs ?? []).map(run => ({ id: Number(run.id) || 0, name: String(run.name), status: String(run.status), conclusion: run.conclusion ?? null, appId: Number.isSafeInteger(run.app?.id) ? Number(run.app.id) : null })), next: response.next };
    }, "check runs");
    // Only the latest run of each check counts: an old success never hides a failed rerun.
    const latest = new Map<string, (typeof all)[number]>();
    for (const run of all) {
      const key = `${run.name}\u0000${run.appId}`;
      if ((latest.get(key)?.id ?? -1) < run.id) latest.set(key, run);
    }
    const runs = [...latest.values()];
    const statuses = (await pages(async page => {
      const response = await github.request<{ statuses?: any[] }>(`/repos/${repository}/commits/${headSha}/status?per_page=100&page=${page}`, token);
      return { items: response.data.statuses ?? [], next: response.next };
    }, "commit statuses")).map(status => ({ context: String(status.context), state: String(status.state) }));
    const checks = [...runs.map(run => ({ name: run.name, result: run.status === "completed" ? run.conclusion ?? "none" : run.status })),
      ...statuses.map(status => ({ name: status.context, result: status.state }))];
    evidence.checks = checks;
    if (!checks.length) throw new Denied(`No check has reported on ${headSha.slice(0, 12)}; an admin merge needs green checks.`, { ...evidence, failing: [] });
    // GitHub passes a required check that succeeded or was skipped (a job its path filter or condition skipped); a commit status has no skipped state.
    const failing = required.filter(check => !runs.some(run => run.name === check.context && run.status === "completed" && PASSING_CONCLUSIONS.includes(String(run.conclusion)) && (check.integrationId === null || run.appId === check.integrationId))
      && !(check.integrationId === null && statuses.some(status => status.context === check.context && status.state === "success"))).map(check => check.context);
    if (failing.length) throw new Denied(`Required checks have not all passed (success or skipped) on ${headSha.slice(0, 12)}: ${[...new Set(failing)].join(", ")}.`, { ...evidence, failing: [...new Set(failing)] });
    return evidence;
  }

  /** Every gate a user-identity write passes. Returns the person, token and any privileged-action evidence. */
  async function authorizeUserWrite(companyId: string, current: GitHubWriteIdentityPolicy, input: {
    repository: string | null; action: GitHubOperationAction; privileged: GitHubPrivilegedAction[]; pullRequest?: number | null; expectedHeadSha?: string | null;
    merge?: boolean; autoMerge?: boolean; retarget?: boolean;
  }) {
    if (!current.enabled) throw new Denied("GitHub writes are switched off for this company (write identity kill switch).");
    if (input.repository === null && input.action !== "project") {
      throw new Denied("Paperclip cannot check this write against the repository fence. Name the repository (-R owner/name or a repos/<owner>/<name> path).");
    }
    if (input.repository !== null && !isGitHubRepositoryAllowed(current, input.repository)) throw new Denied(`${input.repository} is not in this company's GitHub write allowlist.`);
    const off = input.privileged.filter(action => !current.privileged[action]);
    if (off.length) throw new Denied(`This is a privileged GitHub action (${off.join(", ")}) and it is turned off for this company.`);
    const user = await fencedUser(companyId);
    // Phase 1: no auto-merge and no merge queue as the App user (GitHub would merge later, unchecked).
    if (input.autoMerge) throw new Denied(`Agents do not enable auto-merge or the merge queue: a human must merge this pull request, ${current.userLogin ?? "the App user"} in the GitHub web UI.`);
    // A pull request checked against one base could otherwise be retargeted (for example to main) after the merge guard.
    if (input.retarget) throw new Denied(`Agents do not change a pull request's base branch: a human must, ${current.userLogin ?? "the App user"} in the GitHub web UI.`);
    const merged = (input.merge || input.privileged.includes("adminMerge")) && input.repository
      ? await protectedPathEvidence(companyId, current, input.repository, input.pullRequest, input.expectedHeadSha)
      : undefined;
    const admin = input.privileged.includes("adminMerge") && input.repository
      ? await adminMergeEvidence(companyId, current, input.repository, input.pullRequest, input.expectedHeadSha)
      : undefined;
    const evidence = merged || admin ? { ...(merged ? { protectedPaths: merged } : {}), ...(admin ? { adminMerge: admin } : {}) } : undefined;
    const wait = throttle.take(user.userId, current.throttle, now());
    if (wait !== null) throw new Denied(`rate_limited: the GitHub write budget for ${user.login} is spent; retry in ${wait} seconds.`, evidence);
    // The checks above can take a while (an admin merge reads checks and statuses): the kill switch,
    // the allowlist and the authorization are read again right before the token is handed out.
    const latest = await policy(companyId);
    if (!latest || latest.userSource !== "app" || !latest.enabled) throw new Denied("GitHub writes are switched off for this company (write identity kill switch).", evidence);
    if (input.repository !== null && !isGitHubRepositoryAllowed(latest, input.repository)) throw new Denied(`${input.repository} is not in this company's GitHub write allowlist.`, evidence);
    if (input.privileged.some(action => !latest.privileged[action])) throw new Denied("A privileged GitHub action this write needs was turned off for this company.", evidence);
    await fencedUser(companyId);
    return { user, token: await userToken(companyId), evidence };
  }

  async function decide(companyId: string, request: GitHubWriteIdentityRequest): Promise<GitHubWriteIdentityDecision> {
    const current = await policy(companyId);
    const repository = request.repository ? normalizeGitHubRepository(request.repository)?.repository ?? null : null;
    if (!current || current.userSource === "run") {
      // The run's own identity; reads and local commands never consult the policy.
      if (!request.action || (request.access === "read" && !request.privileged.length)) return { identity: "user", missingUserConnection: current?.missingUserConnection ?? "fail" };
      // A privileged action is checked whatever the access the classifier reported.
      if (current && (request.access === "write" || request.privileged.length > 0)) {
        if (!current.enabled) return { identity: "user", unavailable: "GitHub writes are switched off for this company (write identity kill switch)." };
        if (current.allowedRepositories.length && !repository) return { identity: "user", unavailable: "Paperclip cannot tell which repository this write targets; name it with -R owner/name." };
        if (repository && !isGitHubRepositoryAllowed(current, repository)) return { identity: "user", unavailable: `${repository} is not in this company's GitHub write allowlist.` };
        const off = request.privileged.filter(action => !current.privileged[action]);
        if (off.length) return { identity: "user", unavailable: `This is a privileged GitHub action (${off.join(", ")}) and it is turned off for this company.` };
      }
      const identity = identityKind(current, repository, request.action, "runtime");
      if (identity === "user") {
        if (request.fallback !== true) return { identity: "user", missingUserConnection: current?.missingUserConnection ?? "fail" };
        if ((current?.missingUserConnection ?? "fail") !== "use_bot") return { identity: "bot", unavailable: "Connect your GitHub account in Paperclip to write as yourself." };
      }
      if (!repository) return { identity: "bot", unavailable: "Run this command in a GitHub checkout or pass --repo so Paperclip can write as the GitHub App." };
      const target = await repositoryFor(companyId, repository);
      if (!target) return { identity: "bot", unavailable: `${repository} is not available through the company's GitHub App.` };
      return { identity: "bot", credential: await botCredential(companyId, target) };
    }

    // userSource "app": the plugin answers every operation; nothing defers to the
    // run. The policy writes every action as the person; the App only reads.
    const state = await users.state(companyId);
    const person = state && !state.needsReauthorization ? { login: state.login, userId: state.userId } : null;
    const signing = async () => {
      if (!person || !current.enabled || !state?.fence?.ok) return {};
      try { const key = await signingKey(companyId); return key ? { signingKey: key.publicKey } : {}; }
      catch { return {}; }
    };
    // Any privileged action (a wiki included) goes through every write gate.
    const writing = request.access === "write" || request.privileged.length > 0;
    try {
      if (!writing) {
        // Commits (local, or merged by a pull) are the person's and signed; reads use the App.
        const commits = request.action === "commit";
        if (request.access === "none") {
          if (!person) return { identity: "user", unavailable: "Authorize the GitHub user for this company first." };
          return { identity: "user", credential: { token: null, ...person }, ...(commits ? await signing() : {}) };
        }
        const token = await readToken(companyId, current, repository);
        const catalog = await loadCatalog(companyId);
        const bot = { login: `${catalog.app.slug}[bot]`, userId: await botUserId(catalog.app.slug, token) };
        return { identity: "bot", credential: { token, ...bot }, ...(person ? { author: person, ...(commits ? await signing() : {}) } : {}) };
      }
      const action = request.action ?? "other";
      const granted = await authorizeUserWrite(companyId, current, { repository, action, privileged: request.privileged, pullRequest: request.pullRequest, expectedHeadSha: request.expectedHeadSha,
        merge: request.merge === true, autoMerge: request.autoMerge === true, retarget: request.retarget === true });
      return {
        identity: "user", credential: { token: granted.token, ...granted.user },
        ...(await signing()), bodyFooter: current.bodyFooter, ...(granted.evidence ? { evidence: granted.evidence } : {}),
      };
    } catch (error) {
      if (error instanceof Denied) return { identity: writing ? "user" : "bot", unavailable: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) };
      throw error;
    }
  }

  ctx.actions.register("write-identity.get", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const current = await stored(companyId);
    return { companyId, policy: current && "policy" in current ? current.policy : null, invalid: !!current && "invalid" in current };
  });

  ctx.actions.register("write-identity.set", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireInstanceAdmin(actor);
    const next = params.policy === null ? null : parseGitHubWriteIdentityPolicy(params.policy);
    if (next) await savePolicy(companyId, next);
    else { await ctx.state.delete(policyKey(companyId)); policyChanged(companyId); }
    await ctx.activity.log({ companyId, message: next ? "GitHub write identity updated" : "GitHub write identity reset to default", metadata: next ? {
      ...Object.fromEntries(GITHUB_WRITE_ACTIONS.map(action => [action, next.default[action]])),
      overrideCount: next.overrides.length, missingUserConnection: next.missingUserConnection, userSource: next.userSource, enabled: next.enabled,
      allowedRepositories: next.allowedRepositories, installationRepositories: next.installationRepositories,
      ...Object.fromEntries(GITHUB_PRIVILEGED_ACTIONS.map(action => [`privileged.${action}`, next.privileged[action]])),
      throttlePerMinute: next.throttle.perMinute, throttlePerHour: next.throttle.perHour, bodyFooter: next.bodyFooter,
    } : {} });
    // Saving the policy accepts the repositories GitHub has now: their IDs are pinned again by the next check.
    await users.updateState(companyId, state => state.fence ? { ...state, fence: { ...state.fence, repositoryIds: undefined } } : state);
    // Turning the App user on is verified against GitHub right away.
    const fence = next?.userSource === "app" && next.enabled && await users.state(companyId) ? await checkFence(companyId) : null;
    const saved = await stored(companyId);
    return { companyId, policy: saved && "policy" in saved ? saved.policy : null, ...(fence ? { fence } : {}) };
  });

  ctx.actions.register("user-authorization.status", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    return { companyId, authorization: await users.state(companyId) };
  });
  ctx.actions.register("user-authorization.start", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireInstanceAdmin(actor);
    const current = await policy(companyId);
    if (current?.userSource !== "app" || !current.userLogin) throw new Error("Save a write identity with userSource app and userLogin first.");
    return { companyId, ...(await users.start(companyId)), login: current.userLogin };
  });
  ctx.actions.register("user-authorization.poll", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireInstanceAdmin(actor);
    const current = await policy(companyId);
    if (current?.userSource !== "app" || !current.userLogin) throw new Error("Save a write identity with userSource app and userLogin first.");
    const result = await users.poll(companyId, current.userLogin);
    if (result.status !== "authorized") return { companyId, ...result };
    await ctx.activity.log({ companyId, message: "GitHub user authorized for agent writes", metadata: { login: result.login } });
    return { companyId, ...result, fence: await checkFence(companyId) };
  });
  ctx.actions.register("user-authorization.check", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireInstanceAdmin(actor);
    return { companyId, fence: await checkFence(companyId) };
  });
  ctx.actions.register("user-authorization.revoke", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    requireInstanceAdmin(actor);
    await users.forget(companyId, "An administrator revoked the GitHub user authorization. Authorize the GitHub user again.");
    // Writes stay off after a new authorization until an administrator turns them back on.
    const current = await stored(companyId);
    if (current && "policy" in current && current.policy.enabled) await savePolicy(companyId, { ...current.policy, enabled: false });
    await ctx.activity.log({ companyId, message: "GitHub user authorization revoked in Paperclip", metadata: { writesDisabled: true } });
    return { companyId, authorization: await users.state(companyId), next: "Also revoke the App under GitHub Settings → Applications → Authorized GitHub Apps; that kills every token it issued." };
  });

  // Host-only: the Paperclip server asks before each managed git/gh operation.
  // The host bridge maps every browser and agent caller to a user or agent actor,
  // so only the Paperclip server can call as system.
  const hostOnly = (context: { companyId?: string | null; actor: { type: string; userId?: string | null; agentId?: string | null } }, params: Record<string, unknown>) => {
    const companyId = context.companyId;
    if (context.actor.type !== "system" || context.actor.userId || context.actor.agentId || !companyId || params.companyId !== companyId) {
      throw new Error("Write identity decisions are available only to the Paperclip server.");
    }
    return companyId;
  };

  ctx.actions.register("repository-write-identity", async (params, context): Promise<GitHubWriteIdentityDecision> => {
    const companyId = hostOnly(context, params);
    const access = params.access ?? (params.action ? "write" : "read");
    if (access !== "none" && access !== "read" && access !== "write") throw new Error("Unknown GitHub access.");
    const action = params.action ?? null;
    if (action !== null && action !== "other" && action !== "project" && !(GITHUB_WRITE_ACTIONS as readonly unknown[]).includes(action)) throw new Error("Unknown GitHub write action.");
    const repository = params.repository === null || params.repository === undefined ? null : String(params.repository);
    if (repository !== null && !normalizeGitHubRepository(repository)) throw new Error("Choose a GitHub repository as owner/name.");
    const privileged = Array.isArray(params.privileged) ? params.privileged : [];
    if (privileged.some(name => !(GITHUB_PRIVILEGED_ACTIONS as readonly unknown[]).includes(name))) throw new Error("Unknown privileged GitHub action.");
    const pullRequest = Number.isSafeInteger(params.pullRequest) && Number(params.pullRequest) > 0 ? Number(params.pullRequest) : null;
    const expectedHeadSha = typeof params.expectedHeadSha === "string" && FULL_SHA.test(params.expectedHeadSha.toLowerCase()) ? params.expectedHeadSha.toLowerCase() : null;
    try {
      return await decide(companyId, {
        companyId, repository, access, action: action as GitHubOperationAction | null, privileged: privileged as GitHubPrivilegedAction[],
        wiki: params.wiki === true, pullRequest, expectedHeadSha, ...(params.fallback === true ? { fallback: true } : {}),
        ...(params.merge === true ? { merge: true } : {}), ...(params.autoMerge === true ? { autoMerge: true } : {}), ...(params.retarget === true ? { retarget: true } : {}),
      });
    } catch (error) {
      if (error instanceof Denied) return { identity: "user", unavailable: error.message };
      throw error;
    }
  });

  ctx.actions.register("repository-sign-commit", async (params, context): Promise<GitHubSignDecision> => {
    const companyId = hostOnly(context, params);
    if (typeof params.payload !== "string") throw new Error("Send the object to sign as base64.");
    const payload = Buffer.from(params.payload, "base64");
    if (!payload.length || payload.length > MAX_SIGN_PAYLOAD_BYTES) return { unavailable: "The object to sign is empty or larger than 1 MiB." };
    try {
      const current = await policy(companyId);
      if (current?.userSource !== "app") return { unavailable: "Commit signing is available only with the App user identity." };
      if (!current.enabled) return { unavailable: "GitHub writes are switched off for this company (write identity kill switch)." };
      const user = await fencedUser(companyId);
      const email = `${user.userId}+${user.login}@users.noreply.github.com`;
      const check = checkGitObjectForSigning(payload, { name: user.login, email }, now());
      if (!check.ok) {
        return { unavailable: `Paperclip signs only a git commit written now by ${user.login} <${email}>; this one is refused because ${check.reason}` };
      }
      const key = await signingKey(companyId);
      if (!key) return { unavailable: "Bind the signing key secret (signingKey) in this company's plugin config." };
      return { signature: sshSign(key, payload), keyFingerprint: key.fingerprint };
    } catch (error) {
      if (error instanceof Denied) return { unavailable: error.message };
      throw error;
    }
  });

  return {
    /** Identity for a plugin tool write under `run`; without a policy the tools keep writing as the App. */
    toolIdentity: async (companyId: string, repository: string, action: GitHubWriteAction) => {
      const current = await policy(companyId);
      return { identity: resolveGitHubWriteIdentity(current, { repository, action, surface: "plugin" }), missingUserConnection: current?.missingUserConnection ?? "fail" as const };
    },
    /**
     * The token for one of the plugin's own writes (sync write-back, board
     * actions, agent tools). Null keeps the App; with the App user identity it
     * is the user token after the same gates as managed git/gh, or an error.
     */
    async writeToken(companyId: string, repository: string | null, request: PluginWriteRequest): Promise<string | null> {
      const current = await policy(companyId);
      if (current?.userSource !== "app") return null;
      const name = repository ? normalizeGitHubRepository(repository)?.repository ?? null : null;
      try {
        const granted = await authorizeUserWrite(companyId, current, { repository: name, action: request.action, privileged: request.privileged ?? [], pullRequest: request.pullRequest, expectedHeadSha: request.expectedHeadSha,
          merge: request.merge === true, autoMerge: request.autoMerge === true, retarget: request.retarget === true });
        await ctx.activity.log({ companyId, message: "github.user_identity_write", metadata: {
          repository: name, action: request.action, privileged: request.privileged ?? [], source: request.source, login: granted.user.login,
          ...(request.agentId ? { agentId: request.agentId } : {}), ...(request.runId ? { runId: request.runId } : {}),
          ...(request.pullRequest ? { pullRequest: request.pullRequest } : {}), ...(request.expectedHeadSha ? { headSha: request.expectedHeadSha } : {}),
          ...(granted.evidence ? { evidence: granted.evidence } : {}),
        } });
        return granted.token;
      } catch (error) {
        if (!(error instanceof Denied)) throw error;
        await ctx.activity.log({ companyId, message: "github.write_identity_denied", metadata: { repository: name, action: request.action, source: request.source, reason: error.message } });
        throw new Error(error.message);
      }
    },
    /** True when the company writes as its App user. A saved policy that no longer parses throws (fail closed). */
    async appUser(companyId: string): Promise<boolean> {
      return (await policy(companyId))?.userSource === "app";
    },
    /** The company's fenced repositories when it writes as its App user, else null. A saved policy that no longer parses throws. */
    async appUserFence(companyId: string): Promise<string[] | null> {
      const current = await policy(companyId);
      return current?.userSource === "app" ? gitHubInstallationRepositories(current) : null;
    },
    /** Hourly fence check from the sync job, for companies using the App user identity. */
    async maintain(companyId: string): Promise<void> {
      const current = await stored(companyId);
      if (!current || !("policy" in current) || current.policy.userSource !== "app") return;
      const state = await users.state(companyId);
      if (!state || (state.fence && now() - Date.parse(state.fence.checkedAt) < FENCE_CHECK_INTERVAL_MS)) return;
      await checkFence(companyId);
    },
  };
}

import { and, eq, inArray } from "drizzle-orm";
import { pluginConfig, pluginState, plugins, type Db } from "@paperclipai/db";
import {
  GITHUB_WRITE_IDENTITY_STATE,
  gitHubInstallationRepositories,
  mintGitHubInstallationToken,
  parseGitHubWriteIdentityPolicy,
  type GitHubInstallationTokenCall,
  type GitHubInstallationTokenRequest,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

/**
 * I-RO for the server's native GitHub code: the fence that applies to the
 * installation tokens of App `appId` minted for `companyId`.
 *
 * It is null when neither that company nor any company whose GitHub plugin is
 * connected to this App writes as its App user (`userSource: "app"`): their
 * tokens are unchanged. Otherwise it is the fenced repositories (lowercase
 * `owner/name`) every such company allows, and every token must be read-only
 * and name its repositories. A policy that cannot be read counts as an App-user
 * company with an empty fence (nothing is minted).
 */
export async function githubAppUserFence(db: Db, input: { companyId: string; appId?: string | null }): Promise<string[] | null> {
  const owners = (await db.select({ id: plugins.id, manifest: plugins.manifestJson }).from(plugins))
    .filter(row => Boolean((row.manifest as PaperclipPluginManifestV1 | null)?.projectRepositories?.writeIdentityAction))
    .map(row => row.id);
  if (!owners.length) return null;
  const policies = await db
    .select({ pluginId: pluginState.pluginId, companyId: pluginState.scopeId, value: pluginState.valueJson })
    .from(pluginState)
    .where(and(
      inArray(pluginState.pluginId, owners),
      eq(pluginState.scopeKind, "company"),
      eq(pluginState.namespace, GITHUB_WRITE_IDENTITY_STATE.namespace),
      eq(pluginState.stateKey, GITHUB_WRITE_IDENTITY_STATE.stateKey),
    ));
  const fences: string[][] = [];
  for (const row of policies) {
    let fence: string[] | null;
    try {
      const policy = parseGitHubWriteIdentityPolicy(row.value);
      fence = policy.userSource === "app" ? gitHubInstallationRepositories(policy) : null;
    } catch {
      fence = [];
    }
    if (fence === null || !row.companyId) continue;
    if (row.companyId === input.companyId) { fences.push(fence); continue; }
    if (!input.appId) continue;
    const [config] = await db
      .select({ value: pluginConfig.configJson })
      .from(pluginConfig)
      .where(and(eq(pluginConfig.pluginId, row.pluginId), eq(pluginConfig.companyId, row.companyId)));
    if (config && String(config.value?.appId ?? "") === String(input.appId)) fences.push(fence);
  }
  if (!fences.length) return null;
  return fences.reduce((kept, fence) => kept.filter(name => fence.includes(name)));
}

/**
 * Mints an installation token for the server's native GitHub code, through the
 * one mint function Paperclip has (I-RO checked for App-user companies and Apps).
 */
export async function mintNativeGitHubInstallationToken(
  db: Db,
  input: { companyId: string; appId: string | null | undefined } & GitHubInstallationTokenRequest,
  send: (call: GitHubInstallationTokenCall) => Promise<unknown>,
): Promise<string> {
  return mintGitHubInstallationToken(input, await githubAppUserFence(db, input), send);
}

/**
 * The native GitHub connector (chat bots, reviews, checks) acts with App
 * tokens, so it is off for a company that writes as its App user and for an
 * App that such a company uses (I-RO).
 */
export async function assertNativeGitHubAppAllowed(db: Db, input: { companyId: string; appId?: string | null }): Promise<void> {
  if (await githubAppUserFence(db, input) === null) return;
  throw conflict(
    "This company, or this GitHub App, writes on GitHub as an App user (the GitHub plugin's userSource \"app\"), so the native GitHub connector cannot use App tokens here. Use the GitHub plugin, or connect another GitHub App.",
    { code: "github_app_user_identity" },
  );
}

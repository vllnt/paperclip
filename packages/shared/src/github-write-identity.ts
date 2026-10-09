/**
 * Who acts on GitHub for managed `git`/`gh` and the GitHub plugin.
 *
 * Per action, a write uses the company's GitHub App (`bot`) or a `user`.
 * `userSource` says who the user is:
 * - `run`: the run's own GitHub identity (the agent's dedicated account when
 *   granted, otherwise the personal connection of the person whose accepted
 *   instructions the run executes). The server resolves it; the policy never
 *   names a person.
 * - `app`: the one person who authorized the company's own GitHub App (a
 *   GitHub App user-to-server token held by the plugin). GitHub limits that
 *   token to the App's installation, so it is fenced at GitHub. Reads use
 *   read-only installation tokens of the same App.
 *
 * The policy also carries a kill switch, a repository allowlist, toggles for
 * privileged actions and a write throttle. They are enforced when Paperclip
 * hands out a credential; a token captured by an agent bypasses them, so the
 * hard limits must live at GitHub (installation repositories and permissions).
 *
 * Kept free of runtime dependencies so plugin bundles can import it directly.
 */

import { ghCommandMayWrite, parseGhCommand, type GhApiRequest, type GhApiRoute } from "./gh-command.js";

export { ghCommandMayWrite, parseGhCommand, type GhApiRequest, type GhApiRoute, type GhCommand } from "./gh-command.js";

export const GITHUB_WRITE_ACTIONS = ["commit", "push", "pullRequest", "comment"] as const;
export type GitHubWriteAction = (typeof GITHUB_WRITE_ACTIONS)[number];
export type GitHubWriteIdentityKind = "bot" | "user";
export type GitHubWriteIdentityChoice = Record<GitHubWriteAction, GitHubWriteIdentityKind>;
/** Where a write starts: managed `git`/`gh` in a run, or a GitHub plugin tool. */
export type GitHubWriteSurface = "runtime" | "plugin";
/** A classified command's policy action. `project` is an organization Project write. */
export type GitHubOperationAction = GitHubWriteAction | "other" | "project";

/** Actions that each need their own per-company toggle on top of an ordinary write. */
export const GITHUB_PRIVILEGED_ACTIONS = [
  "adminMerge", "deploymentApproval", "release", "tagPush", "workflowDispatch", "pushToMain", "editWorkflows", "wiki",
] as const;
export type GitHubPrivilegedAction = (typeof GITHUB_PRIVILEGED_ACTIONS)[number];
export type GitHubPrivilegedToggles = Record<GitHubPrivilegedAction, boolean>;

/**
 * Defaults for a saved policy. `release` and `tagPush` stay off: release
 * workflows create tags and releases themselves, and a stray tag can deploy
 * without a gate. Pushing to the default branch and changing workflow files
 * (`.github/workflows/**`) stay off too.
 */
export const DEFAULT_GITHUB_PRIVILEGED_TOGGLES: Readonly<GitHubPrivilegedToggles> = Object.freeze({
  adminMerge: true,
  deploymentApproval: true,
  workflowDispatch: true,
  wiki: true,
  release: false,
  tagPush: false,
  pushToMain: false,
  editWorkflows: false,
});

export interface GitHubWriteThrottle {
  /** User-identity writes allowed per GitHub user in any 60 seconds. */
  perMinute: number;
  /** User-identity writes allowed per GitHub user in any hour. */
  perHour: number;
}
export const DEFAULT_GITHUB_WRITE_THROTTLE: Readonly<GitHubWriteThrottle> = Object.freeze({ perMinute: 30, perHour: 300 });

/** Branch names treated as a repository's default branch for `pushToMain`. */
export const GITHUB_DEFAULT_BRANCH_NAMES: readonly string[] = ["main", "master"];
/**
 * Branch names agents never delete, force-push, rename or hard-reset, even
 * when GitHub does not report them as the default or as protected. Compared
 * case-insensitively. `main` and `master` are the usual defaults; `staging`
 * and `production` are release branches (never delete SongTrivia `staging` or
 * `Production`). GitHub's own answer still protects every other branch.
 */
export const GITHUB_PROTECTED_BRANCH_FLOOR: readonly string[] = ["main", "master", "staging", "production"];

/** True when `name` is on {@link GITHUB_PROTECTED_BRANCH_FLOOR}. Accepts `refs/heads/NAME` or the bare name. */
export function isProtectedBranchFloor(name: string): boolean {
  const branch = name.replace(/^refs\/heads\//i, "");
  return GITHUB_PROTECTED_BRANCH_FLOOR.includes(branch.toLowerCase());
}

export type GitHubUserSource = "run" | "app";
export type GitHubPermissionLevel = "read" | "write" | "admin";

/** Installation permissions a fenced App must never hold. */
const FORBIDDEN_INSTALLATION_PERMISSIONS = new Set(["administration", "secrets", "organization_secrets", "organization_administration"]);

export interface GitHubWriteIdentityOverride extends Partial<GitHubWriteIdentityChoice> {
  /** `owner/name` glob; `*` matches within one segment, case-insensitive. */
  match: string;
}

export interface GitHubWriteIdentityPolicy {
  default: GitHubWriteIdentityChoice;
  /** First match wins; actions an override omits use `default`. */
  overrides: GitHubWriteIdentityOverride[];
  /** `fail` stops a `user` write without a GitHub identity; `use_bot` writes as the App (`run` only). */
  missingUserConnection: "fail" | "use_bot";
  /** Who `user` is; see the module comment. */
  userSource: GitHubUserSource;
  /** Kill switch: false denies every user-identity write. Reads continue. */
  enabled: boolean;
  /** Repositories user-identity writes may target: exact lowercase `owner/name`; a `.wiki` counts as its repository. Empty means no allowlist (`run` only). */
  allowedRepositories: string[];
  /**
   * `app`: the exact repositories the App installation must cover (the GitHub-side fence),
   * readable with installation tokens. Empty means the same as `allowedRepositories`. A
   * larger set stages writes: repositories outside `allowedRepositories` stay read-only.
   */
  installationRepositories: string[];
  privileged: GitHubPrivilegedToggles;
  throttle: GitHubWriteThrottle;
  /** End agent `gh` PR and issue text with a "Posted by Paperclip agent" footer. Defaults on for `run`, off for `app`. */
  bodyFooter: boolean;
  /** `app`: the GitHub login that must hold the authorization. */
  userLogin: string | null;
  /** `app`: the exact installation permissions approved for the App. */
  installationPermissions: Record<string, GitHubPermissionLevel> | null;
}

/** What the host asks a GitHub plugin's `writeIdentityAction` for one managed operation. */
/** One workflow path (`.github/workflows` or below) as a commit has it: git mode and blob id, both null when the path is gone there. */
export interface GitHubWorkflowChange {
  path: string;
  mode: string | null;
  oid: string | null;
}

/** A new commit of a push that changes workflow paths: its parents, and those paths as it has them (against its first parent). */
export interface GitHubWorkflowCommit {
  sha: string;
  parents: string[];
  changes: GitHubWorkflowChange[];
}

/**
 * A push of one commit to one named branch that changes workflow files, as the
 * checkout reports it. The plugin allows it without `editWorkflows` only when
 * the push brings in nothing but the base branch's own workflow files: each new
 * commit that changes them is a merge of the base branch, the history it builds
 * on exists on GitHub, and the branch ends up with the base branch's files.
 */
export interface GitHubWorkflowPush {
  /** The branch name, without `refs/heads/`. */
  branch: string;
  /** The pushed commit. */
  tip: string;
  /** Every file under `.github/workflows` at the pushed commit. */
  files: Array<{ path: string; mode: string; oid: string }>;
  /** The new commits (not on any remote ref of the checkout) that change workflow paths. */
  commits: GitHubWorkflowCommit[];
  /** Parents of new commits that are not new themselves; the pushed commit when nothing is new. */
  entries: string[];
}

export interface GitHubWriteIdentityRequest {
  companyId: string;
  /** Lowercase `owner/name` (a wiki folded into its repository), or null when unknown. */
  repository: string | null;
  access: GitHubAccess;
  /** Null for plain reads and local commands that create no commit. */
  action: GitHubOperationAction | null;
  privileged: GitHubPrivilegedAction[];
  wiki: boolean;
  /** Pull request number of a merge, when the command names one. */
  pullRequest?: number | null;
  /** Head SHA the caller expects a merge to merge (`--match-head-commit`, or the API `sha`). */
  expectedHeadSha?: string | null;
  /** A pull request merge: the plugin refuses one that touches protected paths. */
  merge?: boolean;
  /** The merge enables auto-merge or the merge queue. */
  autoMerge?: boolean;
  /** The command changes an open pull request's base branch. */
  retarget?: boolean;
  /** A push whose workflow changes may arrive without `editWorkflows` when they are the base branch's own (see {@link GitHubWorkflowPush}). */
  workflowPush?: GitHubWorkflowPush;
  /** Ask for the App after a `user` write found no GitHub identity. Honoured only under `use_bot`. */
  fallback?: boolean;
}

export interface GitHubIdentityRef { login: string; userId: string }

/**
 * The plugin's answer.
 * - `{ identity: "user", missingUserConnection }` defers to the run's own identity (`userSource: "run"`).
 * - `credential` is the token for this operation: a repository-scoped App token (`bot`) or the
 *   App user token (`user`). A null token carries identity only (local commands). `author` sets the
 *   commit identity when it differs from the token's owner. `signingKey` is the public SSH key
 *   commits are signed with; `bodyFooter` turns on the gh text footer.
 * - `unavailable` stops the operation with that reason; there is never a fallback identity.
 */
export type GitHubWriteIdentityDecision =
  | { identity: "user"; missingUserConnection: GitHubWriteIdentityPolicy["missingUserConnection"] }
  | {
      identity: GitHubWriteIdentityKind;
      credential: GitHubIdentityRef & { token: string | null };
      author?: GitHubIdentityRef;
      signingKey?: string;
      bodyFooter?: boolean;
      /** Checks the plugin made before granting a privileged action, for the audit record. */
      evidence?: Record<string, unknown>;
    }
  | { identity: GitHubWriteIdentityKind; unavailable: string; evidence?: Record<string, unknown> };

/** What the host asks a GitHub plugin's `signCommitAction` to sign. */
export interface GitHubSignRequest {
  companyId: string;
  /** Base64 of the git commit or tag object git asks to sign. */
  payload: string;
}
export type GitHubSignDecision = { signature: string; keyFingerprint: string } | { unavailable: string };

/** Plugin state where the GitHub plugin keeps each company's policy. The host reads it to choose managed mode. */
export const GITHUB_WRITE_IDENTITY_STATE = { namespace: "identity", stateKey: "write-identity" } as const;

export const MAX_GITHUB_WRITE_IDENTITY_OVERRIDES = 50;
export const MAX_GITHUB_ALLOWED_REPOSITORIES = 100;

const POLICY_FIELDS = [
  "default", "overrides", "missingUserConnection", "userSource", "enabled", "allowedRepositories", "installationRepositories",
  "privileged", "throttle", "bodyFooter", "userLogin", "installationPermissions",
];

/** Starting point when an operator turns the setting on. */
export const DEFAULT_GITHUB_WRITE_IDENTITY_POLICY: GitHubWriteIdentityPolicy = {
  default: { commit: "user", push: "user", pullRequest: "user", comment: "user" },
  overrides: [],
  missingUserConnection: "fail",
  userSource: "run",
  enabled: true,
  allowedRepositories: [],
  installationRepositories: [],
  privileged: { ...DEFAULT_GITHUB_PRIVILEGED_TOGGLES },
  throttle: { ...DEFAULT_GITHUB_WRITE_THROTTLE },
  bodyFooter: true,
  userLogin: null,
  installationPermissions: null,
};

const MATCH_PATTERN = /^[A-Za-z0-9_.*-]{1,100}\/[A-Za-z0-9_.*-]{1,100}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const KINDS: readonly string[] = ["bot", "user"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Lowercase `owner/name` for a repository name, with `.git` removed and a
 * `.wiki` repository folded into its repository. Null when not `owner/name`.
 */
export function normalizeGitHubRepository(value: string): { repository: string; wiki: boolean } | null {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(value.trim());
  if (!match) return null;
  let name = match[2]!.replace(/\.git$/i, "");
  const wiki = /\.wiki$/i.test(name);
  if (wiki) name = name.slice(0, -".wiki".length);
  if (!name || [match[1], name].some(part => part === "." || part === "..")) return null;
  return { repository: `${match[1]}/${name}`.toLowerCase(), wiki };
}

function parseInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return Number(value);
}

/** Validates stored or submitted policy input; throws a user-facing message on bad input. */
export function parseGitHubWriteIdentityPolicy(value: unknown): GitHubWriteIdentityPolicy {
  if (!isRecord(value)) throw new Error("Write identity must be an object.");
  const unknownKey = Object.keys(value).find(key => !POLICY_FIELDS.includes(key));
  if (unknownKey) throw new Error(`Unknown write identity field: ${unknownKey}.`);
  if (!isRecord(value.default)) throw new Error("Choose bot or user for every write action.");
  const defaults = {} as GitHubWriteIdentityChoice;
  for (const action of GITHUB_WRITE_ACTIONS) {
    const kind = value.default[action];
    if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error(`Choose bot or user for ${action}.`);
    defaults[action] = kind as GitHubWriteIdentityKind;
  }
  if (Object.keys(value.default).some(key => !(GITHUB_WRITE_ACTIONS as readonly string[]).includes(key))) {
    throw new Error("Write identity defaults accept only commit, push, pullRequest and comment.");
  }
  const rawOverrides = value.overrides ?? [];
  if (!Array.isArray(rawOverrides) || rawOverrides.length > MAX_GITHUB_WRITE_IDENTITY_OVERRIDES) {
    throw new Error(`Use at most ${MAX_GITHUB_WRITE_IDENTITY_OVERRIDES} repository overrides.`);
  }
  const overrides = rawOverrides.map((raw): GitHubWriteIdentityOverride => {
    if (!isRecord(raw) || typeof raw.match !== "string" || !MATCH_PATTERN.test(raw.match.trim())) {
      throw new Error("Each override needs an owner/name pattern, such as vllnt/*.");
    }
    const override: GitHubWriteIdentityOverride = { match: raw.match.trim() };
    for (const [key, kind] of Object.entries(raw)) {
      if (key === "match") continue;
      if (!(GITHUB_WRITE_ACTIONS as readonly string[]).includes(key)) throw new Error(`Unknown override field: ${key}.`);
      if (kind === undefined) continue;
      if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error(`Choose bot or user for ${key} in ${override.match}.`);
      override[key as GitHubWriteAction] = kind as GitHubWriteIdentityKind;
    }
    return override;
  });
  const missing = value.missingUserConnection ?? "fail";
  if (missing !== "fail" && missing !== "use_bot") throw new Error("Missing user connection must be fail or use_bot.");
  const userSource = value.userSource ?? "run";
  if (userSource !== "run" && userSource !== "app") throw new Error("User source must be run or app.");
  const enabled = value.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false.");

  const repositories = (raw: unknown, label: string) => {
    const list = raw ?? [];
    if (!Array.isArray(list) || list.length > MAX_GITHUB_ALLOWED_REPOSITORIES) throw new Error(`List at most ${MAX_GITHUB_ALLOWED_REPOSITORIES} ${label}.`);
    return [...new Set(list.map(entry => {
      const normalized = typeof entry === "string" ? normalizeGitHubRepository(entry) : null;
      if (!normalized) throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} are exact owner/name entries; ${typeof entry === "string" ? entry || "(empty)" : "a non-string"} is not.`);
      return normalized.repository;
    }))];
  };
  const allowedRepositories = repositories(value.allowedRepositories, "allowed repositories");
  const installationRepositories = repositories(value.installationRepositories, "installation repositories");
  const outside = installationRepositories.length ? allowedRepositories.filter(name => !installationRepositories.includes(name)) : [];
  if (outside.length) throw new Error(`Allowed repositories must be installation repositories too: ${outside.join(", ")}.`);

  const rawPrivileged = value.privileged ?? {};
  if (!isRecord(rawPrivileged)) throw new Error("privileged must map each privileged action to true or false.");
  const privileged = { ...DEFAULT_GITHUB_PRIVILEGED_TOGGLES };
  for (const [key, toggle] of Object.entries(rawPrivileged)) {
    if (!(GITHUB_PRIVILEGED_ACTIONS as readonly string[]).includes(key)) throw new Error(`Unknown privileged action: ${key}.`);
    if (typeof toggle !== "boolean") throw new Error(`Turn ${key} on or off with true or false.`);
    privileged[key as GitHubPrivilegedAction] = toggle;
  }

  const rawThrottle = value.throttle ?? {};
  if (!isRecord(rawThrottle) || Object.keys(rawThrottle).some(key => key !== "perMinute" && key !== "perHour")) {
    throw new Error("throttle accepts perMinute and perHour.");
  }
  const throttle = {
    perMinute: parseInteger(rawThrottle.perMinute ?? DEFAULT_GITHUB_WRITE_THROTTLE.perMinute, "throttle.perMinute", 1, 1000),
    perHour: parseInteger(rawThrottle.perHour ?? DEFAULT_GITHUB_WRITE_THROTTLE.perHour, "throttle.perHour", 1, 10000),
  };
  if (throttle.perHour < throttle.perMinute) throw new Error("throttle.perHour must be at least throttle.perMinute.");

  const bodyFooter = value.bodyFooter ?? userSource === "run";
  if (typeof bodyFooter !== "boolean") throw new Error("bodyFooter must be true or false.");

  const userLogin = value.userLogin ?? null;
  if (userLogin !== null && (typeof userLogin !== "string" || !LOGIN_PATTERN.test(userLogin))) throw new Error("userLogin must be a GitHub login.");

  let installationPermissions: Record<string, GitHubPermissionLevel> | null = null;
  if (value.installationPermissions !== undefined && value.installationPermissions !== null) {
    if (!isRecord(value.installationPermissions)) throw new Error("installationPermissions must map permission names to read, write or admin.");
    installationPermissions = {};
    for (const [key, level] of Object.entries(value.installationPermissions)) {
      if (!/^[a-z_]{1,64}$/.test(key) || (level !== "read" && level !== "write" && level !== "admin")) {
        throw new Error("installationPermissions must map permission names to read, write or admin.");
      }
      if (FORBIDDEN_INSTALLATION_PERMISSIONS.has(key)) throw new Error(`A fenced App must not hold ${key}.`);
      if (key === "statuses" && level !== "read") throw new Error("A fenced App must not hold statuses write: it could forge required checks.");
      installationPermissions[key] = level;
    }
  }

  if (userSource === "app") {
    // The App only reads: every write is the authorizing person's.
    if (GITHUB_WRITE_ACTIONS.some(action => defaults[action] !== "user") || overrides.length) throw new Error("An App user identity writes every action as the user; the App bot only reads.");
    if (missing !== "fail") throw new Error("An App user identity never falls back to the App bot; use missingUserConnection fail.");
    if (!allowedRepositories.length) throw new Error("An App user identity needs at least one allowed repository.");
    if (!userLogin) throw new Error("An App user identity needs the GitHub login that authorizes it (userLogin).");
    if (!installationPermissions) throw new Error("An App user identity needs the approved installation permissions.");
  }

  return {
    default: defaults, overrides, missingUserConnection: missing, userSource, enabled, allowedRepositories, installationRepositories,
    privileged, throttle, bodyFooter, userLogin, installationPermissions,
  };
}

/** `owner/name` glob match; `*` never crosses the `/`. */
export function matchesGitHubRepositoryPattern(pattern: string, repository: string): boolean {
  const source = pattern.toLowerCase().split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${source}$`).test(repository.toLowerCase());
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** The only web hosts Paperclip hands GitHub credentials for. */
const GITHUB_WEB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Where a git remote or a gh repository argument goes.
 * - `github`: a github.com repository (a wiki folded into its repository).
 * - `local`: a path on this machine (git only); it needs no GitHub credential.
 * - `foreign`: anything else, including other hosts, remote helpers
 *   (`transport::address`), query strings and names Paperclip cannot read.
 */
export type GitHubDestination =
  | { kind: "github"; repository: string; wiki: boolean }
  | { kind: "local" }
  | { kind: "foreign"; reason: string };

const foreignDestination = (reason: string): GitHubDestination => ({ kind: "foreign", reason });

/** `path` without leading and trailing slashes, in linear time (no backtracking regex on agent input). */
function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path.charCodeAt(start) === 47) start += 1;
  while (end > start && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(start, end);
}

/** `owner/name` from a URL or scp path: exactly two percent-decoded segments, then normalized. */
function repositoryFromPath(path: string): { repository: string; wiki: boolean } | null {
  if (path.length > 2048) return null;
  const segments = trimSlashes(path).split("/");
  if (segments.length !== 2) return null;
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try { value = decodeURIComponent(segment); } catch { return null; }
    // A decoded slash, backslash, space, control character or a second encoding layer is not a repository name.
    if (!value || /[/\\%\s\x00-\x1f\x7f]/.test(value)) return null;
    decoded.push(value);
  }
  return normalizeGitHubRepository(`${decoded[0]}/${decoded[1]}`);
}

/**
 * Parses one destination. `git` reads remotes as git does (URL, scp-style
 * `host:path`, else a local path); `gh` reads `[HOST/]OWNER/REPO` or a URL.
 * Only https (and SSH, which Paperclip rewrites to https) on github.com counts as GitHub.
 */
export function parseGitHubDestination(value: string, program: "git" | "gh"): GitHubDestination {
  const raw = value.trim();
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return foreignDestination("an empty or unreadable destination");
  // git remote helpers (`transport::address`) connect anywhere.
  if (raw.includes("::")) return foreignDestination(`the remote helper address ${raw.slice(0, 100)}`);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    if (program === "git" && protocol === "file") return { kind: "local" };
    let url: URL;
    try { url = new URL(raw); } catch { return foreignDestination("an unreadable URL"); }
    const host = url.hostname.toLowerCase();
    if (!["https", "ssh", "git+ssh", "ssh+git"].includes(protocol)) return foreignDestination(`a ${protocol} URL`);
    if (!GITHUB_WEB_HOSTS.has(host)) return foreignDestination(`the host ${host || "(none)"}`);
    if (url.port && !(protocol !== "https" && url.port === "22")) return foreignDestination(`port ${url.port} on ${host}`);
    if (url.search || url.hash || raw.includes("?") || raw.includes("#")) return foreignDestination("a URL with a query or fragment");
    const repository = repositoryFromPath(url.pathname);
    return repository ? { kind: "github", ...repository } : foreignDestination(`${url.pathname.slice(0, 100)} on ${host}, which is not owner/name`);
  }
  if (program === "git") {
    // git's scp-style syntax: a colon before any slash.
    const colon = raw.indexOf(":"), slash = raw.indexOf("/");
    if (colon > 0 && (slash < 0 || colon < slash)) {
      const host = raw.slice(0, colon).replace(/^[^@]*@/, "").toLowerCase();
      if (!GITHUB_WEB_HOSTS.has(host)) return foreignDestination(`the host ${host || "(none)"}`);
      const path = raw.slice(colon + 1);
      if (path.includes("?") || path.includes("#")) return foreignDestination("a remote with a query or fragment");
      const repository = repositoryFromPath(path);
      return repository ? { kind: "github", ...repository } : foreignDestination(`${path.slice(0, 100)} on ${host}, which is not owner/name`);
    }
    return { kind: "local" };
  }
  const parts = raw.split("/");
  if (parts.length === 3) {
    const host = parts[0]!.toLowerCase();
    if (!GITHUB_WEB_HOSTS.has(host)) return foreignDestination(`the host ${host || "(none)"}`);
    parts.shift();
  }
  if (parts.length !== 2) return foreignDestination(`${raw.slice(0, 100)}, which is not [HOST/]OWNER/REPO`);
  const repository = repositoryFromPath(parts.join("/"));
  return repository ? { kind: "github", ...repository } : foreignDestination(`${raw.slice(0, 100)}, which is not OWNER/REPO`);
}

/** Exact allowlist match after normalization; look-alike names never match. Empty list allows all. */
export function isGitHubRepositoryAllowed(policy: Pick<GitHubWriteIdentityPolicy, "allowedRepositories">, repository: string | null): boolean {
  if (!policy.allowedRepositories.length) return true;
  const normalized = repository ? normalizeGitHubRepository(repository) : null;
  return !!normalized && policy.allowedRepositories.includes(normalized.repository);
}

/** The repositories the App installation must cover exactly (`app`), and that installation tokens may read. */
export function gitHubInstallationRepositories(policy: Pick<GitHubWriteIdentityPolicy, "allowedRepositories" | "installationRepositories">): string[] {
  return policy.installationRepositories.length ? policy.installationRepositories : policy.allowedRepositories;
}

/**
 * The identity for one write. Without a policy, today's behaviour applies:
 * managed `git`/`gh` write as the user and plugin tools write as the App.
 */
export function resolveGitHubWriteIdentity(
  policy: Pick<GitHubWriteIdentityPolicy, "default" | "overrides"> | null,
  input: { repository: string | null; action: GitHubWriteAction; surface: GitHubWriteSurface },
): GitHubWriteIdentityKind {
  if (!policy) return input.surface === "runtime" ? "user" : "bot";
  const repository = input.repository;
  const override = repository ? policy.overrides.find(candidate => matchesGitHubRepositoryPattern(candidate.match, repository)) : undefined;
  return override?.[input.action] ?? policy.default[input.action];
}

/**
 * The identity for a write the policy has no action for. It writes as the user
 * only when every action for that repository does, so a write Paperclip cannot
 * classify never gains a personal identity the operator restricted elsewhere.
 */
export function resolveGitHubWriteIdentityForOther(
  policy: Pick<GitHubWriteIdentityPolicy, "default" | "overrides"> | null,
  input: { repository: string | null; surface: GitHubWriteSurface },
): GitHubWriteIdentityKind {
  return GITHUB_WRITE_ACTIONS.every(action => resolveGitHubWriteIdentity(policy, { ...input, action }) === "user") ? "user" : "bot";
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

/** GitHub access a command needs: none (local only), read, or write. */
export type GitHubAccess = "none" | "read" | "write";

export interface GitHubCommandClass {
  access: GitHubAccess;
  /** The policy action; null for plain reads and local commands that create no commit. */
  action: GitHubOperationAction | null;
  privileged: GitHubPrivilegedAction[];
  /** Set when no toggle can allow the command; the reason says why. */
  denied?: string;
  /**
   * The refusal applies whether or not the company has a write identity
   * policy: it protects the credential itself (another host, a git command or
   * option Paperclip cannot read), or refuses an operation agents never
   * perform (see {@link AGENTS_NEVER}).
   */
  integrity?: true;
  /**
   * Branches (names without `refs/heads/`) this write deletes, force-updates,
   * renames or hard-resets. Only GitHub knows whether one is the repository's
   * default branch or a protected branch, so the server refuses the write
   * unless it has read from GitHub that none of them is.
   */
  branchRewrites?: string[];
}

export interface GitHubCommandContext {
  /** The remote URL the command targets, when known. A `.wiki` remote makes the command a `wiki` action. */
  remote?: string | null;
  /** The checked-out branch, for pushes without a refspec or with `HEAD`. */
  currentBranch?: string | null;
  /** Full ref names (`refs/heads/x`, `refs/tags/y`) of bare push refspec names, resolved in the checkout. */
  refs?: Record<string, string>;
  /** Whether a push's new commits change `.github/workflows/**`; null when the checkout could not tell. */
  touchesWorkflows?: boolean | null;
  /** A push without refspecs whose repository config (push.default, remote push refspecs, mirror, followTags) can push more than the current branch. */
  implicitPush?: boolean;
  /** Config makes every push also send annotated tags (push.followTags, from any scope), refspecs or not. */
  followTags?: boolean;
  /** push.recurseSubmodules as git will read it for this push, when it is not "no" or "check" ("unknown" when unreadable). */
  recurseSubmodules?: string;
}

/** Release tags (`name@version`) are created only by the repository's release workflow. */
const RELEASE_TAG_DENIED = "Release tags (name@version) are created only by the repository's release workflow, never by an agent.";
const BULK_TAG_DENIED = "Push tags by name: Paperclip cannot check a bulk tag push for release tags (name@version).";
const isReleaseTag = (name: string) => name.includes("@");
const decodePath = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/**
 * Operations agents never perform, whatever the company's policy and toggles:
 * no token is handed out for them. Each refusal names the operation and its
 * route (never its arguments), which the audit record keeps.
 */
const AGENTS_NEVER = {
  repository: "archive, delete, rename, transfer or change the settings of a repository",
  defaultBranch: "delete or force-push a default or protected branch",
  protection: "change branch protection or rulesets",
  hooks: "change webhooks",
  secrets: "change secrets, variables or deploy keys",
  deployments: "delete deployments, change or delete environments, or mark a deployment inactive",
} as const;
export type GitHubAgentsNever = keyof typeof AGENTS_NEVER;
type AgentsNever = GitHubAgentsNever;
/** The refusal of an operation agents never perform, naming its route. */
export function gitHubAgentsNeverDenial(what: GitHubAgentsNever, route: string): string {
  return `Denied: agents never ${AGENTS_NEVER[what]} (${route}). A person must do this on GitHub.`;
}
const neverByAgents = (base: GitHubCommandClass, what: AgentsNever, route: string): GitHubCommandClass =>
  ({ ...base, denied: gitHubAgentsNeverDenial(what, route), integrity: true });
/** A branch name that is, or may be, a default branch: gh fills `{branch}` and `:branch` from the checkout. */
const mayBeDefaultBranch = (name: string) => /\{branch\}|:branch\b/.test(name) || isProtectedBranchFloor(name);

/** git's global options that take the next argument as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
/** Every other global option Paperclip accepts (flags, or `--name=value` forms of the options above). */
const GIT_GLOBAL_FLAGS = new Set(["-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--no-advice",
  "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "-v", "--version", "-h", "--help", "--html-path",
  "--man-path", "--info-path", "--exec-path"]);
const GIT_GLOBAL_INLINE = /^--(git-dir|work-tree|namespace|config-env|super-prefix|attr-source|exec-path|list-cmds)=/;
/** Commands that create commits locally. */
const GIT_COMMIT_SUBCOMMANDS = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "am", "commit-tree"]);
/**
 * Every other git command Paperclip runs without GitHub access. This is an
 * allowlist: network plumbing (send-pack, fetch-pack, upload-pack,
 * receive-pack, http-push, remote-* helpers), credential helpers, aliases and
 * any command not listed here are refused, because Paperclip cannot see where
 * they connect or what they push.
 */
const GIT_LOCAL_SUBCOMMANDS = new Set([
  "add", "annotate", "apply", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap",
  "check-ref-format", "checkout", "checkout-index", "cherry", "clean", "column", "commit-graph", "config", "count-objects", "describe",
  "diff", "diff-files", "diff-index", "diff-tree", "difftool", "fast-export", "fast-import", "for-each-ref", "format-patch", "fsck",
  "gc", "get-tar-commit-id", "grep", "hash-object", "help", "index-pack", "init", "interpret-trailers", "log", "ls-files", "ls-tree",
  "mailinfo", "mailsplit", "merge-base", "merge-file", "merge-index", "merge-tree", "mergetool", "mktag", "mktree", "multi-pack-index",
  "mv", "name-rev", "notes", "pack-objects", "pack-refs", "patch-id", "prune", "prune-packed", "range-diff", "read-tree", "reflog",
  "repack", "replace", "rerere", "reset", "restore", "rev-list", "rev-parse", "rm", "shortlog", "show", "show-branch", "show-index",
  "show-ref", "sparse-checkout", "stash", "status", "stripspace", "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects",
  "update-index", "update-ref", "var", "verify-commit", "verify-pack", "verify-tag", "version", "whatchanged", "worktree", "write-tree",
  "refs", "replay", "hook", "filter-branch",
]);
/** Commands that read from a remote (`pull` also merges locally). */
const GIT_READ_SUBCOMMANDS = new Set(["fetch", "clone", "ls-remote"]);
/** `git remote` verbs that only change or print local configuration. */
const GIT_REMOTE_LOCAL_VERBS = new Set(["add", "rename", "remove", "rm", "set-branches", "set-url", "get-url"]);
/** `git submodule` verbs that fetch; the others are local. */
const GIT_SUBMODULE_NETWORK_VERBS = new Set(["add", "update"]);
/** `git lfs` verbs that upload or lock; any other verb downloads or is local. */
const GIT_LFS_WRITE_VERBS = new Set(["push", "pre-push", "lock", "unlock"]);
/**
 * The options of git's network commands Paperclip reads: flags, options that
 * take a value (next argument or `--name=value`), and options whose value is
 * optional (attached only). git also accepts abbreviated long options and
 * clustered short flags; an option not in these tables is refused, so a value
 * can never be mistaken for the destination.
 */
interface GitOptionTable { flags: ReadonlySet<string>; values: ReadonlySet<string>; optional: ReadonlySet<string> }
const gitOptions = (flags: string, values: string, optional = ""): GitOptionTable => ({
  flags: new Set(flags.split(" ").filter(Boolean)), values: new Set(values.split(" ").filter(Boolean)), optional: new Set(optional.split(" ").filter(Boolean)),
});
const GIT_COMMON_NETWORK_FLAGS = "-q --quiet --no-quiet -v --verbose --no-verbose --progress --no-progress -4 --ipv4 -6 --ipv6";
const GIT_FETCH_FLAGS = "--all -a --append --atomic --unshallow --update-shallow --dry-run --porcelain --write-fetch-head --no-write-fetch-head -f --force -k --keep "
  + "--multiple --auto-maintenance --no-auto-maintenance --auto-gc --no-auto-gc --write-commit-graph --no-write-commit-graph --prefetch -p --prune -P --prune-tags "
  + "-n --no-tags -t --tags --no-recurse-submodules -u --update-head-ok --set-upstream --show-forced-updates --no-show-forced-updates --stdin --refetch";
const GIT_FETCH_VALUES = "--upload-pack --depth --deepen --shallow-since --shallow-exclude -j --jobs --refmap -o --server-option --negotiation-tip --filter "
  + "--recurse-submodules-default --submodule-prefix";
const GIT_NETWORK_OPTIONS: Record<string, GitOptionTable> = {
  push: gitOptions(`${GIT_COMMON_NETWORK_FLAGS} --all --branches --mirror --prune -n --dry-run --porcelain -d --delete --tags --follow-tags --no-follow-tags --no-signed `
    + "--atomic --no-atomic -f --force --no-force-with-lease --force-if-includes --no-force-if-includes --no-recurse-submodules --verify --no-verify -u --set-upstream "
    + "--thin --no-thin", "--repo -o --push-option --receive-pack --exec --recurse-submodules", "--signed --force-with-lease"),
  fetch: gitOptions(`${GIT_COMMON_NETWORK_FLAGS} ${GIT_FETCH_FLAGS} --negotiate-only`, GIT_FETCH_VALUES, "--recurse-submodules"),
  pull: gitOptions(`${GIT_COMMON_NETWORK_FLAGS} ${GIT_FETCH_FLAGS} --commit --no-commit -e --edit --no-edit --ff --no-ff --ff-only --no-log --signoff --no-signoff --stat `
    + "--no-stat --squash --no-squash --verify --no-verify --autostash --no-autostash --allow-unrelated-histories -r --no-rebase --verify-signatures "
    + "--no-verify-signatures --no-gpg-sign", `${GIT_FETCH_VALUES} -s --strategy -X --strategy-option --cleanup`, "--rebase --log --gpg-sign --recurse-submodules -S"),
  clone: gitOptions(`${GIT_COMMON_NETWORK_FLAGS} -l --local --no-local --no-hardlinks -s --shared --dissociate -n --no-checkout --bare --mirror --reject-shallow `
    + "--no-reject-shallow --single-branch --no-single-branch --no-tags --tags --shallow-submodules --no-shallow-submodules --remote-submodules "
    + "--no-remote-submodules --sparse --also-filter-submodules", "-o --origin -b --branch -u --upload-pack --reference --reference-if-able --separate-git-dir "
    + "--depth --shallow-since --shallow-exclude -c --config -j --jobs --template --filter --server-option --bundle-uri --ref-format --revision", "--recurse-submodules"),
  "ls-remote": gitOptions(`${GIT_COMMON_NETWORK_FLAGS} -h --heads --branches -t --tags --refs --exit-code --get-url --symref`, "--upload-pack --exec -o --server-option --sort"),
};

/** A git network command's arguments (after the subcommand), read exactly; `problem` names an option Paperclip does not know. */
export interface GitNetworkArguments {
  positional: string[];
  /** Flags as written (`-d`, `--delete`). */
  flags: Set<string>;
  /** Values of options that take one, by option name. */
  values: Map<string, string[]>;
  problem?: string;
}

/** Parses `git push|fetch|pull|clone|ls-remote` arguments; null for any other subcommand. */
export function gitNetworkArguments(subcommand: string, args: readonly string[]): GitNetworkArguments | null {
  const table = GIT_NETWORK_OPTIONS[subcommand];
  if (!table) return null;
  const result: GitNetworkArguments = { positional: [], flags: new Set(), values: new Map() };
  const value = (name: string, item: string) => result.values.set(name, [...(result.values.get(name) ?? []), item]);
  const unknown = (arg: string) => {
    result.problem ??= `Paperclip does not know the git ${subcommand} option ${arg.slice(0, 60)} (write options in full and short ones separately), so it cannot tell where the command goes.`;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") { result.positional.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { result.positional.push(arg); continue; }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals > 0 ? arg.slice(0, equals) : arg;
      if (equals > 0 && (table.values.has(name) || table.optional.has(name))) { value(name, arg.slice(equals + 1)); continue; }
      if (equals < 0 && table.values.has(name)) { value(name, args[index + 1] ?? ""); index += 1; continue; }
      if (equals < 0 && (table.flags.has(name) || table.optional.has(name))) { result.flags.add(name); continue; }
      unknown(arg);
      continue;
    }
    // Short options, possibly clustered: flags, then at most one that takes the rest (or the next argument) as its value.
    for (let at = 1; at < arg.length; at += 1) {
      const short = `-${arg[at]}`;
      if (table.values.has(short)) {
        if (at + 1 < arg.length) value(short, arg.slice(at + 1)); else { value(short, args[index + 1] ?? ""); index += 1; }
        break;
      }
      if (table.optional.has(short)) { if (at + 1 < arg.length) value(short, arg.slice(at + 1)); else result.flags.add(short); break; }
      if (table.flags.has(short)) { result.flags.add(short); continue; }
      unknown(arg);
      break;
    }
  }
  return result;
}
const GIT_UNKNOWN_DENIED = (name: string) =>
  `Paperclip does not run git ${name.slice(0, 60)} with GitHub access: it cannot check where that command connects. Use git fetch, pull, push, clone or ls-remote.`;

const read = (): GitHubCommandClass => ({ access: "read", action: null, privileged: [] });
const local = (action: GitHubOperationAction | null = null): GitHubCommandClass => ({ access: "none", action, privileged: [] });
const write = (action: GitHubOperationAction, ...privileged: GitHubPrivilegedAction[]): GitHubCommandClass =>
  ({ access: "write", action, privileged: [...new Set(privileged)] });

/** Index of git's subcommand in argv (after global options), or -1. */
export function gitSubcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    return index;
  }
  return -1;
}

/** The first global option before git's subcommand that Paperclip does not know, if any: it could shift where the subcommand is. */
function unknownGitGlobalOption(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) { index += 1; continue; }
    if (!arg.startsWith("-")) return null;
    if (!GIT_GLOBAL_FLAGS.has(arg) && !GIT_GLOBAL_INLINE.test(arg) && !/^-c./.test(arg) && !/^-C./.test(arg)) return arg;
  }
  return null;
}

/**
 * Config keys a `git push` may set on its command line (`-c`, `--config-env`), lowercase; `*` is any
 * subsection. Command-line config is read after everything the launcher sets, so any other key could
 * undo it: `submodule.recurse` and `push.recurseSubmodules` push submodules to remotes Paperclip
 * never checks, and `include.path` can bring in either.
 */
const GIT_PUSH_COMMAND_LINE_CONFIG = [
  /^user\.(name|email)$/, /^core\.quotepath$/, /^color\.[a-z0-9.-]+$/, /^advice\.[a-z0-9]+$/,
  /^push\.(default|followtags|autosetupremote)$/, /^remote\.pushdefault$/, /^branch\..+\.(remote|pushremote)$/, /^remote\..+\.(url|pushurl|push)$/,
];
/** The keys `-c name=value` (also attached, `-cname=value`) and `--config-env name=VAR` set before git's subcommand, lowercase. */
function gitCommandLineConfigKeys(args: readonly string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    let entry: string | null = null;
    if (arg === "-c" || arg === "--config-env") entry = args[++index] ?? "";
    else if (/^-c./.test(arg)) entry = arg.slice(2);
    else if (arg.startsWith("--config-env=")) entry = arg.slice("--config-env=".length);
    else if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) { index += 1; continue; }
    else if (!arg.startsWith("-")) break;
    if (entry !== null) keys.push(entry.split("=")[0]!.toLowerCase());
  }
  return keys;
}

/** True when a remote URL or gh repository names a github.com wiki, after URL decoding and normalization. */
export function isGitHubWikiRemote(remote: string | null | undefined, program: "git" | "gh" = "git"): boolean {
  if (!remote) return false;
  const destination = parseGitHubDestination(remote, program);
  return destination.kind === "github" && destination.wiki;
}

function isDefaultBranchRef(ref: string): boolean {
  return ref === "refs/heads/*" || GITHUB_DEFAULT_BRANCH_NAMES.some(name => ref === `refs/heads/${name}`);
}

/** One destination ref of a `git push`, and whether the push may overwrite its history or delete it. */
export interface GitPushUpdate {
  ref: string;
  /** `+refspec`, `--force`, `--force-with-lease`, `--mirror`, or refspecs from config Paperclip cannot see. */
  force: boolean;
  /** `--delete`, `:ref`, or a pattern under `--prune`/`--mirror` (or from config). */
  delete: boolean;
  /** The refspec comes from the checkout's config (no refspec on the command line). */
  configured?: true;
}

/**
 * Destination refs of a `git push`, fully qualified, with how each is updated.
 * `refs/heads/*` and `refs/tags/*` stand for "every branch" and "every tag". A
 * ref Paperclip cannot resolve counts as a branch of that name; with no branch
 * known, as every branch.
 */
export function gitPushUpdates(pushArgs: readonly string[], context: GitHubCommandContext = {}): GitPushUpdate[] {
  const parsed = gitNetworkArguments("push", pushArgs)!;
  const refspecs = parsed.positional.slice(1), flags = parsed.flags;
  const resolve = (name: string) => context.refs?.[name] ?? `refs/heads/${name}`;
  const current = context.currentBranch ? `refs/heads/${context.currentBranch}` : "refs/heads/*";
  const qualify = (name: string, src: string) => {
    // A pattern refspec can match any branch or tag.
    if (name.includes("*")) return /^(refs\/)?tags\//.test(name) ? "refs/tags/*" : "refs/heads/*";
    if (name === "HEAD" || name === "@") return current;
    if (name.startsWith("refs/")) return name;
    // git resolves heads/x and tags/x under refs/.
    if (/^(heads|tags)\//.test(name)) return `refs/${name}`;
    if (src && src !== name) {
      const source = src === "HEAD" || src === "@" ? current : src.startsWith("refs/") ? src : context.refs?.[src];
      return source?.startsWith("refs/tags/") ? `refs/tags/${name}` : `refs/heads/${name}`;
    }
    return resolve(name);
  };
  const mirror = flags.has("--mirror");
  // --force-with-lease (with or without a value) overwrites like --force; --force-if-includes alone does not.
  const forceAll = mirror || flags.has("-f") || flags.has("--force") || flags.has("--force-with-lease") || parsed.values.has("--force-with-lease");
  // --prune (and --mirror) delete the remote refs a pattern covers that the push does not send.
  const prune = mirror || flags.has("--prune");
  const deleting = flags.has("--delete") || flags.has("-d");
  const updates: GitPushUpdate[] = [];
  const add = (ref: string, force: boolean, remove: boolean) => updates.push({ ref, force: force || forceAll, delete: remove || (prune && ref.endsWith("/*")) });
  if (flags.has("--all") || flags.has("--branches") || mirror) add("refs/heads/*", false, false);
  // push.followTags sends tags with any refspec, unless --no-follow-tags turns it off for this push.
  if (flags.has("--tags") || flags.has("--follow-tags") || mirror || (context.followTags && !flags.has("--no-follow-tags"))) add("refs/tags/*", false, false);
  for (let index = 0; index < refspecs.length; index += 1) {
    const forced = refspecs[index]!.startsWith("+");
    const spec = refspecs[index]!.replace(/^\+/, "");
    if (spec === "tag" && index + 1 < refspecs.length) { add(`refs/tags/${refspecs[++index]}`, forced, deleting); continue; }
    // A bare `:` (or `+:`) pushes every branch both sides have.
    if (spec === ":") { add("refs/heads/*", forced, false); continue; }
    const colon = spec.indexOf(":");
    const src = deleting ? "" : colon < 0 ? spec : spec.slice(0, colon);
    const dst = deleting ? spec : colon < 0 || colon === spec.length - 1 ? src : spec.slice(colon + 1);
    add(qualify(dst, src), forced, deleting || colon === 0);
  }
  if (!refspecs.length && !flags.has("--tags") && !flags.has("--all") && !flags.has("--branches") && !mirror) {
    add(current, false, false);
    // Config refspecs (remote.<name>.push, mirror, push.default) may force or prune; Paperclip cannot see them.
    if (context.implicitPush) for (const ref of ["refs/heads/*", "refs/tags/*"]) updates.push({ ref, force: true, delete: true, configured: true });
  }
  return updates;
}

/** The destination refs of a `git push` ({@link gitPushUpdates}), each once. */
export function gitPushDestinations(pushArgs: readonly string[], context: GitHubCommandContext = {}): string[] {
  return [...new Set(gitPushUpdates(pushArgs, context).map(update => update.ref))];
}

function classifyGit(args: readonly string[], context: GitHubCommandContext): GitHubCommandClass {
  const unknownOption = unknownGitGlobalOption(args);
  if (unknownOption) return { ...write("other"), denied: `Paperclip does not know the git option ${unknownOption.slice(0, 60)}, so it cannot tell which command runs.`, integrity: true };
  const index = gitSubcommandIndex(args);
  const subcommand = index < 0 ? null : args[index]!;
  if (!subcommand) return local();
  if (GIT_COMMIT_SUBCOMMANDS.has(subcommand)) return local("commit");
  if (subcommand === "archive") {
    // `--remote` asks another server for the archive.
    return args.slice(index + 1).some(arg => /^--(remote|exec)(=|$)/.test(arg)) ? { ...read(), denied: GIT_UNKNOWN_DENIED("archive --remote"), integrity: true } : local();
  }
  if (GIT_LOCAL_SUBCOMMANDS.has(subcommand)) return local();
  const verb = args.slice(index + 1).find(arg => !arg.startsWith("-"));
  if (subcommand === "remote") {
    if (verb === undefined || GIT_REMOTE_LOCAL_VERBS.has(verb)) {
      // `git remote add -f` fetches right away.
      return verb === "add" && args.slice(index + 1).some(arg => arg === "-f" || arg === "--fetch") ? { ...read(), denied: GIT_UNKNOWN_DENIED("remote add --fetch"), integrity: true } : local();
    }
    return { ...read(), denied: GIT_UNKNOWN_DENIED(`remote ${verb}`), integrity: true };
  }
  if (subcommand === "submodule") return verb !== undefined && GIT_SUBMODULE_NETWORK_VERBS.has(verb) ? read() : local();
  if (subcommand === "lfs") return verb !== undefined && GIT_LFS_WRITE_VERBS.has(verb) ? write("push") : read();
  const wiki = isGitHubWikiRemote(context.remote) ? ["wiki" as const] : [];
  const network = gitNetworkArguments(subcommand, args.slice(index + 1));
  if (network?.problem) return { ...(subcommand === "push" ? write("push") : read()), denied: network.problem, integrity: true };
  const pushConfig = subcommand === "push" ? gitCommandLineConfigKeys(args).find(key => !GIT_PUSH_COMMAND_LINE_CONFIG.some(allowed => allowed.test(key))) : undefined;
  if (pushConfig !== undefined) {
    return { ...write("push"), denied: `Paperclip does not run git push with -c ${pushConfig.slice(0, 60)}: command-line config can undo what Paperclip sets (submodule recursion, includes). Set it in the repository's config or drop it.`, integrity: true };
  }
  // Pushing submodules sends the user's token to remotes Paperclip never checks; only no and check (which pushes nothing) pass.
  const recursion = subcommand === "push"
    ? [...(network?.values.get("--recurse-submodules") ?? []), ...(context.recurseSubmodules !== undefined ? [context.recurseSubmodules] : [])].find(value => !["no", "check"].includes(value))
    : undefined;
  if (recursion !== undefined) {
    return { ...write("push"), denied: `git push --recurse-submodules=${recursion.slice(0, 20)} pushes submodules to remotes Paperclip does not check; push each repository on its own.`, integrity: true };
  }
  if (subcommand === "push") {
    const updates = gitPushUpdates(args.slice(index + 1), context);
    const destinations = [...new Set(updates.map(update => update.ref))];
    const tags = destinations.filter(ref => ref.startsWith("refs/tags/"));
    // Only a push made of deletions alone adds no commits; a deletion next to an update does not hide the update.
    const deletes = updates.length > 0 && updates.every(update => update.delete);
    const result = write("push",
      ...(tags.length ? ["tagPush" as const] : []),
      ...(destinations.some(isDefaultBranchRef) ? ["pushToMain" as const] : []),
      // A deletion adds no commits; otherwise an unknown answer counts as a workflow change.
      ...(!deletes && context.touchesWorkflows !== false ? ["editWorkflows" as const] : []),
      ...wiki);
    const destructive = updates.find(update => (update.force || update.delete) && (isDefaultBranchRef(update.ref) || isProtectedBranchFloor(update.ref)));
    if (destructive) {
      return neverByAgents(result, "defaultBranch", destructive.configured
        ? "git push with the checkout's push config, which may force or prune every branch; push branches by name"
        : `git push ${destructive.delete ? "deleting" : "force-pushing"} ${destructive.ref}`);
    }
    // Any other branch the push forces or deletes may be the default or a protected branch: the server asks GitHub.
    const rewrites = [...new Set(updates.filter(update => (update.force || update.delete) && update.ref.startsWith("refs/heads/"))
      .map(update => update.ref.slice("refs/heads/".length)))];
    if (rewrites.length) result.branchRewrites = rewrites;
    if (tags.includes("refs/tags/*")) return { ...result, denied: BULK_TAG_DENIED };
    if (tags.some(ref => isReleaseTag(ref.slice("refs/tags/".length)))) return { ...result, denied: RELEASE_TAG_DENIED };
    return result;
  }
  if (subcommand === "pull") return { access: "read", action: "commit", privileged: wiki };
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return { access: "read", action: null, privileged: wiki };
  // Unknown commands, aliases and network plumbing: refused (fail closed).
  return { ...write("other"), denied: GIT_UNKNOWN_DENIED(subcommand), integrity: true };
}

/** gh value flags that can appear before a command's verb or name its target. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo"]);
/** Positional arguments after the command group, skipping flags (and the values of `-R`/`--repo`). */
export function ghPositionals(args: readonly string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") { positional.push(...args.slice(index + 1)); break; }
    if (GH_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return positional;
}
/** `gh release` options that take a value, so the tag is found among the remaining arguments. */
const GH_RELEASE_VALUE_FLAGS = new Set(["-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "--discussion-category", "--notes-start-tag", "-R", "--repo", "--tag"]);
/** Tags a `gh release` command names: the tag after `create`, and any `--tag` value. */
function releaseTags(args: readonly string[]): string[] {
  const tags: string[] = [];
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = /^--tag=(.*)$/.exec(arg);
    if (inline) { tags.push(inline[1]!); continue; }
    if (arg === "--tag") { tags.push(args[index + 1] ?? ""); index += 1; continue; }
    if (GH_RELEASE_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  if (positional[0] === "create" && positional[1]) tags.push(positional[1]);
  return tags;
}

/** Parses `gh api` argv (starting with `api`) the way gh's flag parser does; unknown flags are reported. */
export function parseGhApiArgs(args: readonly string[]): GhApiRequest {
  return parseGhCommand(["api", ...args.slice(1)]).api?.request
    ?? { method: null, path: null, hostname: null, fields: [], input: false, unknown: "(argv Paperclip cannot read)" };
}

/** One definition in a GraphQL document: its type and, for operations, the fields selected at its root. */
export interface GraphqlDefinition {
  type: "query" | "mutation" | "subscription" | "fragment";
  /** Root field names (aliases resolved), in order. */
  fields: string[];
  /** The root selects through a fragment spread or inline fragment, so its fields are not all visible here. */
  spread: boolean;
}

/**
 * The definitions in a GraphQL document, or null when Paperclip cannot read
 * it. Reads only the top-level structure and each operation's root fields:
 * comments, commas, strings, variable defaults, arguments and directive
 * arguments are skipped; anything that is not an operation or fragment
 * definition makes the document unreadable.
 */
export function parseGraphqlDocument(document: string): GraphqlDefinition[] | null {
  const definitions: GraphqlDefinition[] = [];
  let current: GraphqlDefinition | null = null;
  let braces = 0, parens = 0, brackets = 0;
  // At the top level: "definition" expects a keyword or `{`; "header" skips to the selection set.
  let state: "definition" | "header" = "definition";
  // The previous significant token at an operation's root, to tell aliases and directives from fields.
  let previous = "";
  const atRoot = () => braces === 1 && parens === 0 && brackets === 0;
  let index = 0;
  const length = document.length;
  while (index < length) {
    const char = document[index]!;
    if (char === "﻿" || char === " " || char === "\t" || char === "\n" || char === "\r" || char === ",") { index += 1; continue; }
    if (char === "#") { while (index < length && document[index] !== "\n" && document[index] !== "\r") index += 1; continue; }
    if (char === "\"") {
      if (braces === 0 && parens === 0) return null;
      if (document.startsWith("\"\"\"", index)) {
        let end = index + 3;
        for (;;) {
          const close = document.indexOf("\"\"\"", end);
          if (close < 0) return null;
          if (document[close - 1] === "\\") { end = close + 3; continue; }
          index = close + 3;
          break;
        }
        continue;
      }
      index += 1;
      while (index < length && document[index] !== "\"") {
        if (document[index] === "\n" || document[index] === "\r") return null;
        index += document[index] === "\\" ? 2 : 1;
      }
      if (index >= length) return null;
      index += 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(document.slice(index, index + 256))?.[0];
    if (name) {
      if (braces === 0 && parens === 0 && brackets === 0 && state === "definition") {
        if (name !== "query" && name !== "mutation" && name !== "subscription" && name !== "fragment") return null;
        current = { type: name as GraphqlDefinition["type"], fields: [], spread: false };
        definitions.push(current);
        state = "header";
      } else if (current && atRoot()) {
        // `alias: field` names the field second; `@directive` names no field.
        if (previous === ":") current.fields[current.fields.length - 1] = name;
        else if (previous !== "@" && previous !== "...") current.fields.push(name);
        previous = previous === "..." ? "..." : "name";
      }
      index += name.length;
      continue;
    }
    if (char === "." && document.startsWith("...", index)) {
      if (braces === 0) return null;
      if (current && atRoot()) { current.spread = true; previous = "..."; }
      index += 3;
      continue;
    }
    if (/[-0-9.]/.test(char)) {
      // Numbers; never at the start of a definition.
      if (braces === 0 && parens === 0 && state === "definition") return null;
      index += 1;
      continue;
    }
    if (char === "{") {
      if (braces === 0 && parens === 0 && brackets === 0 && state === "definition") {
        current = { type: "query", fields: [], spread: false };
        definitions.push(current);
      }
      braces += 1; index += 1;
      if (braces === 1) previous = "";
      continue;
    }
    if (char === "}") {
      braces -= 1; index += 1;
      if (braces < 0) return null;
      if (braces === 0 && parens === 0 && brackets === 0) state = "definition";
      if (atRoot()) previous = "}";
      continue;
    }
    if (char === "(") { parens += 1; index += 1; continue; }
    if (char === ")") { parens -= 1; index += 1; if (parens < 0) return null; if (atRoot()) previous = ")"; continue; }
    if (char === "[") { brackets += 1; index += 1; continue; }
    if (char === "]") { brackets -= 1; index += 1; if (brackets < 0) return null; continue; }
    if ("!$&:=@|".includes(char)) {
      if (braces === 0 && parens === 0 && state === "definition") return null;
      if (atRoot()) previous = char;
      index += 1;
      continue;
    }
    return null;
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0 || state !== "definition" || !definitions.some(definition => definition.type !== "fragment")) return null;
  return definitions;
}

/** The operation types in a GraphQL document, or null when Paperclip cannot read it. */
export function graphqlOperationTypes(document: string): Array<"query" | "mutation" | "subscription"> | null {
  const definitions = parseGraphqlDocument(document);
  return definitions ? definitions.flatMap(definition => definition.type === "fragment" ? [] : [definition.type]) : null;
}

/**
 * GraphQL mutations an agent may run through `gh api graphql`. They name their
 * target by node ID, so Paperclip cannot check the repository: only comment-class
 * and organization Project mutations are allowed. Merges, refs, commits, files,
 * releases and everything else go through gh commands or REST endpoints that
 * name the repository and carry the privileged checks.
 */
const GRAPHQL_COMMENT_MUTATIONS = new Set(["addComment", "resolveReviewThread", "unresolveReviewThread", "addPullRequestReviewThreadReply"]);
const GRAPHQL_PROJECT_MUTATIONS = new Set([
  "addProjectV2ItemById", "addProjectV2DraftIssue", "updateProjectV2ItemFieldValue", "clearProjectV2ItemFieldValue", "updateProjectV2ItemPosition",
  "archiveProjectV2Item", "unarchiveProjectV2Item", "deleteProjectV2Item", "convertProjectV2DraftIssueItemToIssue", "updateProjectV2DraftIssue",
]);

/**
 * GraphQL mutations that are operations agents never perform. Refs are named
 * by node ID, so `deleteRef`, `updateRef` and `updateRefs` could reach the
 * default branch on any repository: use git push, which names the branch.
 * GitHub's GraphQL API has no webhook, secret or variable mutations.
 */
const GRAPHQL_MUTATIONS_AGENTS_NEVER = new Map<string, AgentsNever>([
  ...["archiveRepository", "unarchiveRepository", "updateRepository", "transferRepository"].map(name => [name, "repository"] as const),
  ...["deleteRef", "updateRef", "updateRefs"].map(name => [name, "defaultBranch"] as const),
  ...["createBranchProtectionRule", "updateBranchProtectionRule", "deleteBranchProtectionRule",
    "createRepositoryRuleset", "updateRepositoryRuleset", "deleteRepositoryRuleset"].map(name => [name, "protection"] as const),
  ...["deleteDeployment", "createDeploymentStatus", "createEnvironment", "updateEnvironment", "deleteEnvironment"].map(name => [name, "deployments"] as const),
]);

/**
 * The operation agents never perform that a `gh api` REST write is, or null.
 * Matched case-insensitively on the route as GitHub routes it; `repositories/ID`
 * counts like `repos/OWNER/REPO`, and placeholders count as any value.
 */
function restWriteAgentsNever(route: string, method: string, request: GhApiRequest): GitHubCommandClass | null {
  const label = (path: string) => `${method} ${path}`;
  const organization = /^orgs\/[^/]+(?:\/(.*))?$/i.exec(route);
  if (organization) {
    const rest = organization[1] ?? "";
    if (/^hooks(\/|$)/i.test(rest)) return neverByAgents(write("other"), "hooks", label("orgs/{org}/hooks"));
    if (/^rulesets(\/|$)/i.test(rest)) return neverByAgents(write("other"), "protection", label("orgs/{org}/rulesets"));
    const secrets = /^(actions|dependabot|codespaces)\/(secrets|variables)(\/|$)/i.exec(rest);
    if (secrets) return neverByAgents(write("other"), "secrets", label(`orgs/{org}/${secrets[1]!.toLowerCase()}/${secrets[2]!.toLowerCase()}`));
    return null;
  }
  const repository = /^(?:repos\/[^/]+\/[^/]+|repositories\/[^/]+)(?:\/(.*))?$/i.exec(route);
  if (!repository) return null;
  const rest = repository[1] ?? "";
  const field = (name: string) => request.fields.filter(entry => entry.name === name);
  // Values Paperclip cannot see: a body from a file or stdin, a typed field read from one or filled by gh from the
  // checkout ({branch}, {repo}…), or a query string GitHub may read as parameters.
  const opaque = request.input || (request.path ?? "").includes("?")
    || request.fields.some(entry => entry.typed && (entry.value.startsWith("@") || GH_FILLED_PLACEHOLDER.test(entry.value)));
  if (rest === "" || /^transfer$/i.test(rest)) return neverByAgents(write("other"), "repository", label(rest ? "repos/{owner}/{repo}/transfer" : "repos/{owner}/{repo}"));
  // Branch names may hold slashes, which GitHub routes as they are (branches/release/1/protection).
  if (/^branches\/.+\/protection(\/|$)/i.test(rest)) return neverByAgents(write("other"), "protection", label("repos/{owner}/{repo}/branches/{branch}/protection"));
  if (/^rulesets(\/|$)/i.test(rest)) return neverByAgents(write("other"), "protection", label("repos/{owner}/{repo}/rulesets"));
  if (/^tags\/protection(\/|$)/i.test(rest)) return neverByAgents(write("other"), "protection", label("repos/{owner}/{repo}/tags/protection"));
  if (/^hooks(\/|$)/i.test(rest)) return neverByAgents(write("other"), "hooks", label("repos/{owner}/{repo}/hooks"));
  const secrets = /^(actions|dependabot|codespaces)\/(secrets|variables)(\/|$)/i.exec(rest);
  if (secrets) return neverByAgents(write("other"), "secrets", label(`repos/{owner}/{repo}/${secrets[1]!.toLowerCase()}/${secrets[2]!.toLowerCase()}`));
  if (/^keys(\/|$)/i.test(rest)) return neverByAgents(write("other"), "secrets", label("repos/{owner}/{repo}/keys"));
  if (/^environments(\/|$)/i.test(rest)) return neverByAgents(write("other"), "deployments", label("repos/{owner}/{repo}/environments"));
  if (/^deployments\/[^/]+$/i.test(rest)) return neverByAgents(write("other"), "deployments", label("repos/{owner}/{repo}/deployments/{id}"));
  // An inactive status deactivates the deployment (staging, Production); other states stay deployment approvals.
  if (/^deployments\/[^/]+\/statuses$/i.test(rest) && (opaque || field("state").some(entry => entry.value.trim().toLowerCase() === "inactive"))) {
    return neverByAgents(write("other", "deploymentApproval"), "deployments", label("repos/{owner}/{repo}/deployments/{id}/statuses with state inactive"));
  }
  const change = restBranchRewrite(rest, method, opaque, request);
  if (change && mayBeDefaultBranch(change.branch)) {
    return neverByAgents(change.kind === "rename" ? write("other") : write("push", "pushToMain"), "defaultBranch", label(change.kind === "rename"
      ? "repos/{owner}/{repo}/branches/{default branch}/rename"
      : `repos/{owner}/{repo}/git/refs/heads/{default branch}${change.kind === "force" ? " with force" : ""}`));
  }
  return null;
}

/**
 * The branch a `gh api` REST write deletes, force-updates or renames, if any.
 * `rest` is the route after `repos/OWNER/REPO/`. A ref update is forced unless
 * `force` is absent or exactly `false`; a value Paperclip cannot read may force it.
 */
function restBranchRewrite(rest: string, method: string, opaque: boolean, request: GhApiRequest): { branch: string; kind: "delete" | "force" | "rename" } | null {
  const rename = /^branches\/(.+)\/rename$/i.exec(rest);
  if (rename) return { branch: decodePath(rename[1]!), kind: "rename" };
  const head = /^git\/refs\/heads\/(.+)$/i.exec(rest);
  if (!head) return null;
  if (method === "DELETE") return { branch: decodePath(head[1]!), kind: "delete" };
  const forced = opaque || request.fields.some(entry => entry.name === "force" && entry.value !== "false");
  return forced ? { branch: decodePath(head[1]!), kind: "force" } : null;
}

/** The branch a `gh api` write (already classified, not refused) rewrites, as {@link GitHubCommandClass.branchRewrites}. */
function ghApiBranchRewrites(request: GhApiRequest, endpoint: GhApiRoute): string[] {
  const method = request.method ?? (request.fields.length || request.input ? "POST" : "GET");
  const rest = /^(?:repos\/[^/]+\/[^/]+|repositories\/[^/]+)\/(.+)$/i.exec(endpoint.route ?? "")?.[1];
  if (method === "GET" || method === "HEAD" || rest === undefined) return [];
  const opaque = request.input || (request.path ?? "").includes("?")
    || request.fields.some(entry => entry.typed && (entry.value.startsWith("@") || GH_FILLED_PLACEHOLDER.test(entry.value)));
  const change = restBranchRewrite(rest, method, opaque, request);
  return change ? [change.branch] : [];
}

/** A gh placeholder anywhere in a value, with gh's own pattern (`:branch-x` is filled too). */
const GH_FILLED_PLACEHOLDER = /\{(owner|repo|branch)\}|:(owner|repo|branch)\b/;

/** Reads the endpoint of `gh api` argv the way GitHub routes it. A full URL must be https://api.github.com. */
export function ghApiRoute(args: readonly string[]): GhApiRoute {
  return parseGhCommand(["api", ...args.slice(1)]).api?.endpoint
    ?? { route: null, problem: "Paperclip cannot tell which command runs.", repository: null, placeholder: false };
}

function ghApiClass(request: GhApiRequest, endpoint: GhApiRoute): GitHubCommandClass {
  if (request.unknown) return { ...write("other"), denied: `Paperclip does not know the gh api option ${request.unknown.slice(0, 60)}, so it cannot check this request.`, integrity: true };
  if (request.hostname !== null && request.hostname.trim().toLowerCase() !== "github.com") {
    return { ...write("other"), denied: `gh api would send this request to ${request.hostname.slice(0, 100)}; Paperclip hands GitHub credentials only to github.com (api.github.com).`, integrity: true };
  }
  // gh treats any endpoint containing "://" as a full URL; only https://api.github.com is allowed.
  if (endpoint.route === null && (request.path ?? "").includes("://")) return { ...write("other"), denied: endpoint.problem!, integrity: true };
  // `gh api` switches to POST when fields or a body are sent without an explicit method.
  const effective = request.method ?? (request.fields.length || request.input ? "POST" : "GET");
  const writes = effective !== "GET" && effective !== "HEAD";
  // Operations agents never perform are refused before anything else, also on a route Paperclip otherwise refuses.
  const never = writes && endpoint.route !== null && endpoint.route !== "graphql" ? restWriteAgentsNever(endpoint.route, effective, request) : null;
  if (never) return never;
  // gh fills {owner}, {repo} and {branch} (or :branch…) from the checkout after this check, and a branch name may hold
  // slashes (a branch named hooks/1 or heads/main), so a write's endpoint is written out beyond repos/{owner}/{repo}.
  if (writes && GH_FILLED_PLACEHOLDER.test((endpoint.route ?? "").replace(/^repos\/[^/]+\/[^/]+(\/|$)/i, ""))) {
    return { ...write("other"), denied: "Write the endpoint out instead of gh placeholders ({branch}, :branch…): gh fills them from the checkout, so Paperclip cannot check them.", integrity: true };
  }
  // A write Paperclip cannot route cannot be checked for those operations either, so it is refused for every company.
  if (endpoint.problem || endpoint.route === null) return { ...write("other"), denied: endpoint.problem ?? "Paperclip cannot read this endpoint.", ...(writes ? { integrity: true as const } : {}) };
  const route = endpoint.route;
  const fields = new Map<string, string>();
  // A typed field read from a file or stdin (`-F name=@file`) is a value Paperclip cannot see.
  let opaqueBody = request.input;
  for (const field of request.fields) {
    if (field.typed && field.value.startsWith("@")) { opaqueBody = true; continue; }
    fields.set(field.name, field.value);
  }
  if (route === "graphql") {
    // A request Paperclip cannot read may hold a mutation agents never perform: refused for every company.
    if (opaqueBody) return { ...write("other"), denied: "Pass the GraphQL query with -f query='...'; Paperclip cannot read a query or body from a file or stdin.", integrity: true };
    // gh fills placeholders in -F values after this check: a query sent that way could name any mutation.
    if (request.fields.some(field => field.name === "query" && field.typed && GH_FILLED_PLACEHOLDER.test(field.value))) {
      return { ...write("other"), denied: "Pass the GraphQL query with -f query='...': gh fills {owner}, {repo} and {branch} in a -F value, so Paperclip cannot check it.", integrity: true };
    }
    const queries = request.fields.filter(field => field.name === "query").map(field => field.value);
    const documents = queries.length ? queries.map(parseGraphqlDocument) : [null];
    if (documents.some(document => document === null)) return { ...write("other"), denied: "Paperclip cannot read this GraphQL document, so it cannot tell whether it changes anything.", integrity: true };
    // Any mutation or subscription in the document can run (operationName picks one): it is a write.
    const changes = documents.flatMap(document => document!).filter(definition => definition.type === "mutation" || definition.type === "subscription");
    if (!changes.length) return read();
    if (changes.some(definition => definition.type === "subscription" || definition.spread || !definition.fields.length)) {
      return { ...write("other"), denied: "Name each GraphQL mutation field directly (no subscriptions or fragments); Paperclip cannot check it otherwise.", integrity: true };
    }
    const fields = changes.flatMap(definition => definition.fields);
    const forbidden = fields.find(field => GRAPHQL_MUTATIONS_AGENTS_NEVER.has(field));
    if (forbidden) {
      const what = GRAPHQL_MUTATIONS_AGENTS_NEVER.get(forbidden)!;
      return neverByAgents(write("other"), what, `graphql ${forbidden}${what === "defaultBranch" ? ", which names its ref by node ID; use git push" : ""}`);
    }
    const unfenced = [...new Set(fields.filter(field => !GRAPHQL_COMMENT_MUTATIONS.has(field) && !GRAPHQL_PROJECT_MUTATIONS.has(field)))];
    // A mutation outside the fence may change anything its node ID names (settings, refs, collaborators): refused for every company.
    if (unfenced.length) {
      return { ...write("other"), denied: `Paperclip cannot check the GraphQL mutation ${unfenced.slice(0, 5).join(", ")}: it names its target by node ID. Use the gh command or the REST endpoint (repos/OWNER/REPO/...), which carry the repository and privileged checks.`, integrity: true };
    }
    if (fields.every(field => GRAPHQL_PROJECT_MUTATIONS.has(field))) return write("project");
    if (fields.every(field => GRAPHQL_COMMENT_MUTATIONS.has(field))) return write("comment");
    return { ...write("other"), denied: "Send comment and Project mutations in separate gh api graphql calls." };
  }
  // Only GET and HEAD are reads; any other method, known or not, is a write. Rendering markdown only reads.
  if (effective === "GET" || effective === "HEAD" || route === "markdown" || route === "markdown/raw") return read();
  const repo = /^repos\/[^/]+\/[^/]+\//.exec(`${route}/`) ? route.split("/").slice(3).join("/") : null;
  // A write outside repos/OWNER/REPO/… names no repository Paperclip can fence.
  if (repo === null) return { ...write("other"), denied: "Paperclip checks gh api writes only under repos/OWNER/REPO/… and graphql; use one of those endpoints." };
  // gh fills placeholders from the checkout (a branch can be named "pulls/1/merge" or "tags/pkg@1"), so a
  // write's endpoint after the repository, and the ref or tag it names, must be written out.
  const filled = [repo, fields.get("ref"), fields.get("tag"), fields.get("tag_name")].find(value => value !== undefined && GH_FILLED_PLACEHOLDER.test(value));
  if (filled !== undefined) {
    return { ...write("other"), denied: "Write the endpoint, ref and tag out instead of gh placeholders ({branch}, :branch…): gh fills them from the checkout, so Paperclip cannot check them." };
  }
  const fieldDependent = /^(releases(\/|$)|git\/(refs|tags)$|contents(\/|$)|merges$|merge-upstream$)/.test(repo);
  if (opaqueBody && fieldDependent) {
    return { ...write("other"), denied: "Name this request's fields with -f; Paperclip cannot check values read from a file or stdin here." };
  }
  // gh fills {branch} (or :branch) from the checkout, which may be the default branch.
  const defaultBranch = (name: string | undefined) => name === undefined || name.includes("{branch}") || name.includes(":branch") || GITHUB_DEFAULT_BRANCH_NAMES.includes(name.replace(/^refs\/heads\//, ""));
  if (/^actions\/runs\/[^/]+\/pending_deployments$/.test(repo)) return write("other", "deploymentApproval");
  // Creating a deployment or its status can start a deploy, like approving one.
  if (/^deployments(\/[^/]+\/statuses)?$/.test(repo)) return write("other", "deploymentApproval");
  // merge-upstream updates a branch (by default the default branch) from the upstream repository.
  if (repo === "merge-upstream") return write("push", ...(defaultBranch(fields.get("branch")) ? ["pushToMain" as const] : []));
  if (/^actions\/workflows\/[^/]+\/(dispatches|enable|disable)$|^dispatches$|^actions\/runs\/[^/]+\/(rerun|rerun-failed-jobs|cancel|force-cancel|approve)$|^actions\/jobs\/[^/]+\/rerun$/.test(repo)) {
    return write("other", "workflowDispatch");
  }
  // gh fills {branch} (and :branch, {owner}, …) from the checkout, so a tag name made of one cannot be checked for release tags.
  const releaseTag = (name: string | undefined) => !name ? {}
    : GH_FILLED_PLACEHOLDER.test(name) ? { denied: "Name the tag literally: gh fills {branch} and the other placeholders from the checkout, so Paperclip cannot check it for release tags." }
    : isReleaseTag(name) ? { denied: RELEASE_TAG_DENIED } : {};
  if (/^releases(\/|$)/.test(repo)) return { ...write("other", "release"), ...releaseTag(fields.get("tag_name")) };
  if (/^check-(runs|suites)\/[^/]+\/rerequest$/.test(repo)) return write("other", "workflowDispatch");
  if (repo === "git/refs") {
    const ref = fields.get("ref") ?? "";
    if (!ref) return { ...write("push", "tagPush", "pushToMain"), denied: "Name the ref with -f ref=refs/heads/<branch>; Paperclip cannot check a ref it cannot see." };
    return {
      ...write("push", ...(ref.startsWith("refs/tags/") ? ["tagPush" as const] : []), ...(ref.startsWith("refs/heads/") && defaultBranch(ref) ? ["pushToMain" as const] : [])),
      ...releaseTag(ref.startsWith("refs/tags/") ? ref : undefined),
    };
  }
  const encodedRef = /^git\/refs\/(.+)$/.exec(repo)?.[1];
  const ref = encodedRef ? decodePath(encodedRef) : undefined;
  if (ref) {
    return {
      ...write("push", ...(ref.startsWith("tags/") ? ["tagPush" as const] : []), ...(ref.startsWith("heads/") && defaultBranch(ref.slice("heads/".length)) ? ["pushToMain" as const] : [])),
      ...releaseTag(ref.startsWith("tags/") ? ref : undefined),
    };
  }
  if (repo === "git/tags") return { ...write("commit", "tagPush"), ...releaseTag(fields.get("tag")) };
  if (/^git\/(commits|trees|blobs)$/.test(repo)) return write("commit");
  // The contents API commits to the default branch unless a branch is named.
  if (/^contents(\/|$)/.test(repo)) {
    return write("commit",
      ...(defaultBranch(fields.get("branch")) ? ["pushToMain" as const] : []),
      ...(/^contents\/\.github\/workflows(\/|$)/.test(decodePath(repo)) ? ["editWorkflows" as const] : []));
  }
  if (repo === "merges") return write("push", ...(defaultBranch(fields.get("base") ?? "main") ? ["pushToMain" as const] : []));
  // A raw merge can bypass branch rules for an admin, so it counts as an admin merge.
  if (/^pulls\/[^/]+\/merge$/.test(repo)) return write("pullRequest", "adminMerge");
  if (/^(issues|pulls)\/[^/]+\/comments$|^pulls\/[^/]+\/reviews$|^pulls\/comments\/[^/]+\/replies$/.test(repo)) return write("comment");
  if (/^pulls(\/[^/]+(\/(update-branch|requested_reviewers))?)?$/.test(repo)) return write("pullRequest");
  return write("other");
}

/**
 * gh argv with -R/--repo given before the command group moved after it, as gh
 * reads it; a problem when another option comes first, or an empty argument
 * comes before the verb (gh skips empty arguments when it finds the command).
 */
export function normalizeGhArgs(args: readonly string[]): { args: string[]; problem?: undefined } | { args?: undefined; problem: string } {
  const command = parseGhCommand(args);
  return command.problem !== null ? { problem: command.problem } : { args: command.args };
}

/**
 * Index of a gh command's verb in normalized argv: right after the group, or
 * after an -R/--repo given first. -1 when another option comes before it: gh's
 * parser skips options it does not need when finding the verb, so Paperclip
 * could not tell which command runs.
 */
export function ghVerbIndex(args: readonly string[]): number {
  return parseGhCommand(args).verbIndex;
}

/**
 * gh's own command groups (gh 2.97) that may write; its read-only groups are in
 * the shared gh grammar. gh runs an alias or an extension for any other name.
 */
const GH_WRITE_GROUPS = new Set(["pr", "issue", "release", "workflow", "run", "project", "repo", "secret", "variable", "alias", "extension", "copilot",
  "codespace", "discussion", "gist", "label", "cache", "gpg-key", "ssh-key", "agent-task", "preview", "skill"]);

/** `gh repo` verbs agents never run: they archive, delete, rename, transfer or change the settings of a repository. */
const GH_REPO_VERBS_AGENTS_NEVER = new Set(["archive", "unarchive", "delete", "rename", "edit", "transfer"]);

function classifyGh(original: readonly string[]): GitHubCommandClass {
  // One grammar for gh argv, shared with the managed launcher (which embeds it).
  const command = parseGhCommand(original);
  if (command.problem !== null) return { ...write("other"), denied: command.problem, integrity: true };
  const args = command.args;
  const group = command.group;
  if (group === null || group.startsWith("-")) return read();
  if (command.hidesRepo) {
    return { ...write("other"), denied: "Write -R OWNER/REPO on its own (and short options separately): gh reads an R inside a cluster of short options as -R.", integrity: true };
  }
  // Commands that print the credential (the shared grammar, which the launcher also refuses without asking).
  if (command.printsToken) return { ...read(), denied: "Paperclip does not hand GitHub credentials to commands that print them.", integrity: true };
  // Whatever the launcher may run without a managed credential is a read here, so a write is never one it runs that way.
  if (!ghCommandMayWrite(command)) return read();
  if (group === "api") {
    const result = ghApiClass(command.api!.request, command.api!.endpoint);
    const rewrites = result.denied ? [] : ghApiBranchRewrites(command.api!.request, command.api!.endpoint);
    return rewrites.length ? { ...result, branchRewrites: rewrites } : result;
  }
  // An alias or an extension can run any gh command or program, and the Copilot CLI any command: Paperclip cannot check them.
  if (!GH_WRITE_GROUPS.has(group)) {
    return { ...write("other"), denied: `Denied: Paperclip does not know the gh command ${group.slice(0, 60)}, so it cannot check it: gh aliases and extensions do not run with GitHub access. Run the gh command itself.`, integrity: true };
  }
  if (group === "copilot") return { ...write("other"), denied: "Denied: Paperclip does not run the Copilot CLI with GitHub access: it cannot tell what it runs.", integrity: true };
  const verbIndex = command.verbIndex;
  // gh <group> --help prints help and runs nothing.
  if (verbIndex < 0 && args.length === 2 && (args[1] === "-h" || args[1] === "--help")) return read();
  // A hidden verb may be one agents never run (gh repo archive), so the refusal applies to every company.
  if (verbIndex < 0) {
    return { ...write("other"), denied: "Put the verb right after the gh command group (gh pr merge …, with -R OWNER/REPO first if needed): Paperclip cannot tell which command an option before it hides.", integrity: true };
  }
  const verb = args[verbIndex];
  switch (group) {
    case "pr":
      if (verb === "comment" || verb === "review") return write("comment");
      if (verb === "merge" && args.some(arg => arg === "--admin" || (arg.startsWith("--admin=") && arg !== "--admin=false"))) return write("pullRequest", "adminMerge");
      return write("pullRequest");
    case "issue": return verb === "comment" ? write("comment") : write("other");
    case "release": {
      const tags = releaseTags(args);
      return { ...write("other", "release"), ...(tags.some(isReleaseTag) ? { denied: RELEASE_TAG_DENIED } : {}) };
    }
    case "workflow": case "run": return write("other", "workflowDispatch");
    case "project": return write("project");
    case "repo": {
      if (verb !== undefined && GH_REPO_VERBS_AGENTS_NEVER.has(verb)) return neverByAgents(write("other"), "repository", `gh repo ${verb}`);
      if (verb === "deploy-key" && args[verbIndex + 1] !== "list") return neverByAgents(write("other"), "secrets", "gh repo deploy-key");
      // `gh repo sync` updates a branch (by default the default branch) from its upstream; --force hard-resets it.
      if (verb !== "sync") return write("other");
      const force = args.some(arg => arg === "--force" || (arg.startsWith("--force=") && !/^--force=(false|f|0)$/i.test(arg)));
      const branchAt = args.findIndex(arg => arg === "-b" || arg === "--branch");
      const branch = branchAt > 0 ? args[branchAt + 1] : args.find(arg => /^(--branch=|-b.)/.test(arg))?.replace(/^(--branch=|-b=?)/, "");
      if (force && (branch === undefined || mayBeDefaultBranch(branch))) return neverByAgents(write("push", "pushToMain"), "defaultBranch", "gh repo sync --force");
      // A named branch may still be protected: the server asks GitHub.
      return force ? { ...write("push", "pushToMain"), branchRewrites: [branch!] } : write("push", "pushToMain");
    }
    // Secrets and variables never change through an agent; their list and get verbs are reads.
    case "secret": case "variable": return verb === "ls" ? read() : neverByAgents(write("other"), "secrets", `gh ${group} ${verb}`);
    case "alias": return { ...write("other"), denied: "Denied: Paperclip does not create gh aliases for agents: it cannot tell what an alias runs. Run the gh command itself.", integrity: true };
    case "extension": return { ...write("other"), denied: "Denied: Paperclip does not run gh extensions with GitHub access: it cannot tell what an extension runs.", integrity: true };
    default: return write("other");
  }
}

/**
 * Classifies one managed command from its argv (without the executable).
 * A command Paperclip does not recognize counts as a write (`other`).
 */
export function classifyGitHubCommand(tool: "git" | "gh", args: readonly string[], context: GitHubCommandContext = {}): GitHubCommandClass {
  return tool === "git" ? classifyGit(args, context) : classifyGh(args);
}

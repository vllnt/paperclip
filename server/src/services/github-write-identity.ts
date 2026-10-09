import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { pluginState, plugins, type Db } from "@paperclipai/db";
import {
  GITHUB_WRITE_IDENTITY_STATE,
  classifyGitHubCommand,
  ghApiRoute,
  ghVerbIndex,
  gitNetworkArguments,
  gitPushDestinations,
  normalizeGhArgs,
  gitSubcommandIndex,
  parseGhApiArgs,
  parseGitHubDestination,
  parseGitHubWriteIdentityPolicy,
  type GitHubAccess,
  type GitHubDestination,
  type GitHubOperationAction,
  type GitHubPrivilegedAction,
  type GitHubSignDecision,
  type GitHubWorkflowPush,
  type GitHubWriteIdentityDecision,
  type GitHubWriteIdentityPolicy,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

/**
 * One managed `git`/`gh` invocation as reported by the token-free launcher.
 * Used only to choose the identity; never persisted or logged, because
 * arguments can carry message bodies.
 */
export const gitHubOperationSchema = z.object({
  program: z.enum(["git", "gh"]),
  args: z.array(z.string().max(8192)).max(256),
  /** The remote URL the command targets (git), or the checkout's origin URL (gh), when known. */
  remote: z.string().max(1000).nullable().optional(),
  /** gh: GH_REPO, which gh uses instead of the checkout's remotes when no -R is given. */
  ghRepo: z.string().max(1000).nullable().optional(),
  /** gh without -R or GH_REPO: the checkout's saved default repositories (remote.<name>.gh-resolved); "base" marks a remote. */
  ghResolved: z.array(z.string().max(1000)).max(16).optional(),
  /** git push: the checked-out branch. */
  currentBranch: z.string().max(1000).nullable().optional(),
  /** git push: full ref names of bare refspec names, resolved in the checkout. */
  refs: z.record(z.string().max(300), z.string().max(300)).optional()
    .refine(value => !value || Object.keys(value).length <= 64, "Too many refs"),
  /** git push: whether the new commits change `.github/workflows/**`; null when unknown. */
  touchesWorkflows: z.boolean().nullable().optional(),
  /**
   * git push of one commit that changes workflow files: every file under `.github/workflows` at the pushed commit, the new
   * commits that change workflow paths (with their parents and those paths as they have them: git mode and blob id, null
   * when gone), and the parents where new history joins commits that already exist. Absent when unknown or too much.
   */
  workflowFiles: z.array(z.object({ path: z.string().max(300), mode: z.string().regex(/^\d{6}$/), oid: z.string().regex(/^[0-9a-f]{40,64}$/) })).max(100).optional(),
  workflowCommits: z.array(z.object({
    sha: z.string().regex(/^[0-9a-f]{40,64}$/),
    parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)).max(16),
    changes: z.array(z.object({
      path: z.string().max(300),
      mode: z.string().regex(/^\d{6}$/).nullable(),
      oid: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
    })).min(1).max(100),
  })).max(100).optional()
    .refine(value => !value || value.reduce((total, commit) => total + commit.changes.length, 0) <= 400, "Too many workflow changes"),
  workflowEntries: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)).max(8).optional(),
  /** git push: the commit SHAs being pushed (for the audit record). */
  shas: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)).max(64).optional(),
  /** git push: every push URL of the remote (git pushes to all of them). */
  pushUrls: z.array(z.string().max(1000)).max(16).optional(),
  /** gh without -R or GH_REPO: the checkout's remote URLs, since gh may pick any of them. */
  remotes: z.array(z.string().max(1000)).max(16).optional(),
  /** git: url.*.insteadOf / pushInsteadOf config beyond Paperclip's own, so the destination is uncertain. */
  urlRewrites: z.boolean().optional(),
  /** git push without refspecs: config that can push more than the current branch. */
  implicitPush: z.boolean().optional(),
  followTags: z.boolean().optional(),
  recurseSubmodules: z.string().max(100).optional(),
  /** The launcher shortened the command to report it. */
  truncated: z.boolean().optional(),
});
/**
 * The agent and run an operation came from. The server sets it from the run's own token with
 * {@link attachGitHubCaller}; the launcher's report can never name them (the schema above has no such field and
 * drops one), so no command can claim to come from another agent.
 */
export interface GitHubOperationCaller { agentId: string; runId: string }
export type GitHubOperation = z.infer<typeof gitHubOperationSchema> & { caller?: GitHubOperationCaller };

/** A launcher body that names an operation Paperclip cannot read. */
export const UNREADABLE_GITHUB_OPERATION = "unreadable" as const;

/** The reported operation; `unreadable` when a body names one that fails validation. */
export function readGitHubOperation(body: unknown): GitHubOperation | typeof UNREADABLE_GITHUB_OPERATION | null {
  const operation = body && typeof body === "object" ? (body as { operation?: unknown }).operation : undefined;
  if (operation === undefined || operation === null) return null;
  const parsed = gitHubOperationSchema.safeParse(operation);
  return parsed.success ? parsed.data : UNREADABLE_GITHUB_OPERATION;
}

export function parseGitHubOperation(body: unknown): GitHubOperation | null {
  const operation = readGitHubOperation(body);
  return operation === UNREADABLE_GITHUB_OPERATION ? null : operation;
}

/**
 * The reported operation with the run that sent it, taken from the run's token on the server (never from the
 * report). Scoped privileged grants match on this agent. A report that is missing or unreadable stays as it is.
 */
export function attachGitHubCaller<T extends GitHubOperation | typeof UNREADABLE_GITHUB_OPERATION | null>(operation: T, run: { agentId: string; runId: string }): T {
  return operation && typeof operation === "object" ? { ...operation, caller: { agentId: run.agentId, runId: run.runId } } : operation;
}

/** Values of gh flags that always hold free text, never a repository or URL selector. */
const GH_TEXT_FLAGS = new Set(["--body", "-b", "--title", "--notes", "--homepage", "--description"]);
/** gh pr merge's flags: those that take a value, and the others. Any other flag is refused. */
const GH_PR_MERGE_VALUE_FLAGS = new Set(["--match-head-commit", "-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "-R", "--repo"]);
const GH_PR_MERGE_FLAGS = new Set(["--admin", "--auto", "-d", "--delete-branch", "--disable-auto", "-m", "--merge", "-r", "--rebase", "-s", "--squash", "-h", "--help"]);

/**
 * Exactly what `gh pr merge` merges: its selector and expected head commit.
 * gh's flag parser gives a value flag the next argument whatever it looks like,
 * so every flag must be known; an unknown flag or a second selector is refused.
 */
function ghPrMergeArguments(args: readonly string[]): { selector: string | null; sha: string | null; auto: boolean; problem?: string } {
  const positional: string[] = [];
  let sha: string | null = null;
  // --auto in any spelling but an explicit false enables auto-merge (or the merge queue).
  let auto = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") { positional.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { positional.push(arg); continue; }
    const equals = arg.indexOf("=");
    // --name=value, and pflag's -X=value short form.
    const name = (arg.startsWith("--") && equals > 0) || /^-[A-Za-z]=/.test(arg) ? arg.slice(0, equals) : arg;
    if (GH_PR_MERGE_VALUE_FLAGS.has(name)) {
      const value = name !== arg ? arg.slice(equals + 1) : args[++index] ?? "";
      if (name === "--match-head-commit") sha = value;
      continue;
    }
    if (name === "--auto" && !/^--auto=(false|f|0)$/i.test(arg)) auto = true;
    if (GH_PR_MERGE_FLAGS.has(name) || /^--admin=(true|false)$/.test(arg)) continue;
    // Short flags combined (-ds) or with an attached value (-RO/R, -tTitle).
    if (/^-[A-Za-z]{2,}/.test(arg) && !arg.startsWith("--")) {
      let known = true;
      for (let at = 1; at < arg.length; at += 1) {
        const flag = `-${arg[at]}`;
        if (GH_PR_MERGE_VALUE_FLAGS.has(flag)) { if (at + 1 >= arg.length) index += 1; break; }
        if (!GH_PR_MERGE_FLAGS.has(flag)) { known = false; break; }
      }
      if (known) continue;
    }
    return { selector: null, sha: null, auto, problem: `Paperclip does not know the gh pr merge option ${arg.slice(0, 60)}, so it cannot tell which pull request is merged.` };
  }
  // positional[0] is "merge".
  if (positional.length > 2) return { selector: null, sha: null, auto, problem: "Name one pull request: gh pr merge <number> …; Paperclip cannot tell which of several arguments gh merges." };
  return { selector: positional[1] ?? null, sha, auto };
}
/** `gh repo` verbs whose positional arguments name repositories (`create` names a new one). */
const GH_REPO_POSITIONAL_VERBS = new Set(["view", "clone", "edit", "delete", "archive", "unarchive", "sync", "fork", "set-default", "create"]);
const GH_REPOSITORY_LIKE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.%-]+){1,2}$/;

/** A gh URL argument as a destination: a github.com URL becomes its repository; anything else stays as given (and is refused). */
function ghUrlDestination(arg: string): string | null {
  let url: URL;
  try { url = new URL(arg); } catch { return arg; }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return arg;
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  // A github.com page that is not a repository (for example /settings) names none.
  return owner && name ? `https://github.com/${owner}/${name}` : null;
}

/**
 * What a gh command names, and the hosts it asks gh to contact.
 * - `named`: `-R`/`--repo` (gh uses the last), GH_REPO, the gh api endpoint, URL arguments,
 *   repository arguments of `gh repo` and the destination of `gh issue transfer`.
 * - `hosts`: `--hostname` values (and `-h` under `gh auth`).
 * - `withAmbient`: the checkout's remotes are a destination too (`gh issue transfer`).
 */
function ghDestinations(operation: GitHubOperation): { named: string[]; hosts: string[]; withAmbient: boolean; swallowedRepo: boolean } {
  const args = operation.args;
  const group = args[0];
  let explicit: string | null = null;
  const named: string[] = [];
  const hosts: string[] = [];
  const positional: string[] = [];
  // gh gives a value flag the next argument whatever it looks like: `-t -R o/r` titles "-R" and acts on the checkout.
  let swallowedRepo = false;
  const takesNext = (previous: string | undefined) => !!previous && previous.startsWith("-") && previous.length > 1 && !previous.includes("=") && !GH_TEXT_FLAGS.has(previous);
  for (let index = group === undefined ? 0 : 1; index < args.length; index += 1) {
    const arg = args[index]!;
    const repoFlag = arg === "-R" || arg === "--repo" || /^(?:--repo=|-R)/.test(arg);
    if (repoFlag && index > 1 && takesNext(args[index - 1])) swallowedRepo = true;
    if (arg === "-R" || arg === "--repo") { explicit = args[index + 1] ?? ""; index += 1; continue; }
    const repoInline = /^(?:--repo=|-R=?)([\s\S]*)$/.exec(arg);
    if (repoInline) { explicit = repoInline[1]!; continue; }
    if (arg === "--hostname" || (group === "auth" && arg === "-h")) { hosts.push(args[index + 1] ?? ""); index += 1; continue; }
    if (arg.startsWith("--hostname=")) { hosts.push(arg.slice("--hostname=".length)); continue; }
    // A text option's value is skipped only when the option itself cannot be another option's value
    // (`-q --body URL` gives --body to -q, and URL is then gh's selector).
    if (GH_TEXT_FLAGS.has(arg) && !(args[index - 1]?.startsWith("-") && !args[index - 1]!.includes("="))) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  if (explicit !== null) named.push(explicit);
  else if (operation.ghRepo) named.push(operation.ghRepo);
  let withAmbient = false;
  if (group === "api") {
    // The same normalized route the classifier reads; gh fills {owner}/{repo} (or :owner/:repo) from the checkout, as without -R.
    const endpoint = ghApiRoute(args);
    if (endpoint.repository) named.push(endpoint.repository);
  } else {
    for (const arg of positional) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
        const destination = ghUrlDestination(arg);
        if (destination) named.push(destination);
      }
    }
    const verb = positional[0];
    const rest = positional.slice(1).filter(arg => !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg));
    if (group === "repo" && verb && GH_REPO_POSITIONAL_VERBS.has(verb)) {
      const repositories = rest.filter(arg => verb === "create" || GH_REPOSITORY_LIKE.test(arg)).slice(0, verb === "create" ? 1 : 16);
      named.push(...repositories);
      // Without a repository argument these verbs act on the checkout's saved default or remote, whatever GH_REPO
      // says (gh 2.97 ignores GH_REPO for repo view, edit, fork, archive…): both count, and a write needs them to agree.
      if (!repositories.length && explicit === null && operation.ghRepo) withAmbient = true;
    }
    if (group === "issue" && verb === "transfer") {
      named.push(...rest.filter(arg => GH_REPOSITORY_LIKE.test(arg)));
      withAmbient = explicit === null && !operation.ghRepo;
    }
  }
  return { named, hosts, withAmbient, swallowedRepo };
}

/**
 * The repository argument of a git network command (the first positional
 * argument, or push's --repo), read with the same exact option tables as the
 * classifier; null when it names none.
 */
function gitTarget(args: readonly string[], index: number): string | null {
  const subcommand = index < 0 ? undefined : args[index];
  const parsed = subcommand ? gitNetworkArguments(subcommand, args.slice(index + 1)) : null;
  if (!parsed) return null;
  // A positional repository wins over --repo, as in git.
  return parsed.positional[0] ?? (subcommand === "push" ? parsed.values.get("--repo")?.at(-1) ?? null : null);
}

export interface ClassifiedGitHubOperation {
  access: GitHubAccess;
  action: GitHubOperationAction | null;
  privileged: GitHubPrivilegedAction[];
  denied?: string;
  /** Lowercase `owner/name` with any `.wiki` folded in, or null. */
  repository: string | null;
  wiki: boolean;
  pullRequest: number | null;
  expectedHeadSha: string | null;
  /** Non-secret details for the audit record (SHAs, Actions run, approval state). */
  target: Record<string, unknown>;
  /** A git command that can ask Paperclip to sign the commits it creates (commit, merge, rebase, pull…). */
  signing?: boolean;
  /** The refusal protects the credential itself, so it applies whether or not the company has a policy. */
  integrity?: true;
  /** A pull request merge (gh pr merge, the REST merge endpoint): the plugin's protected-path guard checks it. */
  merge?: true;
  /** The merge enables auto-merge (gh pr merge --auto), which may also put it in the merge queue. */
  autoMerge?: true;
  /** The command changes an open pull request's base branch (gh pr edit --base, the REST base field). */
  retarget?: true;
  /**
   * A push of one commit to one named branch that asks for `editWorkflows`, with the workflow paths it changes. The
   * plugin lets it through without the toggle only when every path is the base branch's own.
   */
  workflowPush?: GitHubWorkflowPush;
  /** The endpoint of a `gh api` write that needs `editWorkflows`: the plugin records it with the allowed write. */
  route?: string;
  /** The agent and run that sent the command, when the server attached them (see {@link GitHubOperationCaller}). */
  caller?: GitHubOperationCaller;
}

/** A reported command Paperclip could not read: it is treated as a write it cannot check. */
export const UNREADABLE_CLASSIFIED_OPERATION: ClassifiedGitHubOperation = {
  access: "write", action: "other", privileged: [], denied: "Paperclip could not read this command's report, so it cannot check it.",
  repository: null, wiki: false, pullRequest: null, expectedHeadSha: null, target: {},
};

/** A command the launcher did not report (for example a server-side clone) counts as a plain read. */
export const UNREPORTED_GITHUB_OPERATION: ClassifiedGitHubOperation = {
  access: "read", action: null, privileged: [], repository: null, wiki: false, pullRequest: null, expectedHeadSha: null, target: {},
};

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Classifies one reported command and names its repository. Every destination
 * the command names must be a github.com repository: another host, a remote
 * helper or a destination Paperclip cannot read refuses the whole command,
 * reads included. A git command that only reaches local paths gets no GitHub access.
 */
export function classifyGitHubOperation(reported: GitHubOperation): ClassifiedGitHubOperation {
  // gh argv as gh reads it (a leading -R after the group); the classifier refuses argv it cannot normalize.
  const normalized = reported.program === "gh" ? normalizeGhArgs(reported.args).args : undefined;
  const operation: GitHubOperation = normalized ? { ...reported, args: normalized } : reported;
  const index = operation.program === "git" ? gitSubcommandIndex(operation.args) : -1;
  const subcommand = index < 0 ? undefined : operation.args[index];
  let named: Array<{ value: string; semantics: "git" | "gh" }>;
  let ambient: string[] = [];
  let hosts: string[] = [];
  let swallowedRepo = false;
  if (operation.program === "gh") {
    const destinations = ghDestinations(operation);
    named = destinations.named.map(value => ({ value, semantics: "gh" as const }));
    hosts = destinations.hosts;
    swallowedRepo = destinations.swallowedRepo;
    if (!named.length || destinations.withAmbient) {
      // gh's saved default repository (gh repo set-default, remote.<name>.gh-resolved) replaces the remotes; "base" only marks a remote.
      const saved = (operation.ghResolved ?? []).filter(value => value !== "base");
      if (saved.length) named.push(...saved.map(value => ({ value, semantics: "gh" as const })));
      else ambient = (operation.remotes?.length ? operation.remotes : [operation.remote]).filter((value): value is string => !!value);
    }
  } else {
    // A target the launcher resolved as a configured remote (git checks remote names first) is that remote's URL;
    // otherwise the target itself is the URL or path.
    const target = gitTarget(operation.args, index);
    const resolved = subcommand === "push" && operation.pushUrls?.length ? operation.pushUrls : operation.remote ? [operation.remote] : [];
    // A target with a colon is a URL or scp address (never a remote name): it always counts.
    const values = [...resolved, ...(target && (target.includes(":") || !resolved.length) ? [target] : [])];
    named = values.map(value => ({ value, semantics: "git" as const }));
  }
  const parsed = named.map(entry => parseGitHubDestination(entry.value, entry.semantics));
  // gh ignores remotes on other hosts (its host is pinned to github.com), so only GitHub ones count.
  const ambientRepositories = ambient.map(value => parseGitHubDestination(value, "git"))
    .filter((destination): destination is Extract<GitHubDestination, { kind: "github" }> => destination.kind === "github");
  const github = [...parsed.filter((destination): destination is Extract<GitHubDestination, { kind: "github" }> => destination.kind === "github"), ...ambientRepositories];
  const candidates = [...new Set(github.map(destination => destination.repository))];
  const firstRemote = named[0]?.value ?? ambient[0] ?? null;
  const command = classifyGitHubCommand(operation.program, operation.args, {
    remote: operation.program === "git" ? firstRemote : null,
    currentBranch: operation.currentBranch ?? null,
    refs: operation.refs,
    touchesWorkflows: operation.touchesWorkflows,
    implicitPush: operation.implicitPush,
    followTags: operation.followTags,
    recurseSubmodules: operation.recurseSubmodules,
  });
  let access = command.access;
  let denied = command.denied;
  let integrity = command.integrity;
  const network = access !== "none";
  // A refusal that protects the credential applies to every company, so it replaces a policy refusal.
  const refuse = (reason: string) => { if (!integrity) { denied = reason; integrity = true; } };
  const foreign = parsed.find((destination): destination is Extract<GitHubDestination, { kind: "foreign" }> => destination.kind === "foreign");
  const badHost = hosts.find(host => host.trim().toLowerCase() !== "github.com");
  const local = parsed.some(destination => destination.kind === "local");
  if (network && badHost !== undefined) refuse(`This command asks gh to contact ${badHost.slice(0, 100) || "(no host)"}; Paperclip hands GitHub credentials only to github.com.`);
  if (network && foreign) refuse(`This command goes to ${foreign.reason}; Paperclip hands GitHub credentials only to github.com repositories.`);
  if (network && operation.program === "git" && operation.urlRewrites) {
    refuse("This checkout rewrites GitHub URLs (url.*.insteadOf), so Paperclip cannot check where the command goes. Remove the rewrite.");
  }
  if (network && operation.truncated) refuse("This command is too long for Paperclip to check; shorten it.");
  if (!denied && network && local && candidates.length) denied = "This command reaches both a local path and GitHub; Paperclip cannot check that as one operation. Push or fetch them separately.";
  // Only local paths: nothing reaches GitHub, so no GitHub access is given. A push stays a write, so every check still applies.
  if (!denied && network && local && !candidates.length && subcommand !== "push") access = "none";
  const ghVerb = operation.program === "gh" ? operation.args[ghVerbIndex(operation.args)] : undefined;
  if (!denied && access === "write" && swallowedRepo && !(operation.args[0] === "pr" && ghVerb === "merge")) {
    denied = "Put -R OWNER/REPO right after the command (gh <group> <verb> -R OWNER/REPO …): the option before it may take it as its value, so Paperclip cannot tell which repository gh writes to.";
  }
  if (!denied && access === "write" && candidates.length > 1) {
    denied = `Paperclip cannot tell which repository this command writes to (${candidates.join(", ")}); name one with -R owner/name or use a single remote.`;
  }
  const repository = candidates.length === 1 ? candidates[0]! : null;
  // The wiki flag comes from the parsed destinations, never from the raw text.
  const wiki = access !== "none" && github.some(destination => destination.wiki);
  const privileged = [...new Set([...command.privileged.filter(name => name !== "wiki"), ...(wiki ? ["wiki" as const] : [])])];
  const target: Record<string, unknown> = {};
  let pullRequest: number | null = null;
  let expectedHeadSha: string | null = null;
  let merging = false, autoMerge = false, retarget = false;
  // gh pr edit's short options all take a value, so -B…, --base and --base=… are the only spellings of a base change.
  if (operation.program === "gh" && operation.args[0] === "pr" && ghVerb === "edit") {
    retarget = operation.args.slice(1).some(arg => arg === "--base" || arg.startsWith("--base=") || arg.startsWith("-B"));
  }
  if (operation.program === "git" && subcommand === "push" && operation.shas?.length) target.shas = operation.shas;
  // One commit to one named branch, reported whole, is the only push whose workflow history the plugin can check against GitHub.
  let workflowPush: GitHubWorkflowPush | undefined;
  if (operation.program === "git" && subcommand === "push" && privileged.includes("editWorkflows") && operation.touchesWorkflows === true
    && operation.shas?.length === 1 && operation.workflowFiles && operation.workflowCommits && operation.workflowEntries?.length) {
    const destinations = gitPushDestinations(operation.args.slice(index + 1), {
      currentBranch: operation.currentBranch ?? null, refs: operation.refs, followTags: operation.followTags, implicitPush: operation.implicitPush,
    });
    const [only] = destinations;
    if (destinations.length === 1 && only!.startsWith("refs/heads/") && !only!.includes("*")) {
      workflowPush = {
        branch: only!.slice("refs/heads/".length), tip: operation.shas[0]!,
        files: operation.workflowFiles, commits: operation.workflowCommits, entries: operation.workflowEntries,
      };
    }
  }
  if (operation.program === "gh" && operation.args[0] === "pr" && ghVerb === "merge") {
    const merge = ghPrMergeArguments(operation.args);
    merging = true;
    autoMerge = merge.auto;
    if (!denied && merge.problem) denied = merge.problem;
    const number = merge.selector ? /^(?:#)?(\d{1,9})$|\/pull\/(\d{1,9})(?:[/?#]|$)/.exec(merge.selector) : null;
    pullRequest = number ? Number(number[1] ?? number[2]) : null;
    expectedHeadSha = merge.sha;
  }
  if (operation.program === "gh" && operation.args[0] === "api") {
    const request = parseGhApiArgs(operation.args);
    const path = ghApiRoute(operation.args).route ?? "";
    const field = (name: string) => [...request.fields].reverse().find(entry => entry.name === name && !(entry.typed && entry.value.startsWith("@")))?.value ?? null;
    const merge = /^repos\/[^/]+\/[^/]+\/pulls\/(\d{1,9})\/merge$/.exec(path);
    if (merge) { pullRequest = Number(merge[1]); expectedHeadSha = field("sha"); merging = access === "write"; }
    // A base field, or a body Paperclip cannot read, on a pull request write may retarget it.
    if (access === "write" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(path)
      && (request.input || request.fields.some(entry => entry.name === "base" || (entry.typed && entry.value.startsWith("@"))))) retarget = true;
    const deployment = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d{1,20})\/pending_deployments$/.exec(path);
    if (deployment) {
      target.actionsRunId = deployment[1];
      target.state = field("state");
      target.comment = field("comment")?.slice(0, 500) ?? null;
    }
    const run = /^repos\/[^/]+\/[^/]+\/actions\/(?:runs|jobs)\/(\d{1,20})\//.exec(path);
    if (run && !deployment) target.actionsRunId = run[1];
  }
  if (pullRequest) target.pullRequest = pullRequest;
  // Only a full commit SHA binds a merge to one head; an abbreviation is dropped (and the merge refused).
  expectedHeadSha = expectedHeadSha?.toLowerCase() ?? null;
  if (expectedHeadSha && FULL_SHA.test(expectedHeadSha)) target.headSha = expectedHeadSha;
  else expectedHeadSha = null;
  return {
    access, action: command.action, privileged,
    ...(denied ? { denied } : {}),
    ...(denied && integrity ? { integrity } : {}),
    repository, wiki,
    pullRequest, expectedHeadSha, target,
    ...(merging ? { merge: true as const } : {}),
    ...(autoMerge ? { autoMerge: true as const } : {}),
    ...(retarget ? { retarget: true as const } : {}),
    ...(workflowPush ? { workflowPush } : {}),
    ...(command.route ? { route: command.route } : {}),
    ...(operation.caller ? { caller: operation.caller } : {}),
    ...(operation.program === "git" && command.action === "commit" ? { signing: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// The GitHub plugin's company policy and decisions
// ---------------------------------------------------------------------------

export interface GitHubIdentityPolicyRecord {
  pluginId: string;
  ready: boolean;
  manifest: PaperclipPluginManifestV1;
  /** The saved policy, or "invalid" when it no longer parses or the plugin is ambiguous (fail closed). */
  policy: GitHubWriteIdentityPolicy | "invalid";
  /** More than one installed plugin declares a write identity: no plugin is asked. */
  ambiguous?: true;
}

/**
 * The company's saved write-identity policy in the GitHub plugin that
 * declares `writeIdentityAction`, whatever the plugin's status. A saved policy
 * keeps the company in managed GitHub mode, so turning writes off can never
 * hand runs back to an ambient credential.
 */
export async function loadGitHubIdentityPolicy(db: Db, companyId: string): Promise<GitHubIdentityPolicyRecord | null> {
  // Exactly one installed plugin may own the write identity. Another plugin that
  // also declares it could otherwise answer instead of the GitHub plugin.
  const owners = (await db.select({ id: plugins.id, status: plugins.status, manifest: plugins.manifestJson }).from(plugins))
    .filter(row => Boolean((row.manifest as PaperclipPluginManifestV1 | null)?.projectRepositories?.writeIdentityAction));
  if (!owners.length) return null;
  const rows = await db
    .select({ pluginId: pluginState.pluginId, value: pluginState.valueJson })
    .from(pluginState)
    .where(and(
      eq(pluginState.scopeKind, "company"),
      eq(pluginState.scopeId, companyId),
      eq(pluginState.namespace, GITHUB_WRITE_IDENTITY_STATE.namespace),
      eq(pluginState.stateKey, GITHUB_WRITE_IDENTITY_STATE.stateKey),
    ));
  const saved = rows.filter(row => owners.some(owner => owner.id === row.pluginId));
  if (!saved.length) return null;
  const owner = owners.find(candidate => candidate.id === saved[0]!.pluginId)!;
  if (owners.length > 1) {
    return { pluginId: owner.id, ready: false, manifest: owner.manifest as PaperclipPluginManifestV1, policy: "invalid", ambiguous: true };
  }
  let policy: GitHubWriteIdentityPolicy | "invalid";
  try { policy = parseGitHubWriteIdentityPolicy(saved[0]!.value); } catch { policy = "invalid"; }
  return { pluginId: owner.id, ready: owner.status === "ready", manifest: owner.manifest as PaperclipPluginManifestV1, policy };
}

const identityRef = { login: z.string().regex(/^[A-Za-z0-9-]{1,100}(\[bot\])?$/), userId: z.string().regex(/^[1-9]\d{0,19}$/) };
const decisionSchema = z.union([
  z.object({ identity: z.literal("user"), missingUserConnection: z.enum(["fail", "use_bot"]) }),
  z.object({
    identity: z.enum(["bot", "user"]),
    credential: z.object({ ...identityRef, token: z.string().min(1).max(1000).nullable() }),
    author: z.object(identityRef).optional(),
    signingKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]{20,200}$/).optional(),
    bodyFooter: z.boolean().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
  }).refine(value => value.identity === "user" || (value.credential.token !== null && value.credential.login.endsWith("[bot]")), "A bot credential carries a bot token"),
  z.object({ identity: z.enum(["bot", "user"]), unavailable: z.string().min(1).max(500), evidence: z.record(z.string(), z.unknown()).optional() }),
]);

const UNAVAILABLE: GitHubWriteIdentityDecision = { identity: "bot", unavailable: "GitHub write identity is temporarily unavailable" };

let pluginWorkers: Pick<PluginWorkerManager, "call"> | null = null;

/**
 * Credential brokers also run inside native sessions, outside the app's route
 * graph, so the app registers its plugin workers once at startup.
 */
export function registerGitHubWriteIdentityWorkers(workers: Pick<PluginWorkerManager, "call"> | null): void {
  pluginWorkers = workers;
}

async function callPlugin(record: GitHubIdentityPolicyRecord, key: string | undefined, companyId: string, params: Record<string, unknown>, timeoutMs: number) {
  if (!key || !record.ready || record.ambiguous || !pluginWorkers) return null;
  return pluginWorkers.call(record.pluginId, "performAction", {
    key, params: { companyId, ...params }, companyId,
    actorContext: { type: "system", userId: null, agentId: null, runId: null, companyId },
  }, timeoutMs);
}

/**
 * Asks the GitHub plugin which identity performs one operation. Null means no
 * plugin declares a write identity, so the run's identity applies as before. A
 * plugin that cannot answer fails closed instead of falling back to anyone.
 */
export async function resolveGitHubWriteIdentityDecision(
  db: Db,
  input: { companyId: string; operation: ClassifiedGitHubOperation; fallback?: boolean },
  record?: GitHubIdentityPolicyRecord | null,
): Promise<GitHubWriteIdentityDecision | null> {
  const policy = record === undefined ? await loadGitHubIdentityPolicy(db, input.companyId) : record;
  if (!policy) return null;
  const { operation } = input;
  try {
    const raw = await callPlugin(policy, policy.manifest.projectRepositories?.writeIdentityAction, input.companyId, {
      repository: operation.repository, access: operation.access, action: operation.action, privileged: operation.privileged,
      wiki: operation.wiki, pullRequest: operation.pullRequest, expectedHeadSha: operation.expectedHeadSha,
      ...(operation.merge ? { merge: true } : {}), ...(operation.autoMerge ? { autoMerge: true } : {}), ...(operation.retarget ? { retarget: true } : {}),
      ...(operation.workflowPush ? { workflowPush: operation.workflowPush } : {}),
      ...(operation.route ? { route: operation.route } : {}),
      ...(operation.caller ? { agentId: operation.caller.agentId, runId: operation.caller.runId } : {}),
      ...(input.fallback ? { fallback: true } : {}),
    }, 15_000);
    return raw === null ? UNAVAILABLE : decisionSchema.parse(raw) as GitHubWriteIdentityDecision;
  } catch {
    // Provider errors may include credentials; expose only a safe reason.
    return UNAVAILABLE;
  }
}

const signSchema = z.union([
  z.object({ signature: z.string().startsWith("-----BEGIN SSH SIGNATURE-----").max(8192), keyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }),
  z.object({ unavailable: z.string().min(1).max(500) }),
]);

/** Asks the GitHub plugin to sign one git object for the company's App user. */
export async function resolveGitHubSignature(db: Db, companyId: string, payload: string): Promise<GitHubSignDecision> {
  const record = await loadGitHubIdentityPolicy(db, companyId);
  if (!record) return { unavailable: "Commit signing needs the GitHub plugin's App user identity for this company." };
  try {
    const raw = await callPlugin(record, record.manifest.projectRepositories?.signCommitAction, companyId, { payload }, 15_000);
    return raw === null ? { unavailable: "Commit signing is temporarily unavailable." } : signSchema.parse(raw);
  } catch {
    return { unavailable: "Commit signing is temporarily unavailable." };
  }
}

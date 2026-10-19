import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";
import { createHash } from "node:crypto";
import { logActivity } from "./activity-log.js";
import {
  UNREADABLE_CLASSIFIED_OPERATION,
  UNREADABLE_GITHUB_OPERATION,
  UNREPORTED_GITHUB_OPERATION,
  classifyGitHubOperation,
  loadGitHubIdentityPolicy,
  resolveGitHubSignature,
  resolveGitHubWriteIdentityDecision,
  type ClassifiedGitHubOperation,
  type GitHubIdentityPolicyRecord,
  type GitHubOperation,
} from "./github-write-identity.js";
import type { GitHubWriteIdentityDecision } from "@paperclipai/shared";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};


/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return false;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return false;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return false;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return (
    resolveCoreTrustPreset({
      companyId: run.companyId,
      agent,
      project,
      issue,
      run: {
        companyId: run.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    }).kind === "standard"
  );
}

/**
 * Who is acting, so managed launchers can mark agent PR text even when the
 * GitHub actor is a person's account. Never a credential.
 */
export type GitHubOperationAttribution = { agentName: string; runId: string };

export type GitHubOperationCredentials = GitHubCredentialSummary & {
  identityContextId: string | null;
  revision: number | null;
  /** Set when a GitHub plugin write-identity policy chose this operation's identity. */
  writeIdentity?: "bot" | "user";
  /** Present when the company wants agent gh text marked (the launcher's footer). */
  attribution?: GitHubOperationAttribution;
  /** Public SSH key the launcher configures git to sign commits with (through the run bridge). */
  signingKey?: string;
  /** A refused write: the launcher must not run the command with any other credential. */
  failClosed?: true;
  /** The repository Paperclip checked; the launcher pins gh to it (GH_REPO) so gh cannot act on another one. */
  repository?: string;
  env: Record<string, string>;
};

async function operationAttribution(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<GitHubOperationAttribution> {
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
  return { agentName: agent?.name ?? run.agentId, runId: run.id };
}

/** The Paperclip issue key (for example ANT-1234) of the run's task, for the audit record. */
async function runIssueKey(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string | null> {
  const issueId = run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.nativeIssueId;
  if (typeof issueId !== "string" || !isUuidLike(issueId)) return null;
  const [issue] = await db
    .select({ identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
  return issue?.identifier ?? null;
}

const isWrite = (operation: ClassifiedGitHubOperation) => operation.access === "write" || operation.privileged.length > 0;
/** A refused write, or any command Paperclip refused to check (another host, unknown git command…): it must not run at all. */
const mustNotRun = (operation: ClassifiedGitHubOperation) => isWrite(operation) || !!operation.denied;

/**
 * Commit signing is bound to the run's own git commands: the launcher reports
 * every commit, merge, rebase or pull before git runs, and only then may
 * that run ask Paperclip to sign, for a limited time. In-memory: a server
 * restart closes every window (signing fails closed until the next git command).
 */
const SIGNING_WINDOW_MS = 30 * 60_000;
const signingWindows = new Map<string, number>();
function openSigningWindow(runId: string, now = Date.now()) {
  if (signingWindows.size > 10_000) for (const [id, expires] of signingWindows) if (expires <= now) signingWindows.delete(id);
  signingWindows.set(runId, now + SIGNING_WINDOW_MS);
}
function signingWindowOpen(runId: string, now = Date.now()): boolean {
  return (signingWindows.get(runId) ?? 0) > now;
}

/**
 * Audits each write the policy governs. Granted user-identity writes use
 * `github.user_identity_write`, so one audit query lists everything done in a
 * person's name; refusals and App writes use `github.write_identity_resolved`.
 * Never includes command arguments or tokens.
 */
async function logWriteIdentity(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  operation: ClassifiedGitHubOperation,
  outcome: { identity: "bot" | "user"; status: string; login?: string; source?: string; reason?: string; evidence?: Record<string, unknown> },
) {
  await logActivity(db, {
    companyId: run.companyId,
    actorType: "agent",
    actorId: run.agentId,
    agentId: run.agentId,
    runId: run.id,
    action: outcome.identity === "user" && outcome.status === "available" ? "github.user_identity_write" : "github.write_identity_resolved",
    entityType: "heartbeat_run",
    entityId: run.id,
    details: {
      runId: run.id,
      agentId: run.agentId,
      issueKey: await runIssueKey(db, run),
      repository: operation.repository,
      access: operation.access,
      action: operation.action,
      privileged: operation.privileged,
      wiki: operation.wiki,
      ...operation.target,
      ...outcome,
    },
  });
}

/**
 * An App (bot) credential the plugin minted under the run's identity is handed
 * out only if the company has not switched to its App user meanwhile: under
 * the App user the App never writes (I-RO). The plugin revokes the token itself.
 */
async function stillAppWrites(db: Db, companyId: string, decision: Exclude<GitHubWriteIdentityDecision, { missingUserConnection: unknown }>) {
  if (!("credential" in decision) || decision.identity !== "bot") return decision;
  const latest = await loadGitHubIdentityPolicy(db, companyId);
  if (latest && latest.policy !== "invalid" && latest.policy.userSource === "run") return decision;
  return { identity: "bot" as const, unavailable: "The company's GitHub write identity changed while this command was checked; run it again." };
}

/** Git identity without a token: local commands still commit as the right person. */
function identityOnlyEnv(identity: { login: string; userId: string }): Record<string, string> {
  const env = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null, githubIdentity: identity }).env;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "PAPERCLIP_GIT_TOKEN"]) delete env[key];
  return env;
}

/**
 * Turns a plugin decision into the broker response. `unavailable` never falls
 * back: a refused write is marked `failClosed` so the launcher does not run it.
 */
async function pluginDecisionResult(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  context: { id: string; revision: number },
  operation: ClassifiedGitHubOperation,
  decision: Exclude<GitHubWriteIdentityDecision, { missingUserConnection: unknown }>,
  attribution: GitHubOperationAttribution | undefined,
): Promise<GitHubOperationCredentials> {
  const base = { identityContextId: context.id, revision: context.revision, writeIdentity: decision.identity, ...(attribution ? { attribution } : {}) };
  if ("unavailable" in decision) {
    if (mustNotRun(operation)) await logWriteIdentity(db, run, operation, { identity: decision.identity, status: "unavailable", reason: decision.unavailable, ...(decision.evidence ? { evidence: decision.evidence } : {}) });
    return { ...base, status: "unavailable", reason: decision.unavailable, env: {}, ...(mustNotRun(operation) ? { failClosed: true as const } : {}) };
  }
  const { credential } = decision;
  const author = decision.author ?? { login: credential.login, userId: credential.userId };
  if (isWrite(operation)) {
    await logWriteIdentity(db, run, operation, { identity: decision.identity, status: "available", login: credential.login, ...(decision.evidence ? { evidence: decision.evidence } : {}) });
  }
  if (operation.signing && decision.signingKey) openSigningWindow(run.id);
  return {
    ...base,
    ...(decision.bodyFooter === false ? { attribution: undefined } : {}),
    status: "available",
    login: credential.login,
    authenticationMode: "managed",
    ...(operation.repository ? { repository: operation.repository } : {}),
    ...(decision.signingKey ? { signingKey: decision.signingKey } : {}),
    env: credential.token
      ? buildGitAuthInvocation({ token: credential.token, source: "managed_connection", secretName: null, githubIdentity: author }).env
      : identityOnlyEnv(author),
  };
}

/**
 * Resolves the credential for one managed git/gh operation.
 *
 * - Without a GitHub plugin write-identity policy, the run's own identity
 *   applies (agent account or responsible person) as before.
 * - With `userSource: "run"`, the plugin may route a write to its App and
 *   gates writes (kill switch, allowlist, privileged toggles).
 * - With `userSource: "app"` (or a policy that no longer parses), the plugin
 *   answers every operation, reads included; the run's own GitHub connection
 *   is never consulted and nothing falls back to it.
 *
 * No company secrets or ambient credentials are consulted by this path.
 */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
  },
  operation: GitHubOperation | typeof UNREADABLE_GITHUB_OPERATION | null = null,
): Promise<GitHubOperationCredentials> {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  const policy = await loadGitHubIdentityPolicy(db, input.companyId);
  // Agent gh text is marked unless the company's policy turns the footer off.
  const attribution = !policy || (policy.policy !== "invalid" && policy.policy.bodyFooter) ? await operationAttribution(db, run) : undefined;
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  if (!(await allowsGitHubCredentialExport(db, run))) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      ...(attribution ? { attribution } : {}),
      env,
    };
  }
  const classified = operation === UNREADABLE_GITHUB_OPERATION
    ? (policy ? UNREADABLE_CLASSIFIED_OPERATION : UNREPORTED_GITHUB_OPERATION)
    : operation ? classifyGitHubOperation(operation) : UNREPORTED_GITHUB_OPERATION;
  // Another host, or a git command or option Paperclip cannot read: no credential
  // at all and the command never runs, whatever the company's policy (or none).
  if (classified.denied && classified.integrity) {
    return pluginDecisionResult(db, run, context, classified, { identity: "user", unavailable: classified.denied }, attribution);
  }
  // With the kill switch on, the run's own (write-capable) token is not handed
  // out at all; local commands keep their identity without a token.
  let withholdToken = false;
  if (policy) {
    if (classified.denied) {
      return pluginDecisionResult(db, run, context, classified, { identity: "user", unavailable: classified.denied }, attribution);
    }
    const appUser = policy.policy === "invalid" || policy.policy.userSource === "app";
    if (appUser) {
      const decision = await resolveGitHubWriteIdentityDecision(db, { companyId: input.companyId, operation: classified }, policy);
      // A plugin that defers here is broken; the run's own identity is never used for an App-user company.
      const answered = !decision || "missingUserConnection" in decision
        ? { identity: "user" as const, unavailable: "GitHub write identity is temporarily unavailable" }
        : decision;
      return pluginDecisionResult(db, run, context, classified, answered, attribution);
    }
    if (policy.policy !== "invalid" && !policy.policy.enabled) {
      if (classified.access !== "none") {
        return pluginDecisionResult(db, run, context, classified, { identity: "user", unavailable: "GitHub access is switched off for this company (write identity kill switch)." }, attribution);
      }
      withholdToken = true;
    }
  }
  const governed = classified.action !== null || classified.privileged.length > 0;
  const decision = policy && governed
    ? await resolveGitHubWriteIdentityDecision(db, { companyId: input.companyId, operation: classified }, policy)
    : null;
  if (decision && !("missingUserConnection" in decision)) {
    return pluginDecisionResult(db, run, context, classified, await stillAppWrites(db, input.companyId, decision), attribution);
  }
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      input.companyId,
      {
        agentId: input.agentId,
        heartbeatRunId: input.runId,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }
  if (context)
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
  if (withholdToken) for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "PAPERCLIP_GIT_TOKEN"]) delete env[key];
  if (decision && governed) {
    if (summary.status !== "available" && decision.missingUserConnection === "use_bot") {
      const fallback = await resolveGitHubWriteIdentityDecision(db, { companyId: input.companyId, operation: classified, fallback: true }, policy);
      if (fallback && !("missingUserConnection" in fallback)) return pluginDecisionResult(db, run, context, classified, await stillAppWrites(db, input.companyId, fallback), attribution);
    }
    if (isWrite(classified)) {
      await logWriteIdentity(db, run, classified, {
        identity: "user",
        status: summary.status,
        ...(summary.login ? { login: summary.login } : {}),
        ...(summary.source ? { source: summary.source } : {}),
      });
    }
  }
  const refusedWrite = !!decision && governed && isWrite(classified) && summary.status !== "available";
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    ...(decision && governed ? { writeIdentity: "user" as const } : {}),
    ...(attribution ? { attribution } : {}),
    ...(refusedWrite ? { failClosed: true as const } : {}),
    ...(summary.status === "available" && classified.repository ? { repository: classified.repository } : {}),
    env,
  };
}

/** Largest git object the run bridge forwards for signing. */
export const MAX_GITHUB_SIGN_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Signs one git commit object (never a tag) for the run's company with the GitHub
 * plugin's server-held key. Only an active, standard-trust run can sign, and
 * only objects committed by the company's App user. Each signature is audited
 * with the object's SHA-256, never its content.
 */
export async function resolveGitHubCommitSignature(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
  payload: string,
): Promise<{ signature: string } | { unavailable: string }> {
  const { run } = await captureRunIdentity(db, input);
  if (!(await allowsGitHubCredentialExport(db, run))) return { unavailable: "Commit signing is not available to low-trust or unverified executions." };
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length || bytes.length > MAX_GITHUB_SIGN_PAYLOAD_BYTES || bytes.toString("base64") !== payload.replace(/\s+/g, "")) {
    return { unavailable: "Send the git object as base64, at most 1 MiB." };
  }
  // Only while this run's own git commit, merge, rebase or pull is in progress.
  const result = signingWindowOpen(run.id)
    ? await resolveGitHubSignature(db, input.companyId, bytes.toString("base64"))
    : { unavailable: "Paperclip signs only for a git commit, merge, rebase or pull this run started through its managed git in the last 30 minutes." };
  await logActivity(db, {
    companyId: run.companyId,
    actorType: "agent",
    actorId: run.agentId,
    agentId: run.agentId,
    runId: run.id,
    action: "signature" in result ? "github.commit_signed" : "github.commit_sign_refused",
    entityType: "heartbeat_run",
    entityId: run.id,
    details: {
      runId: run.id, agentId: run.agentId, issueKey: await runIssueKey(db, run),
      payloadSha256: createHash("sha256").update(bytes).digest("hex"),
      ...("signature" in result ? { keyFingerprint: result.keyFingerprint } : { reason: result.unavailable }),
    },
  });
  return "signature" in result ? { signature: result.signature } : result;
}

export type { GitHubIdentityPolicyRecord };

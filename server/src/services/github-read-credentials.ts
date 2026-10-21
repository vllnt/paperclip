import { and, eq } from "drizzle-orm";
import { issues, runIdentityContexts, type Db } from "@paperclipai/db";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { allowsGitHubCredentialExport } from "./github-operation-credentials.js";
import {
  classifyGitHubOperation,
  loadGitHubIdentityPolicy,
  resolveGitHubWriteIdentityDecision,
} from "./github-write-identity.js";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The GitHub token the server reads one repository with for an issue, when no run exists yet: the
 * pull request wake gate decides before a run starts, and the issue's external-object panel refreshes
 * without any run. It answers as the runtime-tools credential route (`resolveGitHubOperationCredentials`)
 * would answer a plain read by a run of this agent on this issue, with the same company boundary:
 *
 * - A run that may not export a credential (a low-trust or unverified issue) gets no token.
 * - A company that saved a write-identity policy keeps to it. With the App user (or a policy that no
 *   longer parses) the GitHub plugin answers, as it does for every read. With the kill switch on, no
 *   token. Otherwise the run's own identity applies.
 * - The run's own identity is the one the issue continues under (`continuationIdentityContextId`, else
 *   `originIdentityContextId`, which is what dispatch gives the next run): its responsible user's
 *   personal GitHub authorization, else the agent's dedicated one. A company-default identity names
 *   nobody to act as, and standing delegations never count, exactly as in the route.
 * - With no managed GitHub connection for the agent, a `GITHUB_TOKEN`/`GH_TOKEN`/`PAPERCLIP_GITHUB_TOKEN`
 *   company secret. The server-environment token is not any company's credential.
 *
 * Resolves to null when there is no credential. Throws when a managed identity is configured but cannot
 * be used (the message is fixed text, never provider output). Callers fail open. Nothing here logs or
 * stores the token.
 */
export async function resolveGitHubIssueReadToken(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; repository: string },
): Promise<string | null> {
  const { companyId, agentId, issueId, repository } = input;
  if (!REPOSITORY_PATTERN.test(repository)) return null;
  // Checks that the agent and the issue belong to the company, and the issue's trust, before anything else.
  if (!(await allowsGitHubCredentialExport(db, { agentId, companyId, contextSnapshot: { issueId }, nativeIssueId: null }))) {
    return null;
  }
  const [issue] = await db
    .select({
      continuationIdentityContextId: issues.continuationIdentityContextId,
      originIdentityContextId: issues.originIdentityContextId,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!issue) return null;

  const policy = await loadGitHubIdentityPolicy(db, companyId);
  if (policy) {
    const operation = classifyGitHubOperation({ program: "gh", args: ["api", `repos/${repository}`], remote: null });
    if (operation.denied) return null;
    if (policy.policy === "invalid" || policy.policy.userSource === "app") {
      const decision = await resolveGitHubWriteIdentityDecision(db, { companyId, operation }, policy);
      return decision && "credential" in decision ? decision.credential.token : null;
    }
    if (!policy.policy.enabled) return null;
  }

  const contextId = issue.continuationIdentityContextId ?? issue.originIdentityContextId;
  const [identity] = contextId
    ? await db
        .select({ responsibleUserId: runIdentityContexts.responsibleUserId, cause: runIdentityContexts.cause })
        .from(runIdentityContexts)
        .where(and(
          eq(runIdentityContexts.id, contextId),
          eq(runIdentityContexts.companyId, companyId),
          eq(runIdentityContexts.status, "accepted"),
        ))
    : [];
  const provider = createGitRemoteAuthProvider(
    db,
    companyId,
    {
      issueId,
      agentId,
      allowStandingDelegation: false,
      responsibleUserId: identity && identity.cause !== "company_default" ? identity.responsibleUserId : null,
    },
    { env: {} },
  );
  const invocation = await provider(`https://github.com/${repository}.git`);
  return invocation?.env.GH_TOKEN?.trim() || null;
}

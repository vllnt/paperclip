import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveGitHubOperationCredentials } from "./github-operation-credentials.js";
import { readProtectedBranches, withProtectedBranchFacts, type ProtectedBranchFacts } from "./github-protected-branches.js";
import { UNREADABLE_GITHUB_OPERATION, classifyGitHubOperation } from "./github-write-identity.js";

type Run = Parameters<typeof resolveGitHubOperationCredentials>[1];
type ReportedOperation = Parameters<typeof resolveGitHubOperationCredentials>[2];

/**
 * Resolves the credential for one managed `git`/`gh` operation an agent run
 * reports. This is the entry point for reported operations; use it instead of
 * calling resolveGitHubOperationCredentials with an operation.
 *
 * A write that forces, deletes, renames or hard-resets a branch is refused by
 * the classifier unless GitHub has said, for this operation, that the branch is
 * neither the repository's default nor protected. This reads that answer on
 * every such operation, with the run's own read credential, which is used here
 * and never handed out, and keeps it for this operation only (nothing is cached
 * across runs, companies or requests). When GitHub cannot be read, the
 * classifier refuses the write.
 *
 * @param db - The Paperclip database.
 * @param run - The run the operation belongs to.
 * @param operation - The operation as the launcher reported it.
 * @returns The credential decision for the operation.
 */
export async function resolveGitHubOperationAccess(db: Db, run: Run, operation: ReportedOperation): ReturnType<typeof resolveGitHubOperationCredentials> {
  const classified = operation && operation !== UNREADABLE_GITHUB_OPERATION ? classifyGitHubOperation(operation) : null;
  const repository = classified?.repository;
  let facts: ProtectedBranchFacts | null = null;
  if (repository && classified.branchRewrites?.length) {
    const reader = await resolveGitHubOperationCredentials(db, run, { program: "gh", args: ["api", `repos/${repository}`], remote: null });
    if (reader.status === "available") {
      facts = await readProtectedBranches(repository, classified.branchRewrites, reader.env.GH_TOKEN).catch((error: unknown) => {
        logger.warn({ repository, err: error instanceof Error ? error.message : String(error) }, "GitHub branch protection could not be read; the write is refused");
        return null;
      });
    }
  }
  return withProtectedBranchFacts(facts, () => resolveGitHubOperationCredentials(db, run, operation));
}

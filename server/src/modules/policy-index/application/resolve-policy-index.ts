import { POLICY_INDEX_QUERY_LIMIT, type PolicyIndex } from "@paperclipai/shared";
import { buildPolicyIndexEntries, mergeMentionedKeys, policyIndexDigestInput } from "../domain/policy-index.js";
import type { PolicyIndexDeps } from "./ports.js";

export interface ResolvePolicyIndexInput {
  companyId: string;
  /** The task's project. Null for a task with no project: only company policies and mentions apply. */
  projectId: string | null;
  issue: { id: string; title: string; description: string | null };
  /** Absolute path of the agent's committed instructions file, when it has one. */
  instructionsFilePath?: string | null;
  /** Company skill keys the run uses. */
  skillKeys?: readonly string[];
}

/**
 * The policy index for one task. It lists the company's and the project's active policies and the
 * policies the task, the agent's instructions or its skills mention. It makes at most one policy
 * query, and a run whose sources mention nothing still makes exactly that one.
 */
export function createResolvePolicyIndex(deps: PolicyIndexDeps) {
  async function mentioned(
    source: "issue" | "instructions" | "skills",
    read: () => Promise<string[]>,
  ): Promise<string[]> {
    try {
      return await read();
    } catch (error) {
      deps.onSourceError?.(source, error);
      return [];
    }
  }

  return async function resolvePolicyIndex(input: ResolvePolicyIndexInput): Promise<PolicyIndex> {
    const skillKeys = input.skillKeys ?? [];
    const [fromIssue, fromInstructions, fromSkills] = await Promise.all([
      mentioned("issue", () =>
        deps.sources.issue({
          companyId: input.companyId,
          issueId: input.issue.id,
          title: input.issue.title,
          description: input.issue.description,
        }),
      ),
      input.instructionsFilePath
        ? mentioned("instructions", () => deps.sources.instructions({ filePath: input.instructionsFilePath! }))
        : Promise.resolve([]),
      skillKeys.length > 0
        ? mentioned("skills", () => deps.sources.skills({ companyId: input.companyId, skillKeys }))
        : Promise.resolve([]),
    ]);
    const mentionedKeys = mergeMentionedKeys([fromIssue, fromInstructions, fromSkills]);

    const result = await deps.rows.load({
      companyId: input.companyId,
      projectId: input.projectId,
      mentionedKeys,
      limit: POLICY_INDEX_QUERY_LIMIT + mentionedKeys.length,
    });
    const { entries, moreCount } = buildPolicyIndexEntries({ result, projectId: input.projectId, mentionedKeys });
    return { entries, moreCount, digest: deps.digest(policyIndexDigestInput(entries, moreCount)) };
  };
}

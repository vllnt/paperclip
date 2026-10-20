import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import type { agentService } from "./agents.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import type { projectService } from "./projects.js";
import { resolveCoreTrustPreset, type TrustPresetResolution } from "./trust-preset-resolver.js";

/** The lookups trust resolution reads from. The caller owns them, so it decides how they are built. */
export interface AgentTrustLookups {
  agents: Pick<ReturnType<typeof agentService>, "getById">;
  projects: Pick<ReturnType<typeof projectService>, "getById">;
}

/** The agent, and the run it acts in, whose containment a new task or step has to keep. */
export interface TrustedAgentActor {
  agentId: string | null | undefined;
  runId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves how much an agent is trusted and what a task or routine step it writes inherits from that.
 * One owner for both writers: the issue routes and the routine routes must contain agent-authored work
 * the same way.
 */
export function agentTrustService(db: Db, lookups: AgentTrustLookups) {
  const { agents: agentsSvc, projects: projectsSvc } = lookups;

  /**
   * The trust preset that applies when `input.agentId` acts on `issue`, from the agent, the project,
   * the issue's own policy and the run's policy. `null` when there is no agent or it is in another company.
   */
  async function resolveAgentTrustForIssue(
    input: TrustedAgentActor,
    companyId: string,
    issue?: {
      companyId: string;
      projectId?: string | null;
      executionPolicy?: unknown;
    } | null,
  ): Promise<TrustPresetResolution | null> {
    if (!input.agentId) return null;
    const [agent, run] = await Promise.all([
      agentsSvc.getById(input.agentId),
      input.runId
        ? db
            .select({
              companyId: heartbeatRuns.companyId,
              agentId: heartbeatRuns.agentId,
              contextSnapshot: heartbeatRuns.contextSnapshot,
            })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, companyId)))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    if (!agent || agent.companyId !== companyId) return null;
    const runContext = run?.agentId === agent.id && isRecord(run.contextSnapshot) ? run.contextSnapshot : null;
    const runExecutionPolicy = isRecord(runContext?.executionPolicy) ? runContext.executionPolicy : null;
    const project = issue?.projectId ? await projectsSvc.getById(issue.projectId) : null;
    return resolveCoreTrustPreset({
      companyId,
      agent,
      project: project?.companyId === companyId ? project : null,
      issue: issue ? { companyId: issue.companyId, executionPolicy: issue.executionPolicy } : null,
      run: runExecutionPolicy ? { companyId, executionPolicy: runExecutionPolicy } : null,
    });
  }

  /**
   * The execution policy a task or step written by an agent carries. A low-trust author hands its
   * containment to the new work, including run-only restrictions: the requested policy can narrow it,
   * never reset it.
   * @throws HttpError 403 when the author's trust configuration is denied.
   */
  async function containCreatedExecutionPolicy(
    actor: TrustedAgentActor,
    companyId: string,
    projectId: string | null,
    requestedPolicy: unknown,
  ) {
    const policy = normalizeIssueExecutionPolicy(requestedPolicy);
    const trust = await resolveAgentTrustForIssue(actor, companyId, { companyId, projectId, executionPolicy: policy });
    if (trust?.kind === "denied") throw forbidden(trust.detail);
    if (trust?.kind !== "low_trust_review") return policy;
    return normalizeIssueExecutionPolicy({
      ...policy,
      authorizationPolicy: {
        ...policy?.authorizationPolicy,
        trustPreset: trust.preset,
        trustBoundary: trust.boundary,
      },
    });
  }

  return { resolveAgentTrustForIssue, containCreatedExecutionPolicy };
}

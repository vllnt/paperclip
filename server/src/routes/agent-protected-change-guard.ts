import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { logActivity, type accessService } from "../services/index.js";

export type AgentProtectedChangeSurface = "patch" | "config_rollback" | "permissions" | "join_replay";

export type AgentProtectedChangeActivityActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
};

/**
 * Refuses a change to an agent's protected fields unless the actor holds a
 * direct `agents:configure` grant that covers the agent. Callers decide when
 * the check applies: an agent editing itself, or an invite replay that rewrites
 * an existing agent. Each refusal writes an `agent.self_config_update_denied`
 * activity entry with the field names, never their values, and returns 403.
 */
export async function assertAgentProtectedChangeGranted(input: {
  db: Db;
  access: Pick<ReturnType<typeof accessService>, "decide">;
  req: Request;
  activityActor: AgentProtectedChangeActivityActor;
  target: { id: string; companyId: string };
  fields: string[];
  surface: AgentProtectedChangeSurface;
  details?: Record<string, unknown>;
}): Promise<void> {
  if (input.fields.length === 0) return;
  const decision = await input.access.decide({
    actor: input.req.actor,
    action: "agent_config:update",
    resource: { type: "agent", companyId: input.target.companyId, agentId: input.target.id },
    scope: { requiresChangeGrant: true, targetAgentId: input.target.id },
  });
  if (decision.allowed) return;

  await logActivity(input.db, {
    companyId: input.target.companyId,
    ...input.activityActor,
    action: "agent.self_config_update_denied",
    entityType: "agent",
    entityId: input.target.id,
    details: {
      surface: input.surface,
      fields: input.fields,
      ...input.details,
      ...authorizationDeniedDetails(decision),
    },
  });
  throw forbidden(
    `Agents cannot change their own run limits, budget, model, environment, sandbox, role, or permissions (${input.fields.join(", ")}). `
      + "Ask a board user, or an agent with agents:configure for this agent, to make the change.",
    { code: "agent_self_protected_config_change", ...authorizationDeniedDetails(decision), fields: input.fields },
  );
}

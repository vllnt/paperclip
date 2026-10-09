import { forbidden } from "../errors.js";
import {
  authorizationDeniedDetails,
  type AuthorizationActor,
  type AuthorizationDecision,
} from "./authorization.js";

export type AgentProtectedChangeSurface =
  | "patch"
  | "config_rollback"
  | "permissions"
  | "join_replay"
  | "plugin_managed_reset"
  | "built_in_provision"
  | "patch_conflict"
  | "config_rollback_conflict"
  | "agent_create"
  | "agent_hire"
  | "built_in_first_provision";

/**
 * Refuses a change to an agent's protected fields unless the actor holds a
 * direct `agents:configure` grant that covers the agent. Callers decide when
 * the check applies and compute the changed field names. A refusal records the
 * field names, never their values, through `recordDenial`, then returns 403
 * with code `agent_self_protected_config_change`.
 */
export async function assertAgentProtectedChangeGranted(input: {
  actor: AuthorizationActor;
  decide: (request: {
    actor: AuthorizationActor;
    action: "agent_config:update";
    resource: { type: "agent"; companyId: string; agentId: string };
    scope: Record<string, unknown>;
  }) => Promise<AuthorizationDecision>;
  recordDenial: (details: Record<string, unknown>) => Promise<void>;
  target: { id: string; companyId: string };
  fields: string[];
  surface: AgentProtectedChangeSurface;
  details?: Record<string, unknown>;
}): Promise<void> {
  if (input.fields.length === 0) return;
  const decision = await input.decide({
    actor: input.actor,
    action: "agent_config:update",
    resource: { type: "agent", companyId: input.target.companyId, agentId: input.target.id },
    scope: { requiresChangeGrant: true, targetAgentId: input.target.id },
  });
  if (decision.allowed) return;

  await input.recordDenial({
    surface: input.surface,
    fields: input.fields,
    ...input.details,
    ...authorizationDeniedDetails(decision),
  });
  throw forbidden(
    `Agents cannot change their own run limits, budget, model, environment, sandbox, role, or permissions (${input.fields.join(", ")}). `
      + "Ask a board user, or an agent with agents:configure for this agent, to make the change.",
    { code: "agent_self_protected_config_change", ...authorizationDeniedDetails(decision), fields: input.fields },
  );
}

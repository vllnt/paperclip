import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  assertAgentProtectedChangeGranted as assertProtectedChangeGranted,
  type AgentProtectedChangeSurface,
} from "../services/agent-protected-change-guard.js";
import { logActivity, type accessService } from "../services/index.js";

export type { AgentProtectedChangeSurface };

export type AgentProtectedChangeActivityActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
};

/**
 * Route adapter for the protected-change guard: judges `req.actor` and writes
 * the denial as an `agent.self_config_update_denied` activity entry. The log
 * call comes from the services barrel so route-test mocks apply.
 */
export async function assertAgentProtectedChangeGranted(input: {
  db: Db;
  access: Pick<ReturnType<typeof accessService>, "decide">;
  req: Request;
  activityActor: AgentProtectedChangeActivityActor;
  target: { id: string; companyId: string };
  /** Where the denial is logged. Defaults to the target agent; creates log against the company because the agent does not exist yet. */
  entity?: { type: "agent" | "company"; id: string };
  fields: string[];
  surface: AgentProtectedChangeSurface;
  details?: Record<string, unknown>;
}): Promise<void> {
  const entity = input.entity ?? { type: "agent" as const, id: input.target.id };
  await assertProtectedChangeGranted({
    actor: input.req.actor,
    decide: (request) => input.access.decide(request),
    recordDenial: async (details) => {
      await logActivity(input.db, {
        companyId: input.target.companyId,
        ...input.activityActor,
        action: "agent.self_config_update_denied",
        entityType: entity.type,
        entityId: entity.id,
        details,
      });
    },
    target: input.target,
    fields: input.fields,
    surface: input.surface,
    details: input.details,
  });
}

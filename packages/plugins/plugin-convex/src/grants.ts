import type { Capability, ConnectionConfig, EnvironmentClass } from "./contracts.js";

export interface AgentIdentity { id: string; role: string | null }

/**
 * Default deny: an agent holds a capability on an environment class only through a grant that names its id or role,
 * lists the class and includes the capability. Lifecycle never applies outside previews, whatever the grants say.
 */
export function isGranted(config: ConnectionConfig, agent: AgentIdentity, environment: EnvironmentClass, capability: Capability): boolean {
  if (capability === "lifecycle" && environment !== "preview") return false;
  return config.grants.some(grant =>
    (grant.agentId === agent.id || (grant.role !== null && grant.role === agent.role)) &&
    grant.environments.includes(environment) &&
    grant.capabilities.includes(capability) &&
    // A grant that needs a per-call approval is not usable by an agent until the approval flow exists (slice 3).
    grant.approval === null);
}

/** Whether the agent holds the capability on at least one class; used to refuse calls that have no environment yet. */
export function hasAnyGrant(config: ConnectionConfig, agent: AgentIdentity, capability: Capability): boolean {
  return config.grants.some(grant =>
    (grant.agentId === agent.id || (grant.role !== null && grant.role === agent.role)) && grant.capabilities.includes(capability) && grant.approval === null);
}

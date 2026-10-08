import { isDeepStrictEqual } from "node:util";

/**
 * Agent fields that bound how much an agent may run and spend, or what it may
 * do. An agent may not change these on itself without an explicit
 * `agents:configure` grant for itself; board users and granted agents keep
 * their usual access. `role` is included because the CEO role carries agent
 * creation and permission management.
 */
const PROTECTED_TOP_LEVEL_KEYS = ["adapterType", "budgetMonthlyCents", "spentMonthlyCents", "role"] as const;

/**
 * adapterConfig keys that select the model, the reasoning effort, or a per-run
 * limit. `extraArgs`/`args` are included because adapters pass them straight to
 * the CLI, where `--model`, `--effort`, or `--max-turns` would override the
 * protected keys.
 */
export const AGENT_SELF_PROTECTED_ADAPTER_CONFIG_KEYS = [
  "model",
  "provider",
  "acpxAgent",
  "effort",
  "reasoningEffort",
  "modelReasoningEffort",
  "thinkingEffort",
  "thinking",
  "variant",
  "maxTurns",
  "maxTurnsPerRun",
  "timeoutSec",
  "timeoutMs",
  "graceSec",
  "outputInactivityTimeoutMs",
  "waitTimeoutMs",
  "extraArgs",
  "args",
] as const;

export type AgentProtectedConfigState = {
  adapterType: string;
  adapterConfig: unknown;
  runtimeConfig: unknown;
  budgetMonthlyCents: number;
  spentMonthlyCents?: number;
  role?: string;
  status?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Lists the protected fields that differ between two agent config states, as
 * dotted paths such as `runtimeConfig.heartbeat.maxDailyRuns`. Every key under
 * `runtimeConfig.heartbeat` is protected: it holds the run caps, concurrency,
 * daily cost cap, and timer cadence, including their legacy aliases. Leaving
 * `paused` is protected because it is a resume, which already needs a grant.
 */
export function collectAgentProtectedConfigChanges(
  before: AgentProtectedConfigState,
  after: AgentProtectedConfigState,
): string[] {
  const changed: string[] = [];
  for (const key of PROTECTED_TOP_LEVEL_KEYS) {
    if (after[key] !== undefined && !isDeepStrictEqual(before[key], after[key])) changed.push(key);
  }
  if (before.status === "paused" && after.status !== undefined && after.status !== before.status) {
    changed.push("status");
  }

  const beforeAdapterConfig = recordOrEmpty(before.adapterConfig);
  const afterAdapterConfig = recordOrEmpty(after.adapterConfig);
  for (const key of AGENT_SELF_PROTECTED_ADAPTER_CONFIG_KEYS) {
    if (!isDeepStrictEqual(beforeAdapterConfig[key], afterAdapterConfig[key])) {
      changed.push(`adapterConfig.${key}`);
    }
  }

  const beforeRuntimeConfig = recordOrEmpty(before.runtimeConfig);
  const afterRuntimeConfig = recordOrEmpty(after.runtimeConfig);
  const beforeHeartbeat = recordOrEmpty(beforeRuntimeConfig.heartbeat);
  const afterHeartbeat = recordOrEmpty(afterRuntimeConfig.heartbeat);
  const heartbeatKeys = [...new Set([...Object.keys(beforeHeartbeat), ...Object.keys(afterHeartbeat)])].sort();
  for (const key of heartbeatKeys) {
    if (!isDeepStrictEqual(beforeHeartbeat[key], afterHeartbeat[key])) {
      changed.push(`runtimeConfig.heartbeat.${key}`);
    }
  }
  if (!isDeepStrictEqual(beforeRuntimeConfig.aiConnection, afterRuntimeConfig.aiConnection)) {
    changed.push("runtimeConfig.aiConnection");
  }
  return changed;
}

/**
 * Applies `PATCH /agents/:id` merge rules to the protected fields: adapterConfig
 * merges into the stored config unless `replaceAdapterConfig` is set or the
 * adapter type changes, runtimeConfig replaces the stored config but keeps the
 * stored `aiConnection` when the request leaves it empty, and omitted top-level
 * fields keep their stored value.
 */
export function agentProtectedConfigAfterPatch(
  existing: AgentProtectedConfigState,
  patch: Record<string, unknown>,
  replaceAdapterConfig: boolean,
): AgentProtectedConfigState {
  const adapterType = typeof patch.adapterType === "string" ? patch.adapterType : existing.adapterType;
  const changingAdapterType = adapterType !== existing.adapterType;
  const existingAdapterConfig = recordOrEmpty(existing.adapterConfig);
  const requestedAdapterConfig = isRecord(patch.adapterConfig) ? patch.adapterConfig : null;
  const adapterConfig = !requestedAdapterConfig
    ? (changingAdapterType ? {} : existingAdapterConfig)
    : (replaceAdapterConfig || changingAdapterType
      ? requestedAdapterConfig
      : { ...existingAdapterConfig, ...requestedAdapterConfig });

  const existingRuntimeConfig = recordOrEmpty(existing.runtimeConfig);
  const requestedRuntimeConfig = isRecord(patch.runtimeConfig) ? patch.runtimeConfig : null;
  const runtimeConfig = !requestedRuntimeConfig
    ? existingRuntimeConfig
    : (requestedRuntimeConfig.aiConnection || !existingRuntimeConfig.aiConnection
      ? requestedRuntimeConfig
      : { ...requestedRuntimeConfig, aiConnection: existingRuntimeConfig.aiConnection });

  return {
    adapterType,
    adapterConfig,
    runtimeConfig,
    budgetMonthlyCents: typeof patch.budgetMonthlyCents === "number" ? patch.budgetMonthlyCents : existing.budgetMonthlyCents,
    spentMonthlyCents: typeof patch.spentMonthlyCents === "number" ? patch.spentMonthlyCents : existing.spentMonthlyCents,
    role: typeof patch.role === "string" ? patch.role : existing.role,
    status: typeof patch.status === "string" ? patch.status : existing.status,
  };
}

/**
 * Lists the permission keys that differ between the stored and the next
 * normalized permissions, as `permissions.<key>` paths.
 */
export function collectAgentPermissionChanges(before: unknown, after: unknown): string[] {
  const beforePermissions = recordOrEmpty(before);
  const afterPermissions = recordOrEmpty(after);
  return [...new Set([...Object.keys(beforePermissions), ...Object.keys(afterPermissions)])]
    .sort()
    .filter((key) => !isDeepStrictEqual(beforePermissions[key], afterPermissions[key]))
    .map((key) => `permissions.${key}`);
}

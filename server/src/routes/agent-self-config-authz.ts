import { isDeepStrictEqual } from "node:util";
import { ADAPTER_AGNOSTIC_KEYS } from "@paperclipai/shared";

/**
 * Agent fields that bound how much an agent may run and spend, where it runs,
 * or what it may do. An agent may not change these on itself without an
 * explicit `agents:configure` grant for itself; board users and granted agents
 * keep their usual access. `role` is included because the CEO role carries
 * agent creation and permission management.
 */
const PROTECTED_TOP_LEVEL_KEYS = [
  "adapterType",
  "budgetMonthlyCents",
  "spentMonthlyCents",
  "role",
  "defaultEnvironmentId",
] as const;

/**
 * adapterConfig keys an agent may not change on itself. They select the model,
 * engine, profile, or service tier; set per-run, spend, or session limits;
 * choose the working directory (the workspace and sandbox root when a run has
 * no project workspace), the executable, its arguments, its environment
 * variables, its state directory, the endpoint, or the runtime environment
 * that serves the run; or
 * relax approvals, sandbox scope, tool sets, gateway permissions, or data
 * retention consent. `env` is compared per variable.
 */
export const AGENT_SELF_PROTECTED_ADAPTER_CONFIG_KEYS = [
  "model",
  "provider",
  "acpxAgent",
  "engine",
  "managedProfileId",
  "agentCoreProfileId",
  "fastMode",
  "effort",
  "reasoningEffort",
  "modelReasoningEffort",
  "thinkingEffort",
  "thinking",
  "variant",
  "maxTurns",
  "maxTurnsPerRun",
  "maxIterations",
  "maxOutputTokens",
  "maxEstimatedSessionCostUsd",
  "maxSessionListCostUsd",
  "timeoutSec",
  "timeoutSeconds",
  "timeoutMs",
  "idleTimeoutMs",
  "graceSec",
  "outputInactivityTimeoutMs",
  "waitTimeoutMs",
  "warmHandleIdleMs",
  "acpWarmHandleIdleMs",
  "lifecycleMode",
  "cwd",
  "command",
  "agentCommand",
  "acpAgentCommand",
  "hermesCommand",
  "stateDir",
  "acpStateDir",
  "extraArgs",
  "args",
  "env",
  "url",
  "apiBaseUrl",
  "runtimeEnvType",
  "runtimeEnvName",
  "dangerouslySkipPermissions",
  "dangerouslyBypassApprovalsAndSandbox",
  "dangerouslyBypassSandbox",
  "dangerouslyAllowInsecureRemoteHttp",
  "permissionMode",
  "acpPermissionMode",
  "acpxPermissionMode",
  "opencodePermissionMode",
  "codexPermissionMode",
  "nonInteractivePermissions",
  "acpNonInteractivePermissions",
  "sandbox",
  "filesystemSandboxCommand",
  "filesystemScope",
  "filesystemExtraPaths",
  "networkScope",
  "networkAllowlist",
  "approvalMode",
  "yolo",
  "alwaysApprove",
  "skipReviewerRequest",
  "toolsets",
  "enabledToolsets",
  "disableDeviceAuth",
  "scopes",
  "role",
  "managedAgentsRetentionAcknowledged",
  "agentCoreRetentionAcknowledged",
] as const;

/**
 * Name patterns for adapterConfig keys that are protected even when they are
 * not listed: escape hatches, executables, permission modes, `max*` limits,
 * timeouts, idle timers, profile selectors, and retention consents. They cover a new
 * adapter key of the same kind without a change here.
 */
const PROTECTED_ADAPTER_CONFIG_KEY_PATTERNS: readonly RegExp[] = [
  /^dangerously/i,
  /Command$/,
  /PermissionMode$/i,
  /^max[A-Z]/,
  /[tT]imeout(Sec|Seconds|Ms)$/,
  /IdleMs$/,
  /ProfileId$/,
  /RetentionAcknowledged$/,
];

const PROTECTED_ADAPTER_CONFIG_KEY_SET: ReadonlySet<string> = new Set(AGENT_SELF_PROTECTED_ADAPTER_CONFIG_KEYS);

export type AgentProtectedConfigState = {
  adapterType: string;
  adapterConfig: unknown;
  runtimeConfig: unknown;
  budgetMonthlyCents: number;
  spentMonthlyCents?: number;
  role?: string;
  status?: string;
  defaultEnvironmentId?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sortedUnionKeys(before: Record<string, unknown>, after: Record<string, unknown>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
}

function isProtectedAdapterConfigKey(key: string) {
  return PROTECTED_ADAPTER_CONFIG_KEY_SET.has(key)
    || PROTECTED_ADAPTER_CONFIG_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Appends `path` for each change between `before` and `after`, descending into
 * plain objects up to `depth` levels so the paths name the changed keys. A
 * missing side counts as an empty object, so an added or removed object still
 * reports its keys.
 */
function collectChangedPaths(before: unknown, after: unknown, path: string, depth: number, changed: string[]) {
  const canDescend = (isRecord(before) || isRecord(after))
    && (before === undefined || isRecord(before))
    && (after === undefined || isRecord(after));
  if (depth > 0 && canDescend) {
    const beforeRecord = recordOrEmpty(before);
    const afterRecord = recordOrEmpty(after);
    for (const key of sortedUnionKeys(beforeRecord, afterRecord)) {
      collectChangedPaths(beforeRecord[key], afterRecord[key], `${path}.${key}`, depth - 1, changed);
    }
    return;
  }
  if (!isDeepStrictEqual(before, after)) changed.push(path);
}

/**
 * Lists the protected fields that differ between two agent config states, as
 * dotted paths such as `runtimeConfig.heartbeat.maxDailyRuns` or
 * `adapterConfig.env.CODEX_HOME`. Every key under `runtimeConfig.heartbeat` is
 * protected: it holds the run caps, concurrency, daily cost cap, and timer
 * cadence, including their legacy aliases. Leaving `paused` is protected
 * because it is a resume, which already needs a grant.
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
  for (const key of sortedUnionKeys(beforeAdapterConfig, afterAdapterConfig)) {
    if (!isProtectedAdapterConfigKey(key)) continue;
    collectChangedPaths(
      beforeAdapterConfig[key],
      afterAdapterConfig[key],
      `adapterConfig.${key}`,
      key === "env" ? 1 : 0,
      changed,
    );
  }

  const beforeRuntimeConfig = recordOrEmpty(before.runtimeConfig);
  const afterRuntimeConfig = recordOrEmpty(after.runtimeConfig);
  collectChangedPaths(
    recordOrEmpty(beforeRuntimeConfig.heartbeat),
    recordOrEmpty(afterRuntimeConfig.heartbeat),
    "runtimeConfig.heartbeat",
    1,
    changed,
  );
  if (!isDeepStrictEqual(beforeRuntimeConfig.aiConnection, afterRuntimeConfig.aiConnection)) {
    changed.push("runtimeConfig.aiConnection");
  }
  return changed;
}

/**
 * Applies `PATCH /agents/:id` merge rules to the protected fields: adapterConfig
 * merges into the stored config unless `replaceAdapterConfig` is set or the
 * adapter type changes (which keeps the stored adapter-agnostic keys such as
 * `env` and `cwd` that the request omits), runtimeConfig replaces the stored
 * config but keeps the
 * stored `aiConnection` when the request leaves it empty, and omitted top-level
 * fields keep their stored value. Callers restore redacted `env` echoes first.
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
  const adapterConfig: Record<string, unknown> = !requestedAdapterConfig
    ? (changingAdapterType ? {} : { ...existingAdapterConfig })
    : (replaceAdapterConfig || changingAdapterType
      ? { ...requestedAdapterConfig }
      : { ...existingAdapterConfig, ...requestedAdapterConfig });
  if (changingAdapterType) {
    for (const key of ADAPTER_AGNOSTIC_KEYS) {
      if (adapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
        adapterConfig[key] = existingAdapterConfig[key];
      }
    }
  }

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
    defaultEnvironmentId: hasOwn(patch, "defaultEnvironmentId")
      ? (typeof patch.defaultEnvironmentId === "string" ? patch.defaultEnvironmentId : null)
      : existing.defaultEnvironmentId,
  };
}

/**
 * Lists every field a config rollback would change, given the exact patch the
 * rollback applies. A rollback restores a whole snapshot (including the
 * environment, profile, instructions paths, and workspace commands) and skips
 * the other agent checks on `PATCH /agents/:id`, so for an agent rolling back
 * its own config every change counts, not only the protected fields.
 */
export function collectAgentConfigRollbackChanges(
  existing: Record<string, unknown>,
  restored: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(restored).sort()) {
    const depth = key === "adapterConfig" || key === "runtimeConfig" ? 2 : 0;
    collectChangedPaths(existing[key] ?? null, restored[key] ?? null, key, depth, changed);
  }
  return changed;
}

/**
 * Lists the permission keys that differ between the stored and the next
 * normalized permissions, as `permissions.<key>` paths.
 */
export function collectAgentPermissionChanges(before: unknown, after: unknown): string[] {
  const beforePermissions = recordOrEmpty(before);
  const afterPermissions = recordOrEmpty(after);
  return sortedUnionKeys(beforePermissions, afterPermissions)
    .filter((key) => !isDeepStrictEqual(beforePermissions[key], afterPermissions[key]))
    .map((key) => `permissions.${key}`);
}

import { envBindingSchema, type SecretProjectionClass, type SecretVersionSelector } from "@paperclipai/shared";

interface AgentSecretBindingSyncService {
  syncSecretRefsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string },
    refs: Array<{
      secretId: string;
      configPath: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      label?: string | null;
      projectionClass?: SecretProjectionClass;
      projectionAllowlistKey?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
  syncEnvBindingsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    envValue: unknown,
  ) => Promise<unknown>;
  syncUserSecretDeclarationsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    refs: Array<{
      definitionKey: string;
      configPath: string;
      envKey: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      allowMissingOverride?: boolean;
      label?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function collectSecretRefs(adapterConfig: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
    projectionClass?: SecretProjectionClass;
    projectionAllowlistKey?: string | null;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: `env.${key}`,
      versionSelector: binding.version ?? "latest",
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: key,
      versionSelector: binding.version ?? "latest",
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  }

  return refs;
}

export function collectUserSecretRefs(adapterConfig: unknown): Array<{
  definitionKey: string;
  configPath: string;
  envKey: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  allowMissingOverride?: boolean;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    definitionKey: string;
    configPath: string;
    envKey: string;
    versionSelector?: SecretVersionSelector;
    required?: boolean;
    allowMissingOverride?: boolean;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "user_secret_ref") continue;
    refs.push({
      definitionKey: binding.key,
      configPath: `env.${key}`,
      envKey: key,
      versionSelector: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "user_secret_ref") continue;
    refs.push({
      definitionKey: binding.key,
      configPath: key,
      envKey: key,
      versionSelector: binding.version ?? "latest",
      required: binding.required ?? true,
      allowMissingOverride: binding.allowMissingOverride ?? false,
    });
  }

  return refs;
}

/**
 * The binding path prefix of one fallback target's env entries. Each target
 * binds its env under its own path, so two targets can hold different secrets
 * for the same key (for example two `OPENAI_API_KEY` references).
 *
 * @param index - Position of the target in the agent's stored `fallbacks`.
 * @returns A prefix such as `fallbacks[0].`.
 */
export function fallbackEnvBindingPrefix(index: number): string {
  return `fallbacks[${index}].`;
}

/**
 * Every secret and user-secret reference an agent needs bound: the primary
 * adapterConfig at its usual paths and each fallback target's env under that
 * target's own prefix.
 *
 * @param adapterConfig - The agent's primary adapterConfig.
 * @param fallbacks - The agent's stored fallback targets.
 * @returns Secret and user-secret references with their binding paths.
 */
export function collectAgentBindingRefs(adapterConfig: unknown, fallbacks: unknown) {
  const secretRefs = [...collectSecretRefs(adapterConfig)];
  const userSecretRefs = [...collectUserSecretRefs(adapterConfig)];
  if (Array.isArray(fallbacks)) {
    fallbacks.forEach((entry, index) => {
      const env = asRecord(entry)?.env;
      if (!env) return;
      const prefix = fallbackEnvBindingPrefix(index);
      for (const ref of collectSecretRefs({ env })) {
        secretRefs.push({ ...ref, configPath: `${prefix}${ref.configPath}` });
      }
      for (const ref of collectUserSecretRefs({ env })) {
        userSecretRefs.push({ ...ref, configPath: `${prefix}${ref.configPath}` });
      }
    });
  }
  return { secretRefs, userSecretRefs };
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export async function syncAgentAdapterEnvBindings(input: {
  secretsSvc: AgentSecretBindingSyncService;
  companyId: string;
  agentId: string;
  adapterConfig: unknown;
  fallbacks?: unknown;
}) {
  if (input.secretsSvc.syncSecretRefsForTarget) {
    const refs = collectAgentBindingRefs(input.adapterConfig, input.fallbacks);
    await input.secretsSvc.syncSecretRefsForTarget(
      input.companyId,
      { targetType: "agent", targetId: input.agentId },
      uniqueBy(refs.secretRefs, (ref) => ref.configPath),
      { replaceAll: true },
    );
    await input.secretsSvc.syncUserSecretDeclarationsForTarget?.(
      input.companyId,
      { targetType: "agent", targetId: input.agentId },
      uniqueBy(refs.userSecretRefs, (ref) => ref.configPath),
      { replaceAll: true },
    );
    return;
  }
  const envValue = asRecord(asRecord(input.adapterConfig)?.env);
  await input.secretsSvc.syncEnvBindingsForTarget?.(
    input.companyId,
    { targetType: "agent", targetId: input.agentId },
    envValue,
  );
}

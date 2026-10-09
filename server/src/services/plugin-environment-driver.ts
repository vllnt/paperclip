import type { Db } from "@paperclipai/db";
import type {
  EnvironmentProbeResult,
  PluginEnvironmentConfig,
  PluginEnvironmentDriverDeclaration,
} from "@paperclipai/shared";
import type {
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentInteractiveSetupSession,
  PluginEnvironmentStartInteractiveSetupParams,
  PluginEnvironmentGetInteractiveSetupParams,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentCancelInteractiveSetupParams,
  PluginEnvironmentCancelInteractiveSetupResult,
  PluginEnvironmentDeleteTemplateParams,
  PluginEnvironmentDeleteTemplateResult,
  PluginEnvironmentLease,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
} from "@paperclipai/plugin-sdk";
import { unprocessable } from "../errors.js";
import {
  collectSecretRefPaths,
  parseSecretRefBindingObject,
  SecretRefRedactionLimitError,
  haveSameSecretRefValues,
  readConfigValueAtPath,
  redactProviderMetadata,
  writeConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

// A plugin worker resolves its declared secret-ref values itself, so the host
// never sees them and cannot scrub them out of free text. Worker output that
// reaches an API response is therefore untrusted: metadata is redacted by the
// driver's config schema, and provider-written text is replaced by constant text.
const WITHHELD_PROVIDER_TEXT = "The provider's text is withheld because a provider can echo a resolved secret.";
const DIAGNOSTIC_SEVERITIES = new Set(["info", "warning", "error"]);

function declaredConfigSchema(driver: PluginEnvironmentDriverDeclaration): Record<string, unknown> | null {
  const schema = driver.configSchema;
  return schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : null;
}

const MAX_PROBE_DIAGNOSTICS = 50;

interface ProbeDiagnostic {
  severity: string;
  message: string;
  code?: string;
  omitted?: number;
}

function readDiagnosticSeverity(diagnostic: unknown): string {
  if (typeof diagnostic !== "object" || diagnostic === null || !("severity" in diagnostic)) return "info";
  const { severity } = diagnostic;
  return typeof severity === "string" && DIAGNOSTIC_SEVERITIES.has(severity) ? severity : "info";
}

/**
 * Maps the diagnostics of a provider probe to constant entries, at most
 * `MAX_PROBE_DIAGNOSTICS` of them plus one marker that counts the rest. A worker
 * response can hold millions of entries, so the list is cut before it is mapped:
 * the cost of the probe response does not depend on how many entries arrive.
 *
 * @param diagnostics - The `diagnostics` value of a probe result. Anything but an array maps to none.
 * @returns The kept entries, each with a checked severity and constant text, and a marker when entries were left out.
 */
function boundedProbeDiagnostics(diagnostics: unknown): ProbeDiagnostic[] {
  if (!Array.isArray(diagnostics)) return [];
  const kept = diagnostics.slice(0, MAX_PROBE_DIAGNOSTICS).map(
    (diagnostic): ProbeDiagnostic => ({
      severity: readDiagnosticSeverity(diagnostic),
      message: WITHHELD_PROVIDER_TEXT,
    }),
  );
  const omitted = diagnostics.length - kept.length;
  if (omitted <= 0) return kept;
  return [
    ...kept,
    { severity: "warning", message: WITHHELD_PROVIDER_TEXT, code: "diagnostics_truncated", omitted },
  ];
}

function safeProbeOutput(
  result: { diagnostics?: unknown; metadata?: Record<string, unknown> },
  configSchema: Record<string, unknown> | null,
) {
  return {
    diagnostics: boundedProbeDiagnostics(result.diagnostics),
    metadata: redactProviderMetadata(result.metadata, configSchema),
  };
}

function providerRejectedConfig(subject: string, result: { errors?: unknown; warnings?: unknown }) {
  return unprocessable(`${subject} rejected its config. ${WITHHELD_PROVIDER_TEXT}`, {
    errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
    warningCount: Array.isArray(result.warnings) ? result.warnings.length : 0,
  });
}

/**
 * The worker methods a sandbox provider must advertise before the host reuses
 * a provider lease across runs. The host resumes a lease through
 * `environmentResumeLease`, ends it through `environmentReleaseLease`, and tears
 * down a stale lease through `environmentDestroyLease`. The reuse path destroys
 * the stale lease when a resume fails and then acquires a fresh lease, so a
 * provider that omits any of the three methods can strand the stale lease and
 * can never complete the reuse path.
 *
 * The runtime capability normalizer maps `reusableLeases` to these same methods,
 * so the acquisition guard, the effective-capability snapshot, and the published
 * provider-capabilities value all read one source and cannot drift.
 */
export const REUSABLE_LEASE_WORKER_METHODS = [
  "environmentResumeLease",
  "environmentReleaseLease",
  "environmentDestroyLease",
] as const;

/**
 * The worker methods a sandbox provider must advertise before the customImage
 * setup gate in `environment-custom-images.ts` allows an interactive setup
 * session. The setup lifecycle starts a session through
 * `environmentStartInteractiveSetup`, polls it through
 * `environmentGetInteractiveSetup`, and cancels it through
 * `environmentCancelInteractiveSetup`. A provider that omits any of the three
 * can strand a setup session partway through the lifecycle.
 */
export const INTERACTIVE_SETUP_WORKER_METHODS = [
  "environmentStartInteractiveSetup",
  "environmentGetInteractiveSetup",
  "environmentCancelInteractiveSetup",
] as const;

/** The worker method the customImage template-capture gate in `environment-custom-images.ts` requires. */
export const TEMPLATE_CAPTURE_WORKER_METHODS = [
  "environmentCaptureTemplate",
] as const;

/** The worker method the customImage template-delete gate in `environment-custom-images.ts` requires. */
export const TEMPLATE_DELETE_WORKER_METHODS = [
  "environmentDeleteTemplate",
] as const;

export interface ReadyPluginWorkerRecovery {
  pluginKeys: readonly string[];
  startWorker(plugin: { id: string; pluginKey: string }): Promise<boolean>;
  timeoutMs?: number;
}

export interface ReadyPluginEnvironmentDriver {
  pluginId: string;
  pluginKey: string;
  driverKey: string;
  displayName: string;
  description?: string;
  configSchema: PluginEnvironmentDriverDeclaration["configSchema"];
  supportsReusableLeases?: PluginEnvironmentDriverDeclaration["supportsReusableLeases"];
  sandboxCapabilities?: PluginEnvironmentDriverDeclaration["sandboxCapabilities"];
  /**
   * The running worker for this exact plugin advertises ALL reusable-lease
   * lifecycle methods (`REUSABLE_LEASE_WORKER_METHODS`: resume, release, and
   * destroy). The published provider-capabilities value grants reusable leases
   * only when the declaration allows them AND this flag is true, so presentation
   * matches the acquisition guard, which also verifies the same methods live.
   */
  reusableLeaseMethodsVerified: boolean;
  supportsInteractiveSetup?: PluginEnvironmentDriverDeclaration["supportsInteractiveSetup"];
  interactiveSetupConnectionTypes?: PluginEnvironmentDriverDeclaration["interactiveSetupConnectionTypes"];
  supportsTemplateCapture?: PluginEnvironmentDriverDeclaration["supportsTemplateCapture"];
  templateRefKind?: PluginEnvironmentDriverDeclaration["templateRefKind"];
  templateConfigBinding?: PluginEnvironmentDriverDeclaration["templateConfigBinding"];
  supportsTemplateDelete?: PluginEnvironmentDriverDeclaration["supportsTemplateDelete"];
  supportsLoginPty?: PluginEnvironmentDriverDeclaration["supportsLoginPty"];
}

export function pluginDriverProviderKey(config: Pick<PluginEnvironmentConfig, "pluginKey" | "driverKey">): string {
  return `${config.pluginKey}:${config.driverKey}`;
}

const DEFAULT_READY_PLUGIN_WORKER_RECOVERY_TIMEOUT_MS = 2_000;

async function resolveWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function resolvePluginEnvironmentDriver(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
}) {
  const pluginRegistry = pluginRegistryService(input.db);
  const plugin = await pluginRegistry.getByKey(input.config.pluginKey);
  if (!plugin || plugin.status !== "ready") {
    throw new Error(`Plugin environment driver "${pluginDriverProviderKey(input.config)}" is not ready.`);
  }
  const driver = plugin.manifestJson.environmentDrivers?.find(
    (candidate) => candidate.driverKey === input.config.driverKey,
  );
  if (!driver) {
    throw new Error(`Plugin "${input.config.pluginKey}" does not declare environment driver "${input.config.driverKey}".`);
  }
  if (!input.workerManager.isRunning(plugin.id)) {
    throw new Error(`Plugin environment driver "${pluginDriverProviderKey(input.config)}" has no running worker.`);
  }
  return { plugin, driver };
}

export async function resolvePluginEnvironmentDriverByKey(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  driverKey: string;
}) {
  return await resolvePluginSandboxProviderDriverByKey({
    db: input.db,
    driverKey: input.driverKey,
    workerManager: input.workerManager,
    requireRunning: true,
  });
}

export async function resolvePluginSandboxProviderDriverByKey(input: {
  db: Db;
  driverKey: string;
  workerManager?: PluginWorkerManager;
  requireRunning?: boolean;
}): Promise<{ plugin: Awaited<ReturnType<ReturnType<typeof pluginRegistryService>["list"]>>[number]; driver: PluginEnvironmentDriverDeclaration } | null> {
  const pluginRegistry = pluginRegistryService(input.db);
  const plugins = await pluginRegistry.list();
  for (const plugin of plugins) {
    const driver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === input.driverKey && candidate.kind === "sandbox_provider",
    ) as PluginEnvironmentDriverDeclaration | undefined;
    if (!driver) continue;
    if (input.requireRunning) {
      if (plugin.status !== "ready") continue;
      if (!input.workerManager?.isRunning(plugin.id)) continue;
    }
    return { plugin, driver };
  }
  return null;
}

/**
 * Resolve the sandbox-provider driver declaration from one exact plugin id.
 *
 * A driver key is only unique inside a single manifest. Two installed plugins
 * can declare the same driver key. A lease pins the plugin that acquired it
 * through `metadata.pluginId`. Use this resolver, not the by-key resolver, when
 * the caller must read the declaration from that exact plugin. The by-key
 * resolver returns the first installed plugin with the key, which can be a
 * different, even disabled, plugin.
 *
 * This resolver fails closed. It returns `null` when the plugin id is unknown,
 * or when that plugin no longer declares a `sandbox_provider` driver with the
 * given key.
 */
export async function resolvePluginSandboxProviderDriverById(input: {
  db: Db;
  pluginId: string;
  driverKey: string;
}): Promise<{ plugin: Awaited<ReturnType<ReturnType<typeof pluginRegistryService>["getById"]>>; driver: PluginEnvironmentDriverDeclaration } | null> {
  const pluginRegistry = pluginRegistryService(input.db);
  const plugin = await pluginRegistry.getById(input.pluginId);
  if (!plugin) return null;
  const driver = plugin.manifestJson.environmentDrivers?.find(
    (candidate) => candidate.driverKey === input.driverKey && candidate.kind === "sandbox_provider",
  ) as PluginEnvironmentDriverDeclaration | undefined;
  if (!driver) return null;
  return { plugin, driver };
}

export async function listReadyPluginEnvironmentDrivers(input: {
  db: Db;
  workerManager?: PluginWorkerManager;
  recoverMissingWorker?: ReadyPluginWorkerRecovery;
}) {
  if (!input.workerManager) return [];
  const pluginRegistry = pluginRegistryService(input.db);
  const plugins = await pluginRegistry.list();
  const recoverablePluginKeys = new Set(input.recoverMissingWorker?.pluginKeys ?? []);
  const readyPlugins = plugins.filter((plugin) => plugin.status === "ready");
  const recoveryAttempts: Promise<boolean>[] = [];

  for (const plugin of readyPlugins) {
    const hasSandboxProviderDriver = plugin.manifestJson.environmentDrivers?.some(
      (driver) => driver.kind === "sandbox_provider",
    ) ?? false;
    const canRecover =
      hasSandboxProviderDriver
      && !input.workerManager.isRunning(plugin.id)
      && recoverablePluginKeys.has(plugin.pluginKey)
      && !input.workerManager.getWorker(plugin.id);
    if (!canRecover || !input.recoverMissingWorker) continue;
    const timeoutMs =
      input.recoverMissingWorker.timeoutMs ?? DEFAULT_READY_PLUGIN_WORKER_RECOVERY_TIMEOUT_MS;
    recoveryAttempts.push(resolveWithTimeout(
      input.recoverMissingWorker.startWorker({
        id: plugin.id,
        pluginKey: plugin.pluginKey,
      }).catch(() => false),
      timeoutMs,
      false,
    ));
  }

  if (recoveryAttempts.length > 0) {
    await Promise.all(recoveryAttempts);
  }

  const rows: ReadyPluginEnvironmentDriver[] = [];
  for (const plugin of readyPlugins) {
    if (!input.workerManager.isRunning(plugin.id)) {
      continue;
    }
    // The plugin is running, so read the live worker's verified methods once per
    // plugin. A provider advertises reusable leases only when its worker carries
    // all reuse lifecycle methods; the declaration alone never grants them.
    const workerMethods = new Set(input.workerManager.getWorker(plugin.id)?.supportedMethods ?? []);
    const reusableLeaseMethodsVerified = REUSABLE_LEASE_WORKER_METHODS.every(
      (method) => workerMethods.has(method),
    );
    rows.push(
      ...(plugin.manifestJson.environmentDrivers ?? [])
        .filter((driver) => driver.kind === "sandbox_provider")
        .map((driver) => ({
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          driverKey: driver.driverKey,
          displayName: driver.displayName,
          description: driver.description,
          configSchema: driver.configSchema,
          supportsReusableLeases: driver.supportsReusableLeases,
          sandboxCapabilities: driver.sandboxCapabilities,
          reusableLeaseMethodsVerified,
          supportsInteractiveSetup: driver.supportsInteractiveSetup,
          interactiveSetupConnectionTypes: driver.interactiveSetupConnectionTypes,
          supportsTemplateCapture: driver.supportsTemplateCapture,
          templateRefKind: driver.templateRefKind,
          templateConfigBinding: driver.templateConfigBinding,
          supportsTemplateDelete: driver.supportsTemplateDelete,
          supportsLoginPty: driver.supportsLoginPty,
        })),
    );
  }
  return rows;
}

export async function validatePluginSandboxProviderConfig(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  provider: string;
  config: Record<string, unknown>;
}): Promise<{
  normalizedConfig: Record<string, unknown>;
  pluginId: string;
  pluginKey: string;
  driver: PluginEnvironmentDriverDeclaration;
}> {
  const resolved = await resolvePluginSandboxProviderDriverByKey({
    db: input.db,
    driverKey: input.provider,
    workerManager: input.workerManager,
    requireRunning: true,
  });
  if (!resolved) {
    throw unprocessable(`Sandbox provider "${input.provider}" is not installed or its plugin worker is not running.`);
  }

  // Secret pickers submit `{ type: "secret_ref", secretId, version }` binding
  // objects for `format: "secret-ref"` fields. Plugins only understand string
  // config values, so canonicalize bindings to the bare secret id (the
  // persisted shape) before the plugin validates.
  const configSchema =
    resolved.driver.configSchema && typeof resolved.driver.configSchema === "object" && !Array.isArray(resolved.driver.configSchema)
      ? resolved.driver.configSchema as Record<string, unknown>
      : null;
  let config = input.config;
  for (const path of collectSecretRefPaths(configSchema)) {
    const binding = parseSecretRefBindingObject(readConfigValueAtPath(config, path));
    if (!binding) continue;
    if (binding.version !== "latest") {
      throw unprocessable(
        `Secret binding at ${path} pins version ${binding.version}; sandbox provider secret references always resolve the latest version.`,
      );
    }
    config = writeConfigValueAtPath(config, path, binding.secretId);
  }

  const result = await input.workerManager.call(resolved.plugin.id, "environmentValidateConfig", {
    driverKey: input.provider,
    config,
  });

  if (!result.ok) {
    throw providerRejectedConfig(`Sandbox provider "${input.provider}"`, result);
  }

  return {
    normalizedConfig: result.normalizedConfig ?? config,
    pluginId: resolved.plugin.id,
    pluginKey: resolved.plugin.pluginKey,
    driver: resolved.driver,
  };
}

// The host owns the values at declared secret-ref positions: they are the caller's
// secret ids. A provider may normalize any other field, but a different value at
// one of those positions could be a resolved secret that it echoes, and the
// normalized config is stored and returned as is. A value over the redaction
// limits cannot be checked, so it counts as changed.
function keepsCallerSecretRefs(
  caller: Record<string, unknown>,
  normalized: Record<string, unknown>,
  schema: Record<string, unknown> | null,
): boolean {
  try {
    return haveSameSecretRefValues(caller, normalized, schema);
  } catch (error) {
    if (error instanceof SecretRefRedactionLimitError) return false;
    throw error;
  }
}

export async function validatePluginEnvironmentDriverConfig(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
}): Promise<PluginEnvironmentConfig> {
  const { plugin, driver } = await resolvePluginEnvironmentDriver(input);
  const result = await input.workerManager.call(plugin.id, "environmentValidateConfig", {
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  });

  if (!result.ok) {
    throw providerRejectedConfig(`Plugin environment driver "${pluginDriverProviderKey(input.config)}"`, result);
  }

  const driverConfig = result.normalizedConfig ?? input.config.driverConfig;
  if (!keepsCallerSecretRefs(input.config.driverConfig, driverConfig, declaredConfigSchema(driver))) {
    throw unprocessable(
      `Plugin environment driver "${pluginDriverProviderKey(input.config)}" returned a config that changes a secret-ref field. The config was not saved.`,
    );
  }

  return {
    ...input.config,
    driverConfig,
  };
}

export async function probePluginEnvironmentDriver(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  config: PluginEnvironmentConfig;
}): Promise<EnvironmentProbeResult> {
  const { plugin, driver } = await resolvePluginEnvironmentDriver(input);
  const result = await input.workerManager.call(plugin.id, "environmentProbe", {
    driverKey: input.config.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    config: input.config.driverConfig,
  }, 120_000);

  return {
    ok: result.ok,
    driver: "plugin",
    summary: `Plugin environment driver "${pluginDriverProviderKey(input.config)}" probe ${result.ok ? "passed" : "failed"}.`,
    details: {
      pluginKey: input.config.pluginKey,
      driverKey: input.config.driverKey,
      ...safeProbeOutput(result, declaredConfigSchema(driver)),
    },
  };
}

export async function probePluginSandboxProviderDriver(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  provider: string;
  config: Record<string, unknown>;
}): Promise<EnvironmentProbeResult> {
  const resolved = await resolvePluginEnvironmentDriverByKey({
    db: input.db,
    workerManager: input.workerManager,
    driverKey: input.provider,
  });
  if (!resolved) {
    return {
      ok: false,
      driver: "sandbox",
      summary: `Sandbox provider "${input.provider}" is not installed or its plugin worker is not running.`,
      details: {
        provider: input.provider,
      },
    };
  }

  const { provider: _provider, ...driverConfig } = input.config;
  const result = await input.workerManager.call(resolved.plugin.id, "environmentProbe", {
    driverKey: input.provider,
    companyId: input.companyId,
    environmentId: input.environmentId,
    config: driverConfig,
  }, 120_000);

  return {
    ok: result.ok,
    driver: "sandbox",
    summary: `Sandbox provider "${input.provider}" probe ${result.ok ? "passed" : "failed"}.`,
    details: {
      provider: input.provider,
      pluginKey: resolved.plugin.pluginKey,
      ...safeProbeOutput(result, declaredConfigSchema(resolved.driver)),
    },
  };
}

export async function resumePluginEnvironmentLease(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  issueId?: string | null;
  config: PluginEnvironmentConfig;
  providerLeaseId: string;
  leaseMetadata?: Record<string, unknown>;
}): Promise<PluginEnvironmentLease> {
  const { plugin } = await resolvePluginEnvironmentDriver(input);
  return await input.workerManager.call(plugin.id, "environmentResumeLease", {
    driverKey: input.config.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    issueId: input.issueId ?? null,
    config: input.config.driverConfig,
    providerLeaseId: input.providerLeaseId,
    leaseMetadata: input.leaseMetadata,
  });
}

export async function destroyPluginEnvironmentLease(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  issueId?: string | null;
  config: PluginEnvironmentConfig;
  providerLeaseId: string | null;
  leaseMetadata?: Record<string, unknown>;
}): Promise<void> {
  const { plugin } = await resolvePluginEnvironmentDriver(input);
  await input.workerManager.call(plugin.id, "environmentDestroyLease", {
    driverKey: input.config.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    issueId: input.issueId ?? null,
    config: input.config.driverConfig,
    providerLeaseId: input.providerLeaseId,
    leaseMetadata: input.leaseMetadata,
  });
}

export async function realizePluginEnvironmentWorkspace(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  pluginId?: string | null;
  params: PluginEnvironmentRealizeWorkspaceParams;
  config: PluginEnvironmentConfig;
}): Promise<PluginEnvironmentRealizeWorkspaceResult> {
  const { plugin } = input.pluginId
    ? { plugin: { id: input.pluginId } }
    : await resolvePluginEnvironmentDriver({
        db: input.db,
        workerManager: input.workerManager,
        config: input.config,
      });
  return await input.workerManager.call(plugin.id, "environmentRealizeWorkspace", input.params);
}

export async function executePluginEnvironmentCommand(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  pluginId?: string | null;
  params: PluginEnvironmentExecuteParams;
  config: PluginEnvironmentConfig;
}): Promise<PluginEnvironmentExecuteResult> {
  const { plugin } = input.pluginId
    ? { plugin: { id: input.pluginId } }
    : await resolvePluginEnvironmentDriver({
        db: input.db,
        workerManager: input.workerManager,
        config: input.config,
      });
  return await input.workerManager.call(
    plugin.id,
    "environmentExecute",
    input.params,
    resolvePluginExecuteRpcTimeoutMs({
      requestedTimeoutMs: input.params.timeoutMs,
      config: input.config.driverConfig,
    }),
  );
}

export async function startPluginEnvironmentInteractiveSetup(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
  params: Omit<PluginEnvironmentStartInteractiveSetupParams, "driverKey" | "config">;
}): Promise<PluginEnvironmentInteractiveSetupSession> {
  const { plugin } = await resolvePluginEnvironmentDriver({
    db: input.db,
    workerManager: input.workerManager,
    config: input.config,
  });
  return await input.workerManager.call(plugin.id, "environmentStartInteractiveSetup", {
    ...input.params,
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  }, resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: undefined,
    config: input.config.driverConfig,
  }));
}

export async function getPluginEnvironmentInteractiveSetup(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
  params: Omit<PluginEnvironmentGetInteractiveSetupParams, "driverKey" | "config">;
}): Promise<PluginEnvironmentInteractiveSetupSession> {
  const { plugin } = await resolvePluginEnvironmentDriver({
    db: input.db,
    workerManager: input.workerManager,
    config: input.config,
  });
  return await input.workerManager.call(plugin.id, "environmentGetInteractiveSetup", {
    ...input.params,
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  }, resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: undefined,
    config: input.config.driverConfig,
  }));
}

export async function capturePluginEnvironmentTemplate(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
  params: Omit<PluginEnvironmentCaptureTemplateParams, "driverKey" | "config">;
}): Promise<PluginEnvironmentCaptureTemplateResult> {
  const { plugin } = await resolvePluginEnvironmentDriver({
    db: input.db,
    workerManager: input.workerManager,
    config: input.config,
  });
  return await input.workerManager.call(plugin.id, "environmentCaptureTemplate", {
    ...input.params,
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  }, resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: input.params.timeoutMs ?? undefined,
    config: input.config.driverConfig,
  }));
}

export async function cancelPluginEnvironmentInteractiveSetup(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
  params: Omit<PluginEnvironmentCancelInteractiveSetupParams, "driverKey" | "config">;
}): Promise<PluginEnvironmentCancelInteractiveSetupResult> {
  const { plugin } = await resolvePluginEnvironmentDriver({
    db: input.db,
    workerManager: input.workerManager,
    config: input.config,
  });
  return await input.workerManager.call(plugin.id, "environmentCancelInteractiveSetup", {
    ...input.params,
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  }, resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: undefined,
    config: input.config.driverConfig,
  }));
}

export async function deletePluginEnvironmentTemplate(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
  params: Omit<PluginEnvironmentDeleteTemplateParams, "driverKey" | "config">;
}): Promise<PluginEnvironmentDeleteTemplateResult> {
  const { plugin } = await resolvePluginEnvironmentDriver({
    db: input.db,
    workerManager: input.workerManager,
    config: input.config,
  });
  return await input.workerManager.call(plugin.id, "environmentDeleteTemplate", {
    ...input.params,
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  }, resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: undefined,
    config: input.config.driverConfig,
  }));
}

const RPC_OVERHEAD_BUFFER_MS = 30_000;

export function resolvePluginExecuteRpcTimeoutMs(input: {
  requestedTimeoutMs?: number;
  config: Record<string, unknown>;
}): number | undefined {
  let baseMs: number | undefined;
  if (Number.isFinite(input.requestedTimeoutMs) && (input.requestedTimeoutMs ?? 0) > 0) {
    baseMs = Math.trunc(input.requestedTimeoutMs!);
  } else {
    const configTimeoutMs = typeof input.config.timeoutMs === "number" ? input.config.timeoutMs : null;
    if (configTimeoutMs && Number.isFinite(configTimeoutMs) && configTimeoutMs > 0) {
      baseMs = Math.trunc(configTimeoutMs);
    }
  }
  return baseMs != null ? baseMs + RPC_OVERHEAD_BUFFER_MS : undefined;
}

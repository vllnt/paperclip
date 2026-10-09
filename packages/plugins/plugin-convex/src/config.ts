import { compilePattern } from "./ci-previews.js";
import {
  CAPABILITIES, ENVIRONMENT_CLASSES, PRESETS, PRODUCTION_WRITE_CAPABILITIES,
  type Capability, type ConnectionConfig, type EnvironmentClass, type Grant, type ProjectMapping, type SecretRef,
} from "./contracts.js";

/** A problem in the company config. The message names the field and never contains a value. */
export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function isSecretRef(value: unknown): value is SecretRef {
  return isRecord(value) && value.type === "secret_ref" && typeof value.secretId === "string" && value.secretId.length > 0;
}
function secretRef(value: unknown, path: string): SecretRef | null {
  if (value === undefined || value === null) return null;
  if (!isSecretRef(value)) throw new ConfigError(`${path} must be a Paperclip company secret reference ({type:"secret_ref", secretId}); plaintext tokens are never accepted.`);
  return { type: "secret_ref", secretId: value.secretId, version: "latest" };
}
function id(value: unknown, path: string): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]{1,20}$/.test(text.trim())) throw new ConfigError(`${path} must be a numeric Convex id.`);
  return text.trim();
}
function names(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim() || item.length > 200)) throw new ConfigError(`${path} must be a list of deployment names or references.`);
  return [...new Set((value as string[]).map(item => item.trim()))];
}
function bounded(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}
function flag(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be true or false.`);
  return value;
}
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function project(raw: unknown, index: number): ProjectMapping {
  const path = `projects[${index}]`;
  if (!isRecord(raw)) throw new ConfigError(`${path} must be an object.`);
  const environments = isRecord(raw.environments) ? raw.environments : {};
  const repository = raw.repository === undefined || raw.repository === null ? null : raw.repository;
  if (repository !== null && (typeof repository !== "string" || !REPOSITORY.test(repository))) throw new ConfigError(`${path}.repository must be owner/name.`);
  const convexProjectId = id(raw.convexProjectId, `${path}.convexProjectId`);
  return {
    convexProjectId,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 100) : `project-${convexProjectId}`,
    repository,
    paperclipProjectId: typeof raw.paperclipProjectId === "string" && raw.paperclipProjectId ? raw.paperclipProjectId : null,
    token: secretRef(raw.token, `${path}.token`),
    previewDeployKey: secretRef(raw.previewDeployKey, `${path}.previewDeployKey`),
    production: names(environments.production, `${path}.environments.production`),
    staging: names(environments.staging, `${path}.environments.staging`),
  };
}

function grant(raw: unknown, index: number): Grant {
  const path = `grants[${index}]`;
  if (!isRecord(raw)) throw new ConfigError(`${path} must be an object.`);
  const agentId = typeof raw.agentId === "string" && raw.agentId ? raw.agentId : null;
  const role = typeof raw.role === "string" && raw.role ? raw.role : null;
  if ((agentId === null) === (role === null)) throw new ConfigError(`${path} needs exactly one of agentId or role.`);
  if (!Array.isArray(raw.environments) || !raw.environments.length || raw.environments.some(env => !(ENVIRONMENT_CLASSES as readonly string[]).includes(env as string))) {
    throw new ConfigError(`${path}.environments must list environment classes: ${ENVIRONMENT_CLASSES.join(", ")}.`);
  }
  const capabilities = new Set<Capability>();
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== "string" || !(raw.preset in PRESETS)) throw new ConfigError(`${path}.preset must be one of ${Object.keys(PRESETS).join(", ")}.`);
    for (const capability of PRESETS[raw.preset as keyof typeof PRESETS]) capabilities.add(capability);
  }
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some(capability => !(CAPABILITIES as readonly string[]).includes(capability as string))) {
      throw new ConfigError(`${path}.capabilities must list capabilities: ${CAPABILITIES.join(", ")}.`);
    }
    for (const capability of raw.capabilities as Capability[]) capabilities.add(capability);
  }
  if (!capabilities.size) throw new ConfigError(`${path} grants nothing; set preset or capabilities.`);
  const environments = [...new Set(raw.environments as EnvironmentClass[])];
  // Agents may only manage the lifecycle of previews. Reject the grant instead of ignoring it, so an operator sees the mistake.
  if (capabilities.has("lifecycle") && environments.some(env => env !== "preview")) throw new ConfigError(`${path}: lifecycle can only be granted on preview.`);
  const approval = raw.approval === undefined || raw.approval === null ? null : raw.approval;
  if (approval !== null && approval !== "per-call") throw new ConfigError(`${path}.approval must be "per-call".`);
  if (environments.includes("production") && [...capabilities].some(capability => PRODUCTION_WRITE_CAPABILITIES.includes(capability)) && approval !== "per-call") {
    throw new ConfigError(`${path}: production writes need approval "per-call".`);
  }
  return { agentId, role, environments, capabilities: [...capabilities], approval };
}

function patterns(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw new ConfigError(`${path} must be a list of at most 100 reference patterns (exact names, or a prefix ending in *).`);
  }
  return [...new Set((value as string[]).map(item => item.trim()))];
}
function prPattern(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 200 || !value.includes("(?<pr>")) throw new ConfigError('reaper.pullRequestPattern must be a regular expression of at most 200 characters with a named group (?<pr>...).');
  try { compilePattern(value); } catch { throw new ConfigError("reaper.pullRequestPattern is not a valid regular expression."); }
  return value;
}

/** Parses the company config strictly. Anything unexpected throws, so a typo can never widen access. */
export function parseConfig(raw: Record<string, unknown> | null | undefined): ConnectionConfig {
  const source = raw ?? {};
  if (source.teamId !== undefined && source.teamId !== null) id(source.teamId, "teamId");
  const projects = source.projects === undefined ? [] : source.projects;
  if (!Array.isArray(projects) || projects.length > 50) throw new ConfigError("projects must be a list of at most 50 mappings.");
  const mapped = projects.map(project);
  if (new Set(mapped.map(item => item.convexProjectId)).size !== mapped.length) throw new ConfigError("A Convex project can be mapped once per company.");
  const github = isRecord(source.github) ? source.github : {};
  const grants = source.grants === undefined ? [] : source.grants;
  if (!Array.isArray(grants) || grants.length > 200) throw new ConfigError("grants must be a list of at most 200 entries.");
  const guards = isRecord(source.guards) ? source.guards : {};
  const reaper = isRecord(source.reaper) ? source.reaper : {};
  const dev = isRecord(reaper.dev) ? reaper.dev : {};
  return {
    teamId: source.teamId === undefined || source.teamId === null ? null : id(source.teamId, "teamId"),
    teamToken: secretRef(source.teamToken, "teamToken"),
    projects: mapped,
    githubToken: secretRef(github.token, "github.token"),
    grants: grants.map(grant),
    guards: {
      activityHours: bounded(guards.activityHours, "guards.activityHours", 24, 1, 168),
      maxDeletesPerRun: bounded(guards.maxDeletesPerRun, "guards.maxDeletesPerRun", 20, 1, 100),
      callsPerMinute: bounded(guards.callsPerMinute, "guards.callsPerMinute", 60, 1, 600),
      dryRunOnly: flag(guards.dryRunOnly, "guards.dryRunOnly", false),
    },
    reaper: {
      enabled: flag(reaper.enabled, "reaper.enabled", false),
      ttlHours: bounded(reaper.ttlHours, "reaper.ttlHours", 36, 3, 168),
      quota: bounded(reaper.quota, "reaper.quota", 300, 1, 100_000),
      alertPercent: bounded(reaper.alertPercent, "reaper.alertPercent", 80, 1, 100),
      dev: {
        enabled: flag(dev.enabled, "reaper.dev.enabled", false),
        maxAgeDays: bounded(dev.maxAgeDays, "reaper.dev.maxAgeDays", 7, 1, 90),
        protect: patterns(dev.protect, "reaper.dev.protect"),
        onlyPatterns: patterns(dev.onlyPatterns, "reaper.dev.onlyPatterns"),
        maxDeletes: bounded(dev.maxDeletes, "reaper.dev.maxDeletes", 20, 1, 100),
      },
      pullRequestPattern: prPattern(reaper.pullRequestPattern),
      supersededMinAgeMinutes: bounded(reaper.supersededMinAgeMinutes, "reaper.supersededMinAgeMinutes", 60, 15, 1440),
    },
  };
}

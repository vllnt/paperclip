/** Agent config fields that `agent config get|set` can address. */
export const AGENT_CONFIG_ROOTS = ["adapterConfig", "runtimeConfig"] as const;

type AgentConfigRoot = (typeof AGENT_CONFIG_ROOTS)[number];

/** A merge patch for `PATCH /api/agents/:id` with `mergeConfig: true`. */
export type AgentConfigMergePatch = Partial<Record<AgentConfigRoot, Record<string, unknown>>>;

function isConfigRoot(value: string): value is AgentConfigRoot {
  return (AGENT_CONFIG_ROOTS as readonly string[]).includes(value);
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function splitConfigPath(dottedPath: string): { root: AgentConfigRoot; keys: string[] } {
  const [root, ...keys] = dottedPath.split(".");
  if (keys.some((key) => FORBIDDEN_KEYS.has(key))) {
    throw new Error(`Invalid config path "${dottedPath}": __proto__, constructor and prototype are not allowed.`);
  }
  if (!root || !isConfigRoot(root) || keys.length === 0 || keys.some((key) => key.length === 0)) {
    throw new Error(
      `Invalid config path "${dottedPath}". Use adapterConfig.<key> or runtimeConfig.<key>, ` +
        "for example runtimeConfig.heartbeat.maxDailyRuns.",
    );
  }
  return { root, keys };
}

/** Parses a value as JSON when it is valid JSON (`64`, `true`, `{"a":1}`), otherwise keeps the raw string. */
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function setPath(target: Record<string, unknown>, keys: string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = keys;
  if (rest.length === 0) return { ...target, [key]: value };
  return { ...target, [key]: setPath(asPlainObject(target[key]) ?? {}, rest, value) };
}

/**
 * Builds a JSON merge patch from `path=value` assignments and paths to remove.
 *
 * @param assignments - entries such as `runtimeConfig.heartbeat.maxDailyRuns=64`.
 * @param unset - paths to remove, sent as `null`.
 * @returns the patch, keyed by `adapterConfig` and `runtimeConfig`.
 * @example
 * buildAgentConfigMergePatch(["runtimeConfig.heartbeat.maxDailyRuns=64"], ["adapterConfig.env.DEBUG"])
 * // => { runtimeConfig: { heartbeat: { maxDailyRuns: 64 } }, adapterConfig: { env: { DEBUG: null } } }
 */
export function buildAgentConfigMergePatch(assignments: string[], unset: string[] = []): AgentConfigMergePatch {
  const patch: AgentConfigMergePatch = {};
  const apply = (dottedPath: string, value: unknown) => {
    const { root, keys } = splitConfigPath(dottedPath);
    patch[root] = setPath(patch[root] ?? {}, keys, value);
  };
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid assignment "${assignment}". Use path=value, for example adapterConfig.model=gpt-5.`);
    }
    apply(assignment.slice(0, separator), parseConfigValue(assignment.slice(separator + 1)));
  }
  for (const dottedPath of unset) {
    if (dottedPath.includes("=")) {
      throw new Error(
        `--unset takes paths, not assignments ("${dottedPath}"). Put path=value pairs before --unset.`,
      );
    }
    apply(dottedPath, null);
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Nothing to change. Pass at least one path=value or --unset <path>.");
  }
  return patch;
}

/** Reads a dotted path such as `runtimeConfig.heartbeat` from an agent record. */
export function readConfigPath(agent: Record<string, unknown>, dottedPath: string | undefined): unknown {
  if (!dottedPath) {
    return { adapterConfig: agent.adapterConfig ?? {}, runtimeConfig: agent.runtimeConfig ?? {} };
  }
  if (isConfigRoot(dottedPath)) return agent[dottedPath] ?? {};
  const { root, keys } = splitConfigPath(dottedPath);
  let cursor: unknown = agent[root];
  for (const key of keys) {
    const container = asPlainObject(cursor);
    if (!container) return undefined;
    cursor = container[key];
  }
  return cursor;
}

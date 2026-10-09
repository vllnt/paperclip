import { classifyModelVendor } from "@paperclipai/shared";
import { grokLocalReasoningEffortsForModel } from "./reasoning-efforts.js";

export interface GrokSwitchSource {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown> | null;
}

export type GrokSwitchPlan =
  | {
      ok: true;
      /** The body for `PATCH /api/agents/:id`. */
      patch: {
        adapterType: "grok_local";
        adapterConfig: Record<string, unknown>;
        replaceAdapterConfig: true;
      };
      /** What the switch moves, renames, clamps or drops. */
      changes: string[];
      /** What the operator still has to check or set. */
      warnings: string[];
    }
  | {
      ok: false;
      reason: "not_codex_local" | "not_xai_model" | "managed_connection" | "confinement_not_portable";
      message: string;
    };

/** Keys both harnesses read, copied unchanged. */
const KEPT_KEYS = [
  "model",
  "cwd",
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "timeoutSec",
  "graceSec",
  "paperclipSkillSync",
  "workspaceStrategy",
  "workspaceRuntime",
] as const;

/** Codex-only keys, dropped. `command`, `extraArgs` and the confinement keys are handled apart. */
const CODEX_ONLY_KEYS = [
  "engine",
  "search",
  "fastMode",
  "dangerouslyBypassApprovalsAndSandbox",
  "outputInactivityTimeoutMs",
  "agentCommand",
  "mode",
  "nonInteractivePermissions",
  "stateDir",
  "warmHandleIdleMs",
] as const;

const CONFINEMENT_KEYS = ["filesystemScope", "filesystemExtraPaths", "filesystemSandboxCommand", "networkScope", "networkAllowlist"] as const;

/** The Codex env keys that have a Grok counterpart. */
const ENV_RENAMES: Record<string, string> = {
  OPENAI_API_KEY: "XAI_API_KEY",
  OPENAI_BASE_URL: "GROK_XAI_API_BASE_URL",
};

const REDACTED = "***REDACTED***";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** A binding the API returned redacted cannot be copied under another key. */
function isRedactedBinding(value: unknown): boolean {
  if (typeof value === "string") return value === REDACTED;
  return isRecord(value) && value.type === "plain" && value.value === REDACTED;
}

/**
 * Plans moving a `codex_local` agent that runs a Grok model onto `grok_local`:
 * same model, instructions, working directory and skills. The plan is a body
 * for the existing `PATCH /api/agents/:id`, which re-checks that the harness
 * accepts the model. The CLI and the web UI share it, so both give the same
 * result.
 *
 * Refuses rather than weaken anything: a filesystem or network confinement
 * setting has no Grok counterpart, and a managed AI connection is bound to the
 * Codex provider.
 *
 * @param source - The agent's adapter type and config, as the API returns them.
 * @returns The patch and a report of what changed, or the reason it cannot move.
 */
export function planCodexToGrokSwitch(source: GrokSwitchSource): GrokSwitchPlan {
  if (source.adapterType !== "codex_local") {
    return { ok: false, reason: "not_codex_local", message: `Only codex_local agents can be switched this way; this agent uses ${source.adapterType}.` };
  }
  const config = source.adapterConfig;
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (classifyModelVendor(model) !== "xai") {
    return {
      ok: false,
      reason: "not_xai_model",
      message: model
        ? `Model "${model}" is not an xAI model, so Grok cannot run it. Change the model first.`
        : "The agent has no model set, so it runs Codex's default model, which Grok cannot run. Set a grok-* model first.",
    };
  }
  if (isSet(source.runtimeConfig?.aiConnection)) {
    return {
      ok: false,
      reason: "managed_connection",
      message: "The agent uses a managed AI connection bound to Codex. Switch the harness from the agent's AI connection settings instead.",
    };
  }
  const confinement = CONFINEMENT_KEYS.filter((key) => isSet(config[key]));
  if (confinement.length > 0) {
    return {
      ok: false,
      reason: "confinement_not_portable",
      message: `grok_local has no equivalent of ${confinement.join(", ")}; switching would silently remove that confinement. Remove it first if that is intended.`,
    };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const next: Record<string, unknown> = {};
  for (const key of KEPT_KEYS) {
    if (config[key] !== undefined) next[key] = structuredClone(config[key]);
  }

  const effort = typeof config.modelReasoningEffort === "string" ? config.modelReasoningEffort.trim() : "";
  if (effort) {
    const supported = grokLocalReasoningEffortsForModel(model);
    if (supported.includes(effort)) {
      next.reasoningEffort = effort;
      changes.push(`modelReasoningEffort -> reasoningEffort (${effort})`);
    } else if (["xhigh", "max", "ultra"].includes(effort)) {
      const highest = supported[supported.length - 1]!;
      next.reasoningEffort = highest;
      changes.push(`modelReasoningEffort ${effort} -> reasoningEffort ${highest} (the highest ${model} takes)`);
    } else {
      changes.push(`modelReasoningEffort "${effort}" dropped (${model} takes ${supported.join("|")})`);
    }
  }

  const sourceEnv = isRecord(config.env) ? config.env : {};
  const env: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    const renamed = ENV_RENAMES[key];
    if (renamed) continue;
    if (key.startsWith("OPENAI_") || key.startsWith("CODEX_")) {
      changes.push(`env ${key} dropped (Codex only)`);
      continue;
    }
    env[key] = structuredClone(value);
  }
  for (const [from, to] of Object.entries(ENV_RENAMES)) {
    if (!(from in sourceEnv)) continue;
    if (to in sourceEnv) {
      changes.push(`env ${from} dropped (${to} is already set)`);
    } else if (isRedactedBinding(sourceEnv[from])) {
      changes.push(`env ${from} dropped (its plain-text value is not readable through the API)`);
    } else {
      env[to] = structuredClone(sourceEnv[from]);
      changes.push(`env ${from} -> ${to}`);
    }
  }
  if (!(("XAI_API_KEY") in env)) {
    warnings.push("No XAI_API_KEY is set. Bind one as a company secret before the first run (or log in the Grok home), or the run fails with grok_auth_required.");
  }
  if ("GROK_XAI_API_BASE_URL" in env) {
    warnings.push("GROK_XAI_API_BASE_URL was taken from OPENAI_BASE_URL. Confirm the gateway serves xAI models on /v1/chat/completions before moving every agent.");
  }
  next.env = env;

  const dropped = CODEX_ONLY_KEYS.filter((key) => isSet(config[key]));
  if (dropped.length > 0) changes.push(`${dropped.join(", ")} dropped (Codex only)`);
  if (typeof config.command === "string" && config.command.trim() && config.command.trim() !== "codex") {
    warnings.push(`Custom command "${config.command}" was not carried over; grok_local runs "grok". Set command if the Grok binary lives elsewhere.`);
  }
  if (isSet(config.extraArgs)) {
    warnings.push("extraArgs were not carried over: they are Codex flags. Add Grok flags to extraArgs if needed.");
  }
  warnings.push("The first run on grok_local starts a fresh session; the Codex session is not resumed.");

  return {
    ok: true,
    patch: { adapterType: "grok_local", adapterConfig: next, replaceAdapterConfig: true },
    changes,
    warnings,
  };
}

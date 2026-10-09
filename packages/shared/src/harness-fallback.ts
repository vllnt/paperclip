import { z } from "zod";
import { envConfigSchema } from "./validators/secret.js";

/** Harnesses that may appear in an agent's `fallbacks` chain. */
export const HARNESS_FALLBACK_ADAPTER_TYPES = ["claude_local", "codex_local", "grok_local"] as const;
export type HarnessFallbackAdapterType = (typeof HARNESS_FALLBACK_ADAPTER_TYPES)[number];

/** Upper bound on fallback entries per agent; one wake re-dispatches at most once. */
export const MAX_AGENT_FALLBACKS = 3;

export const MODEL_VENDORS = ["anthropic", "openai", "xai", "unknown"] as const;
export type ModelVendor = (typeof MODEL_VENDORS)[number];

/**
 * Which model vendors each harness may run. Anthropic models run only through
 * `claude_local`: sending them through another client can get the
 * subscription accounts behind the proxy banned.
 */
export const HARNESS_ALLOWED_MODEL_VENDORS: Readonly<Record<HarnessFallbackAdapterType, readonly ModelVendor[]>> = {
  claude_local: ["anthropic"],
  codex_local: ["openai", "xai"],
  grok_local: ["xai"],
};

const ANTHROPIC_ALIAS_RE = /^(?:opus|sonnet|haiku|fable|mythos|opusplan)(?:$|[-.:@])/;
const OPENAI_MODEL_RE = /^(?:gpt(?:$|[-.\d])|o\d+(?:$|-)|chatgpt-|codex-|computer-use)/;
const ROUTER_PREFIX_RE = /^(?:openrouter\/|azure\/|bedrock\/|vertex_ai\/)/;

/**
 * Classifies a model id by vendor from its name alone.
 *
 * @param model - A model id as an operator or adapter writes it.
 * @returns The vendor, or `unknown` when the id matches no known family.
 * @example classifyModelVendor("anthropic/claude-sonnet-4-5") // "anthropic"
 */
export function classifyModelVendor(model: string): ModelVendor {
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  if (!id) return "unknown";
  if (id.includes("claude") || id.includes("anthropic") || ANTHROPIC_ALIAS_RE.test(id)) return "anthropic";
  if (id.includes("grok")) return "xai";
  const unprefixed = id.replace(ROUTER_PREFIX_RE, "").replace(/^openai\//, "");
  if (OPENAI_MODEL_RE.test(unprefixed)) return "openai";
  return "unknown";
}

function readConfigModelAssignment(value: string): string | null {
  const match = /^model\s*=\s*["']?([^"']+)["']?$/.exec(value.trim());
  return match ? match[1].trim() : null;
}

/**
 * Lists model ids selected through CLI arguments (`--model`, `-m`,
 * `-c model=…`, `--config model=…`), which override `adapterConfig.model`.
 *
 * @param args - An adapter's `extraArgs` or `args` value.
 * @returns Every model id the arguments select, in order.
 */
export function readModelOverridesFromArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const values = args.filter((arg): arg is string => typeof arg === "string");
  const models: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = values[index + 1];
    if ((arg === "--model" || arg === "-m") && next !== undefined) {
      models.push(next.trim());
      index += 1;
    } else if (arg.startsWith("--model=")) {
      models.push(arg.slice("--model=".length).trim());
    } else if ((arg === "-c" || arg === "--config") && next !== undefined) {
      const model = readConfigModelAssignment(next);
      if (model) models.push(model);
      index += 1;
    } else if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      const model = readConfigModelAssignment(arg.slice(arg.indexOf("=") + 1));
      if (model) models.push(model);
    }
  }
  return models.filter((model) => model.length > 0);
}

export interface HarnessModelCompatibilityInput {
  adapterType: string;
  model?: string | null;
  extraArgs?: unknown;
  args?: unknown;
}

export type HarnessModelCompatibilityResult =
  | { ok: true }
  | {
      ok: false;
      code: "harness_model_incompatible";
      message: string;
      model: string;
      vendor: ModelVendor;
    };

function isMatrixHarness(adapterType: string): adapterType is HarnessFallbackAdapterType {
  return (HARNESS_FALLBACK_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

/**
 * Checks a harness against the model it would run, including model overrides
 * in CLI arguments. Anthropic ids are refused on every non-Claude harness.
 *
 * @param input - Harness and model selection (plus `extraArgs`/`args`).
 * @param options - `requireKnownVendor` refuses ids the classifier cannot place.
 * @returns `ok`, or the first incompatible model with an operator-facing message.
 */
export function checkHarnessModelCompatibility(
  input: HarnessModelCompatibilityInput,
  options: { requireKnownVendor: boolean },
): HarnessModelCompatibilityResult {
  const configured = typeof input.model === "string" ? input.model.trim() : "";
  const candidates = [
    ...(configured ? [configured] : []),
    ...readModelOverridesFromArgs(input.extraArgs),
    ...readModelOverridesFromArgs(input.args),
  ];
  for (const model of candidates) {
    const vendor = classifyModelVendor(model);
    if (vendor === "anthropic" && input.adapterType !== "claude_local") {
      return {
        ok: false,
        code: "harness_model_incompatible",
        model,
        vendor,
        message: `Anthropic models never run through ${input.adapterType}; use claude_local for "${model}".`,
      };
    }
    if (!isMatrixHarness(input.adapterType)) continue;
    const allowed = HARNESS_ALLOWED_MODEL_VENDORS[input.adapterType];
    if (vendor === "unknown" ? options.requireKnownVendor : !allowed.includes(vendor)) {
      return {
        ok: false,
        code: "harness_model_incompatible",
        model,
        vendor,
        message: `${input.adapterType} runs only ${allowed.join(" or ")} models; "${model}" is ${vendor === "unknown" ? "not a recognised model id" : `an ${vendor} model`}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * The adapterConfig key that holds reasoning effort for a fallback harness.
 *
 * @param adapterType - A fallback harness.
 * @returns The harness's own effort key.
 */
export function fallbackEffortConfigKey(adapterType: HarnessFallbackAdapterType): string {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "grok_local") return "reasoningEffort";
  return "effort";
}

/**
 * Stable identity of a harness target, used for cooldowns and run records.
 *
 * @param target - Harness and model.
 * @returns `<adapterType>:<model>`.
 */
export function harnessTargetKey(target: { adapterType: string; model?: string | null }): string {
  return `${target.adapterType}:${(target.model ?? "").trim()}`;
}

const RESERVED_FALLBACK_ADAPTER_CONFIG_KEYS = ["env", "model", "effort", "modelReasoningEffort", "reasoningEffort"];

export const agentFallbackTargetSchema = z
  .object({
    adapterType: z.enum(HARNESS_FALLBACK_ADAPTER_TYPES),
    model: z.string().trim().min(1).max(200),
    effort: z.string().trim().min(1).max(40).optional(),
    adapterConfig: z.record(z.string(), z.unknown()).optional(),
    env: envConfigSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    for (const key of RESERVED_FALLBACK_ADAPTER_CONFIG_KEYS) {
      if (entry.adapterConfig && Object.prototype.hasOwnProperty.call(entry.adapterConfig, key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adapterConfig", key],
          message: `Set ${key === "env" ? "env" : key === "model" ? "model" : "effort"} on the fallback entry, not in adapterConfig`,
        });
      }
    }
    const compatibility = checkHarnessModelCompatibility(
      {
        adapterType: entry.adapterType,
        model: entry.model,
        extraArgs: entry.adapterConfig?.extraArgs,
        args: entry.adapterConfig?.args,
      },
      { requireKnownVendor: true },
    );
    if (!compatibility.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: compatibility.message });
    }
  });

export type AgentFallbackTarget = z.infer<typeof agentFallbackTargetSchema>;

export const agentFallbacksSchema = z
  .array(agentFallbackTargetSchema)
  .max(MAX_AGENT_FALLBACKS)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = harnessTargetKey(entry);
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: `Duplicate fallback target ${key}` });
      }
      seen.add(key);
    });
  });

/**
 * Live quota state the API reports for an agent while its primary
 * harness/model is cooling down. `active` means runs use a fallback target;
 * `heldUntil` means every target is cooling down and runs wait until then.
 */
export interface AgentHarnessFallbackState {
  active: boolean;
  adapterType: string;
  model: string | null;
  reason: string | null;
  primaryCooldownUntil: string;
  heldUntil: string | null;
}

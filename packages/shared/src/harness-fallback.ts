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
  const id = stripTrailingBracketSuffix(model.trim().toLowerCase());
  if (!id) return "unknown";
  if (id.includes("claude") || id.includes("anthropic") || ANTHROPIC_ALIAS_RE.test(id)) return "anthropic";
  if (id.includes("grok")) return "xai";
  const unprefixed = id.replace(ROUTER_PREFIX_RE, "").replace(/^openai\//, "");
  if (OPENAI_MODEL_RE.test(unprefixed)) return "openai";
  return "unknown";
}

/**
 * Removes a trailing `[…]` suffix such as Claude's `[1m]` context marker. The
 * suffix starts at the first `[` after the last `]` that precedes the final
 * character, so the scan is linear.
 */
function stripTrailingBracketSuffix(id: string): string {
  if (!id.endsWith("]")) return id;
  const previousClose = id.lastIndexOf("]", id.length - 2);
  const open = id.indexOf("[", previousClose + 1);
  return open === -1 ? id : id.slice(0, open);
}

function isConfigKeyPrefix(prefix: string): boolean {
  if (prefix.length < 2 || !prefix.endsWith(".")) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    const code = prefix.charCodeAt(index);
    const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    if (!word && code !== 46 && code !== 45) return false;
  }
  return true;
}

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'";
}

/**
 * Reads the value of `model=…`, `-c model="…"` or `profiles.x.model=…`. The
 * key is everything before the first `=`; the value may carry one optional
 * quote on each side and no quote inside.
 */
function readConfigModelAssignment(value: string): string | null {
  const text = value.trim();
  const equals = text.indexOf("=");
  if (equals === -1) return null;
  const key = text.slice(0, equals).trimEnd();
  if (key !== "model" && !(key.endsWith(".model") && isConfigKeyPrefix(key.slice(0, -"model".length)))) return null;
  let body = text.slice(equals + 1).trimStart();
  if (isQuote(body[0])) body = body.slice(1);
  if (isQuote(body[body.length - 1])) body = body.slice(0, -1);
  if (body.length === 0 || body.includes('"') || body.includes("'")) return null;
  return body.trim();
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
    } else if (arg.startsWith("--config=")) {
      const model = readConfigModelAssignment(arg.slice("--config=".length));
      if (model) models.push(model);
    } else if (arg.startsWith("-m=")) {
      models.push(arg.slice(3).trim());
    } else if (arg.startsWith("-m") && !arg.startsWith("--")) {
      models.push(arg.slice(2).trim());
    } else if (arg.startsWith("-c") && !arg.startsWith("--")) {
      const model = readConfigModelAssignment(arg.slice(2).replace(/^=/, ""));
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

/** Plain (non-secret) env values a fallback may carry: paths, endpoints and model names. */
const PLAIN_FALLBACK_ENV_KEY_RE = /^(?:[A-Z0-9]+_)*(?:HOME|DIR|PATH|URL|MODEL|EFFORT)$|^(?:HTTPS?_PROXY|NO_PROXY|TZ|LANG)$/;

function plainFallbackEnvValue(binding: unknown): string | null {
  if (typeof binding === "string") return binding;
  if (typeof binding === "object" && binding !== null && (binding as { type?: unknown }).type === "plain") {
    const value = (binding as { value?: unknown }).value;
    return typeof value === "string" ? value : null;
  }
  return null;
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
    for (const [key, binding] of Object.entries(entry.env ?? {})) {
      const plain = plainFallbackEnvValue(binding);
      if (plain === null) continue;
      if (!PLAIN_FALLBACK_ENV_KEY_RE.test(key) || /\/\/[^/\s@]*@/.test(plain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["env", key],
          message: `${key} must be a secret reference: fallback env accepts plain values only for paths, endpoints without credentials and model names`,
        });
      } else if (/(?:^|_)MODEL$/.test(key)) {
        const modelCheck = checkHarnessModelCompatibility({ adapterType: entry.adapterType, model: plain }, { requireKnownVendor: true });
        if (!modelCheck.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["env", key], message: modelCheck.message });
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

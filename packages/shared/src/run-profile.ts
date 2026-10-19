import { z } from "zod";
import {
  HARNESS_FALLBACK_ADAPTER_TYPES,
  checkHarnessModelCompatibility,
  type HarnessFallbackAdapterType,
} from "./harness-fallback.js";

/** The tier that means "the agent's own default": no override. */
export const DEFAULT_RUN_TIER = "deep";

/** Where a run's harness and model came from, recorded on every run. */
export const RUN_TARGET_SOURCES = ["issue_profile", "routine_profile", "fallback", "agent_default"] as const;
export type RunTargetSource = (typeof RUN_TARGET_SOURCES)[number];

const TIER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const tierNameSchema = z.string().regex(TIER_NAME_RE, "Tier names are lowercase letters, digits, - and _ (at most 32 characters)");

/** A harness/model target, validated against the harness/model matrix. */
const explicitTargetShape = {
  adapterType: z.enum(HARNESS_FALLBACK_ADAPTER_TYPES).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(40).optional(),
};

function checkExplicitTarget(
  target: { adapterType?: HarnessFallbackAdapterType; model?: string },
  ctx: z.RefinementCtx,
) {
  if (target.adapterType && !target.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "Name the model to run on another harness" });
    return;
  }
  if (!target.adapterType || !target.model) return;
  const compatibility = checkHarnessModelCompatibility(
    { adapterType: target.adapterType, model: target.model },
    { requireKnownVendor: true },
  );
  if (!compatibility.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: compatibility.message });
}

/**
 * How one issue (or routine) picks its run target: a company tier by name, or
 * an explicit harness, model and effort. `adapterType` is optional: a model or
 * effort alone runs on the agent's own harness.
 */
export const runProfileSchema = z
  .object({ tier: tierNameSchema.optional(), ...explicitTargetShape })
  .strict()
  .superRefine((profile, ctx) => {
    const explicit = profile.adapterType || profile.model || profile.effort;
    if (profile.tier && explicit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Set either a tier or an explicit target, not both" });
      return;
    }
    if (!profile.tier && !explicit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A run profile needs a tier, a model or an effort" });
      return;
    }
    checkExplicitTarget(profile, ctx);
  });

export type RunProfile = z.infer<typeof runProfileSchema>;

const tierTargetSchema = z
  .object({
    adapterType: z.enum(HARNESS_FALLBACK_ADAPTER_TYPES),
    model: z.string().trim().min(1).max(200),
    effort: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .superRefine(checkExplicitTarget);

/**
 * A company's named run tiers. The `deep` tier is reserved for the agent's own
 * default. `agentAllowlist` names the tiers an agent may set on issues it
 * creates or dispatches; everything else needs a board user or an
 * `agents:configure` grant.
 */
export const companyRunTiersSchema = z
  .object({
    tiers: z.record(tierNameSchema, tierTargetSchema).default({}),
    agentAllowlist: z.array(tierNameSchema).max(32).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.hasOwn(value.tiers, DEFAULT_RUN_TIER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiers", DEFAULT_RUN_TIER],
        message: `"${DEFAULT_RUN_TIER}" is reserved for the agent's own default`,
      });
    }
    value.agentAllowlist.forEach((name, index) => {
      if (name !== DEFAULT_RUN_TIER && !Object.hasOwn(value.tiers, name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agentAllowlist", index], message: `Unknown tier "${name}"` });
      }
    });
  });

export type CompanyRunTiers = z.infer<typeof companyRunTiersSchema>;

/** A run profile resolved to concrete values; unset fields keep the agent's own. */
export interface ResolvedRunTarget {
  adapterType?: HarnessFallbackAdapterType;
  model?: string;
  effort?: string;
  tier?: string;
}

export type RunProfileResolution =
  | { ok: true; target: ResolvedRunTarget | null }
  | { ok: false; reason: "unknown_tier"; tier: string };

/**
 * Resolves a profile against the company's tiers.
 *
 * @param profile - The profile stored on an issue or routine.
 * @param tiers - The company's tiers, if it has any.
 * @returns The target, `null` for the default tier, or why it cannot resolve.
 */
export function resolveRunProfile(profile: RunProfile, tiers: CompanyRunTiers | null | undefined): RunProfileResolution {
  if (profile.tier) {
    if (profile.tier === DEFAULT_RUN_TIER) return { ok: true, target: null };
    const tier = tiers && Object.hasOwn(tiers.tiers, profile.tier) ? tiers.tiers[profile.tier] : null;
    if (!tier) return { ok: false, reason: "unknown_tier", tier: profile.tier };
    return { ok: true, target: { ...tier, tier: profile.tier } };
  }
  return {
    ok: true,
    target: {
      ...(profile.adapterType ? { adapterType: profile.adapterType } : {}),
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
    },
  };
}

const LEGACY_EFFORT_KEYS = ["effort", "modelReasoningEffort", "reasoningEffort"] as const;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The issue-level profile of an issue's assignee overrides. An explicit
 * `runProfile` wins. Otherwise the model and effort of the legacy
 * `adapterConfig` override count as a profile on the agent's own harness, so
 * tasks that already pin a model keep running and share the cooldown and
 * fallback behaviour.
 *
 * @param overrides - The issue's `assigneeAdapterOverrides`.
 * @returns The profile and where it was read from, or null.
 */
export function issueRunProfileFromOverrides(
  overrides:
    | { runProfile?: RunProfile | null; adapterConfig?: Record<string, unknown> | null; useProjectWorkspace?: boolean | null }
    | null
    | undefined,
): { profile: RunProfile; origin: "run_profile" | "legacy_adapter_config" } | null {
  if (!overrides) return null;
  if (overrides.runProfile) return { profile: overrides.runProfile, origin: "run_profile" };
  const model = nonEmptyString(overrides.adapterConfig?.model);
  const effort = LEGACY_EFFORT_KEYS.map((key) => nonEmptyString(overrides.adapterConfig?.[key])).find(Boolean);
  if (!model && !effort) return null;
  return { profile: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, origin: "legacy_adapter_config" };
}

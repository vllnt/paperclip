import { z } from "zod";

/** How a run's wake context picks comments when a thread exceeds `maxComments`. */
export const RUN_CONTEXT_WINDOWS = ["oldest", "newest"] as const;
export type RunContextWindow = (typeof RUN_CONTEXT_WINDOWS)[number];

/** Bounds for each run-context setting. */
export const RUN_CONTEXT_LIMITS = {
  maxComments: { min: 1, max: 200 },
  maxCommentChars: { min: 100, max: 50_000 },
  maxTotalCommentChars: { min: 100, max: 500_000 },
} as const;

/**
 * Effective settings when no level sets a value. These equal the behavior
 * before the settings existed: the first 8 comments, 4,000 characters each,
 * 12,000 in total, cut without a marker.
 */
export const RUN_CONTEXT_DEFAULTS = {
  maxComments: 8,
  maxCommentChars: 4_000,
  maxTotalCommentChars: 12_000,
  window: "oldest",
  truncationMarker: false,
} as const satisfies ResolvedRunContextSettings;

const boundedInt = (limits: { min: number; max: number }) =>
  z.number().int().min(limits.min).max(limits.max);

/** One layer of run-context settings. An omitted field inherits from the less specific layer. */
export const runContextSettingsSchema = z
  .object({
    maxComments: boundedInt(RUN_CONTEXT_LIMITS.maxComments).optional(),
    maxCommentChars: boundedInt(RUN_CONTEXT_LIMITS.maxCommentChars).optional(),
    maxTotalCommentChars: boundedInt(RUN_CONTEXT_LIMITS.maxTotalCommentChars).optional(),
    window: z.enum(RUN_CONTEXT_WINDOWS).optional(),
    truncationMarker: z.boolean().optional(),
  })
  .strict();

/**
 * Run-context policy stored on a company, agent (`runtimeConfig.runContext`)
 * or routine. `byWakeReason` holds the wake-type overrides for that level.
 */
export const runContextPolicySchema = runContextSettingsSchema
  .extend({ byWakeReason: z.record(z.string().min(1), runContextSettingsSchema).optional() })
  .strict();

export type RunContextSettings = z.infer<typeof runContextSettingsSchema>;
export type RunContextPolicy = z.infer<typeof runContextPolicySchema>;
export interface ResolvedRunContextSettings {
  maxComments: number;
  maxCommentChars: number;
  maxTotalCommentChars: number;
  window: RunContextWindow;
  truncationMarker: boolean;
}

/** Policies from least to most specific level; missing or invalid layers are skipped. */
export interface RunContextLayers {
  company?: unknown;
  agent?: unknown;
  routine?: unknown;
}

function parsePolicy(raw: unknown): RunContextPolicy | null {
  const parsed = runContextPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve effective settings. Order, least to most specific: company, agent,
 * routine, then wake-type overrides (`byWakeReason[wakeReason]`, again company
 * to routine). A field set at a more specific layer wins.
 *
 * @param layers Stored policies per level.
 * @param wakeReason The run's wake reason, if any.
 * @returns Fully resolved settings, equal to {@link RUN_CONTEXT_DEFAULTS} when nothing is set.
 */
export function resolveRunContextSettings(
  layers: RunContextLayers,
  wakeReason?: string | null,
): ResolvedRunContextSettings {
  const policies = [layers.company, layers.agent, layers.routine].flatMap((raw) => {
    const policy = parsePolicy(raw);
    return policy ? [policy] : [];
  });
  const ordered: RunContextSettings[] = [
    ...policies,
    ...(wakeReason ? policies.flatMap((policy) => policy.byWakeReason?.[wakeReason] ?? []) : []),
  ];
  const resolved: ResolvedRunContextSettings = { ...RUN_CONTEXT_DEFAULTS };
  for (const layer of ordered) {
    if (layer.maxComments !== undefined) resolved.maxComments = layer.maxComments;
    if (layer.maxCommentChars !== undefined) resolved.maxCommentChars = layer.maxCommentChars;
    if (layer.maxTotalCommentChars !== undefined) resolved.maxTotalCommentChars = layer.maxTotalCommentChars;
    if (layer.window !== undefined) resolved.window = layer.window;
    if (layer.truncationMarker !== undefined) resolved.truncationMarker = layer.truncationMarker;
  }
  return resolved;
}

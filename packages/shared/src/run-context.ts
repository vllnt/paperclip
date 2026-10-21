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

/** Bounds of the issue-history window that a wake's continuation context carries. */
export interface ThreadWindowLimits {
  /** Most comments kept in `messages`, newest first, pinned ones included. */
  maxComments: number;
  /** Characters kept of one comment body that is not pinned. */
  maxCommentChars: number;
  /** Characters of all kept comment bodies together. */
  maxTotalChars: number;
  /** Most older comments listed in the one-line `olderMessages` index. */
  maxIndexEntries: number;
}

/**
 * Default history window: the newest 20 comments, 4,000 characters each and
 * 48,000 in total, plus an index of up to 50 older comments. The comments that
 * woke the run and the latest human request are always kept.
 */
export const THREAD_WINDOW_DEFAULTS = {
  maxComments: 20,
  maxCommentChars: 4_000,
  maxTotalChars: 48_000,
  maxIndexEntries: 50,
} as const satisfies ThreadWindowLimits;

/**
 * Characters of the continuation objective that a wake prompt shows. The
 * envelope keeps the whole objective, because server checks read it.
 */
export const CONTINUATION_OBJECTIVE_MAX_CHARS = 16_000;

/**
 * The first `end` characters of `text`, one fewer when the cut would split a
 * surrogate pair. A lone surrogate is invalid JSON for Postgres `jsonb`.
 *
 * @param text Text to cut.
 * @param end Characters to keep.
 * @returns The prefix, never ending in a high surrogate.
 */
export function sliceWhole(text: string, end: number): string {
  let stop = Math.max(0, Math.min(end, text.length));
  const lastCode = text.charCodeAt(stop - 1);
  if (stop > 0 && stop < text.length && lastCode >= 0xd800 && lastCode <= 0xdbff) stop -= 1;
  return text.slice(0, stop);
}

/**
 * Cut text to `max` characters, never inside a surrogate pair, and say how
 * many characters are left and how to read them.
 *
 * @param text Text to cut.
 * @param max Characters to keep.
 * @param readHint Where the full text is, for example `read comment <id>`.
 * @returns The text, or its cut prefix followed by a `[truncated: …]` line.
 * @example cutText("abcdef", 3, "read comment c1") // "abc\n[truncated: 3 more characters; read comment c1]"
 */
export function cutText(text: string, max: number, readHint: string): string {
  if (text.length <= max) return text;
  const kept = sliceWhole(text, max);
  return `${kept}\n[truncated: ${text.length - kept.length} more characters; ${readHint}]`;
}

const CUT_MARKER = /\n\[truncated: \d+ more characters; [^\n]*\]$/;

/**
 * Whether two copies of one comment body, each possibly cut by
 * {@link cutText} at a different length, hold the same text.
 *
 * @returns True when the bodies are equal, or when the kept text of the cut one is a prefix of the other.
 */
export function sameCutText(a: string, b: string): boolean {
  if (a === b) return true;
  const keptA = a.replace(CUT_MARKER, "");
  const keptB = b.replace(CUT_MARKER, "");
  if (keptA === a && keptB === b) return false;
  return keptA.length <= keptB.length ? keptB.startsWith(keptA) : keptA.startsWith(keptB);
}

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

import { z } from "zod";

/**
 * Tunables for bounded transient-failure retries. Every field is optional; an
 * unset field defers to the next less specific layer, and the final defaults
 * reproduce the behavior from before these settings existed.
 */
export interface TransientRetryPolicyFields {
  /** Max transient retries scheduled per (issue, agent) per rolling hour. 0 = unlimited. */
  perIssuePerHour?: number;
  /** Skip the retry when the issue is already `blocked`. */
  suppressWhenBlocked?: boolean;
}

export interface TransientRetryPolicy extends TransientRetryPolicyFields {
  /** Overrides keyed by wake reason (e.g. `bounded_transient_heartbeat_retry`). */
  wakeTypes?: Record<string, TransientRetryPolicyFields>;
}

export interface ResolvedTransientRetryPolicy {
  perIssuePerHour: number;
  suppressWhenBlocked: boolean;
}

export const TRANSIENT_RETRY_POLICY_DEFAULTS: ResolvedTransientRetryPolicy = {
  perIssuePerHour: 0,
  suppressWhenBlocked: false,
};

const transientRetryPolicyFieldsShape = {
  perIssuePerHour: z.number().int().min(0).max(100).optional(),
  suppressWhenBlocked: z.boolean().optional(),
};

export const transientRetryPolicySchema = z
  .object({
    ...transientRetryPolicyFieldsShape,
    wakeTypes: z.record(z.string().min(1), z.object(transientRetryPolicyFieldsShape).strict()).optional(),
  })
  .strict();

export type ParsedTransientRetryPolicy = z.infer<typeof transientRetryPolicySchema>;

/** Lenient read of a stored JSON value: invalid shapes are ignored, never thrown. */
export function readTransientRetryPolicy(value: unknown): TransientRetryPolicy {
  const parsed = transientRetryPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * Layers ordered least to most specific: company < agent < routine. Wake-type
 * overrides from any layer beat every plain layer value, in the same order.
 */
export function resolveTransientRetryPolicy(
  layers: { company?: unknown; agent?: unknown; routine?: unknown },
  wakeReason: string | null,
): ResolvedTransientRetryPolicy {
  const ordered = [layers.company, layers.agent, layers.routine].map(readTransientRetryPolicy);
  const sources: TransientRetryPolicyFields[] = [
    ...ordered,
    ...(wakeReason ? ordered.map((layer) => layer.wakeTypes?.[wakeReason] ?? {}) : []),
  ];
  const resolved = { ...TRANSIENT_RETRY_POLICY_DEFAULTS };
  for (const source of sources) {
    if (source.perIssuePerHour !== undefined) resolved.perIssuePerHour = source.perIssuePerHour;
    if (source.suppressWhenBlocked !== undefined) resolved.suppressWhenBlocked = source.suppressWhenBlocked;
  }
  return resolved;
}

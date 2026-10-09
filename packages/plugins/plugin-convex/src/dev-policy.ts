import { HOUR_MS, type ConvexDeployment } from "./contracts.js";

const DAY_MS = 24 * HOUR_MS;
/** Shared dev pools that are never deleted, for every company. A company adds its own with `reaper.dev.protect`. */
export const BUILT_IN_PROTECTED = ["dev/paperclip-agents", "dev/local-*", "dev/qa-*"] as const;

export interface DevPolicy { enabled: boolean; maxAgeDays: number; protect: string[]; onlyPatterns: string[]; maxDeletes: number }

/** `*` alone matches everything; a trailing `*` matches a prefix; anything else must match exactly. Case does not matter. */
export function matchesPattern(pattern: string, value: string): boolean {
  const wanted = pattern.toLowerCase();
  const actual = value.toLowerCase();
  if (wanted === "*") return true;
  return wanted.endsWith("*") ? actual.startsWith(wanted.slice(0, -1)) : actual === wanted;
}

export type DevDecision = { delete: true; reason: string } | { delete: false; reason: string };

/**
 * Whether a dev deployment is old enough to delete. The hard delete guard has already ruled out defaults, production-like names and every
 * other type; this adds the shared pools, the company's protect list and allow list, and the age limit.
 */
export function decideDev(deployment: ConvexDeployment, policy: DevPolicy, now: number): DevDecision {
  const values = [deployment.reference, deployment.name].filter((value): value is string => !!value);
  const protectedBy = [...BUILT_IN_PROTECTED, ...policy.protect].find(pattern => values.some(value => matchesPattern(pattern, value)));
  if (protectedBy) return { delete: false, reason: `Protected by "${protectedBy}".` };
  if (policy.onlyPatterns.length && !policy.onlyPatterns.some(pattern => values.some(value => matchesPattern(pattern, value)))) {
    return { delete: false, reason: "Not on this company's dev allow list." };
  }
  const last = deployment.lastDeployTime ?? deployment.createTime;
  if (last === null) return { delete: false, reason: "Its age is unknown, so it was kept." };
  const days = (now - last) / DAY_MS;
  if (days < policy.maxAgeDays) return { delete: false, reason: `Younger than the ${policy.maxAgeDays} day limit (${Math.floor(days)} days since its last deploy).` };
  return { delete: true, reason: `dev deployment unused for ${Math.floor(days)} days (limit ${policy.maxAgeDays})` };
}

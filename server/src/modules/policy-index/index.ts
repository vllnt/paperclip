import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { PolicyIndex } from "@paperclipai/shared";
import { createResolvePolicyIndex, type ResolvePolicyIndexInput } from "./application/resolve-policy-index.js";
import { policyIndexDigestInput } from "./domain/policy-index.js";
import { createInstructionsMentionSource } from "./adapters/instructions-file.js";
import {
  createPostgresIssueMentionSource,
  createPostgresPolicyIndexRows,
  createPostgresSkillMentionSource,
} from "./adapters/postgres.js";
import { sharedMentionScanCache, type MentionScanCache } from "./adapters/scan-cache.js";

export type { ResolvePolicyIndexInput } from "./application/resolve-policy-index.js";
export { mergeMentionedKeys } from "./domain/policy-index.js";

/**
 * Where a task session stores the digest of the policy index it was last told. Server-owned: it is
 * stripped before the session params reach an adapter, and it is never part of the config fingerprint.
 */
export const POLICY_INDEX_SESSION_DIGEST_KEY = "__paperclipPoliciesLastSentDigest";

/** The digest a stored task session was last told, or null when it was never told one. */
export function readPolicyIndexSessionDigest(sessionParams: unknown): string | null {
  if (typeof sessionParams !== "object" || sessionParams === null || Array.isArray(sessionParams)) return null;
  const value = (sessionParams as Record<string, unknown>)[POLICY_INDEX_SESSION_DIGEST_KEY];
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

/** Hex digits kept from the SHA-256 of the index. 128 bits is far past any collision a session could meet. */
const DIGEST_LENGTH = 32;

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, DIGEST_LENGTH);
}

export interface PolicyIndexResolver {
  /** The index for one task. At most one policy query. Never throws for an unreadable mention source. */
  resolve(input: ResolvePolicyIndexInput): Promise<PolicyIndex>;
  /** The index with no policy. Its digest is what a session stores after it was told the list is empty. */
  readonly emptyIndex: PolicyIndex;
}

export function createPolicyIndexResolver(
  db: Db,
  options: {
    scanCache?: MentionScanCache;
    onSourceError?: (source: "issue" | "instructions" | "skills", error: unknown) => void;
  } = {},
): PolicyIndexResolver {
  const cache = options.scanCache ?? sharedMentionScanCache;
  return {
    resolve: createResolvePolicyIndex({
      rows: createPostgresPolicyIndexRows(db),
      sources: {
        issue: createPostgresIssueMentionSource(db),
        instructions: createInstructionsMentionSource(cache),
        skills: createPostgresSkillMentionSource(db, cache),
      },
      digest: digestOf,
      onSourceError: options.onSourceError,
    }),
    emptyIndex: { entries: [], moreCount: 0, digest: digestOf(policyIndexDigestInput([], 0)) },
  };
}

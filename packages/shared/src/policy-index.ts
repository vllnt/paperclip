import { z } from "zod";
import {
  COMPANY_POLICY_KEY_MAX_LENGTH,
  COMPANY_POLICY_SCOPES,
  COMPANY_POLICY_SUMMARY_MAX_LENGTH,
  COMPANY_POLICY_TITLE_MAX_LENGTH,
} from "./constants.js";

/**
 * The policy index is what an agent's prompt carries about policies: one line per policy, never a
 * body. It is guidance only. Nothing in it attaches a limit or a block to a run.
 */

/** At most this many active policies are listed in a prompt. The rest become a "+N more" line. */
export const POLICY_INDEX_MAX_ACTIVE_ENTRIES = 20;
/** Of those, this many slots stay free for policies the task text mentions, so a long company list cannot hide them. */
export const POLICY_INDEX_MENTION_RESERVE = 5;
/** The listed lines together stay under this many characters. */
export const POLICY_INDEX_MAX_CHARS = 4_000;
/** A run follows at most this many distinct `policy://` mentions. Mentions come from low-trust text. */
export const POLICY_INDEX_MAX_MENTIONS = 10;
/** One query reads at most this many active policies. The count of the rest is kept for the "+N more" line. */
export const POLICY_INDEX_QUERY_LIMIT = 100;

export const POLICY_INDEX_ENTRY_STATES = ["active", "not_active"] as const;

const keySchema = z.string().min(1).max(COMPANY_POLICY_KEY_MAX_LENGTH);

const activeEntrySchema = z.object({
  state: z.literal("active"),
  key: keySchema,
  title: z.string().max(COMPANY_POLICY_TITLE_MAX_LENGTH),
  summary: z.string().max(COMPANY_POLICY_SUMMARY_MAX_LENGTH).nullable(),
  /** The scope of the policy itself. */
  scope: z.enum(COMPANY_POLICY_SCOPES),
  /** `scope`: the company's, or the task project's. `mention`: only the task text points at it. */
  via: z.enum(["scope", "mention"]),
});

/** A mentioned key that is a draft, archived or unknown. It names no title: a draft title stays with the board. */
const notActiveEntrySchema = z.object({
  state: z.literal("not_active"),
  key: keySchema,
});

export const policyIndexEntrySchema = z.discriminatedUnion("state", [activeEntrySchema, notActiveEntrySchema]);
export type PolicyIndexEntry = z.infer<typeof policyIndexEntrySchema>;
export type ActivePolicyIndexEntry = z.infer<typeof activeEntrySchema>;

export const policyIndexSchema = z.object({
  /** The server lists at most the capped entries. A longer list is still valid: every render path caps it again. */
  entries: z.array(policyIndexEntrySchema).max(POLICY_INDEX_QUERY_LIMIT + POLICY_INDEX_MAX_MENTIONS),
  /** Active policies that apply but do not fit the cap. */
  moreCount: z.number().int().min(0),
  /** Content hash of the listed entries and `moreCount`. A resumed session gets the index again only when it changes. */
  digest: z.string().min(1).max(128),
});
export type PolicyIndex = z.infer<typeof policyIndexSchema>;

/** What a run's context carries: the index, and the digest the resumed session was last told. */
export const policyIndexContextSchema = policyIndexSchema.extend({
  lastSentDigest: z.string().min(1).max(128).nullable().optional(),
});
export type PolicyIndexContext = z.infer<typeof policyIndexContextSchema>;

/** Reads `context.paperclipPolicies`. Anything that is not a valid index is ignored. */
export function readPolicyIndexContext(value: unknown): PolicyIndexContext | null {
  const parsed = policyIndexContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Board text is one line in a prompt: a newline or a run of spaces would let it look like prompt structure. */
export function toSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function policyIndexScopeLabel(entry: ActivePolicyIndexEntry): string {
  return entry.via === "mention" ? "mentioned" : entry.scope;
}

/** One line of the index. The cap measures this exact text. */
export function renderPolicyIndexEntryLine(entry: PolicyIndexEntry): string {
  if (entry.state === "not_active") {
    return `- \`${entry.key}\`: not active (draft, archived or unknown). Do not apply it.`;
  }
  const title = toSingleLine(entry.title);
  const summary = entry.summary ? toSingleLine(entry.summary) : "";
  const text = summary ? `${title}. ${summary}` : title;
  return `- \`${entry.key}\` (${policyIndexScopeLabel(entry)}): ${text}`;
}

export interface PolicyIndexCapOptions {
  maxActiveEntries?: number;
  mentionReserve?: number;
  maxChars?: number;
}

/**
 * Caps an index by entries and characters. Entries come in display order. Not-active mentions
 * always stay, because a mention is never dropped silently; the mention cap keeps them few.
 * `omitted` counts active policies the caller left out before this call, for the "+N more" line.
 */
export function capPolicyIndexEntries(
  entries: readonly PolicyIndexEntry[],
  omitted = 0,
  options: PolicyIndexCapOptions = {},
): { entries: PolicyIndexEntry[]; moreCount: number } {
  const maxActive = options.maxActiveEntries ?? POLICY_INDEX_MAX_ACTIVE_ENTRIES;
  const reserve = options.mentionReserve ?? POLICY_INDEX_MENTION_RESERVE;
  const maxChars = options.maxChars ?? POLICY_INDEX_MAX_CHARS;

  const active = entries.filter((entry): entry is ActivePolicyIndexEntry => entry.state === "active");
  const notActive = entries.filter((entry) => entry.state === "not_active");
  const scoped = active.filter((entry) => entry.via === "scope");
  const mentioned = active.filter((entry) => entry.via === "mention");

  const keptScoped = scoped.slice(0, Math.max(0, maxActive - Math.min(mentioned.length, reserve)));
  const keptMentioned = mentioned.slice(0, Math.max(0, maxActive - keptScoped.length));

  let usedChars = notActive.reduce((total, entry) => total + renderPolicyIndexEntryLine(entry).length + 1, 0);
  const listed: ActivePolicyIndexEntry[] = [];
  for (const entry of [...keptScoped, ...keptMentioned]) {
    usedChars += renderPolicyIndexEntryLine(entry).length + 1;
    if (usedChars > maxChars) break;
    listed.push(entry);
  }

  return {
    entries: [...listed, ...notActive],
    moreCount: active.length - listed.length + omitted,
  };
}

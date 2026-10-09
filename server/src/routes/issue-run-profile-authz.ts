import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  DEFAULT_RUN_TIER,
  HARNESS_FALLBACK_ADAPTER_TYPES,
  checkHarnessModelCompatibility,
  issueRunProfileFromOverrides,
  resolveRunProfile,
  runProfileSchema,
  type CompanyRunTiers,
  type RunProfile,
} from "@paperclipai/shared";
import { badRequest, forbidden, unprocessable } from "../errors.js";
import { profileUnavailableReason } from "../services/harness-fallback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity, type accessService } from "../services/index.js";

export type RunProfileDenialReason =
  | "tier_not_allowlisted"
  | "explicit_target_not_allowed"
  | "existing_profile_not_agent_set"
  | "not_creator_or_dispatcher";

export type RunProfileChangeDecision =
  | { allowed: true; changed: false }
  | { allowed: true; changed: true; before: RunProfile | null; after: RunProfile | null }
  | { allowed: false; reason: RunProfileDenialReason; before: RunProfile | null; after: RunProfile | null };

interface DecideInput {
  actor: { type: "board" } | { type: "agent"; agentId: string; hasConfigureGrant: boolean };
  tiers: CompanyRunTiers | null;
  /** The issue before the change; null on create. */
  existing: { createdByAgentId: string | null; assigneeAgentId: string | null } | null;
  existingOverrides: unknown;
  /** The overrides in the request: undefined when the request leaves them alone, null to clear. */
  next: unknown;
  creating?: boolean;
  /** The request hands the issue to an agent other than the actor. */
  dispatching?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The effective issue-level profile of an overrides value: runProfile, else the legacy model and effort. */
function profileOf(overrides: unknown): RunProfile | null {
  const record = asRecord(overrides);
  if (!record) return null;
  const parsed = runProfileSchema.safeParse(record.runProfile);
  return (
    issueRunProfileFromOverrides({
      runProfile: parsed.success ? parsed.data : null,
      adapterConfig: asRecord(record.adapterConfig),
    })?.profile ?? null
  );
}

function sameProfile(left: RunProfile | null, right: RunProfile | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Decides whether an actor may change an issue's run profile. A board user may
 * set any compatible profile. An agent may only set a tier on the company's
 * allowlist, on an issue it creates or dispatches, and only over a profile that
 * is empty or itself an allowlisted tier. Clearing a profile counts as the
 * default tier, so an agent can never raise its own tasks above its default.
 *
 * @param input - The actor, the company's tiers, and the issue before and after.
 * @returns Whether the change is allowed, and the profile before and after.
 */
export function decideIssueRunProfileChange(input: DecideInput): RunProfileChangeDecision {
  if (input.next === undefined) return { allowed: true, changed: false };
  const before = profileOf(input.existingOverrides);
  const after = profileOf(input.next);
  if (sameProfile(before, after)) return { allowed: true, changed: false };
  if (input.actor.type === "board" || input.actor.hasConfigureGrant) {
    return { allowed: true, changed: true, before, after };
  }
  const allowlist = new Set(input.tiers?.agentAllowlist ?? []);
  const deny = (reason: RunProfileDenialReason): RunProfileChangeDecision => ({ allowed: false, reason, before, after });

  const nextTier = after === null ? DEFAULT_RUN_TIER : after.tier ?? null;
  if (nextTier === null) return deny("explicit_target_not_allowed");
  if (!allowlist.has(nextTier)) return deny("tier_not_allowlisted");
  if (before !== null && !(before.tier && allowlist.has(before.tier))) return deny("existing_profile_not_agent_set");
  const mine = input.creating === true || input.existing?.createdByAgentId === input.actor.agentId;
  if (!mine && input.dispatching !== true) return deny("not_creator_or_dispatcher");
  return { allowed: true, changed: true, before, after };
}

const DENIAL_MESSAGE: Record<RunProfileDenialReason, string> = {
  tier_not_allowlisted: "Agents may only set the run tiers the company allows agents to set, and never raise their own tasks above the default tier.",
  explicit_target_not_allowed: "Agents may set a run tier by name; an explicit harness, model or effort needs a board user or agents:configure for the assignee.",
  existing_profile_not_agent_set: "This issue's run profile was not set by an agent tier; ask a board user to change it.",
  not_creator_or_dispatcher: "Agents may set a run profile only on issues they create or dispatch.",
};

export interface IssueRunProfileGuardInput {
  db: Db;
  access: Pick<ReturnType<typeof accessService>, "decide">;
  req: Request;
  companyId: string;
  existing: { id: string; createdByAgentId: string | null; assigneeAgentId: string | null; assigneeAdapterOverrides: unknown } | null;
  /** The overrides in the request body; undefined when absent. */
  nextOverrides: unknown;
  /** The assignee after the change. */
  assigneeAgentId: string | null | undefined;
  actorInfo: { actorType: "agent" | "user"; actorId: string; agentId: string | null; runId: string | null; agentApiKeyId: string | null };
}

export interface IssueRunProfileChange {
  changed: boolean;
  before: RunProfile | null;
  after: RunProfile | null;
}

/**
 * Enforces who may set an issue's run profile, and that the profile can run on
 * the assignee: 403 with an activity row for an agent outside its allowance,
 * 400 for an incompatible harness and model, 422 for a harness the assignee
 * has no credentials for.
 *
 * @param input - The request, the issue before the change and the requested overrides.
 * @returns Whether the profile changed, with the profile before and after.
 */
export async function assertCanSetIssueRunProfile(input: IssueRunProfileGuardInput): Promise<IssueRunProfileChange> {
  const unchanged: IssueRunProfileChange = { changed: false, before: null, after: null };
  if (input.nextOverrides === undefined) return unchanged;
  const tiers = (await instanceSettingsService(input.db).getGeneral()).companyRunTiers?.[input.companyId] ?? null;
  const actorAgentId = input.req.actor.type === "agent" ? input.req.actor.agentId ?? null : null;
  const base = {
    tiers,
    existing: input.existing,
    existingOverrides: input.existing?.assigneeAdapterOverrides ?? null,
    next: input.nextOverrides,
    creating: input.existing === null,
    dispatching: Boolean(input.assigneeAgentId && actorAgentId && input.assigneeAgentId !== actorAgentId),
  };
  let decision = decideIssueRunProfileChange({
    ...base,
    actor: actorAgentId ? { type: "agent", agentId: actorAgentId, hasConfigureGrant: false } : { type: "board" },
  });
  if (!decision.allowed && actorAgentId && input.assigneeAgentId) {
    const grant = await input.access.decide({
      actor: input.req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: input.companyId, agentId: input.assigneeAgentId },
      scope: { requiresChangeGrant: true, targetAgentId: input.assigneeAgentId },
    });
    if (grant.allowed) {
      decision = decideIssueRunProfileChange({ ...base, actor: { type: "agent", agentId: actorAgentId, hasConfigureGrant: true } });
    }
  }
  if (!decision.allowed) {
    await logActivity(input.db, {
      companyId: input.companyId,
      ...input.actorInfo,
      action: "issue.run_profile_denied",
      entityType: "issue",
      entityId: input.existing?.id ?? "new",
      issueId: input.existing?.id ?? null,
      details: { reason: decision.reason, before: decision.before, after: decision.after, assigneeAgentId: input.assigneeAgentId ?? null },
    });
    throw forbidden(DENIAL_MESSAGE[decision.reason], {
      code: "run_profile_not_allowed",
      reason: decision.reason,
    });
  }
  if (!decision.changed) return unchanged;
  await assertProfileRunsOnAssignee(input.db, input.companyId, input.assigneeAgentId ?? null, decision.after, tiers);
  return { changed: true, before: decision.before, after: decision.after };
}

async function assertProfileRunsOnAssignee(
  db: Db,
  companyId: string,
  assigneeAgentId: string | null,
  profile: RunProfile | null,
  tiers: CompanyRunTiers | null,
) {
  if (!profile) return;
  const resolved = resolveRunProfile(profile, tiers);
  if (!resolved.ok) throw badRequest(`Unknown run tier "${resolved.tier}"`, { code: "unknown_run_tier" });
  if (!resolved.target || !assigneeAgentId) return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, assigneeAgentId));
  if (!agent || agent.companyId !== companyId) return;
  if (!(HARNESS_FALLBACK_ADAPTER_TYPES as readonly string[]).includes(agent.adapterType)) {
    if (profile.tier || profile.adapterType) {
      throw badRequest("Run profiles apply to claude_local, codex_local and grok_local agents", { code: "run_profile_unsupported_harness" });
    }
    return;
  }
  const adapterType = resolved.target.adapterType ?? agent.adapterType;
  if (resolved.target.model) {
    const compatibility = checkHarnessModelCompatibility(
      { adapterType, model: resolved.target.model },
      { requireKnownVendor: adapterType !== agent.adapterType },
    );
    if (!compatibility.ok) throw badRequest(compatibility.message, { code: compatibility.code, model: compatibility.model });
  }
  const unavailable = profileUnavailableReason(
    { adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig, fallbacks: agent.fallbacks },
    { ...resolved.target, source: "issue_profile" },
  );
  if (unavailable) {
    throw unprocessable(
      `The assignee has no credentials for ${adapterType}. Add a fallback entry for it to the agent first.`,
      { code: "run_profile_target_unconfigured", adapterType },
    );
  }
}

/** Records an applied run profile change with the profile before and after. */
export async function logIssueRunProfileChange(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    change: IssueRunProfileChange;
    actorInfo: IssueRunProfileGuardInput["actorInfo"];
    assigneeAgentId: string | null | undefined;
    /** Set when the profile belongs to a child created by a batch request on `issueId`. */
    childTitle?: string | null;
  },
) {
  if (!input.change.changed) return;
  await logActivity(db, {
    companyId: input.companyId,
    ...input.actorInfo,
    action: "issue.run_profile_updated",
    entityType: "issue",
    entityId: input.issueId,
    issueId: input.issueId,
    details: {
      before: input.change.before,
      after: input.change.after,
      assigneeAgentId: input.assigneeAgentId ?? null,
      ...(input.childTitle !== undefined ? { childTitle: input.childTitle } : {}),
    },
  });
}

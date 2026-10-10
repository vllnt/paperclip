import { isDeepStrictEqual } from "node:util";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

/** The text of the 403 an agent gets for leaving a block that waits for a human. */
export const HUMAN_OWNED_BLOCK_MESSAGE =
  "This block waits for the board; a board user must unblock it or change its owner";

type BlockStateInput = {
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
};

type RequestedBlockChange = {
  status?: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
};

function isHumanOwner(owner: IssueUnblockDescriptor["owner"]): boolean {
  return owner === "board" || "userId" in owner;
}

/**
 * True when the issue is blocked and its unblock descriptor names the board or a
 * person as the owner. Such a block waits for a human, so the agent that is
 * waiting is not the one who may clear it.
 *
 * @param issue - The status and unblock descriptor of the issue as stored.
 * @returns Whether the block waits for a human.
 */
export function isHumanOwnedBlock(issue: BlockStateInput): boolean {
  const descriptor = issue.unblockDescriptor;
  return issue.status === "blocked" && descriptor != null && isHumanOwner(descriptor.owner);
}

/**
 * The SQL form of `!isHumanOwnedBlock`, for the `WHERE` of a write that must not take an issue
 * out of a human-owned block. Putting the rule in the statement makes it atomic with the write:
 * a descriptor that changes after the caller read the issue still stops the write.
 * `issue-human-owned-block.test.ts` checks that it agrees with `isHumanOwnedBlock` for every
 * status and owner.
 *
 * @param columns - The `status` and `unblock_descriptor` columns of the issues table.
 * @returns A condition that is true for every row except a blocked row owned by the board or a person.
 */
export function notHumanOwnedBlockCondition(columns: { status: SQLWrapper; unblockDescriptor: SQLWrapper }): SQL {
  const owner = sql`(${columns.unblockDescriptor} -> 'owner')`;
  return sql`NOT COALESCE(
    ${columns.status} = 'blocked' AND (${owner} = '"board"'::jsonb OR (${owner} -> 'userId') IS NOT NULL),
    false
  )`;
}

/**
 * Who asks for an issue checkout. `issueService.checkout` requires one, so a caller cannot skip
 * the human-owned block rule by leaving the actor out: the code does not compile.
 *
 * - `agent`: an agent that acts through the API. It may not take an issue out of a block that the
 *   board or a person owns.
 * - `board`: a board user. It may, because it is the party that owns such a block.
 * - `system`: platform code that checks out an issue on its own account. It is the exemption from
 *   the rule, so every use is named by a `reason` and can be found by searching for `kind: "system"`.
 *   The only one today is the heartbeat, `HEARTBEAT_CHECKOUT_ACTOR`.
 */
export type IssueCheckoutActor =
  | { kind: "agent"; agentId: string }
  | { kind: "board"; userId: string | null }
  | { kind: "system"; reason: "heartbeat" };

/**
 * The system actor of the heartbeat's checkout of the issue that it wakes an agent for. It keeps
 * the heartbeat's behavior from before the rule: that checkout can still move a board-owned block
 * to `in_progress`. `issue-human-owned-block.test.ts` pins the result.
 */
export const HEARTBEAT_CHECKOUT_ACTOR: IssueCheckoutActor = { kind: "system", reason: "heartbeat" };

/**
 * Whether a checkout by this actor must leave a human-owned block blocked. The switch has no
 * default, so a new kind of actor does not compile until its case is decided here.
 *
 * @param actor - Who asks for the checkout.
 * @returns True for an agent, false for the board and for a named system caller.
 */
export function checkoutKeepsHumanOwnedBlock(actor: IssueCheckoutActor): boolean {
  switch (actor.kind) {
    case "agent":
      return true;
    case "board":
    case "system":
      return false;
  }
}

/**
 * The system caller of the native status projection, the write that carries the decision of a
 * native run onto its issue. It is named so that every use can be found by searching for
 * `kind: "system"`. Unlike the heartbeat's checkout, it is held to the human-owned block rule: an
 * `issueService.update` that names it cannot take an issue out of a block that the board or a
 * person owns, and cannot rewrite its descriptor. The write does not match such a row, and the
 * call resolves with the row as it is.
 */
export type NativeStatusProjectionActor = { kind: "system"; reason: "native_status_projection" };

/**
 * The one value of `NativeStatusProjectionActor`. The native runtime passes it where it writes an
 * issue's status without a person or an agent asking: `status-decision-committer.ts` for the
 * decision of a run, and `native-run-finalizer.ts` when finalization runs out of retries.
 */
export const NATIVE_STATUS_PROJECTION_ACTOR: NativeStatusProjectionActor = {
  kind: "system",
  reason: "native_status_projection",
};

/**
 * Refuses a change by an agent that would leave a human-owned block or rewrite
 * its descriptor: a new status other than `blocked`, or any descriptor that
 * differs from the stored one, including clearing it. Re-sending the same
 * descriptor, or changing other fields, is allowed. Call it with the row as it is
 * locked for the write.
 *
 * @param stored - The status and descriptor of the issue as stored.
 * @param requested - The status and descriptor the caller asks for. A field left undefined is not changed.
 * @throws A 403 when the change would end or rewrite a human-owned block.
 */
export function assertAgentMayChangeBlock(stored: BlockStateInput, requested: RequestedBlockChange): void {
  if (!isHumanOwnedBlock(stored)) return;
  const leavesBlock = requested.status !== undefined && requested.status !== "blocked";
  const rewritesDescriptor =
    requested.unblockDescriptor !== undefined &&
    !isDeepStrictEqual(requested.unblockDescriptor, stored.unblockDescriptor);
  if (leavesBlock || rewritesDescriptor) throw forbidden(HUMAN_OWNED_BLOCK_MESSAGE);
}

/**
 * True when a change hands an existing block to a human. The issue is blocked and
 * is not yet human-owned, and the requested descriptor names the board or a
 * person. The attention feed lists a block only if its transition time is current,
 * so the writer stamps a new time when this is true.
 *
 * @param stored - The status and descriptor of the issue as stored.
 * @param requested - The status and descriptor the caller asks for.
 * @returns Whether ownership of the block moves to a human with this change.
 */
export function handsBlockToHuman(stored: BlockStateInput, requested: RequestedBlockChange): boolean {
  if (stored.status !== "blocked" || isHumanOwnedBlock(stored)) return false;
  if (requested.status !== undefined && requested.status !== "blocked") return false;
  const next = requested.unblockDescriptor;
  return next != null && isHumanOwner(next.owner);
}

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
    causedBy?: { kind: "self_reblock"; runId: string; actorId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}

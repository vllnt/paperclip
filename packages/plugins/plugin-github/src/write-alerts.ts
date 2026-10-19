import { createHash } from "node:crypto";
import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./contracts.js";
import type { FenceStatus } from "./user-authorization.js";

/** The company's one open alert carries this origin kind and the company as its origin ID. */
export const WRITE_ALERT_ORIGIN = `plugin:${PLUGIN_ID}:write-alert` as const;
/** A pause (the fence check cannot pass, so writes are refused) that lasts this long raises an alert. */
export const PAUSE_ALERT_AFTER_MS = 30 * 60_000;
/** A host clock this many seconds away from GitHub's raises an alert. */
export const CLOCK_SKEW_ALERT_SECONDS = 60;
/** After a failed issue write, the next attempt waits this long, by the host's clock (the scheduled job calls every minute). */
const RETRY_AFTER_MS = 5 * 60_000;

const stateKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "identity", stateKey: "write-alert" });
const isOpen = (issue: Issue) => issue.status !== "done" && issue.status !== "cancelled";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the plugin knows about a company's alert. It survives restarts; the issue is written from it. */
type AlertState = {
  /** The administrator who last changed the company's write identity: the alert goes to their inbox. */
  contactUserId?: string;
  /** Writes were switched off by the plugin (drift or a revocation) and are still off. */
  disabled?: { at: string; reason: string; reauthorize: boolean };
  /** Every check since `since` was not ok for a transient reason: writes are refused but nothing was switched off. */
  paused?: { since: string; reason: string };
  /** The `since` of the pause whose `github.fence_paused` activity entry was written: one entry per pause. */
  pauseLogged?: string;
  /** GitHub's clock minus this host's, as the latest fence check measured it. */
  skew?: { since: string; seconds: number };
  issueId?: string;
  /** The signature of the conditions the issue shows; the issue is written only when it differs from what is wanted. */
  shown?: string;
  retryAfter?: string;
};

type Condition =
  | { kind: "disabled"; at: string; reason: string; reauthorize: boolean }
  | { kind: "paused"; since: string; reason: string }
  | { kind: "skew"; since: string; size: string; behind: boolean };

const PRIORITY: Record<Condition["kind"], Issue["priority"]> = { disabled: "critical", paused: "high", skew: "medium" };
const RANK: Issue["priority"][] = ["critical", "high", "medium", "low"];

/** "40 seconds", "12 minutes", "4.5 hours": coarse on purpose, so a clock that drifts a little does not rewrite the issue. */
function skewSize(seconds: number): string {
  const size = Math.abs(seconds);
  if (size < 120) return `${Math.max(10, Math.round(size / 10) * 10)} seconds`;
  if (size < 2 * 3600) return `${Math.round(size / 60)} minutes`;
  return `${(Math.round(size / 360) / 10).toString()} hours`;
}

function commands(companyId: string, steps: Array<[action: string, params: string, note?: string]>) {
  return ["```sh", 'PLUGIN=vllnt.paperclip-github', ...steps.flatMap(([action, params, note]) =>
    [`paperclipai plugin action "$PLUGIN" ${action} -C ${companyId} --params-json '${params}' --json${note ? `   # ${note}` : ""}`]), "```"].join("\n");
}

function render(name: string, companyId: string, conditions: Condition[]): { title: string; description: string; priority: Issue["priority"] } {
  const top = conditions[0]!;
  const title = top.kind === "disabled" ? `GitHub writes are switched OFF for ${name}`
    : top.kind === "paused" ? `GitHub writes are paused for ${name}`
    : `This host's clock is off from GitHub's (${name})`;
  const priority = conditions.map(condition => PRIORITY[condition.kind]).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0]!;
  const enable = [
    commands(companyId, [["write-identity.get", "{}", "read the saved policy"]]),
    commands(companyId, [["write-identity.set", '{"policy": <that policy, with "enabled": true>}', "the save re-checks the fence against GitHub"]]),
  ];
  const sections = conditions.map(condition => {
    if (condition.kind === "disabled") {
      return [
        `## Writes were switched off automatically (${condition.at})`,
        `**Company:** ${name} (\`${companyId}\`)`,
        `**Reason:** ${condition.reason}`,
        "The GitHub plugin turned this company's write identity kill switch off (`enabled: false`) because the check of the GitHub App user failed in a way that can be unsafe (drift from the approved fence, or an authorization GitHub no longer honors). Agents cannot commit, push, comment or merge as the GitHub user until an instance administrator turns writes back on. Reads continue on the App installation. The plugin never turns writes back on by itself, and agents must not work around it: only an administrator can.",
        "### Recovery (instance administrator)",
        ...(condition.reauthorize ? [
          "1. **Re-authorize the GitHub user.** The authorization was revoked or refused. Start the device flow, have the person named in the policy (`userLogin`) enter the code at https://github.com/login/device, then poll until the answer is `authorized` with `\"fence\": {\"ok\": true}`:",
          commands(companyId, [["user-authorization.start", "{}"], ["user-authorization.poll", "{}", "repeat until authorized"]]),
          "2. **Turn writes on.** Save the policy again with `\"enabled\": true`:",
        ] : [
          "1. **Find out what changed.** The reason above names it. Fix it on GitHub (the App installation's repositories or permissions), or, if the change is intended, update `installationRepositories` or `installationPermissions` in the saved policy.",
          "2. **Turn writes on.** Save the policy again with `\"enabled\": true`:",
        ]),
        ...enable,
        "If the check still fails, writes stay off and this issue is updated with the new reason.",
      ].join("\n\n");
    }
    if (condition.kind === "paused") {
      return [
        `## Writes have been paused since ${condition.since}`,
        `**Company:** ${name} (\`${companyId}\`)`,
        `**Reason:** ${condition.reason}`,
        `The GitHub fence check has not passed for more than ${PAUSE_ALERT_AFTER_MS / 60_000} minutes, for a reason that is not drift (GitHub could not be reached, or it answered in a way that does not show the authorization is gone). Writes are refused until a check passes; nothing was switched off, so no policy change is needed. The plugin re-checks on its own, every few minutes at first and then hourly, and resumes by itself once a check passes. A pause that never clears needs a person.`,
        "### What to check (instance administrator)",
        "1. Read the reason above. It names what GitHub answered.",
        "2. The Paperclip host can reach api.github.com, and its clock is right.",
        "3. The GitHub App's credentials still work: a `401` or `incorrect_client_credentials` after a refresh means the App's private key or client secret in the plugin config was rotated or revoked.",
        "4. A `403` or `404` on the user endpoints means the App's installation or permissions changed on GitHub.",
        "5. If the user's authorization itself is gone, re-authorize (`user-authorization.start`, then `user-authorization.poll`).",
        "6. Run the check again now:",
        commands(companyId, [["user-authorization.check", "{}"]]),
      ].join("\n\n");
    }
    return [
      `## This host's clock is ${condition.size} ${condition.behind ? "behind" : "ahead of"} GitHub's (since ${condition.since})`,
      `**Company:** ${name} (\`${companyId}\`)`,
      "GitHub tokens and signed requests follow GitHub's clock, so a host clock this far off can make a valid token look expired or a fresh one look stale. Re-sync the host's clock (chrony `makestep`, or the hypervisor's guest time sync after a VM resume). This alert closes itself once a fence check measures the clock within a minute of GitHub's.",
    ].join("\n\n");
  });
  return { title, priority, description: [
    "_Raised by the GitHub plugin. It updates this issue while the condition lasts and closes it when the condition clears; it never re-enables writes._",
    ...sections,
  ].join("\n\n") };
}

/**
 * A board-visible alert, one open issue per company, for what stops an App-user
 * company's GitHub writes: the plugin switching them off (drift or a confirmed
 * revocation), a pause that lasts, and a host clock far from GitHub's. The
 * conditions are kept in plugin state first and the issue is written from
 * them, so a failed issue write is retried by {@link reconcile} instead of lost.
 * Nothing here ever turns writes back on: that stays an administrator action.
 * Every method resolves: a failure is logged, never thrown into a fence check.
 */
export function createWriteAlerts(ctx: PluginContext, now: () => number = () => Date.now(), githubNow: () => number = now) {
  const queues = new Map<string, Promise<unknown>>();
  function exclusive(companyId: string, operation: () => Promise<void>, what: string): Promise<void> {
    const guarded = async () => {
      try { await operation(); }
      catch (error) { ctx.logger.warn(`GitHub write alert: ${what} failed`, { companyId, error: error instanceof Error ? error.message : "unknown" }); }
    };
    const pending = (queues.get(companyId) ?? Promise.resolve()).then(guarded);
    queues.set(companyId, pending);
    void pending.finally(() => { if (queues.get(companyId) === pending) queues.delete(companyId); });
    return pending;
  }

  async function load(companyId: string): Promise<AlertState> {
    const stored = await ctx.state.get(stateKey(companyId));
    return stored && typeof stored === "object" ? stored as AlertState : {};
  }
  const save = (companyId: string, state: AlertState) => ctx.state.set(stateKey(companyId), state);

  function conditionsOf(state: AlertState): Condition[] {
    const conditions: Condition[] = [];
    if (state.disabled) conditions.push({ kind: "disabled", ...state.disabled });
    if (state.paused && githubNow() - Date.parse(state.paused.since) >= PAUSE_ALERT_AFTER_MS) conditions.push({ kind: "paused", ...state.paused });
    if (state.skew) conditions.push({ kind: "skew", since: state.skew.since, size: skewSize(state.skew.seconds), behind: state.skew.seconds > 0 });
    return conditions;
  }

  /** The company's open alert: the one remembered, else any open one by origin (state lost, or a crash after the create). */
  async function findOpen(companyId: string, issueId: string | undefined): Promise<Issue | null> {
    if (issueId) {
      const remembered = await ctx.issues.get(issueId, companyId);
      if (remembered && isOpen(remembered)) return remembered;
    }
    const listed = await ctx.issues.list({ companyId, originKind: WRITE_ALERT_ORIGIN, originId: companyId, limit: 50 });
    return listed.find(isOpen) ?? null;
  }

  /** Makes the issue show `conditions`: creates it, updates it, or closes it when nothing is left. Returns its ID while open. */
  async function write(companyId: string, state: AlertState, conditions: Condition[], resolution: string): Promise<string | undefined> {
    const open = await findOpen(companyId, state.issueId);
    if (!conditions.length) {
      if (open) await ctx.issues.update(open.id, { status: "done", description: `**Resolved ${new Date(githubNow()).toISOString()}:** ${resolution}.\n\n${open.description ?? ""}` }, companyId);
      return undefined;
    }
    const name = (await ctx.companies.get(companyId))?.name ?? companyId;
    const view = render(name, companyId, conditions);
    if (open) {
      // Whoever the board assigned it to keeps it; only an unassigned alert gets the administrator.
      const assign = !open.assigneeUserId && !open.assigneeAgentId && state.contactUserId ? { assigneeUserId: state.contactUserId } : {};
      await ctx.issues.update(open.id, { ...view, ...assign }, companyId);
      return open.id;
    }
    const alert = { companyId, ...view, status: "todo" as const, originKind: WRITE_ALERT_ORIGIN, originId: companyId };
    try { return (await ctx.issues.create({ ...alert, ...(state.contactUserId ? { assigneeUserId: state.contactUserId } : {}) })).id; }
    catch (error) {
      // An administrator who left the company must not stop the alert: it goes unassigned instead.
      if (!state.contactUserId) throw error;
      ctx.logger.warn("GitHub write alert: could not assign it to the last administrator; creating it unassigned", { companyId, error: error instanceof Error ? error.message : "unknown" });
      return (await ctx.issues.create(alert)).id;
    }
  }

  /**
   * Persists `after` (when it differs from `before`), then brings the issue in line with it when it is not already:
   * `force` skips the backoff that follows a failed issue write.
   */
  async function settle(companyId: string, before: AlertState, wantedState: AlertState, options: { force?: boolean; resolution?: string } = {}): Promise<void> {
    let after = wantedState;
    let saved = JSON.stringify(before);
    const persist = async (state: AlertState) => {
      const text = JSON.stringify(state);
      if (text !== saved) { await save(companyId, state); saved = text; }
    };
    const conditions = conditionsOf(after);
    const wanted = conditions.length ? digest(conditions) : undefined;
    const backoff = !options.force && after.retryAfter !== undefined && Date.parse(after.retryAfter) > now();
    // The conditions are saved before the issue is touched: a failed write below is retried by the next reconcile.
    await persist(after);
    // The pause that reached the threshold is written to the activity log once, however long it lasts.
    const paused = conditions.find(condition => condition.kind === "paused");
    if (paused && after.pauseLogged !== paused.since) {
      try {
        await ctx.activity.log({ companyId, message: "github.fence_paused", metadata: { since: paused.since, reason: paused.reason, pausedMinutes: Math.round((githubNow() - Date.parse(paused.since)) / 60_000), writesDisabled: false } });
        after = { ...after, pauseLogged: paused.since };
        await persist(after);
      } catch (error) {
        ctx.logger.warn("GitHub write alert: could not record the paused fence in the activity log; it will be retried", { companyId, error: error instanceof Error ? error.message : "unknown" });
      }
    }
    if (wanted === after.shown || backoff) return;
    try {
      const issueId = await write(companyId, after, conditions, options.resolution ?? "the conditions below no longer hold");
      await persist({ ...after, issueId, shown: wanted, retryAfter: undefined });
    } catch (error) {
      ctx.logger.warn("GitHub write alert: could not write the alert issue; it will be retried", { companyId, error: error instanceof Error ? error.message : "unknown" });
      await persist({ ...after, retryAfter: new Date(now() + RETRY_AFTER_MS).toISOString() });
    }
  }

  return {
    /** Remembers the administrator who changed the company's write identity; an alert raised later goes to their inbox. */
    contact(companyId: string, userId: string | null | undefined): Promise<void> {
      if (!userId) return Promise.resolve();
      return exclusive(companyId, async () => {
        const state = await load(companyId);
        if (state.contactUserId !== userId) await save(companyId, { ...state, contactUserId: userId });
      }, "recording the administrator");
    },

    /** The plugin just switched the company's writes off. The alert is written now, not at the next check. */
    writesOff(companyId: string, off: { reason: string; reauthorize: boolean }): Promise<void> {
      return exclusive(companyId, async () => {
        const state = await load(companyId);
        const { paused: _paused, ...rest } = state;
        await settle(companyId, state, { ...rest, disabled: { at: new Date(githubNow()).toISOString(), ...off } }, { force: true });
      }, "raising the alert");
    },

    /**
     * What a finished fence check says. A transient failure starts (or continues) a pause, which alerts once it
     * has lasted {@link PAUSE_ALERT_AFTER_MS}; a skew above a minute alerts; a passing check with writes on
     * clears what it can.
     */
    observe(companyId: string, fence: FenceStatus, writesEnabled: boolean): Promise<void> {
      return exclusive(companyId, async () => {
        const state = await load(companyId);
        const next: AlertState = { ...state };
        if (writesEnabled && !fence.ok && fence.transient === true) next.paused = { since: fence.pausedSince ?? state.paused?.since ?? fence.checkedAt, reason: fence.reason ?? "The GitHub fence check could not complete." };
        else delete next.paused;
        const skew = fence.clockSkewSeconds;
        if (typeof skew === "number" && Math.abs(skew) > CLOCK_SKEW_ALERT_SECONDS) next.skew = { since: state.skew?.since ?? fence.checkedAt, seconds: skew };
        else delete next.skew;
        // An administrator turned writes back on and the check passed: the switch-off is over.
        if (fence.ok && writesEnabled) delete next.disabled;
        await settle(companyId, state, next);
      }, "observing the fence check");
    },

    /** Every minute, from the scheduled job: a pause that has now lasted long enough, and an issue write that failed earlier. */
    reconcile(companyId: string): Promise<void> {
      return exclusive(companyId, async () => {
        const state = await load(companyId);
        if (!state.shown && !state.disabled && !state.paused && !state.skew) return;
        await settle(companyId, state, state);
      }, "reconciling");
    },

    /** The company no longer writes as its App user, so nothing here applies: the alert is closed. */
    clear(companyId: string): Promise<void> {
      return exclusive(companyId, async () => {
        const state = await load(companyId);
        const { disabled: _disabled, paused: _paused, skew: _skew, ...rest } = state;
        await settle(companyId, state, rest, { force: true, resolution: "this company no longer writes as its GitHub App user, so the conditions below no longer apply" });
      }, "clearing");
    },
  };
}

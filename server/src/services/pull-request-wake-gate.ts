import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { parseIssueWaitPullRequestUrl } from "@paperclipai/shared";
import { createGitRemoteAuthProvider } from "./git-credentials.js";

/**
 * Pre-wake gate for a wait that explicitly targets one GitHub pull request
 * (`issue wait --pull-request <url>`).
 *
 * Before Paperclip starts a run for such a wait's due check, it reads a cheap
 * fingerprint of that pull request: state, head and base commit, merge
 * conflict, check and commit-status rollup, comment and review counts, and the
 * last update time. It compares the fingerprint with the one the agent's last
 * monitor-check run on the issue started from. When nothing changed, the wake
 * is recorded as skipped and the adapter is not invoked. Any doubt (no company
 * credential, a GitHub error, a timeout, a low rate limit, a pull request that
 * is not open) means "wake". A wait without a pull request target never
 * reaches this gate.
 */

/** Skip reason recorded on the wake request when the pull request did not change. */
export const PULL_REQUEST_UNCHANGED_SKIP_REASON = "heartbeat.pull_request_unchanged";
/** Run context key that holds the fingerprint a run started from. */
export const PULL_REQUEST_FINGERPRINT_CONTEXT_KEY = "pullRequestFingerprint";
/**
 * An unchanged pull request still wakes the agent once this long after its last
 * finished run, so a wait cannot stall for good on a pull request nobody touches.
 */
export const PULL_REQUEST_UNCHANGED_MAX_QUIET_MS = 4 * 60 * 60_000;
/** Hard budget for one gate evaluation: credential plus every GitHub request. */
export const PULL_REQUEST_GATE_BUDGET_MS = 5_000;
/**
 * Budget for starting gates in one scheduler tick. It stops new gates from
 * starting, it does not interrupt one in flight: a gate that starts just before
 * it runs out can still spend its own PULL_REQUEST_GATE_BUDGET_MS, so a tick
 * spends at most about the sum of both on GitHub, plus its database reads.
 */
export const PULL_REQUEST_GATE_TICK_BUDGET_MS = 20_000;
/** A larger GitHub answer means "wake": the gate never buffers an unbounded body. */
export const MAX_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;

const FINGERPRINT_VERSION = 2;
/** Below this many remaining GitHub requests, leave the quota to the agents. */
const RATE_LIMIT_FLOOR = 100;
/** Backoff after a timeout, or a rate limit that names no wait. */
const BACKOFF_FALLBACK_MS = 5 * 60_000;
/** Backoff after GitHub refused or could not serve the request (401, 403, 404, a 5xx, a redirect, a network error). */
const BACKOFF_FAILURE_MS = 15 * 60_000;
/** No header from GitHub can hold the gate off for longer than this. */
const BACKOFF_MAX_MS = 60 * 60_000;
const BACKOFF_MAX_ENTRIES = 1_000;
const PAGE_SIZE = 100;
const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);
const FAILING_STATUS_STATES = new Set(["failure", "error"]);

/** The pull request a wait targets. */
export type PullRequestWaitTarget = { owner: string; repo: string; number: number };

export type PullRequestCheckRollup = "none" | "pending" | "success" | "failure";

export type PullRequestFingerprintEntry = {
  /** `owner/name`, lower case. */
  repo: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** GitHub's `mergeable_state` is `dirty`: the branch conflicts with its base. */
  mergeConflict: boolean;
  headSha: string;
  baseSha: string | null;
  updatedAt: string | null;
  comments: number;
  reviewComments: number;
  reviews: number;
  latestReviewId: number | null;
  checks: PullRequestCheckRollup;
  failingChecks: string[];
  /**
   * The newest check run id. A re-run gets a new id, so a re-run that ends as the run before it
   * did still changes the fingerprint.
   */
  latestCheckRunId: number | null;
  status: string;
  failingStatuses: string[];
  /** The newest commit status id. A status posted again gets a new id, also with the same state. */
  latestStatusId: number | null;
};

export type IssuePullRequestFingerprint = {
  version: typeof FINGERPRINT_VERSION;
  digest: string;
  computedAt: string;
  pullRequest: PullRequestFingerprintEntry;
};

/** What a run and its wake request store: only what the next comparison reads. */
export type StoredPullRequestFingerprint = Pick<IssuePullRequestFingerprint, "version" | "digest" | "computedAt">;

export function toStoredPullRequestFingerprint(fingerprint: IssuePullRequestFingerprint): StoredPullRequestFingerprint {
  return { version: fingerprint.version, digest: fingerprint.digest, computedAt: fingerprint.computedAt };
}

export type PullRequestFingerprintFailure =
  | "github_backoff"
  | "github_credentials_missing"
  | "github_credentials_unavailable"
  | "github_rate_limited"
  | "github_rate_limit_low"
  | "github_request_failed"
  | "github_timeout"
  | "github_response_incomplete"
  | "github_response_too_large";

export type PullRequestWakeGateDeps = {
  fetch?: typeof fetch;
  /** Company-scoped GitHub token; null when the company has none. */
  resolveToken?: (input: {
    companyId: string;
    issueId: string;
    agentId: string;
    pullRequest: PullRequestWaitTarget;
  }) => Promise<string | null>;
  budgetMs?: number;
  /** Budget for starting gates in one scheduler tick; see PULL_REQUEST_GATE_TICK_BUDGET_MS. */
  tickBudgetMs?: number;
};

export type PullRequestWakeGateDecision =
  | {
      outcome: "skip";
      fingerprint: IssuePullRequestFingerprint;
      baselineRunId: string;
      baselineFinishedAt: string;
    }
  | {
      outcome: "wake";
      reason: string;
      /** Recorded on the run so the next wake has a baseline; null when it could not be read. */
      fingerprint: IssuePullRequestFingerprint | null;
    };

const TIMEOUT_BACKOFF = { scope: "company", ms: BACKOFF_FALLBACK_MS } as const;

/**
 * What a failure says about when to try GitHub again. `company`: the credential
 * or the quota is shared by the company's every pull request. `repo`: only this
 * repository is affected, so the company's other pull requests keep being gated.
 */
type GateBackoff = { scope: "company" | "repo"; ms: number };

class FingerprintUnavailable extends Error {
  constructor(
    readonly reason: PullRequestFingerprintFailure,
    message: string,
    readonly backoff?: GateBackoff,
  ) {
    super(message);
  }
}

/**
 * The pull request a monitor explicitly targets (`monitor.pullRequestUrl`),
 * re-validated at gate time: other paths (the issue PATCH, the board's monitor
 * editor, imports, rows written before validation) can also write the policy.
 * Only the canonical github.com URL that `issue wait --pull-request` stores
 * qualifies; anything else (another host, a missing or malformed URL) means
 * "no target", so the wait wakes as usual.
 */
export function readPullRequestWaitTarget(
  monitor: { pullRequestUrl?: string | null } | null | undefined,
): PullRequestWaitTarget | null {
  const url = monitor?.pullRequestUrl;
  if (typeof url !== "string") return null;
  const parsed = parseIssueWaitPullRequestUrl(url);
  if (!parsed || parsed.url !== url) return null;
  return { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
}

/**
 * Key -> epoch ms until which the gate does not call GitHub, after a rate
 * limit, a timeout or a refusal. The key is a company id (the whole company
 * waits) or a company id plus repository (only that repository waits). One slow,
 * limited or misconfigured company or repository then costs at most one budget
 * per backoff, not one per due monitor.
 */
const githubBackoffUntil = new Map<string, number>();

function backoffKey(companyId: string, pullRequest: PullRequestWaitTarget, scope: GateBackoff["scope"]) {
  return scope === "company" ? companyId : `${companyId}/${pullRequest.owner}/${pullRequest.repo}`.toLowerCase();
}

function isBackedOff(companyId: string, pullRequest: PullRequestWaitTarget, nowMs: number) {
  return (
    (githubBackoffUntil.get(backoffKey(companyId, pullRequest, "company")) ?? 0) > nowMs ||
    (githubBackoffUntil.get(backoffKey(companyId, pullRequest, "repo")) ?? 0) > nowMs
  );
}

function backOff(key: string, untilMs: number) {
  githubBackoffUntil.delete(key);
  while (githubBackoffUntil.size >= BACKOFF_MAX_ENTRIES) {
    const oldest = githubBackoffUntil.keys().next().value;
    if (oldest === undefined) break;
    githubBackoffUntil.delete(oldest);
  }
  githubBackoffUntil.set(key, untilMs);
}

/** How long GitHub's headers ask us to wait, never more than BACKOFF_MAX_MS. */
function rateLimitRetryMs(headers: Headers, nowMs: number) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^[0-9]+$/.test(retryAfter)) return Math.min(BACKOFF_MAX_MS, Number(retryAfter) * 1000);
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^[0-9]+$/.test(reset)) return Math.min(BACKOFF_MAX_MS, Math.max(1000, Number(reset) * 1000 - nowMs));
  return BACKOFF_FALLBACK_MS;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parses a JSON body, failing once it passes MAX_GITHUB_RESPONSE_BYTES. */
async function readCappedJson(response: Response): Promise<unknown> {
  const tooLarge = () =>
    new FingerprintUnavailable(
      "github_response_too_large",
      `GitHub answered more than ${MAX_GITHUB_RESPONSE_BYTES} bytes`,
    );
  const declared = response.headers.get("content-length");
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > MAX_GITHUB_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Company-scoped sources only: the managed GitHub connection, then a company
 * secret. The server-environment token is not this company's credential.
 */
async function defaultResolveToken(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; pullRequest: PullRequestWaitTarget },
) {
  const provider = createGitRemoteAuthProvider(
    db,
    input.companyId,
    { issueId: input.issueId, agentId: input.agentId },
    { env: {} },
  );
  const invocation = await provider(`https://github.com/${input.pullRequest.owner}/${input.pullRequest.repo}.git`);
  const token = invocation?.env.GH_TOKEN?.trim();
  return token ? token : null;
}

async function readPullRequestEntry(input: {
  pullRequest: PullRequestWaitTarget;
  token: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<PullRequestFingerprintEntry> {
  const { pullRequest, token, fetchImpl, signal } = input;
  const base = `https://api.github.com/repos/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(pullRequest.repo)}`;
  const get = async (path: string) => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "paperclip",
        },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new FingerprintUnavailable("github_timeout", "GitHub did not answer in time", TIMEOUT_BACKOFF);
      // `redirect: "error"` also lands here: a moved or renamed repository is refused, not followed.
      throw new FingerprintUnavailable(
        "github_request_failed",
        error instanceof Error ? error.message : "GitHub request failed",
        { scope: "repo", ms: BACKOFF_FAILURE_MS },
      );
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    // A 403 with `retry-after` is GitHub's secondary rate limit.
    if (
      response.status === 429 ||
      (response.status === 403 && (remaining === "0" || response.headers.has("retry-after")))
    ) {
      throw new FingerprintUnavailable("github_rate_limited", `GitHub answered ${response.status} (rate limited)`, {
        scope: "company",
        ms: rateLimitRetryMs(response.headers, Date.now()),
      });
    }
    if (!response.ok) {
      // A 401 means the company's credential is not accepted, which holds for all of its
      // repositories. A 403 (no access), a 404 (no such repository) or a 5xx is this repository's.
      throw new FingerprintUnavailable("github_request_failed", `GitHub answered ${response.status} for ${path}`, {
        scope: response.status === 401 ? "company" : "repo",
        ms: BACKOFF_FAILURE_MS,
      });
    }
    if (remaining && /^[0-9]+$/.test(remaining) && Number(remaining) < RATE_LIMIT_FLOOR) {
      throw new FingerprintUnavailable("github_rate_limit_low", `GitHub rate limit is low (${remaining} left)`, {
        scope: "company",
        ms: rateLimitRetryMs(response.headers, Date.now()),
      });
    }
    const hasNextPage = /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "");
    return { body: await readCappedJson(response), hasNextPage };
  };
  const incomplete = (what: string) =>
    new FingerprintUnavailable("github_response_incomplete", `GitHub returned an incomplete ${what}`);

  // Two rounds: the pull request and its reviews, then the checks and statuses
  // of the head commit the first answer names.
  const [pullResponse, reviews] = await Promise.all([
    get(`/pulls/${pullRequest.number}`),
    get(`/pulls/${pullRequest.number}/reviews?per_page=${PAGE_SIZE}`),
  ]);
  const pull = readRecord(pullResponse.body);
  const headSha = readRecord(pull.head).sha;
  const baseSha = readRecord(pull.base).sha;
  const comments = readCount(pull.comments);
  const reviewComments = readCount(pull.review_comments);
  if (typeof headSha !== "string" || !headSha || comments === null || reviewComments === null) {
    throw incomplete("pull request");
  }
  if (!Array.isArray(reviews.body) || reviews.hasNextPage) throw incomplete("review list");
  const encodedSha = encodeURIComponent(headSha);
  const [checkRuns, status] = await Promise.all([
    get(`/commits/${encodedSha}/check-runs?per_page=${PAGE_SIZE}`),
    get(`/commits/${encodedSha}/status?per_page=${PAGE_SIZE}`),
  ]);

  const checkBody = readRecord(checkRuns.body);
  const runs = Array.isArray(checkBody.check_runs) ? checkBody.check_runs.map(readRecord) : null;
  const totalRuns = readCount(checkBody.total_count);
  if (!runs || totalRuns === null || totalRuns > runs.length || checkRuns.hasNextPage) {
    throw incomplete("check run list");
  }
  const failingChecks = runs
    .filter((run) => run.status === "completed" && FAILING_CHECK_CONCLUSIONS.has(String(run.conclusion)))
    .map((run) => String(run.name ?? ""))
    .sort();
  const checks: PullRequestCheckRollup =
    failingChecks.length > 0
      ? "failure"
      : runs.some((run) => run.status !== "completed")
        ? "pending"
        : runs.length > 0
          ? "success"
          : "none";

  const statusBody = readRecord(status.body);
  const statusCount = readCount(statusBody.total_count);
  const statuses = Array.isArray(statusBody.statuses) ? statusBody.statuses.map(readRecord) : null;
  if (
    statusCount === null ||
    typeof statusBody.state !== "string" ||
    !statuses ||
    statusCount > statuses.length ||
    status.hasNextPage
  ) {
    throw incomplete("commit status");
  }
  const failingStatuses = statuses
    .filter((entry) => FAILING_STATUS_STATES.has(String(entry.state)))
    .map((entry) => String(entry.context ?? ""))
    .sort();

  const reviewIds = reviews.body
    .map((review) => readCount(readRecord(review).id))
    .filter((id): id is number => id !== null);
  const latestId = (records: Record<string, unknown>[]) => {
    const ids = records.map((record) => readCount(record.id)).filter((id): id is number => id !== null);
    return ids.length > 0 ? Math.max(...ids) : null;
  };

  return {
    repo: `${pullRequest.owner}/${pullRequest.repo}`.toLowerCase(),
    number: pullRequest.number,
    state: pull.merged === true || typeof pull.merged_at === "string"
      ? "merged"
      : pull.state === "closed" ? "closed" : "open",
    draft: pull.draft === true,
    mergeConflict: pull.mergeable_state === "dirty",
    headSha,
    baseSha: typeof baseSha === "string" && baseSha ? baseSha : null,
    updatedAt: typeof pull.updated_at === "string" ? pull.updated_at : null,
    comments,
    reviewComments,
    reviews: reviews.body.length,
    latestReviewId: reviewIds.length > 0 ? Math.max(...reviewIds) : null,
    checks,
    failingChecks,
    latestCheckRunId: latestId(runs),
    // GitHub reports "pending" for a commit with no statuses at all.
    status: statusCount === 0 ? "none" : statusBody.state,
    failingStatuses,
    latestStatusId: latestId(statuses),
  };
}

export function fingerprintDigest(entry: PullRequestFingerprintEntry) {
  return `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`;
}

/**
 * Reads the fingerprint of the targeted pull request within one hard budget.
 * Never throws: every failure is a reason to wake.
 */
export async function computeIssuePullRequestFingerprint(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; pullRequest: PullRequestWaitTarget },
  deps: PullRequestWakeGateDeps = {},
): Promise<
  | { ok: true; fingerprint: IssuePullRequestFingerprint }
  | { ok: false; reason: PullRequestFingerprintFailure; detail: string }
> {
  const fail = (reason: PullRequestFingerprintFailure, detail: string) => ({ ok: false as const, reason, detail });
  if (isBackedOff(input.companyId, input.pullRequest, Date.now())) {
    return fail("github_backoff", "GitHub was rate limited, slow or refused this company or repository recently");
  }

  const fetchImpl = deps.fetch ?? fetch;
  const resolveToken = deps.resolveToken ?? ((tokenInput) => defaultResolveToken(db, tokenInput));
  const budgetMs = deps.budgetMs ?? PULL_REQUEST_GATE_BUDGET_MS;
  const controller = new AbortController();
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    budgetTimer = setTimeout(() => {
      controller.abort();
      reject(
        new FingerprintUnavailable(
          "github_timeout",
          `The pull request check took longer than ${budgetMs} ms`,
          TIMEOUT_BACKOFF,
        ),
      );
    }, budgetMs);
  });
  const read = async () => {
    let token: string | null;
    try {
      token = await resolveToken(input);
    } catch (error) {
      throw new FingerprintUnavailable(
        "github_credentials_unavailable",
        error instanceof Error ? error.message : "The GitHub credential could not be resolved",
      );
    }
    if (!token) throw new FingerprintUnavailable("github_credentials_missing", "No company GitHub credential is configured");
    return readPullRequestEntry({
      pullRequest: input.pullRequest,
      token,
      fetchImpl,
      signal: controller.signal,
    });
  };
  try {
    const entry = await Promise.race([read(), budget]);
    return {
      ok: true,
      fingerprint: {
        version: FINGERPRINT_VERSION,
        digest: fingerprintDigest(entry),
        computedAt: new Date().toISOString(),
        pullRequest: entry,
      },
    };
  } catch (error) {
    if (error instanceof FingerprintUnavailable) {
      if (error.backoff) {
        backOff(backoffKey(input.companyId, input.pullRequest, error.backoff.scope), Date.now() + error.backoff.ms);
      }
      return fail(error.reason, error.message);
    }
    return fail("github_request_failed", error instanceof Error ? error.message : "Unknown error");
  } finally {
    clearTimeout(budgetTimer);
    controller.abort();
  }
}

type BaselineRun = {
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  wakeReason: string | null;
  fingerprint: unknown;
  /** Comments on the issue by anyone but this agent since the run started. */
  newCommentsSinceStart?: boolean;
};

/**
 * The agent's most recent run on the issue, with the fingerprint it started
 * from. The candidates come from the heartbeat_runs_company_issue_or_task_idx
 * expression in a materialized CTE with no ORDER BY or LIMIT: with them, the
 * planner may walk the company's newest runs instead and read (detoast) the
 * context of every run it passes, which for an issue whose runs are all old
 * means thousands of buffers. Only the one chosen row's context is read.
 */
async function readBaselineRun(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<BaselineRun | null> {
  const latestRunId = sql`(
    with candidate as materialized (
      select ${heartbeatRuns.id} as id, ${heartbeatRuns.createdAt} as created_at
      from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${input.companyId}
        and (coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')) = ${input.issueId}
        and ${heartbeatRuns.agentId} = ${input.agentId}
    )
    select id from candidate order by created_at desc, id desc limit 1
  )`;
  const baseline = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      wakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`,
      fingerprint: sql<unknown>`${heartbeatRuns.contextSnapshot} -> ${PULL_REQUEST_FINGERPRINT_CONTEXT_KEY}`,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, latestRunId))
    .then((rows) => rows[0] ?? null);
  if (!baseline?.startedAt) return baseline;
  // A comment that someone else left after the run started is new input for the agent.
  const newComment = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        gt(issueComments.createdAt, baseline.startedAt),
        isNull(issueComments.deletedAt),
        sql`${issueComments.authorAgentId} is distinct from ${input.agentId}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return { ...baseline, newCommentsSinceStart: Boolean(newComment) };
}

/**
 * Pure rule: skip only when the pull request is still open, and the agent's
 * last run on the issue was a monitor check that succeeded, started from this
 * exact fingerprint (read before the run started, so nothing that changed
 * during the run counts as seen), saw no newer comment from anyone else, and
 * finished within the quiet period.
 */
export function decidePullRequestWake(input: {
  current: IssuePullRequestFingerprint;
  baseline: BaselineRun | null;
  now: Date;
}): { skip: true; baselineFinishedAt: Date } | { skip: false; reason: string } {
  const { baseline, current } = input;
  // A closed or merged pull request cannot change further, so a wait on it is
  // about something else (a deploy, a release): never skip it.
  if (current.pullRequest.state !== "open") return { skip: false, reason: "pull_request_not_open" };
  if (!baseline) return { skip: false, reason: "no_previous_run" };
  if (baseline.status !== "succeeded") return { skip: false, reason: "previous_run_not_succeeded" };
  // Another wake (a comment, an assignment) merged into that run took it over.
  if (baseline.wakeReason !== "issue_monitor_due") return { skip: false, reason: "previous_run_not_a_monitor_check" };
  if (baseline.newCommentsSinceStart) return { skip: false, reason: "new_comment_since_previous_run" };
  const previous = readRecord(baseline.fingerprint);
  if (previous.version !== FINGERPRINT_VERSION || typeof previous.digest !== "string") {
    return { skip: false, reason: "previous_run_without_fingerprint" };
  }
  const computedAtMs = typeof previous.computedAt === "string" ? Date.parse(previous.computedAt) : Number.NaN;
  if (!baseline.startedAt || !Number.isFinite(computedAtMs) || computedAtMs > baseline.startedAt.getTime()) {
    // The fingerprint reached a run that had already started (a wake merged into
    // a live run), so that run may never have seen this state.
    return { skip: false, reason: "fingerprint_newer_than_previous_run" };
  }
  if (previous.digest !== current.digest) return { skip: false, reason: "pull_request_changed" };
  if (!baseline.finishedAt || input.now.getTime() - baseline.finishedAt.getTime() > PULL_REQUEST_UNCHANGED_MAX_QUIET_MS) {
    return { skip: false, reason: "quiet_period_elapsed" };
  }
  return { skip: true, baselineFinishedAt: baseline.finishedAt };
}

/** Fingerprints the targeted pull request and decides whether the wake may skip. */
export async function evaluatePullRequestWakeGate(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; pullRequest: PullRequestWaitTarget },
  deps: PullRequestWakeGateDeps = {},
): Promise<PullRequestWakeGateDecision> {
  const computed = await computeIssuePullRequestFingerprint(db, input, deps);
  if (!computed.ok) return { outcome: "wake", reason: computed.reason, fingerprint: null };
  const baseline = await readBaselineRun(db, input);
  const decision = decidePullRequestWake({ current: computed.fingerprint, baseline, now: new Date() });
  if (decision.skip && baseline) {
    return {
      outcome: "skip",
      fingerprint: computed.fingerprint,
      baselineRunId: baseline.id,
      baselineFinishedAt: decision.baselineFinishedAt.toISOString(),
    };
  }
  return {
    outcome: "wake",
    reason: decision.skip ? "no_previous_run" : decision.reason,
    fingerprint: computed.fingerprint,
  };
}

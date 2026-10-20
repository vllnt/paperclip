import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueWorkProducts, type Db } from "@paperclipai/db";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
} from "./github-pull-request-merge.js";
import { linkedWorkProductCondition } from "./work-product-visibility.js";

/**
 * Pre-wake gate for wakes that only re-check a linked GitHub pull request.
 *
 * Before Paperclip starts a run for such a wake, it reads a cheap fingerprint of
 * every pull request linked to the issue as a work product: head commit, state,
 * check and commit-status rollup, comment and review counts, and the last update
 * time. It compares that fingerprint with the one the agent's last run on the
 * issue started from. When nothing changed, the wake is recorded as skipped and
 * the adapter is not invoked. Any doubt (no linked pull request, no company
 * credential, a GitHub error, a timeout or a low rate limit) means "wake".
 */

/** Skip reason recorded on the wake request when the pull request did not change. */
export const PULL_REQUEST_UNCHANGED_SKIP_REASON = "heartbeat.pull_request_unchanged";
/** Run context key that holds the fingerprint a run started from. */
export const PULL_REQUEST_FINGERPRINT_CONTEXT_KEY = "pullRequestFingerprint";
/**
 * An unchanged pull request still wakes the agent once this long after its last
 * finished run, so a wait that is about something outside the pull request
 * cannot stall for good.
 */
export const PULL_REQUEST_UNCHANGED_MAX_QUIET_MS = 4 * 60 * 60_000;
/** Hard budget for one gate evaluation: credential plus every GitHub request. */
export const PULL_REQUEST_GATE_BUDGET_MS = 5_000;

const FINGERPRINT_VERSION = 1;
/** More linked pull requests than this means "wake": the gate stays cheap. */
const MAX_LINKED_PULL_REQUESTS = 3;
/** Below this many remaining GitHub requests, leave the quota to the agents. */
const RATE_LIMIT_FLOOR = 100;
const BACKOFF_FALLBACK_MS = 5 * 60_000;
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

export type PullRequestCheckRollup = "none" | "pending" | "success" | "failure";

export type PullRequestFingerprintEntry = {
  /** `owner/name`, lower case. */
  repo: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  updatedAt: string | null;
  comments: number;
  reviewComments: number;
  reviews: number;
  latestReviewId: number | null;
  checks: PullRequestCheckRollup;
  failingChecks: string[];
  status: string;
};

export type IssuePullRequestFingerprint = {
  version: typeof FINGERPRINT_VERSION;
  digest: string;
  computedAt: string;
  pullRequests: PullRequestFingerprintEntry[];
};

export type PullRequestFingerprintFailure =
  | "no_linked_pull_request"
  | "too_many_linked_pull_requests"
  | "github_backoff"
  | "github_credentials_missing"
  | "github_credentials_unavailable"
  | "github_rate_limited"
  | "github_rate_limit_low"
  | "github_request_failed"
  | "github_timeout"
  | "github_response_incomplete";

export type PullRequestWakeGateDeps = {
  fetch?: typeof fetch;
  /** Company-scoped GitHub token; null when the company has none. */
  resolveToken?: (input: {
    companyId: string;
    issueId: string;
    agentId: string;
    reference: GitHubPullRequestReference;
  }) => Promise<string | null>;
  budgetMs?: number;
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

class FingerprintUnavailable extends Error {
  constructor(
    readonly reason: PullRequestFingerprintFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * companyId -> epoch ms until which the gate does not call GitHub for that
 * company, after a rate limit or a timeout. One slow or limited company then
 * costs at most one budget per backoff, not one per due monitor.
 */
const githubBackoffUntil = new Map<string, number>();

function backOff(companyId: string, untilMs: number) {
  githubBackoffUntil.delete(companyId);
  while (githubBackoffUntil.size >= BACKOFF_MAX_ENTRIES) {
    const oldest = githubBackoffUntil.keys().next().value;
    if (oldest === undefined) break;
    githubBackoffUntil.delete(oldest);
  }
  githubBackoffUntil.set(companyId, untilMs);
}

function rateLimitRetryMs(headers: Headers, nowMs: number) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^[0-9]+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^[0-9]+$/.test(reset)) return Math.max(1000, Number(reset) * 1000 - nowMs);
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

/** The GitHub pull requests linked to the issue as work products (unlinked ones excluded). */
export async function listLinkedGitHubPullRequests(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<GitHubPullRequestReference[]> {
  const rows = await db
    .select({ url: issueWorkProducts.url, metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, input.companyId),
        eq(issueWorkProducts.issueId, input.issueId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
        linkedWorkProductCondition(),
      ),
    );
  const references = new Map<string, GitHubPullRequestReference>();
  for (const row of rows) {
    const metadata = readRecord(row.metadata);
    const shorthand =
      typeof metadata.repo === "string" && typeof metadata.number === "number"
        ? `${metadata.repo}#${metadata.number}`
        : null;
    const [reference] = extractGitHubPullRequestReferences([row.url, shorthand]);
    if (!reference) continue;
    const key = `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
    if (!references.has(key)) references.set(key, reference);
  }
  return [...references.values()];
}

/**
 * Company-scoped sources only: the managed GitHub connection, then a company
 * secret. The server-environment token is not this company's credential.
 */
async function defaultResolveToken(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; reference: GitHubPullRequestReference },
) {
  const provider = createGitRemoteAuthProvider(
    db,
    input.companyId,
    { issueId: input.issueId, agentId: input.agentId },
    { env: {} },
  );
  const invocation = await provider(`https://github.com/${input.reference.owner}/${input.reference.repo}.git`);
  const token = invocation?.env.GH_TOKEN?.trim();
  return token ? token : null;
}

async function readPullRequestEntry(input: {
  reference: GitHubPullRequestReference;
  token: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  onRateLimit: (headers: Headers) => void;
}): Promise<PullRequestFingerprintEntry> {
  const { reference, token, fetchImpl, signal } = input;
  const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
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
      if (signal.aborted) throw new FingerprintUnavailable("github_timeout", "GitHub did not answer in time");
      throw new FingerprintUnavailable(
        "github_request_failed",
        error instanceof Error ? error.message : "GitHub request failed",
      );
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 429 || (response.status === 403 && remaining === "0")) {
      input.onRateLimit(response.headers);
      throw new FingerprintUnavailable("github_rate_limited", `GitHub answered ${response.status} (rate limited)`);
    }
    if (!response.ok) {
      throw new FingerprintUnavailable("github_request_failed", `GitHub answered ${response.status} for ${path}`);
    }
    if (remaining && /^[0-9]+$/.test(remaining) && Number(remaining) < RATE_LIMIT_FLOOR) {
      input.onRateLimit(response.headers);
      throw new FingerprintUnavailable("github_rate_limit_low", `GitHub rate limit is low (${remaining} left)`);
    }
    const hasNextPage = /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "");
    return { body: (await response.json()) as unknown, hasNextPage };
  };
  const incomplete = (what: string) =>
    new FingerprintUnavailable("github_response_incomplete", `GitHub returned an incomplete ${what}`);

  // Two rounds: the pull request and its reviews, then the checks and statuses
  // of the head commit the first answer names.
  const [pullResponse, reviews] = await Promise.all([
    get(`/pulls/${reference.number}`),
    get(`/pulls/${reference.number}/reviews?per_page=${PAGE_SIZE}`),
  ]);
  const pull = readRecord(pullResponse.body);
  const headSha = readRecord(pull.head).sha;
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
  if (statusCount === null || typeof statusBody.state !== "string") throw incomplete("commit status");

  const reviewIds = reviews.body
    .map((review) => readCount(readRecord(review).id))
    .filter((id): id is number => id !== null);

  return {
    repo: `${reference.owner}/${reference.repo}`.toLowerCase(),
    number: reference.number,
    state: pull.merged === true || typeof pull.merged_at === "string"
      ? "merged"
      : pull.state === "closed" ? "closed" : "open",
    draft: pull.draft === true,
    headSha,
    updatedAt: typeof pull.updated_at === "string" ? pull.updated_at : null,
    comments,
    reviewComments,
    reviews: reviews.body.length,
    latestReviewId: reviewIds.length > 0 ? Math.max(...reviewIds) : null,
    checks,
    failingChecks,
    // GitHub reports "pending" for a commit with no statuses at all.
    status: statusCount === 0 ? "none" : statusBody.state,
  };
}

export function fingerprintDigest(entries: readonly PullRequestFingerprintEntry[]) {
  const ordered = [...entries].sort((a, b) =>
    a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1,
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(ordered)).digest("hex")}`;
}

/**
 * Reads the fingerprint of every pull request linked to the issue within one
 * hard budget. Never throws: every failure is a reason to wake.
 */
export async function computeIssuePullRequestFingerprint(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
  deps: PullRequestWakeGateDeps = {},
): Promise<
  | { ok: true; fingerprint: IssuePullRequestFingerprint }
  | { ok: false; reason: PullRequestFingerprintFailure; detail: string }
> {
  const fail = (reason: PullRequestFingerprintFailure, detail: string) => ({ ok: false as const, reason, detail });
  let references: GitHubPullRequestReference[];
  try {
    references = await listLinkedGitHubPullRequests(db, input);
  } catch (error) {
    return fail("github_request_failed", error instanceof Error ? error.message : "Linked pull requests unreadable");
  }
  if (references.length === 0) return fail("no_linked_pull_request", "The issue has no linked GitHub pull request");
  if (references.length > MAX_LINKED_PULL_REQUESTS) {
    return fail("too_many_linked_pull_requests", `The issue links ${references.length} pull requests`);
  }
  if ((githubBackoffUntil.get(input.companyId) ?? 0) > Date.now()) {
    return fail("github_backoff", "GitHub was rate limited or slow for this company recently");
  }

  const fetchImpl = deps.fetch ?? fetch;
  const resolveToken = deps.resolveToken ?? ((tokenInput) => defaultResolveToken(db, tokenInput));
  const budgetMs = deps.budgetMs ?? PULL_REQUEST_GATE_BUDGET_MS;
  const controller = new AbortController();
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    budgetTimer = setTimeout(() => {
      controller.abort();
      reject(new FingerprintUnavailable("github_timeout", `The pull request check took longer than ${budgetMs} ms`));
    }, budgetMs);
  });
  const read = async () => {
    let token: string | null;
    try {
      // GitHub credentials are company-wide here; one resolution serves every linked pull request.
      token = await resolveToken({ ...input, reference: references[0]! });
    } catch (error) {
      throw new FingerprintUnavailable(
        "github_credentials_unavailable",
        error instanceof Error ? error.message : "The GitHub credential could not be resolved",
      );
    }
    if (!token) throw new FingerprintUnavailable("github_credentials_missing", "No company GitHub credential is configured");
    return Promise.all(
      references.map((reference) =>
        readPullRequestEntry({
          reference,
          token,
          fetchImpl,
          signal: controller.signal,
          onRateLimit: (headers) => backOff(input.companyId, Date.now() + rateLimitRetryMs(headers, Date.now())),
        }),
      ),
    );
  };
  try {
    const entries = await Promise.race([read(), budget]);
    return {
      ok: true,
      fingerprint: {
        version: FINGERPRINT_VERSION,
        digest: fingerprintDigest(entries),
        computedAt: new Date().toISOString(),
        pullRequests: entries,
      },
    };
  } catch (error) {
    if (error instanceof FingerprintUnavailable) {
      if (error.reason === "github_timeout") backOff(input.companyId, Date.now() + BACKOFF_FALLBACK_MS);
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
  fingerprint: unknown;
};

/**
 * The agent's most recent run on the issue, with the fingerprint it started
 * from. The inner select uses the heartbeat_runs_company_issue_or_task_idx
 * expression and reads no context; only the one chosen row's context is read.
 */
async function readBaselineRun(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<BaselineRun | null> {
  const latestRunId = db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`(coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')) = ${input.issueId}`,
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1);
  return db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      fingerprint: sql<unknown>`${heartbeatRuns.contextSnapshot} -> ${PULL_REQUEST_FINGERPRINT_CONTEXT_KEY}`,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, sql`(${latestRunId})`))
    .then((rows) => rows[0] ?? null);
}

/**
 * Pure rule: skip only when the agent's last run on the issue succeeded, started
 * from this exact fingerprint (read before the run started, so nothing that
 * changed during the run counts as seen), and finished within the quiet period.
 */
export function decidePullRequestWake(input: {
  current: IssuePullRequestFingerprint;
  baseline: BaselineRun | null;
  now: Date;
}): { skip: true; baselineFinishedAt: Date } | { skip: false; reason: string } {
  const { baseline, current } = input;
  if (!baseline) return { skip: false, reason: "no_previous_run" };
  if (baseline.status !== "succeeded") return { skip: false, reason: "previous_run_not_succeeded" };
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

/** Fingerprints the issue's linked pull requests and decides whether the wake may skip. */
export async function evaluatePullRequestWakeGate(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
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

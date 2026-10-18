/** Poll cadence while a run is live or expected on the open issue. */
export const LIVE_RUN_FAST_POLL_MS = 1_000;

/** Cadence for browser-session discovery while a run is live or expected. */
export const TASK_BROWSER_ACTIVE_POLL_MS = 3_000;

/**
 * Safety-net cadence while nothing is running on the open issue. Live events
 * deliver run changes first; this only covers a missed event.
 */
export const LIVE_RUN_IDLE_POLL_MS = 15_000;

interface PolledRunList {
  state: { data: readonly unknown[] | undefined };
}

interface PolledBrowserList {
  state: { data: ReadonlyArray<{ status: string }> | undefined };
}

interface RunExpectationIssue {
  id: string;
  status: string;
  executionRunId?: string | null;
}

/** Browser session states that end the session; every other state is still changing. */
const SETTLED_BROWSER_STATUSES: ReadonlySet<string> = new Set(["closed", "failed"]);

/**
 * Tells whether a run is running or about to start on the open issue. This is
 * the single source for the "run expected" flag that every polled query of the
 * issue page takes, so the call sites cannot drift apart.
 *
 * A run counts as expected when the issue holds an execution run, is
 * `in_progress`, or the company live-runs list (kept current by live events,
 * which carry no `issueId` for a queued run) holds a queued or running run
 * for this issue. The last case covers a first run started by an agent that is
 * not the assignee.
 *
 * @param issue - The open issue, or nullish while it loads.
 * @param companyLiveRuns - The company's queued and running runs.
 * @returns True when the fast cadence applies.
 */
export function isRunExpectedOnIssue(
  issue: RunExpectationIssue | null | undefined,
  companyLiveRuns: ReadonlyArray<{ issueId?: string | null }> | null | undefined,
): boolean {
  if (!issue) return false;
  if (issue.executionRunId || issue.status === "in_progress") return true;
  return (companyLiveRuns ?? []).some((run) => run.issueId === issue.id);
}

/**
 * Builds a `refetchInterval` for an issue's live-runs query.
 *
 * Every observer of one query key shares the shortest interval among them: the
 * key polls fast while any observer wants it fast. Observers that must agree
 * should take their flag from `isRunExpectedOnIssue`.
 *
 * @param runExpected - True when the issue is in a state where a run is
 * running or about to start (for example `in_progress` or a set execution run).
 * @param activeMs - Cadence while a run is live or expected.
 * @returns A function that returns `activeMs` while the cached list is
 * non-empty or a run is expected, and `LIVE_RUN_IDLE_POLL_MS` otherwise.
 * @example
 * useQuery({ queryKey, queryFn, refetchInterval: liveRunsRefetchInterval(false) });
 */
export function liveRunsRefetchInterval(
  runExpected: boolean,
  activeMs: number = LIVE_RUN_FAST_POLL_MS,
): (query: PolledRunList) => number {
  return (query) => {
    const hasLiveRuns = (query.state.data?.length ?? 0) > 0;
    return hasLiveRuns || runExpected ? activeMs : LIVE_RUN_IDLE_POLL_MS;
  };
}

/**
 * Builds a `refetchInterval` for an issue's browser-session list. No live event
 * reports browser sessions, so polling is the only way to see a new one. A new
 * session can only appear while a run is active, and a visible session needs
 * its status kept fresh.
 *
 * @param runExpected - True while a run is live or expected on the issue.
 * @returns A function that returns `TASK_BROWSER_ACTIVE_POLL_MS` while a run is
 * expected or any listed session has not ended (`starting`, `running`, `idle`
 * or `stopping`), and `LIVE_RUN_IDLE_POLL_MS` otherwise.
 */
export function taskBrowsersRefetchInterval(
  runExpected: boolean,
): (query: PolledBrowserList) => number {
  return (query) => {
    const hasLiveBrowser = (query.state.data ?? []).some(
      (browser) => !SETTLED_BROWSER_STATUSES.has(browser.status),
    );
    return runExpected || hasLiveBrowser ? TASK_BROWSER_ACTIVE_POLL_MS : LIVE_RUN_IDLE_POLL_MS;
  };
}

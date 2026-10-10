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

/**
 * Builds a `refetchInterval` for an issue's live-runs query.
 *
 * Every observer of one query key shares the shortest interval among them, so
 * all observers of the key must use this helper or the shortest unconditional
 * one wins.
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
 * expected or a running or idle session is listed, and `LIVE_RUN_IDLE_POLL_MS`
 * otherwise.
 */
export function taskBrowsersRefetchInterval(
  runExpected: boolean,
): (query: PolledBrowserList) => number {
  return (query) => {
    const hasLiveBrowser = (query.state.data ?? []).some(
      (browser) => browser.status === "running" || browser.status === "idle",
    );
    return runExpected || hasLiveBrowser ? TASK_BROWSER_ACTIVE_POLL_MS : LIVE_RUN_IDLE_POLL_MS;
  };
}

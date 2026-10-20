/**
 * A fake GitHub REST API for one pull request, for the unchanged-pull-request
 * wake gate. Tests change `state` between monitor ticks and read `calls`.
 */
export type FakePullRequestState = {
  headSha: string;
  prState: "open" | "closed";
  merged: boolean;
  updatedAt: string;
  comments: number;
  reviewComments: number;
  reviewIds: number[];
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  statusState: string;
  statusCount: number;
  /** Answer every request with this HTTP status instead. */
  failWithStatus?: number;
  /** Never answer; resolve only when the caller aborts. */
  hang?: boolean;
};

export function defaultFakePullRequestState(): FakePullRequestState {
  return {
    headSha: "1111111111111111111111111111111111111111",
    prState: "open",
    merged: false,
    updatedAt: "2026-04-11T12:00:00Z",
    comments: 2,
    reviewComments: 1,
    reviewIds: [101],
    checkRuns: [{ name: "test", status: "in_progress", conclusion: null }],
    statusState: "pending",
    statusCount: 1,
  };
}

export function createFakeGitHubPullRequestApi(input: { owner: string; repo: string; number: number }) {
  const state: FakePullRequestState = defaultFakePullRequestState();
  const calls: string[] = [];
  const base = `/repos/${input.owner}/${input.repo}`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
    });
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    calls.push(`${parsed.pathname}${parsed.search}`);
    if (state.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (state.failWithStatus) return json({ message: "fake failure" }, state.failWithStatus);
    const path = parsed.pathname;
    if (path === `${base}/pulls/${input.number}`) {
      return json({
        number: input.number,
        state: state.prState,
        merged: state.merged,
        merged_at: state.merged ? state.updatedAt : null,
        draft: false,
        updated_at: state.updatedAt,
        comments: state.comments,
        review_comments: state.reviewComments,
        head: { sha: state.headSha, ref: "feature" },
      });
    }
    if (path === `${base}/pulls/${input.number}/reviews`) {
      return json(state.reviewIds.map((id) => ({ id, state: "COMMENTED" })));
    }
    if (path === `${base}/commits/${state.headSha}/check-runs`) {
      return json({ total_count: state.checkRuns.length, check_runs: state.checkRuns });
    }
    if (path === `${base}/commits/${state.headSha}/status`) {
      return json({ state: state.statusState, total_count: state.statusCount, statuses: [] });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { state, calls, fetch };
}

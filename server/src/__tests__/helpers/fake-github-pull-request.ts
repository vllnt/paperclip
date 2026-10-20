/**
 * A fake GitHub REST API for one pull request, for the unchanged-pull-request
 * wake gate. Tests change `state` between monitor ticks and read `calls`.
 */
export type FakePullRequestState = {
  headSha: string;
  baseSha: string;
  prState: "open" | "closed";
  merged: boolean;
  mergeableState: string;
  updatedAt: string;
  comments: number;
  reviewComments: number;
  reviewIds: number[];
  /** Answer the review list with a `rel="next"` link, as GitHub does past one page. */
  reviewsHaveNextPage?: boolean;
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  statusState: string;
  statuses: Array<{ context: string; state: string }>;
  /** Answer every request with this HTTP status instead. */
  failWithStatus?: number;
  /** Never answer; resolve only when the caller aborts. */
  hang?: boolean;
};

/** What the caller sent, as the gate's security guards need to see it. */
export type FakeGitHubRequest = {
  origin: string;
  /** Path and query. */
  path: string;
  redirect: RequestRedirect | undefined;
  authorization: string | null;
  hasSignal: boolean;
};

export function defaultFakePullRequestState(): FakePullRequestState {
  return {
    headSha: "1111111111111111111111111111111111111111",
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prState: "open",
    merged: false,
    mergeableState: "blocked",
    updatedAt: "2026-04-11T12:00:00Z",
    comments: 2,
    reviewComments: 1,
    reviewIds: [101],
    checkRuns: [{ name: "test", status: "in_progress", conclusion: null }],
    statusState: "pending",
    statuses: [{ context: "ci/build", state: "pending" }],
  };
}

export function createFakeGitHubPullRequestApi(input: { owner: string; repo: string; number: number }) {
  const state: FakePullRequestState = defaultFakePullRequestState();
  const calls: string[] = [];
  const requests: FakeGitHubRequest[] = [];
  const base = `/repos/${input.owner}/${input.repo}`;
  const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...extraHeaders },
    });
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    calls.push(`${parsed.pathname}${parsed.search}`);
    requests.push({
      origin: parsed.origin,
      path: `${parsed.pathname}${parsed.search}`,
      redirect: init?.redirect,
      authorization: new Headers(init?.headers).get("authorization"),
      hasSignal: Boolean(init?.signal),
    });
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
        mergeable_state: state.mergeableState,
        updated_at: state.updatedAt,
        comments: state.comments,
        review_comments: state.reviewComments,
        head: { sha: state.headSha, ref: "feature" },
        base: { sha: state.baseSha, ref: "main" },
      });
    }
    if (path === `${base}/pulls/${input.number}/reviews`) {
      const next = `<https://api.github.com${base}/pulls/${input.number}/reviews?page=2>; rel="next"`;
      return json(
        state.reviewIds.map((id) => ({ id, state: "COMMENTED" })),
        200,
        state.reviewsHaveNextPage ? { link: next } : {},
      );
    }
    if (path === `${base}/commits/${state.headSha}/check-runs`) {
      return json({ total_count: state.checkRuns.length, check_runs: state.checkRuns });
    }
    if (path === `${base}/commits/${state.headSha}/status`) {
      return json({ state: state.statusState, total_count: state.statuses.length, statuses: state.statuses });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof globalThis.fetch;
  return { state, calls, requests, fetch };
}

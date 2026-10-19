// Read-only GitHub access for scripts/factory-throughput-kpi.mjs, through the `gh` CLI.
// Only GET requests and GraphQL queries are built here. Failures are classified, never
// swallowed into zero, and error text is redacted before it leaves this module.

import { execFile } from "node:child_process";

const SECRET_PATTERN = new RegExp(
  [
    String.raw`authorization:\s*(?:(?:bearer|token|basic)\s+)?\S+`,
    String.raw`gh[pousr]_[A-Za-z0-9_]{16,}`,
    String.raw`github_pat_[A-Za-z0-9_]{16,}`,
    String.raw`(?:bearer|token)\s+[A-Za-z0-9._-]{16,}`,
    String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`, // JWT, e.g. a run-scoped API key
    String.raw`(?<=://)[^/\s:@]+:[^@\s/]+(?=@)`, // user:password in a URL
  ].join("|"),
  "gi",
);
const REST_PATH = /^(?:repos|orgs)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.{}:%-]+)*$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MIN_SECRET_LENGTH = 8;
const SECRET_ENV_NAME = /(?:token|secret|password|api_?key)$/i;
const knownSecrets = new Set();

/** Remember exact secret values (for example from the environment) so they never reach output. */
export function registerSecrets(values) {
  for (const value of values) if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) knownSecrets.add(value);
}

/** Register every environment value whose name looks like a credential. */
export function registerEnvSecrets(env) {
  registerSecrets(Object.entries(env ?? {}).filter(([name]) => SECRET_ENV_NAME.test(name)).map(([, value]) => value));
}

export function redact(text) {
  let out = String(text ?? "");
  for (const secret of knownSecrets) out = out.split(secret).join("[redacted]");
  return out.replace(SECRET_PATTERN, "[redacted]");
}

// encodeURIComponent keeps ! ' ( ) * ; the REST allowlist does not, and a branch name may contain them.
const encodeSegment = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const CONCURRENCY = 4;

/** Map with at most `limit` calls in flight, results in input order. */
export async function mapLimit(items, fn, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class GhError extends Error {
  constructor(kind, message, status = null) {
    super(redact(message));
    this.name = "GhError";
    this.kind = kind; // missing | auth | forbidden | notfound | ratelimit | network | graphql | other
    this.status = status;
  }
}

const GRAPHQL_KINDS = { RATE_LIMITED: "ratelimit", FORBIDDEN: "forbidden", INSUFFICIENT_SCOPES: "forbidden", NOT_FOUND: "notfound" };

/** Classify GraphQL `errors` by their `type`; the message is only shown, never matched. */
export function classifyGraphqlErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  const types = list.map((e) => e?.type).filter(Boolean);
  const kind = types.map((t) => GRAPHQL_KINDS[t]).find(Boolean) ?? "graphql";
  return new GhError(kind, list.map((e) => e?.message ?? "error").join("; ") || "GraphQL error");
}

function graphqlErrorsIn(stdout) {
  try {
    const body = JSON.parse(stdout);
    return Array.isArray(body?.errors) && body.errors.length ? body.errors : null;
  } catch {
    return null;
  }
}

export function classifyGhFailure({ code, stderr = "", killed = false, stdout = "" }) {
  // `gh api graphql` exits non-zero with the JSON body on stdout when the response has errors.
  const errors = graphqlErrorsIn(String(stdout));
  if (errors) return classifyGraphqlErrors(errors);
  const text = String(stderr);
  const status = Number(/\(HTTP (\d{3})\)|HTTP (\d{3})/.exec(text)?.slice(1).find(Boolean)) || null;
  if (code === "ENOENT" || code === "EACCES") return new GhError("missing", "gh is not installed or cannot be run");
  if (killed) return new GhError("network", "gh timed out");
  if (status === 429 || /rate limit|secondary rate|abuse detection/i.test(text)) {
    return new GhError("ratelimit", text.trim().split("\n")[0] || "rate limited", status);
  }
  if (status === 401 || /bad credentials|authentication|gh auth login/i.test(text)) {
    return new GhError("auth", "GitHub authentication failed", status);
  }
  if (status === 403) return new GhError("forbidden", text.trim().split("\n")[0] || "forbidden", status);
  if (status === 404) return new GhError("notfound", text.trim().split("\n")[0] || "not found", status);
  if (/error connecting|could not resolve|timed? ?out|connection (refused|reset)|tls/i.test(text)) {
    return new GhError("network", "cannot reach GitHub");
  }
  return new GhError("other", text.trim().split("\n")[0] || `gh exited with ${code}`, status);
}

export function graphqlArgs(query, variables = {}) {
  if (/\b(mutation|subscription)\b/i.test(query)) throw new GhError("other", "read-only: mutation refused");
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    if (Number.isInteger(value)) args.push("-F", `${key}=${value}`);
    else args.push("-f", `${key}=${String(value)}`);
  }
  return args;
}

export function restArgs(path, params = {}) {
  if (!REST_PATH.test(path) || path.includes("..")) throw new GhError("other", `refused REST path: ${path}`);
  const args = ["api", "--method", "GET", path];
  for (const [key, value] of Object.entries(params)) args.push("-f", `${key}=${String(value)}`);
  return args;
}

function defaultRun(args, { ghBin, timeoutMs }) {
  const env = { ...process.env };
  delete env.GH_DEBUG; // gh's api debug mode prints request headers
  delete env.DEBUG;
  // gh needs only its own token; the Paperclip credentials are not for it.
  for (const name of Object.keys(env)) if (name.startsWith("PAPERCLIP_") || /_API_KEY$/.test(name)) delete env[name];
  return new Promise((resolve, reject) => {
    execFile(ghBin, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(classifyGhFailure({ code: error.code, stderr, killed: error.killed, stdout }));
      else resolve(stdout);
    });
  });
}

/** `run(args)` resolves to stdout; tests inject a fake. */
export function createGh({ run, ghBin = "gh", timeoutMs = 90_000 } = {}) {
  const exec = run ?? ((args) => defaultRun(args, { ghBin, timeoutMs }));
  const parse = (stdout) => {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new GhError("other", "GitHub returned a non-JSON response");
    }
  };
  return {
    async graphql(query, variables) {
      const body = parse(await exec(graphqlArgs(query, variables)));
      if (Array.isArray(body.errors) && body.errors.length) throw classifyGraphqlErrors(body.errors);
      return body.data;
    },
    async rest(path, params) {
      return parse(await exec(restArgs(path, params)));
    },
  };
}

export function parseRepo(repo) {
  if (!REPO_NAME.test(repo)) throw new GhError("other", `invalid repository name: ${repo}`);
  const [owner, name] = repo.split("/");
  return { owner, name };
}

const EARLY_STOP_MARGIN_MS = 3_600_000; // mergedAt <= updatedAt, but clocks and page shifts get some room

const MERGED_QUERY = `query($owner:String!,$name:String!,$first:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    defaultBranchRef{name}
    pullRequests(states:MERGED,first:$first,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{number title createdAt mergedAt updatedAt additions deletions baseRefName headRefName headRefOid isCrossRepository
        mergeCommit{oid} author{login} labels(first:20){nodes{name}}
        reviews(first:20){nodes{state submittedAt author{login}}}
        timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT],last:1){nodes{... on ReadyForReviewEvent{createdAt}}}}
    }
  }
}`;

// A review counts once submitted by someone other than the author; PENDING drafts are not reviews yet.
// A deleted account has no login (undefined here), and no login is ever equal to the author's.
function reviewTimes(node) {
  const authorLogin = node.author?.login ?? null;
  return (node.reviews?.nodes ?? [])
    .filter((r) => r.state !== "PENDING" && r.submittedAt && r.author?.login !== authorLogin)
    .map((r) => ({ state: r.state, atMs: Date.parse(r.submittedAt), author: r.author?.login ?? null }));
}

/** The latest decision of each reviewer, which is how GitHub tallies approvals and change requests. */
function latestDecisions(reviews) {
  const latest = new Map();
  const decisive = reviews.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED");
  for (const r of [...decisive].sort((a, b) => a.atMs - b.atMs)) latest.set(r.author ?? `#${latest.size}`, r.state);
  return [...latest.values()];
}

// When the PR became reviewable: the last "ready for review" event, else when it was opened.
function readyAtMs(node) {
  const event = node.timelineItems?.nodes?.at(-1)?.createdAt;
  return Date.parse(event ?? node.createdAt);
}

export function normalizeMergedPr(repo, node) {
  const reviews = reviewTimes(node);
  const mergedAtMs = Date.parse(node.mergedAt);
  // A review after the merge says nothing about how long review took.
  const before = reviews.filter((r) => r.atMs <= mergedAtMs);
  return {
    repo,
    number: node.number,
    title: node.title ?? "",
    createdAtMs: Date.parse(node.createdAt),
    mergedAtMs,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    lines: (node.additions ?? 0) + (node.deletions ?? 0),
    baseRef: node.baseRefName,
    headRef: node.headRefName ?? "",
    headOid: node.headRefOid ?? null,
    mergeOid: node.mergeCommit?.oid ?? null,
    crossRepo: Boolean(node.isCrossRepository),
    author: node.author?.login ?? null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    readyAtMs: readyAtMs(node),
    firstReviewAtMs: before.length ? Math.min(...before.map((r) => r.atMs)) : null,
  };
}

/**
 * Merged PRs into the default branch since `sinceMs`. Paging runs newest-updated first and stops
 * once a page ends before `sinceMs`: mergedAt <= updatedAt, so nothing later can be in range.
 * `complete` is false when the page cap ended the walk early.
 */
export async function fetchMergedPrs(gh, repo, { sinceMs, maxPages = 40, pageSize = 100 }) {
  const { owner, name } = parseRepo(repo);
  const seen = new Map(); // a PR updated while paging can show up on two pages
  const stopBeforeMs = sinceMs - EARLY_STOP_MARGIN_MS;
  let defaultBranch = null;
  let cursor = null;
  let complete = false;
  for (let page = 0; page < maxPages && !complete; page += 1) {
    const data = await gh.graphql(MERGED_QUERY, { owner, name, first: pageSize, cursor });
    if (!data?.repository) throw new GhError("notfound", `repository ${repo} not visible to this token`);
    const { pullRequests, defaultBranchRef } = data.repository;
    defaultBranch ??= defaultBranchRef?.name ?? null;
    for (const node of pullRequests.nodes) seen.set(node.number, node);
    const last = pullRequests.nodes.at(-1);
    complete = !pullRequests.pageInfo.hasNextPage || !last || Date.parse(last.updatedAt) < stopBeforeMs;
    cursor = pullRequests.pageInfo.endCursor;
  }
  const merged = [...seen.values()].map((node) => normalizeMergedPr(repo, node)).filter((pr) => pr.mergedAtMs >= sinceMs);
  const prs = merged.filter((pr) => pr.baseRef === defaultBranch);
  const otherMerged = merged.filter((pr) => pr.baseRef !== defaultBranch);
  return { repo, defaultBranch, prs, otherMerged, otherBaseMerged: otherMerged.length, complete };
}

const OPEN_QUERY = `query($owner:String!,$name:String!,$first:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:$first,after:$cursor,orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{number isDraft mergeable reviewDecision createdAt author{login}
        reviews(last:30){nodes{state submittedAt author{login}}}
        timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT],last:1){nodes{... on ReadyForReviewEvent{createdAt}}}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}}
    }
  }
}`;

export function normalizeOpenPr(repo, node) {
  const reviews = reviewTimes(node);
  return {
    repo,
    number: node.number,
    draft: Boolean(node.isDraft),
    mergeable: node.mergeable ?? "UNKNOWN",
    reviewDecision: node.reviewDecision ?? null,
    createdAtMs: Date.parse(node.createdAt),
    readyAtMs: readyAtMs(node),
    reviewed: reviews.length > 0,
    firstReviewAtMs: reviews.length ? Math.min(...reviews.map((r) => r.atMs)) : null,
    decisions: latestDecisions(reviews),
    checks: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };
}

/** Open PRs of a repo, newest first, up to `maxPages` pages; `complete` is false if the cap was hit. */
export async function fetchOpenPrs(gh, repo, { maxPages = 10, pageSize = 100 } = {}) {
  const { owner, name } = parseRepo(repo);
  const prs = [];
  let cursor = null;
  let complete = false;
  for (let page = 0; page < maxPages && !complete; page += 1) {
    const data = await gh.graphql(OPEN_QUERY, { owner, name, first: pageSize, cursor });
    if (!data?.repository) throw new GhError("notfound", `repository ${repo} not visible to this token`);
    const { nodes, pageInfo } = data.repository.pullRequests;
    prs.push(...nodes.map((node) => normalizeOpenPr(repo, node)));
    complete = !pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }
  return { repo, prs, complete };
}

/** Repos in `org` with a push since `sinceMs`, so a repo the factory starts merging into is picked up. */
export async function discoverActiveRepos(gh, org, { sinceMs, maxPages = 10 }) {
  if (!ORG_NAME.test(org)) throw new GhError("other", `invalid organization name: ${org}`);
  const found = [];
  let complete = false;
  for (let page = 1; page <= maxPages && !complete; page += 1) {
    const rows = await gh.rest(`orgs/${org}/repos`, { sort: "pushed", direction: "desc", per_page: 100, page });
    if (!Array.isArray(rows)) throw new GhError("other", "unexpected repository listing");
    for (const r of rows) if (!r.archived && Date.parse(r.pushed_at) >= sinceMs) found.push(r.full_name);
    // Newest push first: a page that ends before the window, or a short page, is the last one needed.
    const last = rows.at(-1);
    complete = rows.length < 100 || Date.parse(last.pushed_at) < sinceMs;
  }
  return { repos: found, complete };
}

const asError = (error) => (error instanceof GhError ? error : new GhError("other", error?.message ?? String(error)));

/** Rulesets and classic protection for a branch; each source fails independently. */
export async function fetchEnforcement(gh, repo, branch) {
  const { owner, name } = parseRepo(repo);
  const base = `repos/${owner}/${name}`;
  const out = { rules: null, rulesError: null, protection: null, protectionError: null };
  try {
    out.rules = await gh.rest(`${base}/rules/branches/${encodeSegment(branch)}`, { per_page: 100 });
  } catch (error) {
    out.rulesError = asError(error);
  }
  try {
    out.protection = await gh.rest(`${base}/branches/${encodeSegment(branch)}/protection`);
  } catch (error) {
    out.protectionError = asError(error);
  }
  return out;
}

const CHECK_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const STATUS_FAIL = new Set(["FAILURE", "ERROR"]);

export function normalizeCheck(node) {
  if (node.__typename === "CheckRun") {
    const finished = node.status === "COMPLETED";
    const outcome = !finished ? "pending" : CHECK_PASS.has(node.conclusion) ? "pass" : CHECK_FAIL.has(node.conclusion) ? "fail" : "pending";
    return { name: node.name, outcome, atMs: finished && node.completedAt ? Date.parse(node.completedAt) : null };
  }
  const outcome = node.state === "SUCCESS" ? "pass" : STATUS_FAIL.has(node.state) ? "fail" : "pending";
  return { name: node.context, outcome, atMs: node.createdAt ? Date.parse(node.createdAt) : null };
}

const DETAIL_FIELDS = `number mergedAt author{login}
  reviews(first:50){pageInfo{hasNextPage} nodes{state submittedAt author{login}}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){
    pageInfo{hasNextPage}
    nodes{__typename ... on CheckRun{name status conclusion completedAt} ... on StatusContext{context state createdAt}}}}}}}`;

export function normalizeDetail(node) {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  return {
    number: node.number,
    author: node.author?.login ?? null,
    mergedAtMs: Date.parse(node.mergedAt),
    reviews: (node.reviews?.nodes ?? [])
      .filter((r) => r.state !== "PENDING" && r.submittedAt)
      .map((r) => ({ state: r.state, submittedAtMs: Date.parse(r.submittedAt), author: r.author?.login ?? null })),
    reviewsTruncated: Boolean(node.reviews?.pageInfo?.hasNextPage),
    checks: (contexts?.nodes ?? []).map(normalizeCheck),
    checksTruncated: Boolean(contexts?.pageInfo?.hasNextPage),
  };
}

/**
 * Head-commit checks and reviews for merged PRs, a few per request.
 * Returns `{ details, error }`: details is a Map by number of everything read before a failure,
 * so one bad batch does not discard the batches that worked.
 */
export async function fetchMergeDetails(gh, repo, numbers, { batch = 15 } = {}) {
  const { owner, name } = parseRepo(repo);
  const details = new Map();
  let error = null;
  for (let i = 0; i < numbers.length && !error; i += batch) {
    const slice = numbers.slice(i, i + batch);
    const aliases = slice.map((n) => `p${n}:pullRequest(number:${Number(n)}){${DETAIL_FIELDS}}`).join("\n");
    try {
      const data = await gh.graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${aliases}}}`, { owner, name });
      for (const n of slice) {
        const node = data?.repository?.[`p${n}`];
        if (node) details.set(n, normalizeDetail(node));
      }
    } catch (caught) {
      error = asError(caught);
    }
  }
  return { details, error };
}

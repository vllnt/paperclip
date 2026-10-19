import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GhError,
  classifyGhFailure,
  classifyGraphqlErrors,
  createGh,
  discoverActiveRepos,
  fetchEnforcement,
  fetchMergeDetails,
  fetchMergedPrs,
  fetchOpenPrs,
  graphqlArgs,
  mapLimit,
  normalizeMergedPr,
  normalizeOpenPr,
  redact,
  registerEnvSecrets,
  registerSecrets,
  restArgs,
} from "./factory-kpi-github.mjs";
import { HOUR, checkRun, detailNode, fakeGh, mergedNode, openNode, reviewNode, steadyNodes, tempDir } from "./factory-kpi-test-helpers.mjs";

const END = Date.parse("2026-10-18T12:00:00Z");

test("graphqlArgs refuses mutations and subscriptions", () => {
  assert.throws(() => graphqlArgs("mutation { x }"), /read-only/);
  assert.throws(() => graphqlArgs("subscription { x }"), /read-only/);
  assert.throws(() => graphqlArgs("query { a } MUTATION b"), /read-only/);
  const args = graphqlArgs("query($n:Int!){x}", { n: 3, owner: "o", skip: null });
  assert.deepEqual(args.slice(-4), ["-F", "n=3", "-f", "owner=o"]);
});

test("restArgs forces GET and refuses paths outside repos/ and orgs/", () => {
  assert.deepEqual(restArgs("repos/o/r/rules/branches/main", { per_page: 100 }), [
    "api",
    "--method",
    "GET",
    "repos/o/r/rules/branches/main",
    "-f",
    "per_page=100",
  ]);
  for (const bad of ["user", "graphql", "repos/o/../x", "https://evil.example/repos/o/r", "repos/o/r?x=1"]) {
    assert.throws(() => restArgs(bad), /refused REST path/, bad);
  }
});

test("classifyGhFailure separates missing, auth, forbidden, notfound, ratelimit and network", () => {
  const kind = (over) => classifyGhFailure(over).kind;
  assert.equal(kind({ code: "ENOENT" }), "missing");
  assert.equal(kind({ killed: true }), "network");
  assert.equal(kind({ code: 1, stderr: "gh: Bad credentials (HTTP 401)" }), "auth");
  assert.equal(kind({ code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" }), "forbidden");
  assert.equal(kind({ code: 1, stderr: "gh: Branch not protected (HTTP 404)" }), "notfound");
  assert.equal(kind({ code: 1, stderr: "gh: API rate limit exceeded (HTTP 403)" }), "ratelimit");
  assert.equal(kind({ code: 1, stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)" }), "ratelimit");
  assert.equal(kind({ code: 1, stderr: "error connecting to api.github.com\ncheck your internet connection" }), "network");
  assert.equal(kind({ code: 1, stderr: "boom" }), "other");
});

test("error text never carries a token", () => {
  const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0";
  assert.equal(redact(`failed with ${token} and Authorization: Bearer abcdefghijklmnop1234`), "failed with [redacted] and [redacted]");
  assert.ok(!new GhError("other", `token ${token}`).message.includes(token));
  assert.ok(!classifyGhFailure({ code: 1, stderr: `HTTP 500 ${token}` }).message.includes(token));
});

test("redact also removes a JWT, URL credentials and registered secret values", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJhZ2VudCJ9", "c2lnbmF0dXJlLXZhbHVl"].join(".");
  assert.equal(redact(`key ${jwt} end`), "key [redacted] end");
  assert.equal(redact("fetch https://user:hunter2pass@example.test/path failed"), "fetch https://[redacted]@example.test/path failed");
  registerSecrets(["plain-secret-value-123", "short"]);
  assert.equal(redact("saw plain-secret-value-123 in output"), "saw [redacted] in output");
  assert.equal(redact("a short word"), "a short word", "values under 8 characters are not registered");
});

test("registerEnvSecrets picks up credentials by the look of their names only", () => {
  registerEnvSecrets({
    SERVICE_TOKEN: "token-value-aaaa1",
    DB_PASSWORD: "password-value-bbb2",
    CLIENT_SECRET: "secret-value-cccc3",
    PAPERCLIP_API_KEY: "apikey-value-dddd4",
    SOME_APIKEY: "apikey2-value-eeee5",
    HOME: "/home/someone-long-path",
    TOKEN_COUNT: "123456789012",
  });
  const hidden = ["token-value-aaaa1", "password-value-bbb2", "secret-value-cccc3", "apikey-value-dddd4", "apikey2-value-eeee5"];
  assert.equal(redact(hidden.join(" | ")), hidden.map(() => "[redacted]").join(" | "));
  assert.equal(redact("/home/someone-long-path 123456789012"), "/home/someone-long-path 123456789012");
});

test("classifyGraphqlErrors goes by the error type, not by its message", () => {
  const kind = (type, message = "x") => classifyGraphqlErrors([{ type, message }]).kind;
  assert.equal(kind("RATE_LIMITED"), "ratelimit");
  assert.equal(kind("FORBIDDEN"), "forbidden");
  assert.equal(kind("INSUFFICIENT_SCOPES"), "forbidden");
  assert.equal(kind("NOT_FOUND"), "notfound");
  assert.equal(kind("SOMETHING_ELSE", "rate limit"), "graphql");
  assert.equal(classifyGraphqlErrors([]).kind, "graphql");
});

test("a gh that cannot be run is reported as missing, whatever the reason", () => {
  assert.equal(classifyGhFailure({ code: "EACCES" }).kind, "missing");
  assert.equal(classifyGhFailure({ code: "ENOENT" }).kind, "missing");
  assert.equal(classifyGhFailure({ code: 1, stderr: "boom" }).kind, "other");
});

test("a failed gh exit with a GraphQL body on stdout is classified from the body", () => {
  const body = JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
  assert.equal(classifyGhFailure({ code: 1, stdout: body, stderr: "gh: API rate limit exceeded" }).kind, "ratelimit");
  assert.equal(classifyGhFailure({ code: 1, stdout: "not json", stderr: "gh: Bad credentials (HTTP 401)" }).kind, "auth");
  assert.equal(classifyGhFailure({ code: 1, stdout: JSON.stringify({ errors: [] }), stderr: "boom" }).kind, "other");
});

const STUB = fileURLToPath(new URL("./factory-kpi-gh-stub.mjs", import.meta.url));
const stubOut = async () => join(tempDir("kpi-gh-"), "call");

test("createGh runs the real gh binary read-only and without the Paperclip credentials in its environment", async () => {
  const out = await stubOut();
  const saved = { ...process.env };
  Object.assign(process.env, { KPI_STUB_OUT: out, PAPERCLIP_API_KEY: "pcp-key-1", OTHER_API_KEY: "other-key-1", GH_DEBUG: "api", DEBUG: "1", GH_TOKEN: "gh-token-for-child" });
  try {
    const gh = createGh({ ghBin: STUB });
    assert.deepEqual(await gh.graphql("query($n:Int!){x}", { n: 2 }), { ok: 1 });
    assert.deepEqual(JSON.parse(await readFile(`${out}.argv`, "utf8")), ["api", "graphql", "-f", "query=query($n:Int!){x}", "-F", "n=2"]);
    const env = JSON.parse(await readFile(`${out}.env`, "utf8"));
    for (const name of ["PAPERCLIP_API_KEY", "OTHER_API_KEY", "GH_DEBUG", "DEBUG"]) assert.ok(!(name in env), `${name} must not reach gh`);
    assert.equal(env.GH_TOKEN, "gh-token-for-child", "gh keeps its own token");
    await gh.rest("repos/o/r/rules/branches/main", { per_page: 100 });
    assert.deepEqual(JSON.parse(await readFile(`${out}.argv`, "utf8")).slice(0, 3), ["api", "--method", "GET"]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("createGh classifies a gh that exits non-zero with errors on stdout, and a missing binary", async () => {
  const out = await stubOut();
  const saved = { ...process.env };
  Object.assign(process.env, {
    KPI_STUB_OUT: out,
    KPI_STUB_EXIT: "1",
    KPI_STUB_STDOUT: JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
  });
  try {
    await assert.rejects(createGh({ ghBin: STUB }).graphql("query{x}"), (e) => e.kind === "forbidden");
    await assert.rejects(createGh({ ghBin: join(tmpdir(), "no-such-gh-binary") }).graphql("query{x}"), (e) => e.kind === "missing");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("mapLimit keeps the order and never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, n));
    running -= 1;
    return n * 2;
  }, 3);
  assert.deepEqual(out, [10, 2, 8, 4, 6, 12, 14]);
  assert.equal(peak, 3);
  assert.deepEqual(await mapLimit([], async () => 1), []);
});

test("createGh turns a GraphQL errors array into a typed error, never partial data", async () => {
  const gh = createGh({ run: async () => JSON.stringify({ data: { repository: {} }, errors: [{ message: "boom" }] }) });
  await assert.rejects(gh.graphql("query{x}"), (e) => e instanceof GhError && e.kind === "graphql");
  const bad = createGh({ run: async () => "<html>" });
  await assert.rejects(bad.rest("repos/o/r"), (e) => e.kind === "other");
});

test("fetchMergedPrs pages newest-updated first and stops once a page ends before the window", async () => {
  const merged = steadyNodes(END - 10 * HOUR, END, 30); // 300 PRs in 10 h
  const gh = fakeGh({ "o/r": { merged } });
  const got = await fetchMergedPrs(gh, "o/r", { sinceMs: END - 2 * HOUR });
  assert.equal(got.complete, true);
  assert.equal(got.prs.length, 60);
  assert.ok(got.prs.every((pr) => pr.mergedAtMs >= END - 2 * HOUR));
  assert.equal(gh.calls.length, 1, "the first page of 100 already reaches back before the window");
});

test("fetchMergedPrs keeps only merges into the default branch and counts the rest", async () => {
  const merged = [mergedNode(1, END - HOUR), mergedNode(2, END - 2 * HOUR, { base: "release" })];
  const gh = fakeGh({ "o/r": { merged } });
  const got = await fetchMergedPrs(gh, "o/r", { sinceMs: END - 24 * HOUR });
  assert.deepEqual(got.prs.map((p) => p.number), [1]);
  assert.equal(gh.calls.length, 1, "no request for a page that does not exist");
  assert.equal(got.otherBaseMerged, 1);
});

test("fetchMergedPrs flags the page cap as incomplete instead of returning a silent undercount", async () => {
  const merged = steadyNodes(END - 10 * HOUR, END, 30);
  const got = await fetchMergedPrs(fakeGh({ "o/r": { merged } }, { pageSize: 50 }), "o/r", {
    sinceMs: END - 10 * HOUR,
    maxPages: 2,
    pageSize: 50,
  });
  assert.equal(got.complete, false);
  assert.equal(got.prs.length, 100);
});

test("fetchMergedPrs surfaces an invisible repository and API failures as errors", async () => {
  await assert.rejects(fetchMergedPrs(fakeGh({}), "o/missing", { sinceMs: 0 }), (e) => e.kind === "notfound");
  await assert.rejects(
    fetchMergedPrs(fakeGh({ "o/r": new GhError("ratelimit", "slow down", 403) }), "o/r", { sinceMs: 0 }),
    (e) => e.kind === "ratelimit",
  );
  await assert.rejects(fetchMergedPrs(fakeGh({}), "not a repo", { sinceMs: 0 }), /invalid repository/);
});

test("discoverActiveRepos keeps unarchived repos pushed inside the window", async () => {
  const gh = fakeGh({
    "REST orgs/o/repos": [
      { full_name: "o/active", archived: false, pushed_at: new Date(END - HOUR).toISOString() },
      { full_name: "o/old", archived: false, pushed_at: new Date(END - 30 * 24 * HOUR).toISOString() },
      { full_name: "o/archived", archived: true, pushed_at: new Date(END - HOUR).toISOString() },
    ],
  });
  assert.deepEqual(await discoverActiveRepos(gh, "o", { sinceMs: END - 7 * 24 * HOUR }), { repos: ["o/active"], complete: true });
});

test("discoverActiveRepos pages past 100 repositories and says when it stopped early", async () => {
  const recent = (i) => ({ full_name: `o/r${i}`, archived: false, pushed_at: new Date(END - i * 60_000).toISOString() });
  const pages = {
    1: Array.from({ length: 100 }, (_, i) => recent(i)),
    2: Array.from({ length: 100 }, (_, i) => recent(100 + i)),
    3: [{ full_name: "o/ancient", archived: false, pushed_at: new Date(END - 90 * 24 * HOUR).toISOString() }],
  };
  const calls = [];
  const gh = { rest: async (path, params) => (calls.push(params.page), pages[params.page]) };
  const found = await discoverActiveRepos(gh, "o", { sinceMs: END - 7 * 24 * HOUR });
  assert.equal(found.repos.length, 200);
  assert.equal(found.complete, true);
  assert.deepEqual(calls, [1, 2, 3]);
  const capped = await discoverActiveRepos({ rest: async (path, params) => pages[params.page] ?? pages[2] }, "o", { sinceMs: END - 7 * 24 * HOUR, maxPages: 2 });
  assert.equal(capped.complete, false, "a full last page inside the window means there may be more");
});

test("discoverActiveRepos refuses an invalid organization name and a malformed listing", async () => {
  await assert.rejects(discoverActiveRepos({ rest: async () => [] }, "o/../x", { sinceMs: 0 }), /invalid organization/);
  await assert.rejects(discoverActiveRepos({ rest: async () => ({ message: "x" }) }, "o", { sinceMs: 0 }), /unexpected repository listing/);
});

test("fetchEnforcement reads rules and protection through GET paths, each failing on its own", async () => {
  const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }];
  const ok = fakeGh({ "REST repos/o/a/rules/branches/main": rules, "REST repos/o/a/branches/main/protection": { enabled: true } });
  assert.deepEqual(await fetchEnforcement(ok, "o/a", "main"), { rules, rulesError: null, protection: { enabled: true }, protectionError: null });
  assert.deepEqual(ok.calls.map((c) => c.path), ["repos/o/a/rules/branches/main", "repos/o/a/branches/main/protection"]);

  const denied = new GhError("forbidden", "denied", 403);
  const noRules = await fetchEnforcement(fakeGh({ "REST repos/o/a/rules/branches/main": denied, "REST repos/o/a/branches/main/protection": { x: 1 } }), "o/a", "main");
  assert.equal(noRules.rulesError.kind, "forbidden");
  assert.deepEqual(noRules.protection, { x: 1 });
  assert.equal(noRules.protectionError, null);

  const noProtection = await fetchEnforcement(fakeGh({ "REST repos/o/a/rules/branches/main": [], "REST repos/o/a/branches/main/protection": denied }), "o/a", "main");
  assert.equal(noProtection.protectionError.kind, "forbidden");
  assert.deepEqual(noProtection.rules, []);
  assert.equal(noProtection.rulesError, null);
});

test("fetchEnforcement wraps a non-GhError and escapes the branch name", async () => {
  const gh = fakeGh({});
  gh.rest = async (path) => {
    gh.calls.push({ path });
    throw new TypeError("boom");
  };
  const out = await fetchEnforcement(gh, "o/a", "release/1.0");
  assert.equal(out.rulesError.kind, "other");
  assert.equal(out.protectionError.message, "boom");
  assert.equal(gh.calls[0].path, "repos/o/a/rules/branches/release%2F1.0");
});

test("fetchEnforcement asks for a full page of rules and encodes characters the path allowlist rejects", async () => {
  const ok = fakeGh({ "REST repos/o/a/rules/branches/we%28ird%29%27%21%2A": [], "REST repos/o/a/branches/we%28ird%29%27%21%2A/protection": {} });
  const out = await fetchEnforcement(ok, "o/a", "we(ird)'!*");
  assert.equal(out.rulesError, null, "the encoded path passes the REST allowlist");
  assert.equal(ok.calls[0].path, "repos/o/a/rules/branches/we%28ird%29%27%21%2A");
  assert.deepEqual(ok.calls[0].params, { per_page: 100 });
});

test("fetchMergeDetails batches aliased queries and normalises reviews and checks", async () => {
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  const details = Object.fromEntries(
    numbers.map((n) => [
      n,
      detailNode(n, Date.parse("2026-10-18T10:00:00Z"), {
        author: "agent",
        reviews: [{ state: "APPROVED", atMs: Date.parse("2026-10-18T09:00:00Z"), author: "reviewer" }],
        checks: [checkRun("ci", "SUCCESS", Date.parse("2026-10-18T09:30:00Z")), checkRun("slow", null, null, "IN_PROGRESS")],
        truncated: n === 20,
      }),
    ]),
  );
  const gh = fakeGh({ "o/a": { merged: [], details } });
  const { details: out, error } = await fetchMergeDetails(gh, "o/a", numbers);
  assert.equal(error, null);
  assert.equal(gh.calls.length, 2, "15 per request");
  assert.equal(out.size, 20);
  const one = out.get(1);
  assert.equal(one.author, "agent");
  assert.deepEqual(one.reviews, [{ state: "APPROVED", submittedAtMs: Date.parse("2026-10-18T09:00:00Z"), author: "reviewer" }]);
  assert.deepEqual(one.checks.map((c) => [c.name, c.outcome]), [["ci", "pass"], ["slow", "pending"]]);
  assert.equal(one.checksTruncated, false);
  assert.equal(one.reviewsTruncated, false);
  assert.equal(out.get(20).checksTruncated, true);
  for (const call of gh.calls) assert.doesNotMatch(call.query, /\b(mutation|subscription)\b/i);
});

test("fetchMergeDetails leaves out PRs GitHub did not return and handles a PR with no checks", async () => {
  const bare = { number: 2, mergedAt: "2026-10-18T10:00:00Z", author: null, reviews: { nodes: [] }, commits: { nodes: [] } };
  const gh = fakeGh({ "o/a": { merged: [], details: { 2: bare } } });
  const { details: out } = await fetchMergeDetails(gh, "o/a", [1, 2]);
  assert.deepEqual([...out.keys()], [2]);
  assert.deepEqual(out.get(2).checks, []);
  assert.equal(out.get(2).author, null);
  assert.equal(out.get(2).checksTruncated, false);
});

test("fetchMergeDetails keeps what an earlier batch read when a later one fails", async () => {
  const numbers = Array.from({ length: 45 }, (_, i) => i + 1);
  const details = Object.fromEntries(numbers.map((n) => [n, detailNode(n, END)]));
  const inner = fakeGh({ "o/a": { merged: [], details } });
  let batches = 0;
  const gh = {
    graphql: async (query, vars) => {
      batches += 1;
      if (batches === 2) throw new GhError("ratelimit", "slow down", 403);
      return inner.graphql(query, vars);
    },
  };
  const { details: got, error } = await fetchMergeDetails(gh, "o/a", numbers);
  assert.equal(got.size, 15);
  assert.equal(error.kind, "ratelimit");
  assert.equal(batches, 2, "no further batch after a failure");
});

test("detail reads flag a review list that was cut at 50 and drop pending drafts", async () => {
  const node = detailNode(1, END, { reviewsTruncated: true, reviews: [{ state: "PENDING", atMs: END - HOUR, author: "me" }, { state: "APPROVED", atMs: END - HOUR, author: "you" }] });
  const { details } = await fetchMergeDetails(fakeGh({ "o/a": { merged: [], details: { 1: node } } }), "o/a", [1]);
  assert.equal(details.get(1).reviewsTruncated, true);
  assert.deepEqual(details.get(1).reviews.map((r) => r.state), ["APPROVED"]);
});

test("fetchMergedPrs counts a PR once when an update shifts it onto two pages", async () => {
  const merged = steadyNodes(END - 3 * HOUR, END, 5);
  const inner = fakeGh({ "o/r": { merged } });
  const first = merged.map((n) => n.number)[0];
  const gh = {
    calls: inner.calls,
    graphql: async (query, vars) => {
      const data = await inner.graphql(query, vars);
      // The page boundary moved between requests: the last PR of page one is served again on page two.
      if (vars.cursor) data.repository.pullRequests.nodes.unshift(inner.calls.firstPageLast);
      else inner.calls.firstPageLast = data.repository.pullRequests.nodes.at(-1);
      return data;
    },
  };
  const got = await fetchMergedPrs(gh, "o/r", { sinceMs: END - 3 * HOUR, pageSize: 5 });
  assert.equal(got.prs.length, 15);
  assert.equal(new Set(got.prs.map((p) => p.number)).size, 15);
  assert.ok(first);
});

test("fetchMergedPrs keeps paging for an hour past the window, since clocks and page shifts are not exact", async () => {
  const merged = [
    ...steadyNodes(END - 2 * HOUR, END, 3),
    mergedNode(900, END - 3 * HOUR - 10 * 60_000, { updatedMs: END - 2 * HOUR - 30 * 60_000 }),
  ];
  const gh = fakeGh({ "o/r": { merged } });
  const got = await fetchMergedPrs(gh, "o/r", { sinceMs: END - 3 * HOUR, pageSize: 3 });
  assert.ok(gh.calls.length >= 3, "the page that ends 30 min after the window start was not the last");
  assert.ok(got.prs.some((p) => p.number === 900) === false);
});

test("a PR with no author and a review by a deleted account is read without error", () => {
  const node = mergedNode(1, END, { reviews: [{ state: "APPROVED", atMs: END - HOUR, author: "x" }] });
  node.author = null;
  node.reviews.nodes[0].author = null;
  const pr = normalizeMergedPr("o/r", node);
  assert.equal(pr.author, null);
  assert.equal(pr.firstReviewAtMs, END - HOUR, "a deleted reviewer is still someone other than the author");
});

test("a review after the merge is not the first review", () => {
  const node = mergedNode(1, END, { reviews: [{ state: "COMMENTED", atMs: END + HOUR, author: "late" }] });
  assert.equal(normalizeMergedPr("o/r", node).firstReviewAtMs, null);
  const both = mergedNode(2, END, { reviews: [{ atMs: END + HOUR, author: "late" }, { atMs: END - 2 * HOUR, author: "early" }] });
  assert.equal(normalizeMergedPr("o/r", both).firstReviewAtMs, END - 2 * HOUR);
});

test("open PRs: a missing status rollup is null, and the latest decision of each reviewer is kept", () => {
  const none = normalizeOpenPr("o/r", openNode(1, { checks: null }));
  assert.equal(none.checks, null);
  const flipped = normalizeOpenPr("o/r", openNode(2, { reviews: [
    { state: "CHANGES_REQUESTED", atMs: 1000, author: "a" },
    { state: "APPROVED", atMs: 2000, author: "a" },
    { state: "CHANGES_REQUESTED", atMs: 1500, author: "b" },
    { state: "COMMENTED", atMs: 3000, author: "b" },
  ] }));
  assert.deepEqual(flipped.decisions.sort(), ["APPROVED", "CHANGES_REQUESTED"]);
  assert.equal(flipped.firstReviewAtMs, 1000);
});

test("every field a normalizer reads is asked for by its query", async () => {
  const merged = fakeGh({ "o/r": { merged: [mergedNode(1, END)] } });
  await fetchMergedPrs(merged, "o/r", { sinceMs: 0 });
  const open = fakeGh({ "o/r": { open: [openNode(1)] } });
  await fetchOpenPrs(open, "o/r");
  const detail = fakeGh({ "o/r": { merged: [], details: { 1: detailNode(1, END) } } });
  await fetchMergeDetails(detail, "o/r", [1]);
  const needs = [
    [merged.calls[0].query, ["number", "title", "createdAt", "mergedAt", "updatedAt", "additions", "deletions", "baseRefName", "headRefName", "author{login}", "labels(", "reviews(", "READY_FOR_REVIEW_EVENT", "defaultBranchRef{name}", "hasNextPage", "endCursor"]],
    [open.calls[0].query, ["number", "isDraft", "mergeable", "reviewDecision", "createdAt", "author{login}", "reviews(", "READY_FOR_REVIEW_EVENT", "statusCheckRollup{state}", "hasNextPage", "endCursor"]],
    [detail.calls[0].query, ["mergedAt", "author{login}", "reviews(first:50)", "pageInfo{hasNextPage}", "statusCheckRollup", "contexts(first:100)", "... on CheckRun{name status conclusion completedAt}", "... on StatusContext{context state createdAt}", "__typename"]],
  ];
  for (const [query, fields] of needs) for (const field of fields) assert.ok(query.includes(field), `query is missing ${field}`);
});

test("a review submitted at the very moment of the merge counts as the first review; one after it does not", () => {
  const at = (ms) => normalizeMergedPr("o/r", mergedNode(1, END, { reviews: [{ atMs: ms, author: "r" }] })).firstReviewAtMs;
  assert.equal(at(END), END);
  assert.equal(at(END + 1), null);
});

test("a PR from a deleted account still has reviews, and a deleted reviewer is somebody else", () => {
  const ghost = { ...mergedNode(1, END, { reviews: [{ atMs: END - HOUR, author: "r" }] }), author: null };
  assert.equal(normalizeMergedPr("o/r", ghost).firstReviewAtMs, END - HOUR);
  const anonymous = { ...ghost, reviews: { nodes: [{ state: "APPROVED", submittedAt: new Date(END - 2 * HOUR).toISOString(), author: null }] } };
  assert.equal(normalizeMergedPr("o/r", anonymous).firstReviewAtMs, END - 2 * HOUR);
  const own = mergedNode(2, END, { author: "agent", reviews: [{ atMs: END - HOUR, author: "agent" }] });
  assert.equal(normalizeMergedPr("o/r", own).firstReviewAtMs, null, "the author's own review is not a review");
});

test("fetchMergedPrs keeps paging while the last PR on a page was updated within the safety margin of the window", async () => {
  const since = END - 6 * HOUR;
  const merged = [
    mergedNode(1, since + 2 * HOUR),
    mergedNode(2, since + 60_000, { updatedMs: since - 30 * 60_000 }),
    mergedNode(3, since - 3 * HOUR),
  ];
  const gh = fakeGh({ "o/r": { merged } }, { pageSize: 2 });
  const got = await fetchMergedPrs(gh, "o/r", { sinceMs: since, pageSize: 2 });
  assert.equal(gh.calls.length, 2, "30 minutes before the window is still inside the one hour margin");
  assert.deepEqual(got.prs.map((p) => p.number).sort(), [1, 2]);
  assert.equal(got.complete, true);
  const far = fakeGh({ "o/r": { merged: [merged[0], mergedNode(2, since - 3 * HOUR), merged[2]] } }, { pageSize: 2 });
  await fetchMergedPrs(far, "o/r", { sinceMs: since, pageSize: 2 });
  assert.equal(far.calls.length, 1, "three hours before the window is past the margin");
});

test("discoverActiveRepos stops at a full page that already ends before the window", async () => {
  const old = (i) => ({ full_name: `o/r${i}`, archived: false, pushed_at: new Date(END - (10 + i) * 24 * HOUR).toISOString() });
  const calls = [];
  const gh = { rest: async (path, params) => (calls.push(params.page), Array.from({ length: 100 }, (_, i) => old(i))) };
  const found = await discoverActiveRepos(gh, "o", { sinceMs: END - 7 * 24 * HOUR });
  assert.deepEqual(calls, [1], "nothing later can be newer");
  assert.deepEqual(found, { repos: [], complete: true });
});

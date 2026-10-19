import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_INCOMPLETE,
  EXIT_OK,
  EXIT_POST,
  EXIT_USAGE,
  UsageError,
  collectSnapshot,
  main,
  parseOptions,
  renderLine,
  renderReport,
} from "./factory-throughput-kpi.mjs";
import { clean } from "./lib/factory-kpi-render.mjs";
import { GhError } from "./lib/factory-kpi-github.mjs";
import { StateError, fileStore } from "./lib/factory-kpi-state.mjs";
import { HOUR, checkRun, detailNode, fakeGh, mergedNode, openNode, steadyNodes, tempDir } from "./lib/factory-kpi-test-helpers.mjs";

const NOW = "2026-10-18T12:00:00Z";
const END = Date.parse(NOW);
const DAY = 24 * HOUR;

// The gate refuses --now (its saved state would carry a made-up time), so gate runs get the time as a clock.
function gateClock(argv) {
  if (!argv.includes("--gate")) return { argv, deps: {} };
  const kept = [];
  let ms = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--now") {
      ms = Date.parse(argv[i + 1]);
      i += 1;
    } else kept.push(argv[i]);
  }
  return { argv: kept, deps: ms === null ? {} : { clock: () => ms } };
}

const run = async (argv, gh, env = {}) => {
  const out = [];
  const err = [];
  const timed = gateClock(argv);
  const code = await main(timed.argv, { gh, env, ...timed.deps, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

test("parseOptions needs repositories, validates names and numbers", () => {
  assert.throws(() => parseOptions([], {}), UsageError);
  assert.throws(() => parseOptions(["--repos", "nope"], {}), /expected owner\/name/);
  assert.throws(() => parseOptions(["--repos", "o/r", "--target", "0"], {}), /positive number/);
  assert.throws(() => parseOptions(["--repos", "o/r", "--now", "yesterday"], {}), /ISO date or a timestamp with a zone/);
  assert.throws(() => parseOptions(["--bogus"], {}), UsageError);
  const o = parseOptions(["--now", NOW, "--no-guard"], { FACTORY_KPI_REPOS: "o/a, o/b" });
  assert.deepEqual(o.repos, ["o/a", "o/b"]);
  assert.equal(o.targetPerHour, 6);
  assert.equal(o.sustainDays, 3);
});

test("parseOptions counts whole days only, covers the throughput days with the guard, and refuses zoneless times", () => {
  const parse = (...extra) => parseOptions(["--repos", "o/r", ...extra], {});
  for (const flag of ["--sustain-days", "--guard-days", "--detail-budget"]) {
    for (const bad of ["0", "1.5", "-2", "abc", ""]) assert.throws(() => parse(`${flag}=${bad}`), /whole number of at least 1/, `${flag} ${bad}`);
  }
  assert.equal(parse("--sustain-days", "3", "--guard-days", "1").guardDays, 3, "the guard may not be shorter than the throughput days");
  assert.equal(parse("--sustain-days", "3", "--guard-days", "7").guardDays, 7);
  assert.equal(parse("--sustain-days", "2").guardDays, 2);
  assert.throws(() => parse("--now", "2026-10-18T12:00:00"), /with a zone/, "local time is a guess");
  assert.throws(() => parse("--baseline-at", "2026-10-18T12:00:00"), /--baseline-at must be an ISO date or a timestamp with a zone/);
  assert.throws(() => parse("--now", "2026-13-45T25:00:00Z"), /ISO timestamp/);
  assert.equal(parse("--now", "2026-10-18T14:00:00+02:00").nowMs, END);
  assert.equal(parse("--now", "2026-10-18T12:00:00.000Z").nowMs, END);
  assert.equal(parse("--now", "2026-10-18").nowMs, Date.parse("2026-10-18T00:00:00Z"));
  assert.equal(parse("--baseline-at", NOW).baselineAtMs, END);
});

test("parseOptions lists each repository once, whatever its letter case", () => {
  assert.deepEqual(parseOptions(["--repos", "o/a,O/A, o/b ,o/a"], {}).repos, ["o/a", "o/b"]);
  assert.deepEqual(parseOptions([], { FACTORY_KPI_REPOS: "o/a,o/A" }).repos, ["o/a"]);
});

test("collectSnapshot reports the headline numbers across repos", async () => {
  const gh = fakeGh({
    "o/a": { merged: steadyNodes(END - 3 * DAY, END, 4, 1) },
    "o/b": { merged: steadyNodes(END - 3 * DAY, END, 3, 10_000) },
  });
  const snap = await collectSnapshot(parseOptions(["--repos", "o/a,o/b", "--now", NOW, "--no-guard"], {}), gh);
  assert.equal(snap.complete, true);
  const [h1, h6, h24] = snap.throughput.rates;
  assert.deepEqual([h1.merged, h6.merged, h24.merged], [7, 42, 168]);
  assert.equal(snap.throughput.sustained.consecutive, 3);
  assert.equal(snap.throughput.sustained.done, true);
  assert.deepEqual(snap.throughput.byRepo.map((r) => r.rates[2].merged), [96, 72]);
});

test("a repo that cannot be read is an error, never a zero", async () => {
  const gh = fakeGh({
    "o/a": { merged: steadyNodes(END - 3 * DAY, END, 8, 1) },
    "o/b": new GhError("forbidden", "Resource not accessible by integration", 403),
  });
  const r = await run(["--repos", "o/a,o/b", "--now", NOW, "--no-guard"], gh);
  assert.equal(r.code, EXIT_INCOMPLETE);
  assert.match(r.out, /ERROR\s+o\/b: forbidden/);
  assert.match(r.out, /DONE yes/, "a lower bound that already meets the target stays true");
  const down = await run(["--repos", "o/b", "--now", NOW, "--line", "--no-guard"], gh);
  assert.equal(down.code, EXIT_INCOMPLETE);
  assert.match(down.out, /done=unknown/);
  assert.match(down.out, /collection=INCOMPLETE/);
});

test("a truncated repo makes the verdict unknown, not false, and says so", async () => {
  // 1,440 PRs in 72 h at 5 per page: the 40 page cap ends the walk after 200 PRs (the newest 10 h).
  const gh = fakeGh({ "o/a": { merged: steadyNodes(END - 3 * DAY, END, 20, 1) } }, { pageSize: 5 });
  const snap = await collectSnapshot(parseOptions(["--repos", "o/a", "--now", NOW, "--no-guard"], {}), gh);
  assert.equal(snap.repos[0].status, "truncated");
  assert.equal(snap.complete, false);
  assert.equal(snap.throughput.sustained.done, null);
  assert.match(renderReport(snap), /WARN\s+o\/a: page cap reached/);
});

test("--json prints aggregates only (no per-PR rows) and --line stays on one line", async () => {
  const gh = fakeGh({ "o/a": { merged: [mergedNode(1, END - HOUR / 2), mergedNode(2, END - 2 * HOUR)] } });
  const json = JSON.parse((await run(["--repos", "o/a", "--now", NOW, "--json", "--no-guard"], gh)).out);
  assert.equal(json.throughput.rates[0].merged, 1);
  assert.equal("prs" in json, false);
  const line = (await run(["--repos", "o/a", "--now", NOW, "--line", "--no-guard"], gh)).out;
  assert.ok(!line.includes("\n"));
  assert.match(line, /^KPI merges 1h=1 6h=2 24h=2 \(0\.1\/h\) min6h=0\.0\/h sustained=0\/3 done=no/);
});

test("renderReport shows the sustained verdict and the anti-gaming shape", async () => {
  const gh = fakeGh({ "o/a": { merged: steadyNodes(END - 3 * DAY, END, 7, 1, { additions: 3, deletions: 1 }) } });
  const snap = await collectSnapshot(parseOptions(["--repos", "o/a", "--now", NOW, "--no-guard"], {}), gh);
  const text = renderReport(snap);
  assert.match(text, /sustained\s+3\/3 days\s+DONE yes/);
  assert.match(text, /tiny\(<=10\) 100%/);
  assert.match(renderLine(snap), /sustained=3\/3 done=yes/);
});

test("usage errors exit 2 and name the problem on stderr", async () => {
  const r = await run([], fakeGh({}));
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /name the repositories/);
});

test("a token in an API error never reaches the output", async () => {
  const token = "ghp_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt";
  const gh = fakeGh({ "o/a": new GhError("other", `request failed for token ${token}`) });
  const r = await run(["--repos", "o/a", "--now", NOW, "--no-guard"], gh);
  assert.ok(!r.out.includes(token) && !r.err.includes(token));
  assert.match(r.out, /\[redacted\]/);
  assert.equal(r.code, EXIT_INCOMPLETE);
});

test("outside text is flattened and capped before it is printed", () => {
  assert.equal(clean("a\nb\r\nc\u001b[0m\u2028d"), "a b c [0m d");
  assert.equal(clean("x".repeat(300)).length, 300);
  const long = clean("y".repeat(301));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith("…"));
  assert.equal(clean(null), "");
});

test("an exact secret from the environment is removed from error text even when it matches no token pattern", async () => {
  const secret = "plain-run-secret-0042";
  const gh = fakeGh({ "o/a": new GhError("other", `upstream said ${secret}`) });
  const r = await run(["--repos", "o/a", "--now", NOW, "--no-guard"], gh, { PAPERCLIP_API_KEY: secret });
  assert.ok(!r.out.includes(secret) && !r.err.includes(secret));
  assert.match(r.out, /upstream said \[redacted\]/);
});

test("--discover-org adds active repositories once, whatever their letter case", async () => {
  const gh = fakeGh({
    "o/a": { merged: steadyNodes(END - 3 * DAY, END, 4, 1) },
    "o/new": { merged: steadyNodes(END - 3 * DAY, END, 4, 1000) },
    "REST orgs/o/repos": [
      { full_name: "O/A", archived: false, pushed_at: new Date(END - HOUR).toISOString() },
      { full_name: "o/new", archived: false, pushed_at: new Date(END - HOUR).toISOString() },
    ],
  });
  const snap = await collectSnapshot(parseOptions(["--repos", "o/a", "--discover-org", "o", "--now", NOW, "--no-guard", "--no-support"], {}), gh);
  assert.deepEqual(snap.repos.map((r) => r.repo), ["o/a", "o/new"]);
  assert.equal(snap.complete, true);
});

test("--discover-org that fails, or lists too many repositories, makes the run incomplete", async () => {
  const base = { "o/a": { merged: steadyNodes(END - 3 * DAY, END, 4, 1) } };
  const args = ["--repos", "o/a", "--discover-org", "o", "--now", NOW, "--no-guard", "--no-support"];
  const denied = await run(args, fakeGh({ ...base, "REST orgs/o/repos": new GhError("forbidden", "denied", 403) }));
  assert.equal(denied.code, EXIT_INCOMPLETE);
  assert.match(denied.out, /ERROR\s+org:o: forbidden/);
  const full = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}`, archived: false, pushed_at: new Date(END - i * 60_000).toISOString() }));
  const gh = fakeGh(base);
  const rest = gh.rest.bind(gh);
  gh.rest = async (path, params) => (path === "orgs/o/repos" ? full.map((r) => ({ ...r, full_name: params.page === 1 ? r.full_name : `${r.full_name}-p${params.page}` })) : rest(path, params));
  const many = await run([...args, "--target", "1"], gh);
  assert.equal(many.code, EXIT_INCOMPLETE);
  assert.match(many.out, /more repositories than were listed/);
});

test("with the guard on, an unreadable repository leaves the verdict unknown even when the others pass", async () => {
  const repo = guardedRepo();
  repo["o/z"] = new GhError("forbidden", "Resource not accessible by integration", 403);
  const r = await run([...GATE_BASE, "--repos", "o/a,o/z", "--no-support"], fakeGh(repo));
  assert.equal(r.code, EXIT_INCOMPLETE);
  assert.match(r.out, /DONE unknown/);
  assert.match(r.out, /collection incomplete/);
  assert.match(r.out, /guard\s+UNKNOWN/, "the guard itself does not call the readable repository clean");
  assert.match(r.out, /o\/z\s+UNKNOWN/);
});

test("the real entry point fails closed when gh is missing", () => {
  const script = fileURLToPath(new URL("./factory-throughput-kpi.mjs", import.meta.url));
  const res = spawnSync(process.execPath, [script, "--repos", "o/a", "--now", NOW, "--no-guard"], {
    env: { PATH: "/nonexistent", HOME: "/nonexistent" },
    encoding: "utf8",
  });
  assert.equal(res.status, EXIT_INCOMPLETE);
  assert.match(res.stdout, /ERROR\s+o\/a: missing: gh is not installed/);
  assert.match(res.stdout, /DONE unknown/);
  assert.equal(EXIT_OK, 0);
});

// --- quality guard -------------------------------------------------------------------------

const requireCi = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } };
const notProtected = new GhError("notfound", "Branch not protected", 404);
const GUARD_ARGS = ["--repos", "o/a", "--now", NOW, "--sustain-days", "1", "--guard-days", "1", "--target", "1"];

// Two merges an hour for a day, each with a green "ci" run finished before the merge.
// `until` lets a fixture keep merging after the evaluation time, for runs that happen later.
function guardedRepo({ rules = [requireCi], protection = notProtected, tweak = () => {}, until = END } = {}) {
  const merged = steadyNodes(END - DAY, until, 2, 1);
  const details = {};
  for (const node of merged) {
    const at = Date.parse(node.mergedAt);
    details[node.number] = detailNode(node.number, at, { checks: [checkRun("ci", "SUCCESS", at - 5 * 60_000)] });
  }
  tweak(merged, details);
  return { "o/a": { merged, details }, "REST repos/o/a/rules/branches/main": rules, "REST repos/o/a/branches/main/protection": protection };
}

test("the guard is on by default and a clean day with a baseline is DONE yes", async () => {
  const r = await run([...GUARD_ARGS, "--baseline", "1/40"], fakeGh(guardedRepo()));
  assert.equal(r.code, EXIT_OK);
  assert.match(r.out, /sustained\s+1\/1 days\s+DONE yes/);
  assert.ok(!r.out.includes("throughput only"));
  assert.match(r.out, /guard\s+PASS/);
  assert.match(r.out, /o\/a\s+PASS\s+48 merges\s+1 required checks, 0 approvals/);
  assert.match(r.out, /revert\+hotfix 7d\s+0\/48 .* vs baseline 1\/40 .*INSUFFICIENT_DATA/);
  assert.match((await run([...GUARD_ARGS, "--baseline", "1/40", "--line"], fakeGh(guardedRepo()))).out, /guard=pass revert_hotfix=insufficient_data done=yes$/);
});

test("a merge with a failing required check makes DONE no and names the PR", async () => {
  const gh = fakeGh(
    guardedRepo({
      tweak: (merged, details) => {
        details[7] = detailNode(7, Date.parse(merged.find((n) => n.number === 7).mergedAt), { checks: [checkRun("ci", "FAILURE", END - 30 * HOUR)] });
      },
    }),
  );
  const r = await run([...GUARD_ARGS, "--baseline", "1/40"], gh);
  assert.equal(r.code, EXIT_OK, "the report was fully collected");
  assert.match(r.out, /DONE no/);
  assert.match(r.out, /blocked by: quality guard: merge with failing or missing required checks/);
  assert.match(r.out, /1 VIOLATION/);
  assert.match(r.out, /#7: required check "ci" failing/);
});

test("a repo without required checks cannot be called clean", async () => {
  const r = await run([...GUARD_ARGS, "--baseline", "1/40"], fakeGh(guardedRepo({ rules: [] })));
  assert.match(r.out, /guard\s+UNENFORCED/);
  assert.match(r.out, /DONE no/);
  assert.match(r.out, /cannot prove zero bypass/);
});

test("unreadable rules make the answer unknown and the exit code 20", async () => {
  const denied = new GhError("forbidden", "Resource not accessible by integration", 403);
  const r = await run([...GUARD_ARGS, "--baseline", "1/40"], fakeGh(guardedRepo({ rules: denied, protection: denied })));
  assert.equal(r.code, EXIT_INCOMPLETE);
  assert.match(r.out, /guard\s+UNKNOWN/);
  assert.match(r.out, /DONE unknown/);
  assert.match(r.out, /enforcement: forbidden/);
  const line = await run([...GUARD_ARGS, "--line"], fakeGh(guardedRepo({ rules: denied, protection: denied })));
  assert.match(line.out, /collection=INCOMPLETE/);
});

test("without a baseline the revert/hotfix share cannot be judged, so DONE is unknown", async () => {
  const r = await run(GUARD_ARGS, fakeGh(guardedRepo()));
  assert.match(r.out, /DONE unknown/);
  assert.match(r.out, /blocked by: revert\/hotfix baseline missing/);
  assert.match(r.out, /vs baseline none\s+NO_BASELINE/);
});

test("an invalid baseline is a usage error", async () => {
  const r = await run([...GUARD_ARGS, "--baseline", "9/3"], fakeGh({}));
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /EVENTS\/TOTAL/);
});

test("--no-guard makes no rule or detail request and labels the verdict throughput-only", async () => {
  const gh = fakeGh(guardedRepo());
  const r = await run([...GUARD_ARGS, "--no-guard"], gh);
  assert.equal(gh.calls.filter((c) => c.kind === "rest").length, 0);
  assert.equal(gh.calls.filter((c) => c.kind === "graphql" && c.variables.first === undefined).length, 0);
  assert.match(r.out, /DONE yes \(throughput only, guard skipped\)/);
  assert.doesNotMatch(r.out, /guard\s+PASS/);
});

test("a merge list cut short makes the guard unknown and says so, even when every PR read was clean", async () => {
  const r = await run([...GATE_BASE, "--no-support"], fakeGh(guardedRepo(), { pageSize: 1 }));
  assert.equal(r.code, EXIT_INCOMPLETE);
  assert.match(r.out, /guard\s+UNKNOWN/);
  assert.match(r.out, /the merge list was cut short, so merges may be missing/);
  assert.match(r.out, /DONE unknown/);
});

test("the guard only ever reads: no mutation, GET-only REST", async () => {
  const gh = fakeGh(guardedRepo());
  await run([...GUARD_ARGS, "--baseline", "1/40"], gh);
  for (const call of gh.calls) {
    if (call.kind === "graphql") assert.doesNotMatch(call.query, /\b(mutation|subscription)\b/i);
    else assert.match(call.path, /^repos\/o\/a\/(rules\/branches|branches)\/main(\/protection)?$/);
  }
});

test("the cache lets a second snapshot skip every detail request", async () => {
  const gh = fakeGh(guardedRepo());
  const options = parseOptions([...GUARD_ARGS, "--baseline", "1/40"], {});
  const cache = {};
  const first = await collectSnapshot(options, gh, { cache });
  const detailRequests = () => gh.calls.filter((c) => c.kind === "graphql" && c.variables.first === undefined).length;
  const afterFirst = detailRequests();
  assert.ok(afterFirst > 0);
  const second = await collectSnapshot(options, gh, { cache });
  assert.equal(detailRequests(), afterFirst);
  assert.deepEqual(second.guard.repos[0].counts, first.guard.repos[0].counts);
  assert.equal(second.verdict.done, true);
});

test("a small detail budget reports what is still unverified instead of passing", async () => {
  const r = await run([...GUARD_ARGS, "--baseline", "1/40", "--detail-budget", "10"], fakeGh(guardedRepo()));
  assert.equal(r.code, EXIT_INCOMPLETE);
  assert.match(r.out, /38 not fetched yet/);
  assert.match(r.out, /guard\s+UNKNOWN/);
  assert.match(r.out, /DONE unknown/);
});

test("a computed baseline reaches back before the trailing week", async () => {
  const merged = steadyNodes(END - 14 * DAY, END, 1, 1);
  merged.find((n) => Date.parse(n.mergedAt) < END - 4 * DAY && Date.parse(n.mergedAt) > END - 9 * DAY).title = "hotfix: old";
  const gh = fakeGh({ "o/a": { merged, details: {} }, "REST repos/o/a/rules/branches/main": [requireCi], "REST repos/o/a/branches/main/protection": notProtected }, { pageSize: 100 });
  const options = parseOptions(["--repos", "o/a", "--now", NOW, "--sustain-days", "1", "--guard-days", "1", "--baseline-at", new Date(END - 3 * DAY).toISOString(), "--detail-budget", "1"], {});
  const snap = await collectSnapshot(options, gh);
  assert.equal(snap.regression.baselineSource, "computed");
  assert.deepEqual([snap.regression.baseline.events, snap.regression.baseline.total], [1, 168]);
});

test("--json carries the guard and revert/hotfix sections and still no per-PR rows", async () => {
  const json = JSON.parse((await run([...GUARD_ARGS, "--baseline", "1/40", "--json"], fakeGh(guardedRepo()))).out);
  assert.equal(json.guard.overall, "pass");
  assert.equal(json.regression.state, "insufficient_data");
  assert.equal(json.verdict.done, true);
  assert.equal("prs" in json, false);
});

// --- gate ----------------------------------------------------------------------------------

const GATE_BASE = [...GUARD_ARGS, "--baseline", "1/40"];
const minutesLater = (m) => new Date(END + m * 60_000).toISOString();
const stateFile = async () => join(tempDir("kpi-gate-"), "state.json");
const gateArgs = (minutes, ...extra) => [...GATE_BASE, "--now", minutesLater(minutes), "--gate", "--state-file", "unused", ...extra];
const PAPERCLIP_ENV_FOR_STATE = { PAPERCLIP_API_URL: "https://paperclip.example", PAPERCLIP_API_KEY: "secret-key-value" };
async function gateMain(argv, deps) {
  const out = [];
  const timed = gateClock(argv);
  const code = await main(timed.argv, { env: {}, ...timed.deps, ...deps, stdout: (t) => out.push(t), stderr: () => {} });
  return { code, out: out.join("\n") };
}
function fileStoreSpy(file, onWrite) {
  const real = fileStore(file);
  return { read: () => real.read(), write: (state) => (onWrite(), real.write(state)) };
}
const detailRequests = (gh) => gh.calls.filter((c) => c.kind === "graphql" && c.variables.first === undefined).length;

test("--now is refused together with --gate", () => {
  assert.throws(() => parseOptions(["--repos", "o/r", "--gate", "--state-file", "x", "--now", NOW], {}), /--now cannot be used with --gate/);
});

test("--gate needs somewhere to keep state", async () => {
  const r = await run([...GATE_BASE, "--gate"], fakeGh(guardedRepo()));
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /--gate needs --state-file or --state-issue/);
});

test("--help works without any repository", async () => {
  const r = await run(["--help"], fakeGh({}));
  assert.equal(r.code, EXIT_OK);
  assert.match(r.out, /usage: factory-throughput-kpi/);
  assert.match(r.out, /--gate/);
});

test("gate: the first run speaks, the next quiet run prints nothing and fetches nothing new", async () => {
  const file = await stateFile();
  const first = fakeGh(guardedRepo({ until: END + HOUR }));
  const a = await run([...GATE_BASE, "--gate", "--state-file", file], first);
  assert.equal(a.code, EXIT_POST);
  assert.match(a.out, /^KPI merges /);
  assert.match(a.out, /why: first run/);
  assert.ok(detailRequests(first) > 0);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.lastPosted.guard, "pass");
  assert.equal(Object.keys(saved.cache).filter((key) => !key.startsWith("@")).length, 48);
  assert.ok(saved.cache["@rules:o/a"].fp, "the rules fingerprint is saved too");

  const second = fakeGh(guardedRepo({ until: END + HOUR }));
  const b = await run([...GATE_BASE, "--now", minutesLater(30), "--gate", "--state-file", file], second);
  assert.equal(b.code, EXIT_OK);
  assert.equal(b.out, "", "silent means no output at all");
  assert.equal(b.err, "");
  const asked = second.calls.filter((c) => c.kind === "graphql" && c.variables.first === undefined).flatMap((c) => [...c.query.matchAll(/p(\d+):pullRequest/g)].map((m) => Number(m[1])));
  assert.deepEqual(asked.filter((n) => n <= 48), [], "merges judged by the first run come from the saved state");
  assert.ok(asked.length > 0 && asked.length <= 2, "only the merges since then are fetched");
});

test("gate: a later merge that bypassed a required check speaks, once", async () => {
  const file = await stateFile();
  const horizon = 6 * HOUR;
  await run([...GATE_BASE, "--gate", "--state-file", file], fakeGh(guardedRepo({ until: END + horizon })));
  const bad = guardedRepo({
    until: END + horizon,
    tweak: (merged, details) => {
      const at = END + 10 * 60_000;
      merged.push(mergedNode(1000, at));
      details[1000] = detailNode(1000, at, { checks: [] });
    },
  });
  const a = await run([...GATE_BASE, "--now", minutesLater(30), "--gate", "--state-file", file], fakeGh(bad));
  assert.equal(a.code, EXIT_POST);
  assert.match(a.out, /why: .*guard pass -> fail/);
  assert.match(a.out, /new violation o\/a#1000/);
  assert.match(a.out, /violation o\/a#1000: required check "ci" missing/);
  const again = await run([...GATE_BASE, "--now", minutesLater(60), "--gate", "--state-file", file], fakeGh(bad));
  assert.equal(again.code, EXIT_OK);
  assert.equal(again.out, "");
});

test("gate: the heartbeat speaks after four quiet hours", async () => {
  const file = await stateFile();
  const repo = () => fakeGh(guardedRepo({ until: END + 6 * HOUR }));
  await run([...GATE_BASE, "--gate", "--state-file", file], repo());
  const quiet = await run([...GATE_BASE, "--now", minutesLater(200), "--gate", "--state-file", file], repo());
  assert.equal(quiet.code, EXIT_OK, "3 h 20 min later: nothing yet");
  const beat = await run([...GATE_BASE, "--now", minutesLater(241), "--gate", "--state-file", file], repo());
  assert.equal(beat.code, EXIT_POST);
  assert.match(beat.out, /why: heartbeat \(4 h since the last line\)/);
});

test("gate: unreadable state speaks instead of staying silent", async () => {
  const file = await stateFile();
  await writeFile(file, "{broken");
  const r = await run([...GATE_BASE, "--gate", "--state-file", file], fakeGh(guardedRepo()));
  assert.equal(r.code, EXIT_POST);
  assert.match(r.out, /why: state unreadable \(state file is not valid JSON\)/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).lastPosted.guard, "pass", "the state is repaired");
});

test("gate: a state that cannot be saved is reported, and --json carries the reasons", async () => {
  const out = [];
  const store = { read: async () => null, write: async () => { throw new StateError("saving state failed with HTTP 409"); } };
  const timed = gateClock([...GATE_BASE, "--gate", "--state-file", "unused"]);
  const code = await main(timed.argv, { gh: fakeGh(guardedRepo()), env: {}, store, ...timed.deps, stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, EXIT_POST);
  assert.match(out.join("\n"), /state not saved \(saving state failed with HTTP 409\), the next run will speak again/);
  const jsonOut = [];
  const jsonTimed = gateClock([...GATE_BASE, "--gate", "--state-file", "unused", "--json"]);
  await main(jsonTimed.argv, { gh: fakeGh(guardedRepo()), env: {}, store: { read: async () => null, write: async () => {} }, ...jsonTimed.deps, stdout: (t) => jsonOut.push(t), stderr: () => {} });
  const parsed = JSON.parse(jsonOut.join(""));
  assert.deepEqual(parsed.gate.reasons, ["first run"]);
  assert.equal("prs" in parsed, false);
});

test("gate: the state file can come from the environment", async () => {
  const file = await stateFile();
  const a = await run([...GATE_BASE, "--gate"], fakeGh(guardedRepo()), { FACTORY_KPI_STATE_FILE: file });
  assert.equal(a.code, EXIT_POST);
  assert.equal(JSON.parse(await readFile(file, "utf8")).lastPosted.guard, "pass");
});

test("gate: issue document state needs the Paperclip credentials", async () => {
  const r = await run([...GATE_BASE, "--gate", "--state-issue", "abc-123"], fakeGh(guardedRepo()), {});
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /Paperclip API url and key/);
});

test("gate: an incomplete collection is reported once and then stays quiet until the heartbeat", async () => {
  const file = await stateFile();
  const denied = new GhError("forbidden", "denied", 403);
  const broken = guardedRepo({ rules: denied, protection: denied });
  const a = await run([...GATE_BASE, "--gate", "--state-file", file], fakeGh(broken));
  assert.equal(a.code, EXIT_POST);
  assert.match(a.out, /collection=INCOMPLETE/);
  const b = await run([...GATE_BASE, "--now", minutesLater(30), "--gate", "--state-file", file], fakeGh(broken));
  assert.equal(b.code, EXIT_OK);
  assert.equal(b.out, "");
});

test("gate: a silent run with merges still unjudged saves them without touching the last line", async () => {
  const file = await stateFile();
  const repo = () => guardedRepo({ until: END + 2 * HOUR });
  await run([...GATE_BASE, "--detail-budget", "10", "--gate", "--state-file", file], fakeGh(repo()));
  const first = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.keys(first.cache).filter((key) => !key.startsWith("@")).length, 10, "the budget limited the first run");
  const second = await run([...GATE_BASE, "--detail-budget", "10", "--now", minutesLater(20), "--gate", "--state-file", file], fakeGh(repo()));
  assert.equal(second.code, EXIT_OK, "still nothing to say");
  assert.equal(second.out, "");
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.keys(after.cache).filter((key) => !key.startsWith("@")).length, 20, "the next ten were saved");
  assert.deepEqual(after.lastPosted, first.lastPosted, "the record of what was last posted is untouched");
});

test("gate: a backlog is saved on a silent run even when the guard already failed, so the run is not 'incomplete'", async () => {
  const file = await stateFile();
  const repo = () =>
    guardedRepo({
      until: END + 2 * HOUR,
      tweak: (merged, details) => {
        const at = Date.parse(merged.find((n) => n.number === 48).mergedAt);
        details[48] = detailNode(48, at, { checks: [checkRun("ci", "FAILURE", at - 5 * 60_000)] });
      },
    });
  const a = await run([...GATE_BASE, "--detail-budget", "10", "--gate", "--state-file", file], fakeGh(repo()));
  assert.equal(a.code, EXIT_POST);
  assert.match(a.out, /guard=fail/);
  const first = JSON.parse(await readFile(file, "utf8"));
  const judged = (state) => Object.keys(state.cache).filter((key) => !key.startsWith("@")).length;
  assert.equal(judged(first), 10);
  const b = await run([...GATE_BASE, "--detail-budget", "10", "--now", minutesLater(20), "--gate", "--state-file", file], fakeGh(repo()));
  assert.equal(b.code, EXIT_OK, "the violation is not new, so there is nothing to say");
  assert.equal(b.out, "");
  assert.equal(judged(JSON.parse(await readFile(file, "utf8"))), 20, "the merges judged by this run were kept");
});

test("gate: a silent run does not write when there is nothing to save", async () => {
  const file = await stateFile();
  await run([...GATE_BASE, "--gate", "--state-file", file], fakeGh(guardedRepo({ until: END + HOUR })));
  let writes = 0;
  const store = fileStoreSpy(file, () => (writes += 1));
  const r = await gateMain(gateArgs(30), { gh: fakeGh(guardedRepo({ until: END + HOUR })), store });
  assert.equal(r.code, EXIT_OK);
  assert.equal(writes, 0);
});

test("gate: a silent run that cannot save speaks, because a gate that cannot remember is broken", async () => {
  const file = await stateFile();
  await run([...GATE_BASE, "--detail-budget", "10", "--gate", "--state-file", file], fakeGh(guardedRepo({ until: END + 2 * HOUR })));
  const real = fileStore(file);
  const store = { read: () => real.read(), write: async () => { throw new StateError("cannot write state file: EROFS"); } };
  const r = await gateMain(gateArgs(20, "--detail-budget", "10"), { gh: fakeGh(guardedRepo({ until: END + 2 * HOUR })), store });
  assert.equal(r.code, EXIT_POST);
  assert.match(r.out, /why: state not saved \(cannot write state file: EROFS\)/);
});

test("gate: one incomplete run is a blip, the second in a row speaks, a complete run resets the count", async () => {
  const file = await stateFile();
  const denied = new GhError("forbidden", "denied", 403);
  const healthy = () => fakeGh(guardedRepo({ until: END + 6 * HOUR }));
  const broken = () => fakeGh(guardedRepo({ rules: denied, protection: denied, until: END + 6 * HOUR }));
  await run([...GATE_BASE, "--gate", "--state-file", file], healthy());
  const blip = await run([...GATE_BASE, "--now", minutesLater(30), "--gate", "--state-file", file], broken());
  assert.equal(blip.code, EXIT_OK, "one failed read is not worth a line");
  assert.equal(JSON.parse(await readFile(file, "utf8")).incompleteStreak, 1, "but it is counted");
  const second = await run([...GATE_BASE, "--now", minutesLater(60), "--gate", "--state-file", file], broken());
  assert.equal(second.code, EXIT_POST);
  assert.match(second.out, /why: collection incomplete for 2 runs in a row/);
  const third = await run([...GATE_BASE, "--now", minutesLater(90), "--gate", "--state-file", file], broken());
  assert.equal(third.code, EXIT_OK, "an outage that was already reported stays quiet");
  const back = await run([...GATE_BASE, "--now", minutesLater(120), "--gate", "--state-file", file], healthy());
  assert.equal(back.code, EXIT_POST);
  assert.match(back.out, /why: collection is complete again/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).incompleteStreak, 0);
});

test("gate: a different configuration speaks instead of comparing numbers that mean something else", async () => {
  const file = await stateFile();
  const repo = () => fakeGh(guardedRepo({ until: END + HOUR }));
  await run([...GATE_BASE, "--gate", "--state-file", file], repo());
  const changed = await run([...GATE_BASE, "--target", "2", "--now", minutesLater(30), "--gate", "--state-file", file], repo());
  assert.equal(changed.code, EXIT_POST);
  assert.match(changed.out, /why: configuration changed/);
});

test("gate: a crash inside the gate is a line, never silence", async () => {
  // A failing read becomes an error entry, so break something that is not a read: the store.
  const store = { read: async () => { throw new RangeError("store exploded\nwhy: forged"); }, write: async () => {} };
  const r = await gateMain(gateArgs(0), { gh: fakeGh(guardedRepo()), store });
  assert.equal(r.code, EXIT_POST);
  assert.equal(r.out, "gate failed: store exploded why: forged");
});

test("gate: the state document key must be one of the gate's own", async () => {
  const r = await run([...GATE_BASE, "--gate", "--state-issue", "abc-123", "--state-key", "plan"], fakeGh(guardedRepo()), PAPERCLIP_ENV_FOR_STATE);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /invalid state document key: it must start with kpi-/);
});

test("gate: state in an issue document works end to end through the injected fetch", async () => {
  let doc = null;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    if (init.method === "GET") return doc ? { ok: true, status: 200, json: async () => doc } : { ok: false, status: 404, json: async () => ({}) };
    doc = { key: "kpi-state", body: JSON.parse(init.body).body, latestRevisionId: `rev-${seen.length}` };
    return { ok: true, status: 200, json: async () => doc };
  };
  const first = await runWithFetch([...GATE_BASE, "--gate", "--state-issue", "abc-123"], fakeGh(guardedRepo({ until: END + HOUR })), PAPERCLIP_ENV_FOR_STATE, fetchImpl);
  assert.equal(first.code, EXIT_POST);
  const quiet = await runWithFetch([...GATE_BASE, "--now", minutesLater(30), "--gate", "--state-issue", "abc-123"], fakeGh(guardedRepo({ until: END + HOUR })), PAPERCLIP_ENV_FOR_STATE, fetchImpl);
  assert.equal(quiet.code, EXIT_OK);
  assert.equal(quiet.out, "");
  assert.deepEqual(seen.map((line) => line.split(" ")[0]), ["GET", "PUT", "GET"], "the second run only reads: nothing to save");
  assert.ok(seen.every((line) => line.endsWith("/api/issues/abc-123/documents/kpi-state")));
});

test("the real entry point exits 10 with a line when the gate has something to say, and 0 in silence", () => {
  const script = fileURLToPath(new URL("./factory-throughput-kpi.mjs", import.meta.url));
  const dir = tempDir("kpi-entry-");
  const file = join(dir, "state.json");
  const args = [script, "--gate", "--state-file", file, "--repos", "o/a", "--no-guard", "--no-support"];
  const env = { PATH: "/nonexistent", HOME: "/nonexistent" };
  const first = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(first.status, EXIT_POST);
  assert.match(first.stdout, /^KPI merges /);
  assert.match(first.stdout, /why: first run/);
  const second = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(second.status, EXIT_OK, "the same outage one run later is a blip, not a line");
  assert.equal(second.stdout, "");
});

// --- supporting metrics ----------------------------------------------------------------------

test("the report shows open PRs by state, the longest wait and review latency", async () => {
  const repo = guardedRepo();
  repo["o/a"].open = [
    openNode(901, { createdMs: END - 40 * HOUR }),
    openNode(902, { draft: true, createdMs: END - 90 * HOUR }),
    openNode(903, { mergeable: "CONFLICTING", createdMs: END - 5 * HOUR }),
    openNode(904, { checks: "FAILURE", createdMs: END - 6 * HOUR }),
    openNode(905, { reviewDecision: "APPROVED", createdMs: END - 80 * HOUR, reviews: [{ state: "APPROVED", atMs: END - HOUR }] }),
  ];
  const r = await run([...GATE_BASE], fakeGh(repo));
  assert.match(r.out, /open PRs\s+5\s+draft 1\s+conflicts 1\s+ci_failing 1\s+ci_pending 0\s+changes_requested 0\s+waiting_review 1\s+ready 1/);
  assert.match(r.out, /o\/a\s+5\s+draft 1/);
  assert.match(r.out, /longest wait for a first review: o\/a#901 40\.0 h/);
  assert.match(r.out, /review 24h\s+48 merged\s+first review p50 n\/a\s+p90 n\/a\s+48 merged without a review by someone else/);
});

test("--no-support makes no open-PR request and prints no support lines", async () => {
  const gh = fakeGh(guardedRepo());
  const r = await run([...GATE_BASE, "--no-support"], gh);
  assert.ok(!gh.calls.some((c) => c.kind === "graphql" && String(c.query).includes("states:OPEN")));
  assert.doesNotMatch(r.out, /open PRs|review 24h/);
});

test("an unreadable open-PR list is shown as unavailable and does not change the verdict or exit code", async () => {
  const repo = guardedRepo();
  const gh = fakeGh(repo);
  const real = gh.graphql.bind(gh);
  gh.graphql = async (query, vars) => {
    if (query.includes("states:OPEN")) throw new GhError("ratelimit", "API rate limit exceeded", 403);
    return real(query, vars);
  };
  const r = await run([...GATE_BASE], gh);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.out, /DONE yes/);
  assert.match(r.out, /o\/a\s+unavailable \(ratelimit: API rate limit exceeded\)/);
});

test("--json carries the support section", async () => {
  const json = JSON.parse((await run([...GATE_BASE, "--json"], fakeGh(guardedRepo()))).out);
  assert.equal(json.support.open.total, 0);
  assert.equal(json.support.review.merged, 48);
  assert.equal(json.support.open.complete, true);
});

test("support metrics never trigger the gate, and a gate run does not request them", async () => {
  const file = await stateFile();
  const repo = () => guardedRepo({ until: END + HOUR });
  await run([...GATE_BASE, "--gate", "--state-file", file], fakeGh(repo()));
  const busier = repo();
  busier["o/a"].open = Array.from({ length: 60 }, (_, i) => openNode(2000 + i, { createdMs: END - 90 * HOUR }));
  const gh = fakeGh(busier);
  const r = await run([...GATE_BASE, "--now", minutesLater(30), "--gate", "--state-file", file], gh);
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.out, "");
  assert.ok(!gh.calls.some((c) => c.kind === "graphql" && String(c.query).includes("states:OPEN")));
});

test("a capped open-PR list is flagged as a lower bound", async () => {
  const repo = guardedRepo();
  repo["o/a"].open = Array.from({ length: 60 }, (_, i) => openNode(3000 + i, { createdMs: END - 5 * HOUR }));
  const gh = fakeGh(repo, { pageSize: 5 });
  const r = await run([...GATE_BASE], gh);
  assert.match(r.out, /WARN\s+open PR list truncated/);
  assert.match(r.out, /open PRs\s+50\s/);
});

// --- agents -----------------------------------------------------------------------------------

const PAPERCLIP_ENV = { PAPERCLIP_API_URL: "https://paperclip.example", PAPERCLIP_API_KEY: "secret-key-value", PAPERCLIP_COMPANY_ID: "co-1" };
const dashboardOk = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ agents: { active: 5, running: 18, paused: 9, error: 0 }, tasks: { open: 608, inProgress: 27, blocked: 93 } }),
});
const runWithFetch = async (argv, gh, env, fetchImpl) => {
  const out = [];
  const err = [];
  const timed = gateClock(argv);
  const code = await main(timed.argv, { gh, env, fetch: fetchImpl, ...timed.deps, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

test("--agents adds idle versus busy agents and says the wake queues are not readable yet", async () => {
  const r = await runWithFetch([...GATE_BASE, "--agents"], fakeGh(guardedRepo()), PAPERCLIP_ENV, dashboardOk);
  assert.match(r.out, /agents\s+idle 5\s+running 18\s+paused 9\s+error 0\s+tasks open 608\s+in_progress 27\s+blocked 93/);
  assert.match(r.out, /wakes\s+queued and deferred wakes are not readable with an agent token yet/);
  assert.ok(!r.out.includes("secret-key-value"));
});

test("--agents without Paperclip credentials is a usage error and agents are off by default", async () => {
  const r = await run([...GATE_BASE, "--agents"], fakeGh({}), {});
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /--agents needs PAPERCLIP_API_URL/);
  const quiet = await runWithFetch([...GATE_BASE], fakeGh(guardedRepo()), PAPERCLIP_ENV, async () => { throw new Error("must not be called"); });
  assert.doesNotMatch(quiet.out, /agents\s+idle/);
});

test("an unreadable dashboard is shown as unavailable and changes neither verdict nor exit code", async () => {
  const r = await runWithFetch([...GATE_BASE, "--agents"], fakeGh(guardedRepo()), PAPERCLIP_ENV, async () => ({ ok: false, status: 403, json: async () => ({}) }));
  assert.equal(r.code, EXIT_OK);
  assert.match(r.out, /DONE yes/);
  assert.match(r.out, /agents\s+unavailable \(auth: dashboard request failed with HTTP 403\)/);
});

test("--json carries the agents section and the API key is not in it", async () => {
  const r = await runWithFetch([...GATE_BASE, "--agents", "--json"], fakeGh(guardedRepo()), PAPERCLIP_ENV, dashboardOk);
  const json = JSON.parse(r.out);
  assert.equal(json.agents.agents.idle, 5);
  assert.ok(!r.out.includes("secret-key-value"));
});

test("agent counts never trigger the gate", async () => {
  const file = await stateFile();
  const repo = () => guardedRepo({ until: END + HOUR });
  const env = { ...PAPERCLIP_ENV };
  let reads = 0;
  const counting = async () => {
    reads += 1;
    return dashboardOk();
  };
  const first = await runWithFetch([...GATE_BASE, "--agents", "--gate", "--state-file", file], fakeGh(repo()), env, counting);
  assert.equal(first.code, EXIT_POST);
  assert.equal(reads, 0, "a gate run does not read the dashboard: the gate line never shows agents");
  const busier = async () => ({ ok: true, status: 200, json: async () => ({ agents: { active: 0, running: 40, paused: 0, error: 9 }, tasks: { open: 1, inProgress: 1, blocked: 1 } }) });
  const r = await runWithFetch([...GATE_BASE, "--now", minutesLater(30), "--agents", "--gate", "--state-file", file], fakeGh(repo()), env, busier);
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.out, "");
});

// --- merges that did not land --------------------------------------------------------------------

const GUARDLESS = ["--repos", "o/a", "--now", NOW, "--no-guard", "--no-support"];

// 5 merges into main and 4 into other branches inside the last 24 h; only the 5 are the KPI.
function mixedRepo(hostileBase = "feat/convex-integration") {
  return {
    "o/a": {
      merged: [
        ...[1, 2, 3, 4, 5].map((n) => mergedNode(n, END - n * HOUR, { head: n === 5 ? "feat/ci" : `feat/${n}` })),
        ...[6, 7, 8].map((n) => mergedNode(n, END - n * HOUR, { base: hostileBase, head: `feat/${n}` })),
        mergedNode(9, END - 9 * HOUR, { base: "feat/ci", head: "feat/ci-a" }),
      ],
      carriers: { [hostileBase]: [{ number: 42, state: "OPEN", baseRefName: "main", headRefOid: "t", isCrossRepository: false }] },
    },
  };
}

test("the headline counts only merges into the default branch; the others are shown next to it", async () => {
  const r = await run(GUARDLESS, fakeGh(mixedRepo()));
  assert.match(r.out, /merges\s+1h 0\s+\(0\.0\/h\)\s+6h 5\s+\(0\.8\/h\)\s+24h 5\s+\(0\.2\/h\)/);
  assert.match(r.out, /raw merged 24h\s+9 = landed on the default branch 5 \(the KPI\) \+ merged into other branches 4 \(not counted\)/);
  assert.match(r.out, /not landed 24h\s+4: carried by another PR 3 \(commit-verified 0\), no PR carries the branch 1, unknown 0/);
  assert.match(r.out, /o\/a\s+merged into: feat\/convex-integration 3, feat\/ci 1/);
  assert.match(r.out, /o\/a\s+landed with stacked PRs: #5 \+1/);
});

test("--json carries the landing section and the per-repo list stays out", async () => {
  const json = JSON.parse((await run([...GUARDLESS, "--json"], fakeGh(mixedRepo()))).out);
  assert.equal(json.throughput.rates[2].merged, 5);
  assert.equal(json.landing.raw24h, 9);
  assert.equal(json.landing.repos[0].byBase[0].base, "feat/convex-integration");
  assert.equal(json.landing.repos[0].items, undefined);
});

test("--no-landing prints no landing lines and asks for no carriers", async () => {
  const gh = fakeGh(mixedRepo());
  const r = await run([...GUARDLESS, "--no-landing"], gh);
  assert.doesNotMatch(r.out, /raw merged|not landed/);
  assert.ok(!gh.calls.some((c) => c.variables?.h0 !== undefined));
  assert.equal(JSON.parse((await run([...GUARDLESS, "--no-landing", "--json"], fakeGh(mixedRepo()))).out).landing, null);
});

test("a gate run asks for no carriers, and a different landing section never wakes the gate", async () => {
  const file = await stateFile();
  const base = ["--repos", "o/a", "--no-guard", "--no-support", "--gate", "--state-file", file];
  await run([...base, "--now", NOW], fakeGh(mixedRepo()));
  const different = mixedRepo();
  different["o/a"].merged.push(...[20, 21, 22].map((n) => mergedNode(n, END + n * 1000, { base: "tmp/other", head: `feat/${n}` })));
  const gh = fakeGh(different);
  const r = await run([...base, "--now", minutesLater(30)], gh);
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.out, "");
  assert.ok(!gh.calls.some((c) => c.variables?.h0 !== undefined));
});

test("branch names from outside cannot add lines or smuggle control characters into the report", async () => {
  const r = await run(GUARDLESS, fakeGh(mixedRepo("evil\nERROR      o/a: injected\u001b[31m")));
  assert.doesNotMatch(r.out, /^ERROR\s+o\/a: injected/m);
  assert.doesNotMatch(r.out, /\u001b/);
  assert.match(r.out, /merged into: evil ERROR\s+o\/a: injected/);
});

test("an unreadable carrier lookup is shown in the landing section and changes neither the verdict nor the exit code", async () => {
  const gh = fakeGh(mixedRepo());
  const real = gh.graphql.bind(gh);
  gh.graphql = async (query, vars) => {
    if (vars.h0 !== undefined) throw new GhError("ratelimit", "API rate limit exceeded", 403);
    return real(query, vars);
  };
  const r = await run(GUARDLESS, gh);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.out, /o\/a\s+carrier lookup unavailable \(ratelimit: API rate limit exceeded\)/);
  assert.match(r.out, /unknown 4/);
  assert.doesNotMatch(r.out, /^ERROR/m);
  assert.match(r.out, /24h 5\s/);
});

test("a cut-short merge list marks the landing numbers as lower bounds", async () => {
  const snapshot = await collectSnapshot(parseOptions(GUARDLESS, {}), fakeGh(mixedRepo()));
  assert.doesNotMatch(renderReport(snapshot), /lower bound/);
  snapshot.landing.repos[0].complete = false;
  assert.match(renderReport(snapshot), /o\/a\s+merged into: .*\(lower bound, merge list cut short\)/);
  assert.match(renderReport(snapshot), /o\/a\s+landed with stacked PRs: #5 \+1 \(merged in the fetched window\)/);
});

test("the landing section prints nothing extra when every merge landed, and cleans error text from outside", async () => {
  const plain = { "o/a": { merged: [1, 2, 3].map((n) => mergedNode(n, END - n * HOUR)) } };
  const quiet = await run(GUARDLESS, fakeGh(plain));
  assert.match(quiet.out, /raw merged 24h\s+3 = landed on the default branch 3 \(the KPI\) \+ merged into other branches 0 \(not counted\)/);
  assert.doesNotMatch(quiet.out, /not landed|merged into:|landed with stacked/);
  const snapshot = await collectSnapshot(parseOptions(GUARDLESS, {}), fakeGh(mixedRepo()));
  snapshot.landing.repos[0].error = { kind: "other", message: "boom\nERROR      o/a: injected\u001b[31m" };
  const text = renderReport(snapshot);
  assert.doesNotMatch(text, /^ERROR\s+o\/a: injected/m);
  assert.doesNotMatch(text, /\u001b/);
  assert.match(text, /carrier lookup unavailable \(other: boom ERROR\s+o\/a: injected/);
});

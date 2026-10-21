/**
 * Self-tests of gate.mjs with synthetic result files in a temp directory.
 * No browser, no server: `node --test tests/perf/web-app/gate.test.mjs`.
 *
 * The arms below carry every probe's file in the JSON shape the probes write, so a
 * whole slice (M1 gates everything) can pass main against main and each seeded
 * defect fails exactly the row it should.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandSpecs, parseGateArgs, routeGroupOf } from "./gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "gate.mjs");
const BANDS_FILE = path.join(HERE, "gate-bands.json");
const BANDS = JSON.parse(fs.readFileSync(BANDS_FILE, "utf8"));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const PAGES = ["tasks-board", "dashboard"];
const PROFILES = ["wan", "desktop"];
const PATTERNS = ["/:prefix/dashboard", "/:prefix/issues", "/:prefix/agents/:agentId", "/auth"];
const ALL_TOOLS = ["measure", "nav-timing", "route-smoke", "spa-mounts", "ws-persistence", "two-user-isolation", "server-load", "start-timer"];

const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

const PAYLOADS = {
  measure: (o) => ({
    rows: [],
    results: PAGES.flatMap((page) =>
      PROFILES.flatMap((profile) =>
        times(o.runs, (i) => ({
          page,
          profile,
          run: i,
          fcpMs: 200 + i + o.fcpAdd,
          lcpMs: (1000 + 10 * i) * o.lcpScale,
          ttiMs: 1500 + 10 * i,
          apiRequests: 12,
          jsBytes: 800_000 * o.jsScale,
          consoleErrors: o.consoleErrors,
        })),
      ),
    ),
  }),
  "nav-timing": (o) => ({
    results: ["board|click", "board|hover-click", "dashboard|click"].flatMap((key) =>
      times(o.runs, (i) => ({ key, firstChangeMs: 60 + i, usableMs: 180 + 2 * i + o.navAdd, ok: true })),
    ),
    rows: [{ key: "backforward|board->issue", scrollDeltaPx: o.scrollDelta, stateKept: true, rightPage: true }],
  }),
  "route-smoke": (o) => ({
    rows: PATTERNS.flatMap((pattern) =>
      [1440, 390].map((width) => ({
        key: `${pattern}|${width}`,
        url: `http://x${pattern}`,
        finalUrl: `http://x${pattern}`,
        status: o.routeFail === pattern ? 500 : 200,
        failedAssets: [],
        consoleErrors: o.routeConsoleFail === pattern ? 1 : 0,
        ok: o.routeFail !== pattern,
      })),
    ),
  }),
  "spa-mounts": (o) => ({
    rows: ["providers", "catchAll"].map((key) => (o.spaNa ? { key, status: "not_applicable" } : { key, maxCount: o.spaMax, navigations: 20, status: "ok" })),
  }),
  "ws-persistence": (o) => ({
    rows: ["live-socket", "runner-upgrade", "terminal-upgrade", "hmr"].map((key) => ({ key, opened: true, closedDuringNav: o.wsClosed, reachedHandler: true, status: "ok" })),
  }),
  "two-user-isolation": (o) => ({
    rows: ["html", "rsc"].map((key) => ({ key, requests: 100, leaks: o.leaks, missingCacheControl: 0, missingVaryCookie: 0, status: "ok" })),
  }),
  "server-load": (o) => ({
    rows: [
      { key: "board-load-cpu", cpuMsPerLoad: o.cpu, loads: 10 },
      { key: "api-p95", idleP95Ms: 20, loadedP95Ms: 20 * o.apiRatio },
      { key: "board-load-requests", rscRequestsPerLoad: 0, loopbackRequestsPerLoad: 0, loads: 10 },
    ],
  }),
  "start-timer": (o) => ({
    results: times(o.runs, (i) => ({ key: "start", run: i, apiReadyMs: 8000 + 10 * i + o.apiAdd, firstUiMs: 8200 + 10 * i + o.uiAdd })),
    rows: [],
  }),
};

const DEFAULTS = { rounds: 2, runs: 5, load: 5, lcpScale: 1, fcpAdd: 0, jsScale: 1, navAdd: 0, consoleErrors: [], scrollDelta: 0, spaMax: 1, wsClosed: 0, leaks: 0, cpu: 90, apiRatio: 1.1, apiAdd: 0, uiAdd: 0 };

/** One arm: a directory with a file per probe per round. */
function makeArm(name, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const dir = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  for (let round = 0; round < o.rounds; round += 1) {
    for (const tool of ALL_TOOLS) {
      if (o.omit?.includes(tool)) continue;
      const meta = { label: `${name}-r${round}`, loadAvgStart: o.load, loadAvgEnd: o.load };
      if (!(o.legacyMeasure && tool === "measure")) meta.tool = tool;
      fs.writeFileSync(path.join(dir, `${name}-r${round}-${tool}.json`), JSON.stringify({ meta, ...PAYLOADS[tool](o) }));
    }
  }
  return dir;
}

/** The CI image file: both arms in one file, every row tagged with its arm. */
function makeImageFile(opts = {}) {
  const o = { sizeAdd: 0, rssAdd: 0, peakAdd: 0, oom: false, buildAdd: 0, ...opts };
  const file = path.join(fs.mkdtempSync(path.join(sandbox, "image-")), "ci-image.json");
  const row = (arm, key, fields) => ({ arm, key, ...fields });
  const add = (arm) => (arm === "head" ? o : { sizeAdd: 0, rssAdd: 0, peakAdd: 0, oom: false, buildAdd: 0 });
  const rows = ["base", "head"].flatMap((arm) => [
    row(arm, "image", { sizeBytes: 3_000_000_000 + add(arm).sizeAdd, buildSeconds: 900 + add(arm).buildAdd }),
    row(arm, "container", { steadyRssBytes: 400_000_000 + add(arm).rssAdd, startupPeakBytes: 600_000_000 + add(arm).peakAdd, oomKilled: add(arm).oom, restarts: 0 }),
  ]);
  fs.writeFileSync(file, JSON.stringify({ meta: { tool: "image", label: "ci", loadAvgStart: 3, loadAvgEnd: 3 }, rows }));
  return file;
}

function gate(slice, baseDir, headDir, { image, extra = [] } = {}) {
  const files = image ? [image] : [];
  const run = spawnSync(process.execPath, [GATE, "--slice", slice, "--base", baseDir, ...files, "--head", headDir, ...files, ...extra], { encoding: "utf8" });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const lines = (out, id) => out.split("\n").filter((l) => l.startsWith(`| ${id} |`));
const columns = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"));
const statusOf = (line) => columns(line).at(-1);
const cellOf = (line) => columns(line)[1];
const hasStatus = (out, id, status) => lines(out, id).some((l) => statusOf(l).startsWith(status));

const image = makeImageFile();
const base = makeArm("base");

describe("main against main", () => {
  const head = makeArm("main", { lcpScale: 1.01, fcpAdd: 3, navAdd: 2 });

  test("every slice that has data passes, within the bands of noise", () => {
    for (const slice of ["M0", "M0b", "M0c", "M3", "M5", "M10", "MF", "image-ci"]) {
      const r = gate(slice, base, head, { image });
      assert.equal(r.code, 0, `slice ${slice}\n${r.out}\n${r.err}`);
      assert.match(r.out, /GATE PASSES/);
      assert.doesNotMatch(r.out, /\| (FAIL|MISSING)/);
    }
  });

  test("M1 gates the board with no tolerance: identical numbers pass, +1% fails", () => {
    const same = gate("M1", base, makeArm("same"), { image });
    assert.equal(same.code, 0, same.out);
    assert.match(same.out, /GATE PASSES/);
    const noisy = gate("M1", base, head, { image });
    assert.equal(noisy.code, 1);
    for (const id of ["board-warm-usable-p75", "board-warm-usable-median", "board-cold-lcp"]) assert.ok(hasStatus(noisy.out, id, "FAIL"), id);
    assert.ok(hasStatus(noisy.out, "cold-lcp", "PASS"), "the no-regression rows keep their tolerance");
  });

  test("slice H gates nothing and needs no files", () => {
    const r = spawnSync(process.execPath, [GATE, "--slice", "H"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gates no rows/);
  });

  test("a measure.mjs file without meta.tool is recognised by its shape", () => {
    const legacy = makeArm("legacy", { legacyMeasure: true });
    const r = gate("M0c", base, legacy);
    assert.equal(r.code, 0, r.out);
    assert.ok(lines(r.out, "cold-lcp").length > 0);
  });

  test("--json writes the report and --quiet folds the PASS rows", () => {
    const json = path.join(sandbox, "report.json");
    const r = gate("M0c", base, head, { extra: ["--json", json, "--quiet"] });
    assert.equal(r.code, 0);
    const report = JSON.parse(fs.readFileSync(json, "utf8"));
    assert.equal(report.exitCode, 0);
    assert.ok(report.summary.pass > 10);
    assert.match(r.out, /cell\(s\)/);
  });
});

describe("seeded regressions fail", () => {
  test("head LCP +20% fails the LCP rows and exits 1", () => {
    const head = makeArm("lcp20", { lcpScale: 1.2 });
    const r = gate("M0c", base, head);
    assert.equal(r.code, 1, r.out);
    assert.ok(hasStatus(r.out, "cold-lcp", "FAIL"));
    assert.match(r.out, /GATE FAILS/);
    const full = gate("M1", base, head, { image });
    assert.ok(hasStatus(full.out, "board-cold-lcp", "FAIL"));
  });

  test("the band is +5% or +50 ms, whichever is larger", () => {
    assert.equal(gate("M0c", base, makeArm("fcp45", { fcpAdd: 45 })).code, 0, "fcp 202 -> 247 is inside +50 ms");
    const over = gate("M0c", base, makeArm("fcp55", { fcpAdd: 55 }));
    assert.equal(over.code, 1);
    assert.ok(hasStatus(over.out, "cold-fcp", "FAIL"));
    assert.equal(gate("M0c", base, makeArm("lcp4", { lcpScale: 1.04 })).code, 0, "lcp +4% is inside +5%");
    assert.equal(gate("M0c", base, makeArm("lcp6", { lcpScale: 1.06 })).code, 1, "lcp +6% is outside +5%");
  });

  test("JS on the wire: +10% passes, +12% fails", () => {
    assert.equal(gate("M0c", base, makeArm("js9", { jsScale: 1.09 })).code, 0);
    const r = gate("M0c", base, makeArm("js12", { jsScale: 1.12 }));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "js-on-wire", "FAIL"));
  });

  test("a new console error fails, fixture noise does not", () => {
    const bad = gate("M0c", base, makeArm("err", { consoleErrors: ["Uncaught TypeError: x is not a function"] }));
    assert.equal(bad.code, 1);
    assert.ok(hasStatus(bad.out, "console-errors-pages", "FAIL"));
    const noise = gate("M0c", base, makeArm("noise", { consoleErrors: ["Failed to load resource: /api/heartbeat-runs/abc/log?limit=1 404"] }));
    assert.equal(noise.code, 0, noise.out);
  });

  test("warm navigation: +5% or +20 ms, and the board is strict", () => {
    const small = makeArm("nav15", { navAdd: 15 });
    const ok = gate("M0c", base, small);
    assert.ok(hasStatus(ok.out, "warm-nav-usable", "PASS"), "usable ~188 -> 203 is inside +20 ms");
    const strict = gate("M1", base, small, { image });
    assert.ok(hasStatus(strict.out, "board-warm-usable-p75", "FAIL"), "any slowdown on the board fails M1's strict row");
    assert.ok(hasStatus(strict.out, "board-warm-usable-median", "FAIL"));
    assert.equal(gate("M0c", base, makeArm("nav30", { navAdd: 30 })).code, 1);
  });

  test("router state: a scroll off by more than 4 px fails", () => {
    assert.equal(gate("M0b", base, makeArm("scroll4", { scrollDelta: 4 })).code, 0);
    const r = gate("M0b", base, makeArm("scroll9", { scrollDelta: -9 }));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "router-state", "FAIL"));
  });
});

describe("a gated row without data is MISSING", () => {
  test("a probe that wrote nothing", () => {
    const r = gate("M0c", base, makeArm("nonav", { omit: ["nav-timing"] }));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "warm-nav-usable", "MISSING"));
  });

  test("a cell that one arm has and the other lost", () => {
    const head = makeArm("onepage");
    for (const f of fs.readdirSync(head).filter((n) => n.endsWith("-measure.json"))) {
      const doc = JSON.parse(fs.readFileSync(path.join(head, f), "utf8"));
      doc.results = doc.results.filter((x) => x.page !== "dashboard");
      fs.writeFileSync(path.join(head, f), JSON.stringify(doc));
    }
    const r = gate("M0c", base, head);
    assert.equal(r.code, 1);
    assert.ok(lines(r.out, "cold-lcp").some((l) => cellOf(l) === "dashboard|wan" && statusOf(l).startsWith("MISSING")));
  });

  test("a route group that route-smoke wrote no rows for", () => {
    const r = gate("M7", base, makeArm("noroutes7"));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "routes-ok", "MISSING"));
  });

  test("the image file is missing from M1", () => {
    const r = gate("M1", base, makeArm("noimage"));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "image-size", "MISSING"));
    assert.ok(hasStatus(r.out, "memory-steady", "MISSING"));
  });
});

describe("the comparison must be valid", () => {
  test("a load average that moves more than 2x is INVALID and exits 2", () => {
    const r = gate("M0c", base, makeArm("busy", { load: 12 }));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /INVALID/);
    assert.match(r.out, /GATE INVALID/);
  });

  test("a load that moves less than 2x is accepted", () => {
    assert.equal(gate("M0c", base, makeArm("busyish", { load: 8 })).code, 0);
  });

  test("a load that stays under the floor is not a 2x change", () => {
    const quiet = makeArm("quiet", { load: 0.3 });
    const calm = makeArm("calm", { load: 0.9 });
    assert.equal(gate("M0c", quiet, calm).code, 0);
  });

  test("fewer than 5 runs per cell and fewer than 2 rounds are warnings, not failures", () => {
    const thin = makeArm("thin", { runs: 3, rounds: 1 });
    const r = gate("M0c", makeArm("thinbase", { runs: 3, rounds: 1 }), thin);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /fewer than 5 runs/);
    assert.match(r.out, /round\(s\) of files/);
  });
});

describe("absolute rows", () => {
  test("a route-smoke failure fails the route rows of its slice", () => {
    const head = makeArm("route500", { routeFail: "/:prefix/dashboard" });
    for (const slice of ["M0", "M1", "M3", "MF"]) {
      const r = gate(slice, base, head, { image });
      assert.equal(r.code, 1, `slice ${slice}`);
      assert.ok(hasStatus(r.out, "routes-ok", "FAIL"));
    }
  });

  test("a slice judges only the routes of its own group", () => {
    const issues = makeArm("issues500", { routeFail: "/:prefix/issues" });
    assert.equal(gate("M3", base, issues).code, 0, "/issues belongs to M1");
    assert.equal(gate("M1", base, issues, { image }).code, 1);
    const agent = makeArm("agent500", { routeFail: "/:prefix/agents/:agentId" });
    assert.equal(gate("M5", base, agent).code, 1);
    assert.equal(gate("M3", base, agent).code, 0);
    const auth = makeArm("auth500", { routeFail: "/auth" });
    assert.equal(gate("M10", base, auth).code, 1);
    assert.equal(gate("M5", base, auth).code, 0);
  });

  test("a new console error on a route is a failure", () => {
    const r = gate("M0", base, makeArm("routeerr", { routeConsoleFail: "/:prefix/dashboard" }), { image });
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "routes-console-errors", "FAIL"));
  });

  test("an isolation leak fails whatever the base says", () => {
    const r = gate("M0b", base, makeArm("leak", { leaks: 2 }));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "isolation", "FAIL"));
    assert.match(r.out, /leaks=2/);
  });

  test("two mounts of the SPA root fail", () => {
    const r = gate("M0b", base, makeArm("remount", { spaMax: 2 }));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "spa-mounts", "FAIL"));
  });

  test("a websocket that closes during navigation fails", () => {
    const r = gate("M0", base, makeArm("wsclose", { wsClosed: 1 }), { image });
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "websockets", "FAIL"));
  });

  test("server CPU per load above 150 ms and an API p95 above 1.2x idle fail", () => {
    const cpu = gate("M1", base, makeArm("cpu", { cpu: 151 }), { image });
    assert.equal(cpu.code, 1);
    assert.ok(hasStatus(cpu.out, "server-cpu-per-load", "FAIL"));
    assert.equal(gate("M1", base, makeArm("cpuok", { cpu: 150 }), { image }).code, 0);
    const api = gate("M1", base, makeArm("p95", { apiRatio: 1.3 }), { image });
    assert.equal(api.code, 1);
    assert.ok(hasStatus(api.out, "server-api-p95", "FAIL"));
  });

  test("start: first UI +2 s and API ready +0.5 s or +10%", () => {
    const head = (name, opts) => makeArm(name, opts);
    assert.equal(gate("M0", base, head("ui19", { uiAdd: 1900 }), { image }).code, 0);
    const ui = gate("M0", base, head("ui25", { uiAdd: 2500 }), { image });
    assert.ok(hasStatus(ui.out, "start-first-ui", "FAIL"));
    assert.equal(gate("M0", base, head("api700", { apiAdd: 700 }), { image }).code, 0, "8000 ms + 10% = 800 ms is larger than 500 ms");
    assert.ok(hasStatus(gate("M0", base, head("api900", { apiAdd: 900 }), { image }).out, "start-api-ready", "FAIL"));
  });

  test("image size, build time, memory and OOM", () => {
    const run = (opts) => gate("M0", base, makeArm("ok"), { image: makeImageFile(opts) });
    assert.equal(run({ sizeAdd: 349_000_000, buildAdd: 299, rssAdd: 249_000_000, peakAdd: 149_000_000 }).code, 0);
    assert.ok(hasStatus(run({ sizeAdd: 400_000_000 }).out, "image-size", "FAIL"));
    assert.ok(hasStatus(run({ buildAdd: 400 }).out, "image-build", "FAIL"));
    assert.ok(hasStatus(run({ rssAdd: 300_000_000 }).out, "memory-steady", "FAIL"));
    assert.ok(hasStatus(run({ peakAdd: 200_000_000 }).out, "memory-startup-peak", "FAIL"));
    assert.ok(hasStatus(run({ oom: true }).out, "oom-kills", "FAIL"));
  });
});

describe("not_applicable", () => {
  test("fails once the slice needs the subject", () => {
    const r = gate("M0b", base, makeArm("na", { spaNa: true }));
    assert.equal(r.code, 1);
    assert.ok(hasStatus(r.out, "spa-mounts", "FAIL"));
    assert.match(r.out, /allowed only before M0b/);
  });

  test("passes before the slice named by the band", () => {
    const early = JSON.parse(JSON.stringify(BANDS));
    early.slices.M0.gate.push("spa-mounts");
    const file = path.join(sandbox, "early-bands.json");
    fs.writeFileSync(file, JSON.stringify(early));
    const r = gate("M0", base, makeArm("naearly", { spaNa: true }), { image, extra: ["--bands", file] });
    assert.equal(r.code, 0, r.out);
    assert.ok(hasStatus(r.out, "spa-mounts", "NOT_APPLICABLE"));
  });
});

describe("report-only rows", () => {
  test("the cold LCP gain of M0b is shown and never gated", () => {
    const faster = makeArm("faster", { lcpScale: 0.9 });
    const r = gate("M0b", base, faster);
    assert.equal(r.code, 0, r.out);
    assert.ok(hasStatus(r.out, "board-cold-lcp-gain", "INFO"));
    assert.match(r.out, /-10\d ms/);
  });
});

describe("usage", () => {
  test("an unknown slice and an empty match exit 3", () => {
    assert.equal(gate("M99", base, base).code, 3);
    const none = spawnSync(process.execPath, [GATE, "--slice", "M0", "--base", path.join(sandbox, "nope-*.json"), "--head", base], { encoding: "utf8" });
    assert.equal(none.status, 3);
  });

  test("argument and pattern helpers", () => {
    assert.deepEqual(parseGateArgs(["--slice", "M0", "--base", "a", "b,c", "--head", "d", "--quiet"]), { base: ["a", "b", "c"], head: ["d"], slice: "M0", quiet: true });
    const dir = fs.mkdtempSync(path.join(sandbox, "glob-"));
    for (const n of ["x-1.json", "x-2.json", "y-1.json"]) fs.writeFileSync(path.join(dir, n), "{}");
    assert.equal(expandSpecs([path.join(dir, "x-*.json")]).length, 2);
    assert.equal(expandSpecs([dir]).length, 3);
  });

  test("route patterns map to the groups of plan section 15.3", () => {
    const g = BANDS.routeGroups;
    assert.equal(routeGroupOf("/:prefix/issues", g), "M1");
    assert.equal(routeGroupOf("/:companyPrefix/issues/:issueId", g), "M2");
    assert.equal(routeGroupOf("issues/:issueId", g), "M2");
    assert.equal(routeGroupOf("/:prefix/agents/:agentId/runs/:runId", g), "M5");
    assert.equal(routeGroupOf("/:prefix/dashboard|1440".split("|")[0], g), "M3");
    assert.equal(routeGroupOf("/:prefix", g), "M3");
    assert.equal(routeGroupOf("/:prefix/company/settings/members", g), "M8");
    assert.equal(routeGroupOf("/:prefix/onboarding", g), "M8");
    assert.equal(routeGroupOf("/onboarding", g), "M10");
    assert.equal(routeGroupOf("/auth", g), "M10");
    assert.equal(routeGroupOf("/some-redirect", g), "M10");
    assert.equal(routeGroupOf("/:prefix/not-a-listed-route", g), "M9", "a plugin route path takes what no other entry names");
  });
});

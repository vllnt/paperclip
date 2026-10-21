/**
 * Route smoke: load every URL pattern of the router once per viewport and record what
 * happened. Plan section 8, row "Every other route". Reports, never fails.
 *
 * Usage (server on :3192 seeded by make-fixture.mjs):
 *   node tests/perf/web-app/route-smoke.mjs --label b1-r1
 *   node tests/perf/web-app/route-smoke.mjs --only dashboard,issues --widths 1440
 *   node tests/perf/web-app/route-smoke.mjs --base https://host --prefix ACME --read-only \
 *     --header "Authorization: Bearer $PAPERCLIP_TOKEN"        # production: GET only
 *
 * Flags: --base --seed --label --out (see lib/common.mjs), --only <substring[,substring]>
 * (match the pattern), --widths 1440,390, --concurrency 2, --header "Name: value[, Name: value]"
 * (`$VAR` in a value is read from the environment; values are never printed or stored, and
 * are sent to the base origin only), --read-only (abort every request that is not
 * GET/HEAD/OPTIONS and count it), --skip-redirects, --splats (also load each splat at its
 * base path, and the catch-alls at an unknown path, where NotFound is the expected page),
 * --prefix <ISSUE_PREFIX> (when there is no seed file: the company is found by prefix).
 *
 * Patterns come from route-list.mjs. Params are filled from the seed and from GET list
 * reads of the seed company; a pattern whose param has no value is listed under `skipped`
 * with its reason. Layouts are never loaded; splats only with --splats; redirects are loaded
 * and `finalUrl` records where they land. One row per `${pattern}|${width}`:
 *   { key, pattern, width, kind, url, finalUrl, status, failedAssets, consoleErrors,
 *     notFound, blank, settled, ok, ... }
 * `status` is the status of the main document, `failedAssets` lists script/stylesheet/font/
 * image/document requests that failed or answered >= 400, `consoleErrors` is a count (fixture
 * noise excluded). `ok` = status < 400, no failed asset, no console error, not blank, and
 * NotFound rendered only where it is the expected page (a dev-only route on a production
 * build, a catch-all probe).
 */
import { chromium } from "@playwright/test";
import { readPatterns, countKinds } from "./route-list.mjs";
import { parseArgs, readSeed, startMeta, writeResult, isFixtureNoise } from "./lib/common.mjs";

const args = parseArgs();
const BASE = String(args.base ?? "http://127.0.0.1:3192").replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin;
const OUT_DIR = args.out && args.out !== true ? args.out : "tmp/perf/results";
const WIDTHS = String(args.widths ?? "1440,390").split(",").map(Number).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 2));
const READ_ONLY = Boolean(args["read-only"]);
const QUIET_MS = 15_000;
const ASSET_TYPES = new Set(["script", "stylesheet", "font", "image", "document"]);
const NOT_FOUND_TEXT = /Page not found|Organization not found/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DUMMY = "perf-smoke";

/** Params that no list read can fill: fixed values per pattern (stem = pattern without the company prefix). */
const STATIC_PARAMS = {
  "/agents/:agentId/:tab": { tab: "dashboard" },
  "/apps/:connectionId/:tab": { tab: "permissions" },
  "/apps/app/:applicationId/:tab": { tab: "overview" },
  "/apps/chat/:endpointId/:tab": { tab: "settings" },
  "/apps/gateways/:gatewayId/:tab": { tab: "overview" },
  "/apps/advanced/:tab": { tab: "profiles" },
  "/apps/connect/:appKey": { appKey: DUMMY },
  "/apps/connect/:appKey/:stage": { appKey: DUMMY, stage: DUMMY },
  "/company/settings/tools/:tab": { tab: "profiles" },
  "/tools/:tab": { tab: "profiles" },
  "/routines/:routineId/:section": { section: "triggers" },
  "/projects/:projectId/issues/:filter": { filter: "active" },
  "/board-claim/:token": { token: DUMMY },
  "/invite/:token": { token: DUMMY },
  "/cli-auth/:id": { id: DUMMY },
};

/** `Name: value, Name2: value2` → [{ name, value }]; `$VAR` is replaced from the environment. */
function parseHeaders(raw) {
  if (!raw || raw === true) return [];
  return String(raw)
    .split(/,\s*(?=[A-Za-z][\w-]*:\s)/)
    .map((part) => {
      const at = part.indexOf(":");
      const name = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim().replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_m, v) => {
        if (process.env[v] === undefined) throw new Error(`--header: environment variable ${v} is not set`);
        return process.env[v];
      });
      return { name, value };
    });
}
const HEADERS = parseHeaders(args.header);
const HEADER_OBJECT = Object.fromEntries(HEADERS.map((h) => [h.name, h.value]));

async function apiGet(pathname, cache) {
  if (cache.has(pathname)) return cache.get(pathname);
  let json = null;
  try {
    const res = await fetch(BASE + pathname, { headers: HEADER_OBJECT });
    json = res.ok ? await res.json() : null;
  } catch {
    json = null;
  }
  cache.set(pathname, json);
  return json;
}

const rows = (json, key) => (Array.isArray(json) ? json : Array.isArray(json?.[key]) ? json[key] : Array.isArray(json?.items) ? json.items : []);

/** The fixture facts the params are filled from, read once. */
async function loadFixture() {
  const cache = new Map();
  let seed = null;
  try {
    seed = readSeed(args.seed && args.seed !== true ? args.seed : undefined);
  } catch {
    seed = null;
  }
  let prefix = seed?.prefix ?? (args.prefix && args.prefix !== true ? String(args.prefix) : null);
  let companyId = seed?.companyId ?? null;
  if (!companyId && prefix) {
    const companies = rows(await apiGet("/api/companies", cache), "companies");
    companyId = companies.find((c) => String(c.issuePrefix).toUpperCase() === prefix.toUpperCase())?.id ?? null;
  }
  if (!prefix || !companyId) throw new Error("no seed file and no resolvable --prefix: cannot pick a company");
  const c = `/api/companies/${companyId}`;
  const fixture = { prefix, companyId, get: (p) => apiGet(p, cache), c };
  fixture.agentIds = seed?.agentIds ?? rows(await fixture.get(`${c}/agents`), "agents").map((a) => a.id);
  fixture.projectIds = seed?.projectIds ?? rows(await fixture.get(`${c}/projects`), "projects").map((p) => p.id);
  fixture.issueIdentifier =
    seed?.featured?.long?.identifier ?? rows(await fixture.get(`${c}/issues?limit=1`), "issues")[0]?.identifier ?? null;
  fixture.run = rows(await fixture.get(`${c}/heartbeat-runs?limit=1`), "runs")[0] ?? null;
  return fixture;
}

const skip = (reason) => ({ skip: reason });
const firstOf = async (fx, pathname, key, field = "id") => {
  const item = rows(await fx.get(pathname), key)[0];
  return item?.[field] ?? null;
};

/** Value for one param, or `{ skip: reason }`. `got` holds the params already filled. */
async function resolveParam(name, stem, fx, got) {
  const fixed = STATIC_PARAMS[stem]?.[name];
  if (fixed) return fixed;
  const c = fx.c;
  const or = (value, reason) => (value ? value : skip(reason));
  switch (name) {
    case "companyPrefix":
      return fx.prefix;
    case "issueId":
      return or(fx.issueIdentifier, "the company has no issue");
    case "runId":
      return or(fx.run?.id, "the company has no heartbeat run");
    case "agentId":
      return or(got.runId ? fx.run?.agentId : fx.agentIds[0], "the company has no agent");
    case "agentRef": {
      const agent = fx.agentIds[0] ? await fx.get(`/api/agents/${fx.agentIds[0]}`) : null;
      return or(agent?.urlKey ?? fx.agentIds[0], "the company has no agent");
    }
    case "projectId":
      return or(fx.projectIds[0], "the company has no project");
    case "routineId":
      return or(await firstOf(fx, `${c}/routines`, "routines"), "the fixture has no routine");
    case "goalId":
      return or(await firstOf(fx, `${c}/goals`, "goals"), "the fixture has no goal");
    case "approvalId":
      return or(await firstOf(fx, `${c}/approvals`, "approvals"), "the fixture has no approval");
    case "pluginId":
      return or(await firstOf(fx, "/api/plugins", "plugins"), "the instance has no plugin");
    case "environmentId":
      return or(await firstOf(fx, `${c}/environments`, "environments"), "the company has no environment");
    case "skillId":
      return or(await firstOf(fx, `${c}/skills`, "skills"), "the company has no skill");
    case "sourceId":
      return or(await firstOf(fx, `${c}/skill-sources`, "sources"), "the fixture has no skill source");
    case "pipelineId":
      return or(await firstOf(fx, `${c}/pipelines`, "pipelines"), "the fixture has no pipeline (experimental surface)");
    case "caseId":
      return skip("pipeline cases are not listed by a known read endpoint");
    case "caseIdentifier":
      return or(await firstOf(fx, `${c}/cases`, "cases", "identifier"), "cases are an experimental surface and not enabled");
    case "cardId":
      return or(await firstOf(fx, `${c}/status-cards`, "cards"), "status cards are an experimental surface and not enabled");
    case "key":
      return or(await firstOf(fx, `${c}/decision-queues`, "queues", "key"), "the fixture has no decision queue");
    case "connectionId":
      return or(await firstOf(fx, `${c}/tools/connections`, "connections"), "the fixture has no app connection");
    case "applicationId":
      return or(await firstOf(fx, `${c}/tools/applications`, "applications", "key"), "the fixture has no app application");
    case "gatewayId":
      return or(await firstOf(fx, `${c}/tools/gateways`, "gateways"), "the fixture has no gateway");
    case "profileId":
      return or(await firstOf(fx, `${c}/tools/profiles`, "profiles"), "the fixture has no tool profile");
    case "endpointId":
      return or(await firstOf(fx, `${c}/chat-endpoints`, "endpoints"), "the fixture has no chat endpoint");
    case "userSlug": {
      const member = rows(await fx.get(`${c}/members`), "members").find((m) => m.principalType === "user");
      const slug = member?.principalId;
      return slug && (await fx.get(`${c}/users/${slug}/profile`)) ? slug : skip("no user profile is readable");
    }
    case "workspaceId": {
      const list = stem.startsWith("/projects/")
        ? fx.projectIds[0] && `/api/projects/${fx.projectIds[0]}/workspaces`
        : `${c}/execution-workspaces`;
      const id = list ? await firstOf(fx, list, "workspaces") : null;
      return or(id, stem.startsWith("/projects/") ? "the project has no workspace" : "the fixture has no execution workspace");
    }
    default:
      return skip(`no source for param :${name}`);
  }
}

/** Splats and catch-alls become probe URLs only with --splats. */
function splatTarget(entry) {
  const base = entry.pattern.replace(/\/\*$/, "");
  const catchAll = base === "" || base === "/:companyPrefix";
  return { pattern: catchAll ? `${base}/${DUMMY}-unknown` : base, expect: catchAll ? "notFound" : "page" };
}

async function plan(entries, fx) {
  const targets = [];
  const skipped = [];
  for (const entry of entries) {
    if (entry.kind === "layout") {
      skipped.push({ pattern: entry.pattern, kind: entry.kind, reason: "layout renders no page of its own" });
      continue;
    }
    if (entry.kind === "splat" && !args.splats) {
      skipped.push({ pattern: entry.pattern, kind: entry.kind, reason: "splat (use --splats to probe its base path)" });
      continue;
    }
    if (entry.kind === "redirect" && args["skip-redirects"]) {
      skipped.push({ pattern: entry.pattern, kind: entry.kind, reason: "redirect (--skip-redirects)" });
      continue;
    }
    const probe = entry.kind === "splat" ? splatTarget(entry) : { pattern: entry.pattern, expect: "page" };
    const stem = entry.pattern.replace(/^\/:companyPrefix(?=\/|$)/, "") || "/";
    const params = {};
    let reason = null;
    const names = [...probe.pattern.matchAll(/:(\w+)/g)].map((m) => m[1]).sort((a, b) => Number(b === "runId") - Number(a === "runId"));
    for (const name of names) {
      const value = await resolveParam(name, stem, fx, params);
      if (value?.skip) {
        reason = `:${name}: ${value.skip}`;
        break;
      }
      params[name] = value;
    }
    if (reason) {
      skipped.push({ pattern: entry.pattern, kind: entry.kind, reason });
      continue;
    }
    const url = probe.pattern.replace(/:(\w+)/g, (_m, name) => encodeURIComponent(params[name])) || "/";
    const devOnly = entry.when.includes("import.meta.env.DEV");
    targets.push({ pattern: entry.pattern, kind: entry.kind, when: entry.when, gates: entry.gates, url, params, expect: devOnly ? "either" : probe.expect });
  }
  return { targets, skipped };
}

const shortUrl = (raw) => {
  try {
    const u = new URL(raw);
    return u.origin === BASE_ORIGIN ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return raw.slice(0, 120);
  }
};
const pathOf = (raw) => {
  const u = new URL(raw);
  return `${u.pathname}${u.search}${u.hash}`;
};

async function settle(page) {
  let settled = true;
  try {
    await page.waitForLoadState("networkidle", { timeout: QUIET_MS });
  } catch {
    settled = false;
  }
  await page.waitForTimeout(300);
  return settled;
}

async function probe(context, target, width, blockedByPage) {
  const page = await context.newPage();
  const failedAssets = [];
  const consoleErrors = [];
  let aborted = 0;
  page.on("response", (r) => {
    const type = r.request().resourceType();
    if (ASSET_TYPES.has(type) && r.status() >= 400) failedAssets.push({ url: shortUrl(r.url()), type, status: r.status() });
  });
  page.on("requestfailed", (req) => {
    const type = req.resourceType();
    const error = req.failure()?.errorText ?? "failed";
    if (!ASSET_TYPES.has(type)) return;
    if (/ERR_ABORTED/.test(error)) aborted += 1;
    else failedAssets.push({ url: shortUrl(req.url()), type, error });
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // --read-only aborts the page's own writes; the browser logs each abort as a console error,
    // and blockedWrites already counts them.
    if (READ_ONLY && /ERR_BLOCKED_BY_CLIENT/.test(text)) return;
    if (!isFixtureNoise(`${m.location()?.url ?? ""} ${text}`)) consoleErrors.push(text.slice(0, 200));
  });
  page.on("pageerror", (e) => {
    const text = `pageerror: ${String(e)}`;
    if (!isFixtureNoise(text)) consoleErrors.push(text.slice(0, 200));
  });
  let status = null;
  let navigationError = null;
  try {
    const response = await page.goto(BASE + target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    status = response?.status() ?? null;
  } catch (error) {
    navigationError = String(error).slice(0, 200);
  }
  const settled = navigationError ? false : await settle(page);
  const text = navigationError ? "" : await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const finalUrl = navigationError ? null : pathOf(page.url());
  const blocked = blockedByPage.get(page) ?? 0;
  await page.close();
  const notFound = NOT_FOUND_TEXT.test(text);
  const blank = !navigationError && text.trim().length === 0;
  const notFoundOk = target.expect === "either" || notFound === (target.expect === "notFound");
  const ok = !navigationError && status !== null && status < 400 && failedAssets.length === 0 && consoleErrors.length === 0 && !blank && notFoundOk;
  return {
    key: `${target.pattern}|${width}`,
    pattern: target.pattern,
    width,
    kind: target.kind,
    url: target.url,
    finalUrl,
    redirected: finalUrl !== null && finalUrl !== target.url,
    status,
    failedAssets,
    consoleErrors: consoleErrors.length,
    consoleErrorSamples: consoleErrors.slice(0, 3),
    notFound,
    blank,
    settled,
    abortedAssets: aborted,
    blockedWrites: blocked,
    ...(target.when.length ? { when: target.when } : {}),
    ...(target.gates.length ? { gates: target.gates } : {}),
    ...(navigationError ? { navigationError } : {}),
    ok,
  };
}

async function newContext(browser, width, blockedByPage, companyId) {
  const mobile = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  // The fixture instance has more than one company; pin the seed company so the
  // unprefixed URLs (which redirect into the selected company) land in it.
  await context.addInitScript((id) => {
    try {
      localStorage.setItem("paperclip.selectedCompanyId", id);
    } catch {}
  }, companyId);
  if (READ_ONLY || HEADERS.length) {
    await context.route("**/*", async (route) => {
      const req = route.request();
      if (READ_ONLY && !SAFE_METHODS.has(req.method())) {
        const page = req.frame()?.page();
        if (page) blockedByPage.set(page, (blockedByPage.get(page) ?? 0) + 1);
        await route.abort("blockedbyclient");
        return;
      }
      if (HEADERS.length && new URL(req.url()).origin === BASE_ORIGIN) {
        await route.continue({ headers: { ...req.headers(), ...HEADER_OBJECT } });
        return;
      }
      await route.continue();
    });
  }
  return context;
}

async function runWidth(browser, targets, width, companyId, progress) {
  const blockedByPage = new WeakMap();
  const context = await newContext(browser, width, blockedByPage, companyId);
  const results = new Array(targets.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      try {
        results[index] = await probe(context, targets[index], width, blockedByPage);
      } catch (error) {
        results[index] = { key: `${targets[index].pattern}|${width}`, pattern: targets[index].pattern, width, kind: targets[index].kind, url: targets[index].url, finalUrl: null, status: null, failedAssets: [], consoleErrors: 0, ok: false, navigationError: String(error).slice(0, 200) };
      }
      progress(results[index]);
    }
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  } finally {
    await context.close();
  }
  return results;
}

async function main() {
  const only = args.only && args.only !== true ? String(args.only).split(",") : null;
  const entries = readPatterns().filter((e) => !only || only.some((s) => e.pattern.includes(s)));
  const fixture = await loadFixture();
  const { targets, skipped } = await plan(entries, fixture);
  const meta = startMeta("route-smoke", args, {
    base: BASE,
    widths: WIDTHS,
    concurrency: CONCURRENCY,
    readOnly: READ_ONLY,
    headerNames: HEADERS.map((h) => h.name),
    patterns: countKinds(entries),
  });
  const browser = await chromium.launch({ headless: true });
  const all = [];
  try {
    for (const width of WIDTHS) {
      const done = await runWidth(browser, targets, width, fixture.companyId, (r) => {
        console.error(`[${width}] ${r.ok ? "ok  " : "FAIL"} ${r.url} -> ${r.finalUrl ?? r.navigationError} ${r.status ?? "-"}${r.failedAssets.length ? ` assets=${r.failedAssets.length}` : ""}${r.consoleErrors ? ` errs=${r.consoleErrors}` : ""}${r.notFound ? " notFound" : ""}${r.blank ? " blank" : ""}`);
      });
      all.push(...done);
    }
  } finally {
    await browser.close();
  }
  all.sort((a, b) => a.key.localeCompare(b.key));
  const byReason = {};
  for (const s of skipped) byReason[s.reason.replace(/^:\w+: /, "")] = (byReason[s.reason.replace(/^:\w+: /, "")] ?? 0) + 1;
  meta.coverage = { patterns: entries.length, probed: targets.length, skipped: skipped.length, skippedByReason: byReason };
  const file = writeResult(meta, { rows: all, skipped }, OUT_DIR);
  const failing = all.filter((r) => !r.ok);
  console.log(`route-smoke: ${entries.length} patterns, ${targets.length} probed x ${WIDTHS.length} widths = ${all.length} rows, ${failing.length} not ok, ${skipped.length} skipped${READ_ONLY ? `, ${all.reduce((s, r) => s + (r.blockedWrites ?? 0), 0)} writes blocked` : ""}`);
  for (const r of failing) {
    const why = [r.status >= 400 ? `status ${r.status}` : null, r.failedAssets?.length ? `${r.failedAssets.length} failed assets` : null, r.consoleErrors ? `${r.consoleErrors} console errors` : null, r.notFound ? "NotFound rendered" : null, r.blank ? "blank" : null, r.navigationError].filter(Boolean).join(", ");
    console.log(`  ${r.key} -> ${r.finalUrl ?? "-"}: ${why || "unexpected page"}`);
  }
  console.log(`skipped by reason: ${JSON.stringify(byReason)}`);
  console.log(`results: ${file}`);
}

await main();

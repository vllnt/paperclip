/**
 * Two users at once, cache headers. Plan section 8, row "Two users at once, cache headers".
 * Reports, never fails (only gate.mjs decides).
 *
 * Needs an authenticated instance and its seed file from make-auth-fixture.mjs
 * (tmp/perf/auth-seed.json: two users, each with a session cookie and a company of their own).
 *
 *   node tests/perf/web-app/two-user-isolation.mjs --label m0-r1
 *   node tests/perf/web-app/two-user-isolation.mjs --requests 10          # a short run
 *
 * Flags: --base (default: the base in the auth seed), --auth-seed, --label, --out (lib/common.mjs),
 * --requests 50 (GETs per user per kind of its own company page), --cross 10 (GETs per user of the
 * OTHER user's company URL, which must not serve the owner's data), --concurrency (default: all own
 * requests in flight at once).
 *
 * Two kinds of request, with the users interleaved so a shared cache or a shared render sees them
 * back to back:
 *   html   GET /<prefix>/dashboard, Accept: text/html
 *   rsc    GET /<prefix>/dashboard?_rsc=1 with header `RSC: 1`
 * Each response (headers and body) is scanned for the other user's company id, issue prefix path,
 * issue identifiers, ids and e-mail; the URL the request itself asked for is removed from the text
 * first, so an echoed path is not a leak. Each of a user's own page responses (2xx) must carry
 * Cache-Control with `private` and `no-store`, and Vary with `Cookie`; the cross-user answers are
 * only scanned for leaks and counted by status.
 *
 * Rows { key: "html" | "rsc", requests, leaks, missingCacheControl, missingVaryCookie, status }:
 *   status  leak (any leak) | no_page_served (none of a user's own page requests got a 2xx, so
 *           there was nothing to leak and nothing to check) | headers_missing | ok |
 *           not_applicable_before_m0
 *   headerCheck  ok | missing | not_applicable_before_m0 — before M0 the HTML is the static Vite
 *                index.html (no `/_next/` in it and no RSC content type), so the header check does
 *                not apply; the header values found are still reported under `headers`.
 */
import fs from "node:fs";
import { parseArgs, startMeta, writeResult } from "./lib/common.mjs";

const args = parseArgs();
const SEED_FILE = args["auth-seed"] && args["auth-seed"] !== true ? args["auth-seed"] : "tmp/perf/auth-seed.json";
const OUT_DIR = args.out && args.out !== true ? args.out : "tmp/perf/results";
const REQUESTS = Number(args.requests ?? 50);
const CROSS = Number(args.cross ?? 10);
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? Math.max(20, REQUESTS * 2)));
const MAX_BODY = 4 * 1024 * 1024;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (s) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`);

/** What identifies one user's data: tests built once per user. */
function markersOf(user) {
  const checks = [
    { type: "companyId", re: token(user.companyId) },
    { type: "prefixPath", re: new RegExp(`/${escapeRe(user.prefix)}(?:[/"'?#\\\\\\s<]|$)`) },
    { type: "identifier", re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(user.prefix)}-\\d+(?![A-Za-z0-9])`) },
    { type: "email", re: token(user.email) },
    ...user.ids.map((id) => ({ type: "entityId", re: token(id) })),
  ];
  return checks;
}

/** Types of the `owner`'s markers found in `text`, after `asked` (the requested URL) is removed. */
function scan(text, markers, asked) {
  const clean = asked ? text.split(asked).join("") : text;
  return [...new Set(markers.filter((m) => m.re.test(clean)).map((m) => m.type))];
}

function selfTest(users, markers) {
  const [a, b] = users;
  const plantedId = scan(`<p>${b.companyId}</p>`, markers.get(b), "");
  const plantedPath = scan(`<a href="/${b.prefix}/issues">`, markers.get(b), "");
  const echoed = scan(`<link href="/${b.prefix}/dashboard">`, markers.get(b), `/${b.prefix}/dashboard`);
  const clean = scan(`<html>${a.companyId} ${a.prefix}</html>`, markers.get(b), "");
  if (!plantedId.includes("companyId") || !plantedPath.includes("prefixPath") || echoed.length || clean.length) {
    throw new Error("leak scanner self-test failed: it would miss or invent leaks");
  }
}

async function pool(items, worker, size) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: size }, lane));
  return out;
}

async function fetchOne(job, base, kind) {
  const asked = `/${job.target.prefix}/dashboard`;
  const url = base + asked + (kind === "rsc" ? "?_rsc=1" : "");
  const headers = { cookie: job.user.cookie, accept: kind === "rsc" ? "text/x-component" : "text/html", ...(kind === "rsc" ? { RSC: "1" } : {}) };
  try {
    const res = await fetch(url, { headers, redirect: "manual" });
    const body = (await res.text()).slice(0, MAX_BODY);
    const headerText = [...res.headers].filter(([k]) => k !== "set-cookie").map(([k, v]) => `${k}: ${v}`).join("\n");
    return {
      cross: job.cross,
      status: res.status,
      cacheControl: res.headers.get("cache-control"),
      vary: res.headers.get("vary"),
      contentType: res.headers.get("content-type"),
      nextMarker: body.includes("/_next/") || /text\/x-component/.test(res.headers.get("content-type") ?? ""),
      hits: scan(`${headerText}\n${body}`, job.otherMarkers, asked),
      pair: `${job.user.prefix}->${job.target.prefix}`,
    };
  } catch (error) {
    return { cross: job.cross, error: String(error.cause?.code ?? error.message).slice(0, 80), hits: [], nextMarker: false };
  }
}

async function runKind(kind, base, users, markers) {
  const [a, b] = users;
  const jobs = [];
  const push = (user, target, other, cross) => jobs.push({ user, target, otherMarkers: markers.get(other), cross });
  for (let i = 0; i < REQUESTS; i += 1) {
    push(a, a, b, false);
    push(b, b, a, false);
  }
  for (let i = 0; i < CROSS; i += 1) {
    push(a, b, b, true);
    push(b, a, a, true);
  }
  // A cross request asks for the owner's URL, so the owner's markers are the ones it must not carry.
  const results = await pool(jobs, (job) => fetchOne(job, base, kind), CONCURRENCY);
  const answered = results.filter((r) => !r.error);
  const lacksCache = (r) => !/\bprivate\b/i.test(r.cacheControl ?? "") || !/\bno-store\b/i.test(r.cacheControl ?? "");
  const lacksVary = (r) => !/\bcookie\b/i.test(r.vary ?? "");
  const leaks = answered.reduce((n, r) => n + r.hits.length, 0);
  // Header checks judge each user's own pages (2xx). Cross-user answers (403/404/redirect) are judged
  // by the leak scan and listed in statusCodes, not by their cache headers.
  const served = answered.filter((r) => !r.cross && r.status >= 200 && r.status < 300);
  const ownServed = served.length;
  const noPages = ownServed === 0;
  const marker = served.filter((r) => r.nextMarker).length;
  const missingCacheControl = served.filter(lacksCache).length;
  const missingVaryCookie = served.filter(lacksVary).length;
  const headerCheck = marker === 0 ? "not_applicable_before_m0" : missingCacheControl + missingVaryCookie > 0 ? "missing" : "ok";
  const distinct = (field) => [...new Set(served.map((r) => r[field] ?? "(none)"))];
  const statusCodes = {};
  for (const r of results) statusCodes[r.error ?? r.status] = (statusCodes[r.error ?? r.status] ?? 0) + 1;
  return {
    key: kind,
    requests: results.length,
    ownRequests: results.filter((r) => !r.cross).length,
    crossRequests: results.filter((r) => r.cross).length,
    errors: results.length - answered.length,
    leaks,
    leakSamples: [...new Set(answered.filter((r) => r.hits.length).map((r) => `${r.pair}: ${r.hits.join(",")}`))].slice(0, 5),
    missingCacheControl,
    missingVaryCookie,
    nextMarker: marker,
    headerCheck,
    ownServed,
    status: leaks > 0 ? "leak" : noPages ? "no_page_served" : headerCheck === "not_applicable_before_m0" ? "not_applicable_before_m0" : headerCheck === "missing" ? "headers_missing" : "ok",
    statusCodes,
    headers: { cacheControl: distinct("cacheControl"), vary: distinct("vary"), contentType: distinct("contentType") },
  };
}

async function main() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`no auth seed at ${SEED_FILE}: run tests/perf/web-app/make-auth-fixture.mjs against an authenticated instance first`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  if (!Array.isArray(seed.users) || seed.users.length < 2) {
    console.error("the auth seed needs two users");
    process.exit(1);
  }
  const base = String(args.base && args.base !== true ? args.base : seed.base ?? "http://127.0.0.1:3194").replace(/\/$/, "");
  const users = seed.users.slice(0, 2);
  const markers = new Map(users.map((u) => [u, markersOf(u)]));
  selfTest(users, markers);
  const meta = startMeta("two-user-isolation", args, { base, users: users.length, requestsPerUser: REQUESTS, crossPerUser: CROSS, concurrency: CONCURRENCY });
  const rows = [];
  for (const kind of ["html", "rsc"]) rows.push(await runKind(kind, base, users, markers));
  const file = writeResult(meta, { rows }, OUT_DIR);
  for (const r of rows) {
    console.log(`${r.key.padEnd(5)} ${r.status.padEnd(26)} requests=${r.requests} (own ${r.ownRequests}, cross ${r.crossRequests}) leaks=${r.leaks} missingCacheControl=${r.missingCacheControl} missingVaryCookie=${r.missingVaryCookie} errors=${r.errors} http=${JSON.stringify(r.statusCodes)}`);
    console.log(`      Cache-Control: ${r.headers.cacheControl.join(" | ")}   Vary: ${r.headers.vary.join(" | ")}   Content-Type: ${r.headers.contentType.join(" | ")}`);
    for (const s of r.leakSamples) console.log(`      LEAK ${s}`);
  }
  console.log(`results: ${file}`);
}

await main();

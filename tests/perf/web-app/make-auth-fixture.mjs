/**
 * Authenticated fixture for the two-user probes (plan section 13.2, H1 "authenticated fixture
 * mode"). Signs up two plain users on an `authenticated` instance through Better Auth's HTTP API,
 * gives each one company that only they belong to, creates a few entities in it, and writes
 * tmp/perf/auth-seed.json for two-user-isolation.mjs:
 *
 *   { base, users: [{ email, userId, cookie, companyId, prefix, ids: [...] }, ...], checks }
 *
 * `cookie` is a ready Cookie header value (a session of that user). `ids` are issue and project
 * ids and issue identifiers that exist only in that user's company.
 *
 * Usage, against a throwaway authenticated instance (never a shared or production one):
 *   node tests/perf/web-app/make-auth-fixture.mjs --base http://127.0.0.1:3194 \
 *     --db postgres://paperclip:paperclip@127.0.0.1:54394/paperclip
 * Flags: --base, --db (or PERF_DB_URL), --out tmp/perf/auth-seed.json, --users 2.
 *
 * Starting the instance (config.json: deploymentMode authenticated, exposure private, bind
 * loopback, port 3194, embeddedPostgresPort 54394, data dirs in a scratch directory):
 *   cd server && PAPERCLIP_CONFIG=<dir>/config.json PAPERCLIP_HOME=<dir> PAPERCLIP_INSTANCE_ID=perf-auth \
 *     PORT=3194 PAPERCLIP_DEPLOYMENT_MODE=authenticated BETTER_AUTH_SECRET=<any throwaway value> \
 *     PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=false SERVE_UI=true node node_modules/tsx/dist/cli.mjs src/index.ts
 *
 * Why a SQL step: creating a company needs an instance admin, and an instance admin may read every
 * company, which would make the isolation probe meaningless. So each user is made instance admin
 * for the length of one company creation (an `instance_user_roles` row) and demoted again. The two
 * users end as plain owners of their own company with no other membership. The fixture then checks
 * that neither can read the other's company and records the answers under `checks`.
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const require = createRequire(path.join(root, "packages/db/package.json"));
const postgres = require("postgres");

const args = parseArgs();
const BASE = String(args.base ?? "http://127.0.0.1:3194").replace(/\/$/, "");
const DB_URL = String(args.db && args.db !== true ? args.db : process.env.PERF_DB_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54394/paperclip");
const OUT = args.out && args.out !== true ? String(args.out) : path.join(root, "tmp/perf/auth-seed.json");
const USERS = Number(args.users ?? 2);
const TAG = crypto.randomBytes(3).toString("hex");
const COMPANY_WORDS = ["Alpha", "Zulu", "Kilo", "Mike", "Oscar", "Tango"];

const host = new URL(BASE).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  throw new Error(`refusing to seed ${BASE}: this fixture writes accounts and role rows, and only runs against a loopback instance`);
}

/** One request; returns { res, json }. `cookie` makes it a signed-in call. */
async function call(method, route, body, cookie) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, json, text };
}

async function must(method, route, body, cookie) {
  const out = await call(method, route, body, cookie);
  if (!out.res.ok) throw new Error(`${method} ${route} -> ${out.res.status} ${out.text.slice(0, 300)}`);
  return out.json;
}

/** `Set-Cookie` lines → a Cookie header value (`name=value; name2=value2`). */
function cookieHeader(res) {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0])
    .join("; ");
}

async function signUp(index) {
  const email = `perf-user-${index}-${TAG}@example.test`;
  const password = crypto.randomBytes(12).toString("hex");
  const { res, json, text } = await call("POST", "/api/auth/sign-up/email", { name: `Perf User ${index}`, email, password });
  if (!res.ok) throw new Error(`sign-up ${email} -> ${res.status} ${text.slice(0, 300)}`);
  const cookie = cookieHeader(res);
  if (!cookie) throw new Error("sign-up set no session cookie");
  return { email, userId: json?.user?.id ?? null, cookie };
}

async function createCompanyAs(sql, user, index) {
  await sql`insert into instance_user_roles (user_id, role) values (${user.userId}, 'instance_admin') on conflict do nothing`;
  try {
    // Names start with different letters so the issue prefixes differ and none extends another.
    return await must("POST", "/api/companies", { name: `${COMPANY_WORDS[(index - 1) % COMPANY_WORDS.length]} Isolation ${TAG}` }, user.cookie);
  } finally {
    await sql`delete from instance_user_roles where user_id = ${user.userId} and role = 'instance_admin'`;
  }
}

async function seedEntities(user, company) {
  const c = `/api/companies/${company.id}`;
  const ids = [];
  for (let n = 1; n <= 2; n += 1) {
    const project = await must("POST", `${c}/projects`, { name: `Isolation project ${company.issuePrefix} ${n}` }, user.cookie);
    ids.push(project.id);
  }
  for (let n = 1; n <= 3; n += 1) {
    const issue = await must("POST", `${c}/issues`, { title: `Isolation issue ${company.issuePrefix} ${n}`, description: `Only visible inside ${company.issuePrefix}.` }, user.cookie);
    ids.push(issue.id, issue.identifier);
  }
  return ids.filter(Boolean);
}

async function main() {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  if (health.deploymentMode !== "authenticated") {
    throw new Error(`${BASE} runs deploymentMode=${health.deploymentMode}; the two-user fixture needs an authenticated instance`);
  }
  const sql = postgres(DB_URL, { max: 1 });
  const users = [];
  try {
    for (let i = 1; i <= USERS; i += 1) {
      const user = await signUp(i);
      if (!user.userId) throw new Error("sign-up response carried no user id");
      const company = await createCompanyAs(sql, user, i);
      const ids = await seedEntities(user, company);
      users.push({ email: user.email, userId: user.userId, cookie: user.cookie, companyId: company.id, prefix: company.issuePrefix, ids });
      console.log(`user ${i}: company ${company.id} prefix=${company.issuePrefix} ids=${ids.length}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const checks = [];
  for (const reader of users) {
    for (const owner of users) {
      if (reader === owner) continue;
      const { res } = await call("GET", `/api/companies/${owner.companyId}/issues?limit=1`, undefined, reader.cookie);
      checks.push({ reader: reader.email, owner: owner.email, status: res.status, isolated: res.status === 401 || res.status === 403 || res.status === 404 });
    }
    const { res } = await call("GET", `/api/companies/${reader.companyId}/issues?limit=1`, undefined, reader.cookie);
    checks.push({ reader: reader.email, owner: reader.email, status: res.status, isolated: res.ok });
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, createdAt: new Date().toISOString(), users, checks }, null, 2), { mode: 0o600 });
  for (const c of checks) console.log(`${c.reader === c.owner ? "own   " : "cross "} read ${c.status} ${c.isolated ? "as expected" : "UNEXPECTED: the two users are not isolated at the API"}`);
  console.log(`wrote ${OUT} (cookies inside; mode 600)`);
}

await main();

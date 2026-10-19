/**
 * Seeds a company shaped like a busy real one into a LOCAL, disposable instance:
 * 32 agents, 8 projects, 1,000 issues (about 70% open), a 400-comment thread,
 * 10,000 heartbeat runs over 10.5 days with cost and activity rows, and run logs
 * for the runs on the three featured issues. It also dismisses the current
 * announcement, so measurements describe a steady-state user.
 *
 *   node tests/perf/web-app/make-fixture.mjs
 *
 * Environment: PERF_BASE (server URL), PERF_DB_URL (embedded Postgres),
 * PERF_INSTANCE (worktree instance id, used to find the run-log directory),
 * PERF_RUN_LOG_DIR, PERF_ISSUES, PERF_RUNS, PERF_AGENTS, PERF_OUT (result file,
 * default tmp/perf/seed-out.json, read by the other scripts in this directory).
 *
 * Never point this at a shared or production instance: it writes directly to the
 * database. Agents are created sequentially on purpose; concurrent creates in one
 * company race in ensureCompanyDefaultAgentGrants and fail with a unique-key 500.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const require = createRequire(path.join(root, "packages/db/package.json"));
const postgres = require("postgres");

const BASE = process.env.PERF_BASE ?? "http://127.0.0.1:3192";
const DB_URL = process.env.PERF_DB_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54332/paperclip";
const INSTANCE = process.env.PERF_INSTANCE ?? "perf-web-app";
const LOG_DIR = process.env.PERF_RUN_LOG_DIR ?? path.join(os.homedir(), ".paperclip-worktrees", "instances", INSTANCE, "data", "run-logs");
const N_ISSUES = Number(process.env.PERF_ISSUES ?? 1000);
const N_RUNS = Number(process.env.PERF_RUNS ?? 10000);
const N_AGENTS = Number(process.env.PERF_AGENTS ?? 32);
const N_PROJECTS = 8;
const CONCURRENCY = 6;
const OUT = process.env.PERF_OUT ?? path.join(root, "tmp/perf/seed-out.json");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261009);
const pick = (list) => list[Math.floor(rand() * list.length)];

async function api(method, route, body, attempt = 0) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "content-type": "application/json", origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if ((res.status === 429 || res.status >= 502) && attempt < 6) {
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    return api(method, route, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

async function pool(items, worker, size = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: size }, lane));
  return results;
}

const VERBS = ["Fix", "Add", "Refactor", "Investigate", "Document", "Migrate", "Improve", "Remove", "Audit", "Optimize", "Review", "Triage"];
const NOUNS = ["onboarding flow", "billing webhook", "agent heartbeat", "invoice export", "search index", "email digest", "retry policy", "OAuth callback", "routine scheduler", "cost report", "approval queue", "workspace sync", "release notes", "rate limiter", "skills catalog", "audit trail", "pricing page", "CSV import", "inbox filters", "run log viewer"];
const CONTEXTS = ["for enterprise customers", "after the last deploy", "on mobile Safari", "when the queue is empty", "under high load", "for the Q4 launch", "in the staging environment", "reported by support", "blocking the release", "flagged by QA", "from the board review", "for new companies"];
const PRIORITIES = ["critical", "high", "medium", "medium", "medium", "low"];
const ROLES = ["ceo", "cto", "cmo", "cfo", "security", "engineer", "engineer", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"];

const sentence = () => `${pick(VERBS)} the ${pick(NOUNS)} ${pick(CONTEXTS)} so the team can ship without manual follow-ups.`;
const paragraph = (n) => Array.from({ length: n }, sentence).join(" ");
function description() {
  const parts = [`## Context\n\n${paragraph(2)}`, `## Acceptance criteria\n\n- ${sentence()}\n- ${sentence()}\n- ${sentence()}`];
  if (rand() < 0.5) parts.push(`## Notes\n\n${paragraph(3)}\n\n\`\`\`ts\nawait queue.drain({ retries: 3 });\n\`\`\``);
  return parts.join("\n\n");
}
function statusFor() {
  const r = rand();
  if (r < 0.2) return "backlog";
  if (r < 0.45) return "todo";
  if (r < 0.57) return "in_progress";
  if (r < 0.7) return "in_review";
  if (r < 0.95) return "done";
  return "cancelled";
}

const t0 = Date.now();
const log = (msg) => console.log(`[seed +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const company = await api("POST", "/api/companies", { name: `Perf Co ${new Date().toISOString().slice(0, 10)}` });
const companyId = company.id;
log(`company ${companyId} prefix=${company.issuePrefix}`);

const agents = await pool(
  Array.from({ length: N_AGENTS }, (_, i) => i),
  (i) =>
    api("POST", `/api/companies/${companyId}/agents`, {
      name: `Agent ${String(i + 1).padStart(2, "0")} ${ROLES[i % ROLES.length]}`,
      role: ROLES[i % ROLES.length],
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: { heartbeat: { enabled: false } },
    }),
  1,
);
const agentIds = agents.map((a) => a.agent?.id ?? a.id);
log(`agents ${agentIds.length}`);

const projects = await pool(Array.from({ length: N_PROJECTS }, (_, i) => i), (i) =>
  api("POST", `/api/companies/${companyId}/projects`, { name: `Project ${i + 1}: ${pick(NOUNS)}` }),
);
const projectIds = projects.map((p) => p.id);

function issueBody(parentId) {
  const status = statusFor();
  const body = {
    title: `${pick(VERBS)} ${pick(NOUNS)} ${pick(CONTEXTS)}`,
    description: description(),
    status,
    priority: pick(PRIORITIES),
    projectId: rand() < 0.85 ? pick(projectIds) : null,
    allowDuplicate: true,
  };
  if (status === "in_progress" || status === "in_review") body.assigneeUserId = "local-board";
  if (parentId) body.parentId = parentId;
  return body;
}

const nTop = Math.floor(N_ISSUES * 0.85);
const top = await pool(Array.from({ length: nTop }), () => api("POST", `/api/companies/${companyId}/issues`, issueBody(null)));
const topIds = top.map((i) => i.id);
const children = await pool(Array.from({ length: N_ISSUES - nTop }), () =>
  api("POST", `/api/companies/${companyId}/issues`, issueBody(pick(topIds))),
);
const allIssues = [...top, ...children];
log(`issues ${allIssues.length}`);

const featured = { long: allIssues[3], medium: allIssues[11], short: allIssues[25] };
function commentBody(i) {
  const flavor = i % 7;
  if (flavor === 0) return `Status update ${i}:\n\n- ${sentence()}\n- ${sentence()}\n\n\`\`\`bash\npnpm test --filter ui\n\`\`\``;
  if (flavor === 3) return `${paragraph(4)}\n\n> ${sentence()}`;
  return paragraph(1 + (i % 3));
}
const seedComments = (issue, count) =>
  pool(Array.from({ length: count }, (_, i) => i), (i) => api("POST", `/api/issues/${issue.id}/comments`, { body: commentBody(i) }), 1);
await seedComments(featured.long, 400);
await seedComments(featured.medium, 60);
await seedComments(featured.short, 12);
await pool(allIssues.filter((_, i) => i % 9 === 0).slice(0, 110), (issue, n) => seedComments(issue, 2 + (n % 5)));
log("comments done");

const sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
try {
  await sql`
    UPDATE issues SET assignee_agent_id = (${agentIds}::uuid[])[1 + floor(random() * ${agentIds.length})::int], assignee_user_id = NULL
    WHERE company_id = ${companyId} AND status IN ('todo', 'in_progress', 'in_review', 'done') AND random() < 0.75`;

  await sql`
    WITH a AS (SELECT ${agentIds}::uuid[] AS ids),
         i AS (SELECT array_agg(id) AS ids FROM issues WHERE company_id = ${companyId}),
         rnd AS (SELECT g, random() AS r1, random() AS r2, random() AS r3, random() AS r4 FROM generate_series(1, ${N_RUNS}::int) g)
    INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, trigger_detail, status, started_at, finished_at, exit_code,
                                usage_json, result_json, context_snapshot, stdout_excerpt, error, created_at, updated_at)
    SELECT gen_random_uuid(), ${companyId}, a.ids[1 + floor(rnd.r1 * ${agentIds.length})::int],
           (ARRAY['assignment','timer','on_demand','automation'])[1 + floor(rnd.r2 * 4)::int],
           'seeded perf fixture',
           CASE WHEN rnd.r3 < 0.86 THEN 'succeeded' WHEN rnd.r3 < 0.96 THEN 'failed' ELSE 'cancelled' END,
           now() - (rnd.r4 * interval '10.5 days'),
           now() - (rnd.r4 * interval '10.5 days') + ((60 + rnd.r1 * 540) * interval '1 second'),
           CASE WHEN rnd.r3 < 0.86 THEN 0 ELSE 1 END,
           jsonb_build_object('inputTokens', (20000 + rnd.r2 * 180000)::int, 'outputTokens', (800 + rnd.r1 * 9000)::int, 'cachedInputTokens', (rnd.r3 * 90000)::int),
           jsonb_build_object('summary', 'Seeded run ' || rnd.g),
           jsonb_build_object('issueId', i.ids[1 + floor(rnd.r2 * array_length(i.ids, 1))::int], 'source', 'perf-seed'),
           'seeded excerpt for run ' || rnd.g,
           CASE WHEN rnd.r3 >= 0.86 AND rnd.r3 < 0.96 THEN 'seeded failure' ELSE NULL END,
           now() - (rnd.r4 * interval '10.5 days'),
           now() - (rnd.r4 * interval '10.5 days') + ((60 + rnd.r1 * 540) * interval '1 second')
    FROM rnd, a, i`;
  log(`runs ${N_RUNS}`);

  await sql`
    INSERT INTO cost_events (company_id, agent_id, issue_id, heartbeat_run_id, provider, biller, billing_type, model,
                             input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at)
    SELECT r.company_id, r.agent_id, (r.context_snapshot ->> 'issueId')::uuid, r.id,
           CASE WHEN abs(hashtext(r.id::text)) % 3 = 0 THEN 'openai' ELSE 'anthropic' END,
           CASE WHEN abs(hashtext(r.id::text)) % 3 = 0 THEN 'openai' ELSE 'anthropic' END,
           'metered_api',
           (ARRAY['claude-sonnet-5','claude-opus-5','gpt-5','claude-haiku-4.5'])[1 + abs(hashtext(r.id::text)) % 4],
           (r.usage_json ->> 'inputTokens')::int, (r.usage_json ->> 'cachedInputTokens')::int, (r.usage_json ->> 'outputTokens')::int,
           1 + abs(hashtext(r.id::text || 'c')) % 250, r.finished_at
    FROM heartbeat_runs r WHERE r.company_id = ${companyId}`;

  await sql`
    INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details, created_at)
    SELECT r.company_id, 'agent', r.agent_id::text,
           (ARRAY['issue.updated','issue.comment_added'])[1 + n % 2], 'issue', r.context_snapshot ->> 'issueId', r.agent_id, r.id,
           jsonb_build_object('source', 'perf-seed'), r.started_at + (n * interval '20 seconds')
    FROM heartbeat_runs r, generate_series(1, 2) n WHERE r.company_id = ${companyId}`;
  log("costs and activity done");

  const featuredIds = Object.values(featured).map((f) => f.id);
  const featuredRuns = await sql`
    SELECT id, agent_id, started_at FROM heartbeat_runs
    WHERE company_id = ${companyId} AND context_snapshot ->> 'issueId' = ANY(${featuredIds}::text[])
    ORDER BY started_at`;
  let big = true;
  for (const run of featuredRuns) {
    const lines = big ? 8000 : 40;
    big = false;
    const rel = path.join(companyId, run.agent_id, `${run.id}.ndjson`);
    const abs = path.join(LOG_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const start = new Date(run.started_at).getTime();
    const out = [];
    for (let i = 0; i < lines; i += 1) {
      const chunk = i % 11 === 0 ? `$ pnpm test --filter ui (step ${i})\n` : `  ✓ seeded step ${i}: ${"output ".repeat(6 + (i % 9))}\n`;
      out.push(JSON.stringify({ ts: new Date(start + i * 40).toISOString(), stream: i % 53 === 0 ? "stderr" : "stdout", chunk, seq: i + 1 }));
    }
    const body = `${out.join("\n")}\n`;
    fs.writeFileSync(abs, body, { mode: 0o600 });
    await sql`UPDATE heartbeat_runs SET log_store = 'local_file', log_ref = ${rel}, log_bytes = ${Buffer.byteLength(body)} WHERE id = ${run.id}`;
  }
  log(`run logs written for ${featuredRuns.length} runs`);

  const counts = await sql`
    SELECT (SELECT count(*) FROM issues WHERE company_id = ${companyId})::int AS issues,
           (SELECT count(*) FROM heartbeat_runs WHERE company_id = ${companyId})::int AS runs,
           (SELECT count(*) FROM issue_comments WHERE company_id = ${companyId})::int AS comments,
           (SELECT count(*) FROM activity_log WHERE company_id = ${companyId})::int AS activity,
           (SELECT count(*) FROM cost_events WHERE company_id = ${companyId})::int AS costs`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        companyId,
        prefix: company.issuePrefix,
        agentIds,
        projectIds,
        featured: Object.fromEntries(Object.entries(featured).map(([k, v]) => [k, { id: v.id, identifier: v.identifier }])),
        counts: counts[0],
      },
      null,
      2,
    ),
  );
  log(`counts ${JSON.stringify(counts[0])}`);
} finally {
  await sql.end();
}

const current = await (await fetch(`${BASE}/api/announcements/current`)).json();
if (current?.id) {
  const res = await fetch(`${BASE}/api/announcements/${current.id}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ companyId }),
  });
  log(`dismissed announcement ${current.id} (${res.status})`);
}
log("done");

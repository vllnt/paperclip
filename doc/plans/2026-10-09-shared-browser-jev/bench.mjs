// Jev (typesafe-ai/jev) vs Sonnet 5.5 vs Haiku 5.5 on browser decision steps.
// Same state for every model. Sequential calls. No secrets are printed or stored.
import { createGateway, experimental_evaluate as evaluate, generateText } from "ai";
import { readFileSync, writeFileSync } from "node:fs";

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("AI_GATEWAY_API_KEY not set");
const gw = createGateway({ apiKey });

const dataset = JSON.parse(readFileSync("dataset.json", "utf8"));
const JEV = "typesafe-ai/jev";
// Sonnet 5.5 and Haiku 5.5 are blocked by the gateway team's model allowlist (HTTP 403); these are the newest permitted.
const LLMS = ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5"];
const JEV_PRICE_IN = 0.042 / 1e6; // $/input token, output free (Vercel guide, 2026-10)
const PAGE_STATES = {
  signed_out: "A sign-in form is shown and the user is not authenticated. This includes a failed or blocked sign-in with an error banner.",
  signed_in: "Authenticated application content is shown (shop, account area, logged-in confirmation).",
  captcha: "A human-verification challenge (CAPTCHA) blocks progress.",
  error_page: "An HTTP, browser or not-found error page replaces the content.",
  other: "Public content where signing in is not involved.",
};

const stateFor = (s) => ({ goal: s.goal, url: s.url, title: s.title, page_snapshot: s.snapshot });

function jevQuestions(s) {
  return {
    page_state: { type: "choice", instructions: "What state is the browser page in?", criteria: PAGE_STATES },
    next_action: {
      type: "choice",
      instructions: "Which candidate is the single best next step toward the goal on this page?",
      criteria: s.candidates,
    },
    goal_done: { type: "boolean", instructions: "Has the goal already been fully achieved on the current page?" },
    needs_human: {
      type: "boolean",
      instructions: "Does progress now require a human (CAPTCHA, 2FA code, locked or blocked account)?",
    },
  };
}

function llmPrompt(s) {
  return [
    "You are the decision step of a browser agent. Answer from the page snapshot only.",
    `Goal: ${s.goal}`,
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    "Page snapshot (accessibility tree):",
    s.snapshot,
    "",
    "page_state options:",
    ...Object.entries(PAGE_STATES).map(([k, v]) => `- ${k}: ${v}`),
    "next_action candidates:",
    ...Object.entries(s.candidates).map(([k, v]) => `- ${k}: ${v}`),
    "",
    'Reply with ONLY a JSON object: {"page_state": <option key>, "next_action": <candidate key>, "goal_done": <true|false>, "needs_human": <true|false>}.',
    "goal_done: the goal is already fully achieved on this page. needs_human: progress requires a human (CAPTCHA, 2FA, locked account).",
  ].join("\n");
}

const errName = (e) => (e instanceof Error ? e.name : typeof e);

async function askJev(s) {
  const t0 = performance.now();
  try {
    const r = await evaluate({ model: gw.evaluationModel(JEV), state: stateFor(s), questions: jevQuestions(s), maxRetries: 0 });
    const ms = performance.now() - t0;
    const a = r.answers;
    const conf = r.providerMetadata?.typesafe?.confidence ?? {};
    return {
      ok: true,
      ms,
      inputTokens: r.usage?.inputTokens ?? null,
      costUsd: (r.usage?.inputTokens ?? 0) * JEV_PRICE_IN,
      page_state: a.page_state?.choice,
      page_state_conf: conf.page_state ?? null,
      next_action: a.next_action?.choice,
      next_action_conf: conf.next_action ?? null,
      next_action_p: a.next_action?.probabilities ?? null,
      goal_done_p: a.goal_done?.probability ?? null,
      needs_human_p: a.needs_human?.probability ?? null,
    };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: errName(e) };
  }
}

const pricing = {};
for (const m of (await gw.getAvailableModels()).models) if (LLMS.includes(m.id)) pricing[m.id] = m.pricing;

async function askLlm(id, s) {
  const t0 = performance.now();
  try {
    const r = await generateText({ model: gw.languageModel(id), prompt: llmPrompt(s), maxRetries: 0 });
    const ms = performance.now() - t0;
    const m = /\{[\s\S]*\}/.exec(r.text);
    const j = m ? JSON.parse(m[0]) : {};
    const p = pricing[id];
    const costUsd = (r.usage?.inputTokens ?? 0) * Number(p.input) + (r.usage?.outputTokens ?? 0) * Number(p.output);
    return {
      ok: true,
      ms,
      inputTokens: r.usage?.inputTokens ?? null,
      outputTokens: r.usage?.outputTokens ?? null,
      costUsd,
      page_state: j.page_state,
      next_action: j.next_action,
      goal_done_p: j.goal_done === true ? 1 : 0,
      needs_human_p: j.needs_human === true ? 1 : 0,
    };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: errName(e) };
  }
}

const rows = [];
for (const s of dataset) {
  const row = { flow: s.flow, step: s.step, truth: s.truth, jev: await askJev(s), jev2: await askJev(s) };
  for (const id of LLMS) row[id] = await askLlm(id, s);
  rows.push(row);
  process.stdout.write(".");
}
console.log();
writeFileSync("results.raw.json", JSON.stringify({ at: new Date().toISOString(), pricing, rows }, null, 1));

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const quantile = (xs, q) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function score(key, pick = (r) => r[key]) {
  const ok = rows.filter((r) => pick(r)?.ok);
  const acc = (f) => ok.filter(f).length;
  const bool = (p, t) => (p ?? 0) >= 0.5 === t;
  return {
    n: ok.length,
    failed: rows.length - ok.length,
    page_state: acc((r) => pick(r).page_state === r.truth.page_state),
    next_action: acc((r) => pick(r).next_action === r.truth.next_action),
    goal_done: acc((r) => bool(pick(r).goal_done_p, r.truth.goal_done)),
    needs_human: acc((r) => bool(pick(r).needs_human_p, r.truth.needs_human)),
    msP50: quantile(ok.map((r) => pick(r).ms), 0.5),
    msP95: quantile(ok.map((r) => pick(r).ms), 0.95),
    msMean: mean(ok.map((r) => pick(r).ms)),
    costPerStep: mean(ok.map((r) => pick(r).costUsd)),
    inTok: mean(ok.map((r) => pick(r).inputTokens ?? 0)),
  };
}

const table = {
  "jev (pass 1)": score("jev"),
  "jev (pass 2)": score("jev2"),
  "sonnet-5": score(LLMS[0]),
  "haiku-4.5": score(LLMS[1]),
};
console.log("\nmodel          n  page_state next_action goal_done needs_human  p50ms p95ms  $/step      inTok");
for (const [name, t] of Object.entries(table)) {
  console.log(
    `${name.padEnd(14)} ${String(t.n).padStart(2)}  ${pct(t.page_state, t.n).padStart(9)} ${pct(t.next_action, t.n).padStart(11)} ${pct(t.goal_done, t.n).padStart(9)} ${pct(t.needs_human, t.n).padStart(11)}  ${String(Math.round(t.msP50)).padStart(5)} ${String(Math.round(t.msP95)).padStart(5)}  ${t.costPerStep.toExponential(2)}  ${Math.round(t.inTok)}`,
  );
}

// Jev confidence as a router: keep Jev's pick when confident, otherwise ask Sonnet.
console.log("\nrouter: use Jev when its next_action confidence >= tau, else Sonnet's answer");
for (const tau of [0.5, 0.7, 0.9]) {
  const usable = rows.filter((r) => r.jev.ok && r[LLMS[0]].ok);
  const confident = usable.filter((r) => (r.jev.next_action_conf ?? 0) >= tau);
  const jevRight = confident.filter((r) => r.jev.next_action === r.truth.next_action).length;
  const routed = usable.length - confident.length;
  const combined = usable.filter((r) => ((r.jev.next_action_conf ?? 0) >= tau ? r.jev : r[LLMS[0]]).next_action === r.truth.next_action).length;
  console.log(`tau=${tau}: confident ${confident.length}/${usable.length}, Jev right on confident ${jevRight}/${confident.length}, routed to LLM ${routed}, combined accuracy ${combined}/${usable.length}`);
}

// Where do the models disagree with the truth?
console.log("\nnext_action misses (flow#step: truth | jev | sonnet | haiku)");
for (const r of rows) {
  const t = r.truth.next_action;
  const miss = [r.jev.next_action, r[LLMS[0]].next_action, r[LLMS[1]].next_action].some((x) => x !== t);
  if (miss) console.log(`${r.flow}#${r.step}: ${t} | ${r.jev.next_action ?? r.jev.error} | ${r[LLMS[0]].next_action ?? r[LLMS[0]].error} | ${r[LLMS[1]].next_action ?? r[LLMS[1]].error}`);
}
console.log("\npage_state/goal_done/needs_human misses (flow#step: field truth -> jev | sonnet | haiku)");
for (const r of rows) {
  for (const f of ["page_state"]) {
    const t = r.truth[f];
    const vals = [r.jev[f], r[LLMS[0]][f], r[LLMS[1]][f]];
    if (vals.some((x) => x !== t)) console.log(`${r.flow}#${r.step}: ${f} ${t} -> ${vals.join(" | ")}`);
  }
  for (const f of ["goal_done", "needs_human"]) {
    const t = r.truth[f];
    const vals = [r.jev[`${f}_p`], r[LLMS[0]][`${f}_p`], r[LLMS[1]][`${f}_p`]];
    if (vals.some((p) => (p ?? 0) >= 0.5 !== t)) console.log(`${r.flow}#${r.step}: ${f} ${t} -> ${vals.map((p) => (p == null ? "err" : p.toFixed(2))).join(" | ")}`);
  }
}

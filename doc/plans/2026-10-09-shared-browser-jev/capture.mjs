// Drives agent-browser through three flows on public automation-practice sites and records, per step,
// the page snapshot plus ground-truth labels. Labels live in the flow spec (written before capture).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SESSION = "jevcap";
const SNAPSHOT_CHARS = 6000;
const run = (...args) => {
  try {
    return execFileSync("agent-browser", args, {
      env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
      encoding: "utf8",
      timeout: 60_000,
    }).trim();
  } catch (e) {
    return `ERR ${String(e.stdout ?? "").trim()} ${String(e.stderr ?? "").trim()}`.trim();
  }
};

// Deterministic PRNG so candidate order is reproducible.
let seed = 20261009;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const ELEMENT = /^\s*- (textbox|button|link|checkbox|radio|combobox|searchbox) "([^"]*)"[^\n]*?\[(?:[^\]]*?)ref=(e\d+)\]/;
const parseElements = (snap) =>
  snap.split("\n").flatMap((line) => {
    const m = ELEMENT.exec(line);
    return m ? [{ role: m[1], name: m[2], ref: m[3] }] : [];
  });

const findTarget = (elements, { role, name, nth = 0 }) => {
  const want = name.toLowerCase();
  const sameRole = elements.filter((e) => !role || e.role === role);
  const exact = sameRole.filter((e) => e.name.toLowerCase() === want);
  const hits = exact.length > nth ? exact : sameRole.filter((e) => e.name.toLowerCase().includes(want));
  if (!hits[nth]) {
    const seen = elements.slice(0, 14).map((e) => `${e.role}:${e.name}`).join(" | ");
    throw new Error(`target not found: ${role} ${name} #${nth}; page has: ${seen}`);
  }
  return hits[nth];
};

const describe = (act, el) => {
  if (act.kind === "stop") return "stop: the goal is already achieved";
  if (act.kind === "handoff") return "handoff: ask a human to take over";
  if (act.kind === "fill") return `fill @${el.ref} (${el.role} "${el.name}") with "${act.value}"`;
  return `click @${el.ref} (${el.role} "${el.name}")`;
};

const FLOWS = [
  {
    id: "saucedemo-checkout",
    goal: "Sign in to the shop as standard_user (password secret_sauce), add the Sauce Labs Backpack to the cart and complete checkout for Ada Lovelace, zip 75001.",
    start: "https://www.saucedemo.com/",
    steps: [
      { state: "signed_out", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Username", value: "standard_user" } },
      { state: "signed_out", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Password", value: "secret_sauce" } },
      { state: "signed_out", done: false, human: false, act: { kind: "click", role: "button", name: "Login" } },
      // agent-browser 0.38.1 reports "Done" for a real click here but the cart stays empty (cause undetermined;
      // a JS .click() works), so the run step uses the page's own click handler.
      { state: "signed_in", done: false, human: false, act: { kind: "click", role: "button", name: "Add to cart", nth: 0 }, run: { kind: "jsclick", selector: "#add-to-cart-sauce-labs-backpack" } },
      { state: "signed_in", done: false, human: false, act: { kind: "click", role: "button", name: "Cart," }, run: { kind: "jsclick", selector: ".shopping_cart_link" } },
      { state: "signed_in", done: false, human: false, act: { kind: "click", role: "button", name: "Checkout" }, run: { kind: "jsclick", selector: "#checkout" } },
      { state: "signed_in", done: false, human: false, act: { kind: "fill", role: "textbox", name: "First Name", value: "Ada" } },
      { state: "signed_in", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Last Name", value: "Lovelace" } },
      { state: "signed_in", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Zip", value: "75001" } },
      { state: "signed_in", done: false, human: false, act: { kind: "click", role: "button", name: "Continue" }, run: { kind: "jsclick", selector: "#continue" } },
      { state: "signed_in", done: false, human: false, act: { kind: "click", role: "button", name: "Finish" }, run: { kind: "jsclick", selector: "#finish" } },
      { state: "signed_in", done: true, human: false, act: { kind: "stop" } },
    ],
  },
  {
    id: "practice-login-retry",
    goal: "Sign in with username student and password Password123, then log out.",
    start: "https://practicetestautomation.com/practice-test-login/",
    steps: [
      { state: "signed_out", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Username", value: "student" } },
      // The agent fumbles the password on purpose to reach the failure page; the label is still the correct decision.
      { state: "signed_out", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Password", value: "Password123" }, run: { kind: "fill", role: "textbox", name: "Password", value: "wrong-pass" } },
      { state: "signed_out", done: false, human: false, act: { kind: "click", role: "button", name: "Submit" } },
      // The failed attempt resets the form, so the retry refills both fields.
      { state: "signed_out", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Username", value: "student" } },
      { state: "signed_out", done: false, human: false, act: { kind: "fill", role: "textbox", name: "Password", value: "Password123" } },
      { state: "signed_out", done: false, human: false, act: { kind: "click", role: "button", name: "Submit" } },
      { state: "signed_in", done: false, human: false, act: { kind: "click", role: "link", name: "Log out" } },
      { state: "signed_out", done: true, human: false, act: { kind: "stop" } },
    ],
  },
  {
    id: "hard-states",
    goal: "Complete the task shown for each page: submit the sample form; recover from errors; add a todo called buy milk and mark it done; find the practice exercises.",
    start: "https://www.google.com/recaptcha/api2/demo",
    steps: [
      // A CAPTCHA the agent must not attempt: hand off to a human.
      { state: "captcha", done: false, human: true, goal: "Submit the sample form on this page.", act: { kind: "handoff" }, run: { kind: "open", url: "https://httpbin.org/status/503" } },
      { state: "error_page", done: false, human: false, goal: "Open https://httpbin.org/status/503 and read the status.", act: { kind: "click", role: "button", name: "Reload" }, run: { kind: "open", url: "https://practicetestautomation.com/this-page-does-not-exist-xyz/" } },
      { state: "error_page", done: false, human: false, goal: "Find the practice exercises on this site.", act: { kind: "click", role: "link", name: "PRACTICE" }, run: { kind: "open", url: "https://www.saucedemo.com/" } },
      // Locked-out account: sign-in fails with an error banner.
      { state: "signed_out", done: false, human: false, goal: "Sign in as locked_out_user (password secret_sauce).", act: { kind: "fill", role: "textbox", name: "Username", value: "locked_out_user" }, run: { kind: "fill", role: "textbox", name: "Username", value: "locked_out_user" } },
      { state: "signed_out", done: false, human: false, goal: "Sign in as locked_out_user (password secret_sauce).", act: { kind: "fill", role: "textbox", name: "Password", value: "secret_sauce" } },
      { state: "signed_out", done: false, human: false, goal: "Sign in as locked_out_user (password secret_sauce).", act: { kind: "click", role: "button", name: "Login" } },
      // The account is locked: the agent cannot fix that, so the right move is to hand off.
      { state: "signed_out", done: false, human: true, goal: "Sign in as locked_out_user (password secret_sauce).", act: { kind: "handoff" }, run: { kind: "open", url: "https://demo.playwright.dev/todomvc/" } },
      { state: "other", done: false, human: false, goal: "Add a todo called buy milk and mark it done.", act: { kind: "fill", role: "textbox", name: "What needs to be done", value: "buy milk" }, run: { kind: "fillEnter", role: "textbox", name: "What needs to be done", value: "buy milk" } },
      { state: "other", done: false, human: false, goal: "Add a todo called buy milk and mark it done.", act: { kind: "click", role: "checkbox", name: "Toggle Todo" }, run: { kind: "click", role: "checkbox", name: "Toggle Todo" } },
      { state: "other", done: true, human: false, goal: "Add a todo called buy milk and mark it done.", act: { kind: "stop" } },
    ],
  },
];

const WAIT_MS = "1800";
const stats = { clicks: 0, noEffectClicks: 0 };
const normalise = (s) => s.replace(/ref=e\d+/g, "ref=_");
run("close", "--all");
await new Promise((r) => setTimeout(r, 3000));
const dataset = [];
for (const flow of FLOWS) {
  run("open", flow.start);
  run("wait", WAIT_MS);
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const snapshot = run("snapshot", "-c").slice(0, SNAPSHOT_CHARS);
    const url = run("get", "url");
    const title = run("get", "title");
    const elements = parseElements(snapshot);
    const goal = step.goal ?? flow.goal;

    let truthEl = null;
    if (step.act.role) truthEl = findTarget(elements, step.act);
    const truthText = describe(step.act, truthEl);

    // Candidates: the right action, a stop and a handoff option, plus plausible distractors from the page.
    const pool = elements.filter((e) => e.ref !== truthEl?.ref);
    const distractors = shuffle(pool).slice(0, 3).map((e) => ({
      text: e.role === "textbox" ? `fill @${e.ref} (${e.role} "${e.name}") with "${step.act.value ?? "text"}"` : `click @${e.ref} (${e.role} "${e.name}")`,
    }));
    const base = [{ text: truthText }, ...distractors];
    if (step.act.kind !== "stop") base.push({ text: describe({ kind: "stop" }) });
    if (step.act.kind !== "handoff") base.push({ text: describe({ kind: "handoff" }) });
    const ordered = shuffle(base);
    const candidates = {};
    let truthId = "";
    ordered.forEach((c, idx) => {
      const id = `c${idx + 1}`;
      candidates[id] = c.text;
      if (c.text === truthText) truthId = id;
    });

    if (!step.skipCapture) {
      dataset.push({
        flow: flow.id,
        step: i + 1,
        goal,
        url,
        title,
        snapshot,
        candidates,
        truth: { page_state: step.state, goal_done: step.done, needs_human: step.human, next_action: truthId },
      });
    }

    // Advance the browser with the "run" action (defaults to the truth action).
    const exec = step.run ?? step.act;
    if (exec.kind === "open") {
      run("open", exec.url);
    } else if (exec.kind === "jsclick") {
      run("eval", `document.querySelector(${JSON.stringify(exec.selector)}).click()`);
    } else if (exec.kind === "stop" || exec.kind === "handoff") {
      // terminal
    } else {
      const el = findTarget(elements, exec);
      const outputs = [];
      if (exec.kind === "fill") outputs.push(run("fill", `@${el.ref}`, exec.value));
      else if (exec.kind === "fillEnter") {
        outputs.push(run("fill", `@${el.ref}`, exec.value));
        outputs.push(run("press", "Enter"));
      } else {
        outputs.push(run("click", `@${el.ref}`));
        stats.clicks++;
        run("wait", "1200");
        const unchanged = normalise(run("snapshot", "-c").slice(0, SNAPSHOT_CHARS)) === normalise(snapshot);
        const expectsChange = !/checkbox|radio/.test(el.role);
        if (unchanged && expectsChange) {
          stats.noEffectClicks++;
          const needle = JSON.stringify(el.name.toLowerCase());
          run("eval", `[...document.querySelectorAll('button,a,input[type=submit],[role=button]')].find(e => (e.innerText||e.value||e.getAttribute('aria-label')||'').trim().toLowerCase().includes(${needle}))?.click()`);
        }
      }
      for (const out of outputs) if (out.startsWith("ERR") || out.includes("✗")) console.error(`[${flow.id}#${i + 1}] ${exec.kind} @${el.ref}: ${out.slice(0, 200)}`);
    }
    run("wait", WAIT_MS);
  }
}
run("close", "--all");
writeFileSync("dataset.json", JSON.stringify(dataset, null, 1));
writeFileSync("capture-stats.json", JSON.stringify(stats, null, 1));
console.log(`captured ${dataset.length} steps across ${FLOWS.length} flows; real clicks=${stats.clicks}, no visible effect (JS fallback)=${stats.noEffectClicks}`);
for (const f of FLOWS) console.log(f.id, dataset.filter((d) => d.flow === f.id).length);

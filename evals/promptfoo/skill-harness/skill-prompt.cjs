// Prompt function for the skill-injecting eval harness (see skill-agent-provider.cjs).
//
// Builds a chat transcript as JSON: a system message that carries the environment and the
// full SKILL.md under test, and a user message that carries only the scenario. The test's
// expectedBehavior var is the answer key, so it is never shown to the model.

const fs = require("node:fs");
const path = require("node:path");

const ENV_VARS = [
  ["PAPERCLIP_AGENT_ID", "agentId"],
  ["PAPERCLIP_COMPANY_ID", "companyId"],
  ["PAPERCLIP_API_URL", "apiUrl"],
  ["PAPERCLIP_RUN_ID", "runId"],
  ["PAPERCLIP_TASK_ID", "taskId"],
  ["PAPERCLIP_WAKE_REASON", "wakeReason"],
  ["PAPERCLIP_APPROVAL_ID", "approvalId"],
];

const DEFAULT_SCENARIO =
  "You were woken for a heartbeat. The wake payload carries no extra context beyond the environment variables above.";

const REPLY_FORMAT =
  "Dry run: no Paperclip API is reachable, so do not try to call it. Reply with the ordered requests you would send " +
  "(method, path, headers, JSON body) and the exact comment text you would post, then stop.";

function buildSystem(vars, skillText, skillDir) {
  const env = ENV_VARS.filter(([, key]) => vars[key] !== undefined && vars[key] !== "")
    .map(([name, key]) => `${name}=${vars[key]}`)
    .join("\n");
  return [
    "You are a Paperclip agent woken for a heartbeat. This is a dry run that evaluates how you follow your skill.",
    "",
    "Environment:",
    env,
    "",
    `Your skill is loaded below. It lives in ${skillDir}. Open a file it refers to with the read_file tool, using a path relative to that directory, when the skill tells you to read it.`,
    "",
    "<skill name=\"paperclip\">",
    skillText.trimEnd(),
    "</skill>",
  ].join("\n");
}

module.exports = function skillPrompt({ vars }) {
  const skillDir = path.resolve(process.cwd(), process.env.PAPERCLIP_EVAL_SKILL_DIR || "skills/paperclip");
  const skillText = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const scenario = String(vars.scenario || vars.prompt || DEFAULT_SCENARIO).trim();
  return JSON.stringify([
    { role: "system", content: buildSystem(vars, skillText, path.relative(process.cwd(), skillDir) || ".") },
    { role: "user", content: `${scenario}\n\n${REPLY_FORMAT}` },
  ]);
};

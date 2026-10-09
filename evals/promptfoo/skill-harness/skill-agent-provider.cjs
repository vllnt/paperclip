// Promptfoo provider that runs a dry-run Paperclip agent turn with a real skill loaded.
//
// The legacy evals prompt the model with a short stand-in (prompts/heartbeat-system.txt)
// and never load skills/paperclip/SKILL.md. This provider closes that gap: the prompt
// function (skill-prompt.cjs) puts the skill in the system message, and this provider
// lets the model open the skill's reference files with a sandboxed read_file tool, the
// way a real agent does. That measures whether the skill's pointers lead to the right
// reference, which a single-turn prompt cannot.
//
// Config (providers[].config):
//   model       gateway model id, e.g. anthropic/claude-sonnet-5
//   baseUrl     OpenAI-compatible endpoint (default https://ai-gateway.vercel.sh/v1)
//   maxTurns    model calls per test, including the final answer (default 6). Tools stay available
//               on every turn except the last one, which omits them so the model has to answer.
//   maxTokens   completion cap per call (default 16000). Hidden thinking counts against it: at 4096 a
//               Sonnet 5 reply could spend the whole budget on thinking and return no visible text.
// Env: AI_GATEWAY_API_KEY (never logged), PAPERCLIP_EVAL_SKILL_DIR (default skills/paperclip)

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a text file from your skill directory. Pass a path relative to the skill directory, for example references/api-reference.md.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside the skill directory." } },
      required: ["path"],
    },
  },
};

function resolveSkillDir() {
  return path.resolve(process.cwd(), process.env.PAPERCLIP_EVAL_SKILL_DIR || "skills/paperclip");
}

function readSkillFile(skillDir, requested) {
  const trimmed = String(requested ?? "").trim().replace(/^\.?\//, "").replace(/^skills\/paperclip\//, "");
  const target = path.resolve(skillDir, trimmed);
  const relative = path.relative(skillDir, target);
  if (!trimmed || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, text: "error: path is outside the skill directory" };
  }
  try {
    if (!fs.statSync(target).isFile()) return { ok: false, text: "error: not a file" };
    return { ok: true, text: fs.readFileSync(target, "utf8"), file: relative };
  } catch {
    return { ok: false, text: "error: file not found" };
  }
}

async function postChat(baseUrl, apiKey, body) {
  let lastError = "no response";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** (attempt - 1)));
    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = `network error: ${error instanceof Error ? error.message : "unknown"}`;
      continue;
    }
    if (response.ok) return { ok: true, json: await response.json() };
    const text = await response.text();
    lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
    if (!RETRY_STATUSES.has(response.status)) break;
  }
  return { ok: false, error: lastError };
}

class SkillAgentProvider {
  constructor(options = {}) {
    this.providerId = options.id ?? "skill-agent";
    this.config = options.config ?? {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) return { error: "AI_GATEWAY_API_KEY is not set" };
    const { model, baseUrl = DEFAULT_BASE_URL, maxTurns = 6, maxTokens = 16000 } = this.config;
    if (!model) return { error: "provider config.model is required" };

    const skillDir = resolveSkillDir();
    const messages = JSON.parse(prompt);
    const filesRead = [];
    const usage = { prompt: 0, completion: 0, total: 0 };

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const lastTurn = turn === maxTurns;
      const result = await postChat(baseUrl, apiKey, {
        model,
        messages,
        max_tokens: maxTokens,
        ...(lastTurn ? {} : { tools: [READ_FILE_TOOL] }),
      });
      if (!result.ok) return { error: result.error };
      const choice = result.json.choices?.[0]?.message;
      const used = result.json.usage ?? {};
      usage.prompt += used.prompt_tokens ?? 0;
      usage.completion += used.completion_tokens ?? 0;
      usage.total += used.total_tokens ?? (used.prompt_tokens ?? 0) + (used.completion_tokens ?? 0);
      if (!choice) return { error: "gateway returned no message" };

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0 || lastTurn) {
        return {
          output: typeof choice.content === "string" ? choice.content : "",
          tokenUsage: { total: usage.total, prompt: usage.prompt, completion: usage.completion },
          metadata: { filesRead, turns: turn },
        };
      }

      messages.push({ role: "assistant", content: choice.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let requested = "";
        try {
          requested = JSON.parse(call.function?.arguments ?? "{}").path;
        } catch {
          requested = "";
        }
        const read = readSkillFile(skillDir, requested);
        if (read.ok) filesRead.push(read.file);
        messages.push({ role: "tool", tool_call_id: call.id, content: read.text });
      }
    }
    return { error: "turn limit reached without an answer" };
  }
}

module.exports = SkillAgentProvider;

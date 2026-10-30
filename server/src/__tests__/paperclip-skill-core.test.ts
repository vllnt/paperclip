import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The bundled `paperclip` skill is loaded in full on every run that uses it, so
// its body is a fixed cost of every turn. SKILL.md is the core (heartbeat loop,
// hot routes, critical rules); everything else is a reference that the core
// links and an agent reads on demand. These checks keep that split honest.

const skillDir = new URL("../../../skills/paperclip/", import.meta.url);
const skillPath = (relative: string): string => path.join(skillDir.pathname, relative);
const read = (relative: string): string => fs.readFileSync(skillPath(relative), "utf8");

const CORE_BUDGET_CHARS = 20_000;

const core = read("SKILL.md");
const referenceFiles = fs
  .readdirSync(skillPath("references"))
  .filter((name) => name.endsWith(".md"))
  .sort();

function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) anchors.add(githubSlug(heading[1]!));
    for (const explicit of line.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(explicit[1]!);
  }
  return anchors;
}

function localLinks(markdown: string): Array<{ target: string; text: string }> {
  const prose = markdown.replace(/```[\s\S]*?```/g, "");
  return [...prose.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)]
    .map((match) => ({ text: match[1]!, target: match[2]! }))
    .filter((link) => !/^[a-z][a-z0-9+.-]*:/i.test(link.target) && !link.target.startsWith("/") && !/[${}]/.test(link.target));
}

function referenceIndex(): string[] {
  const start = core.indexOf("## Reference index");
  const end = core.indexOf("\n## ", start + 1);
  return core
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

describe("paperclip skill core", () => {
  it(`keeps the always-loaded body within ${CORE_BUDGET_CHARS} characters`, () => {
    // Characters, not bytes: the measure the cost review used. Adding a rule that
    // pushes the core over budget means the rule belongs in a reference.
    expect(core.length).toBeLessThanOrEqual(CORE_BUDGET_CHARS);
  });

  it("indexes every reference file with a line that says when to read it", () => {
    const lines = referenceIndex();
    for (const file of referenceFiles) {
      const line = lines.find((candidate) => candidate.includes(`\`references/${file}\``));
      expect(line, `references/${file} is missing from the Reference index`).toBeDefined();
      const description = line!.split(`\`references/${file}\`:`)[1] ?? "";
      expect(description.trim().length, `references/${file} has no trigger text`).toBeGreaterThan(10);
    }
  });

  it("keeps the words an agent matches a task against in each index line", () => {
    // Smoke check for discovery: the index line is the only pointer an agent has,
    // so each line must keep the terms of the task it serves. A fresh agent that
    // read only the core routed 24 sample tasks to the right file with these terms.
    const triggers: Record<string, string[]> = {
      "heartbeat-details.md": ["long threads", "write retries", "final-disposition"],
      "monitors.md": ["CI", "deploy", "re-check"],
      "delegation.md": ["child issues", "courier", "blockers"],
      "human-input.md": ["must answer or decide"],
      "interactions.md": ["checkbox confirmation", "item verdicts"],
      "decisions.md": ["decision bundle"],
      "approvals.md": ["request_board_approval", "approval_required"],
      "planning.md": ["plan"],
      "issue-documents.md": ["document"],
      "artifacts.md": ["work products", "pull_request"],
      "chat.md": ["conversationAgentId", "checkedOutByHarness"],
      "secrets.md": ["credential"],
      "auth-and-cli.md": ["sandbox", "CLI"],
      "inbox.md": ["inbox"],
      "deploy-proof.md": ["production"],
      "routines.md": ["routines", "steps"],
      "cases.md": ["cases"],
      "company-skills.md": ["company skills"],
      "issue-workspaces.md": ["preview"],
      "policies.md": ["policy://"],
      "workflows.md": ["new project", "CEO"],
      "api-reference.md": ["endpoint", "error codes"],
    };
    expect(Object.keys(triggers).sort()).toEqual(referenceFiles);
    const lines = referenceIndex();
    for (const [file, terms] of Object.entries(triggers)) {
      const line = lines.find((candidate) => candidate.includes(`\`references/${file}\``))!;
      for (const term of terms) {
        expect(line.toLowerCase(), `index line for references/${file} lost: ${term}`).toContain(term.toLowerCase());
      }
    }
  });

  it("names no reference file that does not exist", () => {
    const mentioned = [...core.matchAll(/references\/([A-Za-z0-9_.-]+\.md)/g)].map((match) => match[1]!);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const file of new Set(mentioned)) {
      expect(referenceFiles, `SKILL.md names references/${file}`).toContain(file);
    }
  });

  it("resolves every local link and anchor in the core and in every reference", () => {
    const documents = [{ file: "SKILL.md", body: core }, ...referenceFiles.map((file) => ({ file: `references/${file}`, body: read(`references/${file}`) }))];
    for (const { file, body } of documents) {
      const fromDir = path.dirname(skillPath(file));
      for (const { target } of localLinks(body)) {
        const [rawPath = "", anchor] = target.split("#");
        const resolved = rawPath === "" ? skillPath(file) : path.resolve(fromDir, rawPath);
        expect(fs.existsSync(resolved), `${file} links to missing ${target}`).toBe(true);
        if (anchor && resolved.endsWith(".md")) {
          expect(anchorsOf(fs.readFileSync(resolved, "utf8")).has(anchor), `${file} links to missing anchor ${target}`).toBe(true);
        }
      }
    }
  });

  it("keeps the rules every run needs inside the core", () => {
    for (const phrase of [
      "Scoped-wake fast path",
      "never retry a 409",
      "X-Paperclip-Run-Id",
      "Verify writes — never infer them",
      "end your turn with `issue wait`; never leave a background process running",
      "Never paste the API key",
      "Do not use `pnpm paperclipai`",
      "`blockedByIssueIds`",
      "Ticket references are links",
      "Company-prefixed URLs",
      "NEVER paste a credential",
      "`approval_required`",
      "no co-author",
      "`active` company policies",
    ]) {
      expect(core, `the core lost: ${phrase}`).toContain(phrase);
    }
  });

  it("keeps the detail that moved out of the core in its reference", () => {
    const moved: Array<[string, string[]]> = [
      ["interactions.md", ["request_checkbox_confirmation", "request_item_verdicts", '"stale_target"', "reviewInteractionId", "supersedeOnUserComment"]],
      ["decisions.md", ["/decision-bundles", "assign_issue", "wake_origin_agent"]],
      ["human-input.md", ['"kind": "ask_user_questions"', "resolve-from-comment", "asking-for-human-input"]],
      ["approvals.md", ["request_board_approval", "approval_path_missing", "60 minutes"]],
      ["monitors.md", ["tickDueIssueMonitors", "unknown command 'wait'", "--pull-request", "in_review_without_action_path", "invalid_issue_disposition"]],
      ["delegation.md", ["Courier pattern", "Never instruct a delegate", "inheritExecutionWorkspaceFromIssueId", "issue_blockers_resolved"]],
      ["heartbeat-details.md", ["Blocked-task dedup", "bounded_task_history", "Bounded write retry", "final-disposition checklist", "Remaining"]],
      ["chat.md", ["checkedOutByHarness: true", "register_deliverable", "initialPlan"]],
      ["planning.md", ["baseRevisionId", "latestRevisionId", "do not mark the issue as done"]],
      ["secrets.md", ["secret-proposals", "secret_access_events", "/api/agents/me/secrets"]],
      ["auth-and-cli.md", ["pnpm exec paperclipai", "paperclipai agent local-cli", "fallbackFetchNeeded"]],
      ["inbox.md", ["inbox-archive", "inbox:manage"]],
      ["deploy-proof.md", ["/api/health", "merge-base --is-ancestor"]],
      ["artifacts.md", ["`pull_request` for opened PRs", "workspace_file"]],
      ["issue-workspaces.md", ["unmanaged background servers"]],
      ["company-skills.md", ["skills/sync", "desiredSkills"]],
    ];
    for (const [file, phrases] of moved) {
      const body = read(`references/${file}`);
      for (const phrase of phrases) expect(body, `references/${file} lost: ${phrase}`).toContain(phrase);
    }
  });
});

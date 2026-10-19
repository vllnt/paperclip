import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every server source file that can write an agent row (it uses `agentService`,
 * writes the `agents` table directly, or calls the agent lifecycle or the
 * configuration write helper) must be listed here with how an agent
 * caller is kept from using it to set protected fields (caps, model, budget,
 * bypass flags, role, permissions, leaving `paused`). A new file that writes
 * agents fails this test until someone classifies it. A `guarded` entry names
 * the test file that proves the guard.
 */
type Surface =
  | { kind: "guarded"; how: string; tests: string[] }
  | { kind: "board-only" | "user-resolved" | "system" | "read-only" | "owner"; how: string };

const SURFACES: Record<string, Surface> = {
  "routes/access.ts": {
    kind: "guarded",
    how: "OpenClaw invite replay and agent-approved join requests need agents:configure for protected fields",
    tests: ["agent-self-config-guard-routes.test.ts"],
  },
  "routes/agents.ts": {
    kind: "guarded",
    how: "PATCH, config rollback, permissions, create, and hire compare protected fields; PATCH and rollback re-check under a row lock; resume needs a change grant; pause, approve, terminate, and delete are board-only; skill and instruction routes write only their own keys",
    tests: [
      "agent-self-config-guard-routes.test.ts",
      "agent-create-and-race-guard-routes.test.ts",
      "agent-skills-routes.test.ts",
      "agent-instructions-routes.test.ts",
    ],
  },
  "routes/companies.ts": {
    kind: "guarded",
    how: "the agent-reachable safe import needs a company-wide agents:configure when it creates agents",
    tests: ["company-portability-routes.test.ts"],
  },
  "routes/costs.ts": { kind: "board-only", how: "agent budget and budget policy routes call assertBoard" },
  "routes/issues.ts": { kind: "read-only", how: "reads agents for assignment checks" },
  "routes/llms.ts": { kind: "read-only", how: "reads agents for the llms listing" },
  "routes/teams-catalog.ts": { kind: "read-only", how: "reads agents; installs go through the portability service" },
  "services/agents.ts": { kind: "owner", how: "the agent service; every caller is classified in this table" },
  "services/approvals.ts": { kind: "board-only", how: "approve and reject routes call assertBoard and apply a payload the board reviewed" },
  "services/built-in-agents.ts": {
    kind: "guarded",
    how: "provision (existing and first-time) and reset compare protected fields on the route; reconcile applies server-owned definition defaults only",
    tests: ["built-in-agent-routes.test.ts"],
  },
  "services/company-portability.ts": {
    kind: "guarded",
    how: "imports are board-only on the full route and need agents:configure on the agent-safe route",
    tests: ["company-portability-routes.test.ts"],
  },
  "services/company-skills.ts": { kind: "system", how: "skill rename and fork reassignment rewrite only the adapterConfig skill-sync keys; no protected fields" },
  "services/connection-intents.ts": { kind: "user-resolved", how: "a signed-in user resolves the intent that binds an AI connection" },
  "services/heartbeat.ts": { kind: "system", how: "run bookkeeping and legacy runner provider normalization; no caller-chosen values" },
  "services/index.ts": { kind: "read-only", how: "barrel export" },
  "services/native-runtime/agent-instruction-tools.ts": { kind: "read-only", how: "reads the target agent" },
  "services/native-runtime/paperclip-runner-tool-authority.ts": { kind: "read-only", how: "reads agents for tool authority checks" },
  "services/onboarding-seed.ts": { kind: "board-only", how: "runs from the board onboarding flow" },
  "services/plugin-host-services.ts": {
    kind: "guarded",
    how: "managed reconcile and reset, pause, and resume check the agent behind the plugin call",
    tests: ["plugin-managed-agents-agent-caller.test.ts", "plugin-worker-manager.test.ts"],
  },
  "services/plugin-managed-agents.ts": {
    kind: "guarded",
    how: "managed create and reset check the agent behind the plugin call; relink and pause-reason backfill write metadata only",
    tests: ["plugin-managed-agents-agent-caller.test.ts"],
  },
  "services/secret-proposals.ts": { kind: "user-resolved", how: "a signed-in user resolves the proposal that binds a secret" },
  "services/summary-slots.ts": { kind: "read-only", how: "reads agents for summary slots" },
  "services/teams-catalog.ts": { kind: "read-only", how: "reads agents; applies go through the portability service" },
  "modules/active-run-watchdog/adapters/postgres.ts": { kind: "system", how: "watchdog status bookkeeping" },
  "services/agent-instruction-revisions.ts": { kind: "guarded", how: "writes instruction keys only; instruction routes check the instruction permission", tests: ["agent-instructions-routes.test.ts"] },
  "services/budgets.ts": { kind: "system", how: "budget enforcement pauses and resumes; the policy routes are board-only" },
  "services/companies.ts": { kind: "system", how: "company lifecycle (archive, pause, delete)" },
  "services/execution-control-reconciliation.ts": { kind: "system", how: "run reconciliation" },
  "app.ts": { kind: "system", how: "starts the agent lifecycle worker at boot; no request input" },
  "modules/agent-lifecycle/index.ts": { kind: "owner", how: "the agent lifecycle module (hire, configure, pause, resume, terminate, purge); every caller is classified in this table" },
  "modules/agent-lifecycle/configuration.ts": { kind: "read-only", how: "barrel export of the configuration write" },
  "modules/agent-lifecycle/adapters/company-deletion.ts": { kind: "board-only", how: "deletes a company's terminated agents during company deletion, which calls assertBoard" },
  "modules/agent-lifecycle/adapters/configuration.ts": { kind: "owner", how: "the single configuration write; refuses fields outside the configuration list and re-checks the locked row" },
  "modules/agent-lifecycle/adapters/deletion.ts": { kind: "owner", how: "purges terminated agents only; the delete route calls assertBoard" },
  "modules/agent-lifecycle/adapters/postgres.ts": { kind: "owner", how: "lifecycle state, holds, and worker lease bookkeeping behind the lifecycle commands" },
  "modules/agent-lifecycle/adapters/records.ts": { kind: "owner", how: "hire insert, error clearing, and hire approve or reject records behind the lifecycle commands" },
  "modules/external-agents/dot.ts": { kind: "user-resolved", how: "an operator creates the pairing; pair and revoke write only the Dot or Grok binding id" },
  "modules/external-agents/muse.ts": { kind: "board-only", how: "pairing needs a board user with an agent_config:update change grant; writes only the Muse binding id" },
  "routes/dot-runner.ts": { kind: "read-only", how: "reads agents; routes call assertBoard and write through the Dot broker and invitations" },
  "routes/grok-bot.ts": { kind: "read-only", how: "reads agents; routes call assertBoard and write through the Dot broker and invitations" },
  "routes/muse-qualification.ts": { kind: "read-only", how: "reads the agent; routes call assertBoard and need an agent_config:update change grant" },
  "routes/muse.ts": { kind: "read-only", how: "reads agents; routes call assertBoard and write through the Muse broker and invitations" },
  "services/accounting-integrity.ts": { kind: "system", how: "repair resets spentMonthlyCents to the ledger value; the accounting routes call assertBoard" },
  "services/agent-configuration-transaction.ts": { kind: "owner", how: "in-transaction configuration write that refuses budget changes; every caller is classified in this table" },
  "services/agent-deletion.ts": { kind: "system", how: "clears reportsTo on the reports of an agent being purged; purge is board-only" },
  "services/agent-lifecycle.ts": { kind: "owner", how: "wires budget, hire, and configuration effects into the lifecycle module" },
  "services/agent-profile-avatar.ts": { kind: "guarded", how: "writes appearance only; an agent may change only its own avatar", tests: ["agent-profile-avatar.test.ts"] },
  "services/company-deletion.ts": { kind: "board-only", how: "terminates every company agent during company deletion, which calls assertBoard" },
  "services/dot-invitations.ts": { kind: "board-only", how: "invitation routes call assertBoard; creates a fixed-config runner hire that respects board approval" },
  "services/heartbeat/agent-status.ts": { kind: "system", how: "settles run status and error reason; no caller-chosen values" },
  "services/heartbeat/queue.ts": { kind: "system", how: "timer heartbeat stamps and legacy runner provider normalization; no caller-chosen values" },
  "services/muse-invitations.ts": { kind: "board-only", how: "the invitation route calls assertBoard and needs an agents:create change grant; creates a fixed-config hire" },
  "services/public-mcp/oauth.ts": { kind: "user-resolved", how: "consent with the operator's one-use pairing code writes only the Dot or Grok binding id" },
};

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.resolve(SOURCE_ROOT, "__tests__");
// Upstream moved agent writes behind the lifecycle module and the configuration write helper.
const AGENT_WRITE_PATTERN =
  /\bagentService\b|\.(update|insert|delete)\((agents|agentsTable)\)|\b(createAgentLifecycle|configureAgentLifecycle|startAgentLifecycle|updateAgentConfiguration|updateAgentConfigurationInTransaction)\b/;

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : listSourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("agent write surfaces", () => {
  const matched = listSourceFiles(SOURCE_ROOT)
    .filter((file) => AGENT_WRITE_PATTERN.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(SOURCE_ROOT, file).split(path.sep).join("/"))
    .sort();

  it("classifies every source file that can write an agent row", () => {
    expect(matched).toEqual(Object.keys(SURFACES).sort());
  });

  it("points every guarded surface at tests that exist", () => {
    const guarded = Object.entries(SURFACES).filter(([, surface]) => surface.kind === "guarded");
    expect(guarded.length).toBeGreaterThan(0);
    for (const [file, surface] of guarded) {
      if (surface.kind !== "guarded") continue;
      for (const test of surface.tests) {
        expect(fs.existsSync(path.join(TEST_ROOT, test)), `${file} names missing test ${test}`).toBe(true);
      }
    }
  });
});

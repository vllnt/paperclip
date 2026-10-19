import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";
import {
  type ClientCall,
  type CoverageResult,
  type SpecOperation,
  PARITY_BASELINE_FILE,
  PARITY_EXEMPTIONS_FILE,
  collectCoverage,
  escapeCell,
  extractCliCalls,
  extractUiCalls,
  findCliGaps,
  findCliRegistrationPrefixes,
  loadSharedConstants,
  loadSpecOperations,
  matchOperation,
  operationId,
  readParityBaseline,
  readParityExemptions,
  renderCoverageMarkdown,
  unreviewedCliGaps,
} from "../../scripts/api-coverage-matrix.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const sharedConstants = await loadSharedConstants(REPO_ROOT);

/** CLI source the scanner reads, kept as real files so its backticks and `${}` need no escaping. */
const cliFixture = (name: string): string =>
  readFileSync(path.join(TEST_DIR, "fixtures/api-coverage-matrix", `${name}.cli.txt`), "utf8");

/**
 * API calls whose path the scanner can't resolve statically, or that dispatch
 * generically (`/api/${resource}`). Their operations can't be checked against
 * the OpenAPI document, so this list is pinned: a new entry fails the test.
 * Prefer a literal path (or `apiPath` template) over adding to this list.
 */
const KNOWN_UNRESOLVED_CALLS = [
  "cli/src/commands/client/asset.ts POST path",
  "cli/src/commands/client/auth.ts POST `${apiPath`/api/cli-auth/challenges/${id}`}/${action}`",
  "cli/src/commands/client/company.ts POST importApiPath",
  "cli/src/commands/client/company.ts POST previewApiPath",
  "cli/src/commands/client/company.ts POST transferPreviewPath",
  "cli/src/commands/client/run.ts GET `${path}?${params.toString()}`",
  "cli/src/commands/client/teams.ts POST catalogTeamCompanyPath(ctx.companyId, catalogRef, \"install\")",
  "cli/src/commands/client/teams.ts POST catalogTeamCompanyPath(ctx.companyId, catalogRef, \"preview\")",
  "cli/src/commands/client/workspace.ts PATCH path",
  "cli/src/commands/client/workspace.ts POST path",
  "ui/src/api/announcements.ts GET `/api/announcements/${path}`",
  "ui/src/api/auth.ts PATCH `/api/auth${path}`",
  "ui/src/api/auth.ts POST `/api/auth${path}`",
  "ui/src/api/client.ts GET path: string",
  "ui/src/api/document-annotations.ts GET `${targetBasePath(target)}${qs ? `?${qs}` : \"\"}`",
  "ui/src/api/document-annotations.ts GET `${targetBasePath(target)}/${threadId}`",
  "ui/src/api/document-annotations.ts PATCH `${targetBasePath(target)}/${threadId}`",
  "ui/src/api/document-annotations.ts POST `${targetBasePath(target)}/${threadId}/comments`",
  "ui/src/api/document-annotations.ts POST targetBasePath(target)",
  "ui/src/api/summarySlots.ts GET summarySlotPath(selector)",
  "ui/src/api/summarySlots.ts GET summarySlotPath(selector, \"/revisions\")",
  "ui/src/api/summarySlots.ts POST summarySlotPath(selector, \"/generate\")",
];

describe("api coverage matrix scanner", () => {
  it("resolves UI client paths from templates, helpers, concatenation and query suffixes", () => {
    const source = `
import { api } from "./client";
const LIST_PATH = "/widgets?scope=accessible";
function widgetPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(\`/widgets/\${encodeURIComponent(id)}\${suffix}\`, companyId);
}
export const widgetsApi = {
  list: () => api.get(LIST_PATH),
  activity: (companyId: string, qs: string) =>
    api.get<Widget[]>(\`/companies/\${companyId}/activity\${qs ? \`?\${qs}\` : ""}\`),
  pause: (id: string) => api.post(widgetPath(id, undefined, "/pause"), {}),
  rollback: (id: string, revisionId: string) => api.post(widgetPath(id, undefined, \`/revisions/\${revisionId}/rollback\`), {}),
  byName: (companyId: string) => api.get("/companies/" + encodeURIComponent(companyId) + "/widgets" + "?x=1"),
  remove: (id: string, purge?: boolean) => api.delete(\`/widgets/\${id}\${purge ? "?purge=true" : ""}\`),
  unresolved: (base: string) => api.get(\`\${base}/x\`),
};`;
    const calls = extractUiCalls("ui/src/api/widgets.ts", source);
    expect(calls.map((call) => [call.label, call.method, call.path])).toEqual([
      ["widgetsApi.list", "GET", "/api/widgets"],
      ["widgetsApi.activity", "GET", "/api/companies/{}/activity"],
      ["widgetsApi.pause", "POST", "/api/widgets/{}/pause"],
      ["widgetsApi.rollback", "POST", "/api/widgets/{}/revisions/{}/rollback"],
      ["widgetsApi.byName", "GET", "/api/companies/{}/widgets"],
      ["widgetsApi.remove", "DELETE", "/api/widgets/{}"],
      ["widgetsApi.unresolved", "GET", null],
    ]);
  });

  it("labels CLI calls by their command and expands command-registering helpers and tuple loops", () => {
    const source = cliFixture("widget-commands");
    const calls = extractCliCalls("cli/src/commands/client/widget.ts", source);
    expect(calls.map((call) => [call.label, call.method, call.path])).toEqual([
      ["paperclipai widget get", "GET", "/api/widgets/{}"],
      ["paperclipai", "GET", "/api/widgets/{}"],
      ["paperclipai widget runs", "GET", "/api/widgets/{}/runs"],
      ["paperclipai widget pause", "POST", "/api/widgets/{}/pause"],
      ["paperclipai widget heartbeat:invoke", "POST", "/api/widgets/{}/heartbeat/invoke"],
    ]);
  });

  it("finds raw fetch calls, putRaw, and helpers called with loop variables", () => {
    const ui = extractUiCalls(
      "ui/src/api/health.ts",
      `export const healthApi = {
  restart: async () => {
    const res = await fetch("/api/health/dev-server/restart", { method: "POST" });
    return res.json();
  },
  external: () => fetch("https://example.test/x"),
};`,
    );
    expect(ui.map((call) => [call.method, call.path])).toEqual([["POST", "/api/health/dev-server/restart"]]);

    const cli = extractCliCalls(
      "cli/src/commands/client/cost.ts",
      cliFixture("cost-commands"),
    );
    expect(cli.map((call) => [call.label, call.method, call.path])).toEqual([
      ["paperclipai cost upload", "POST", "/api/companies/{}/attachments"],
      ["paperclipai cost upload", "PUT", "/api/transfers/{}/parts/{}"],
      ["paperclipai cost summary", "GET", "/api/companies/{}/costs/summary"],
      ["paperclipai cost by-agent", "GET", "/api/companies/{}/costs/by-agent"],
    ]);
  });

  it("resolves a local path variable only from an enclosing scope", () => {
    const calls = extractUiCalls(
      "ui/src/api/widgets.ts",
      `export const widgetsApi = {
  a: () => {
    const base = \`/widgets\`;
    return api.get(\`\${base}/a\`);
  },
  b: (base: string) => api.get(\`\${base}/b\`),
};`,
    );
    expect(calls.map((call) => call.path)).toEqual(["/api/widgets/a", null]);
  });

  it("prefixes CLI files registered under a command group in cli/src/index.ts", () => {
    const index = `
import { registerRunCommands } from "./commands/client/run.js";
import { registerAgentCommands } from "./commands/client/agent.js";
const run = program.command("run").description("Run Paperclip");
registerRunCommands(run);
registerAgentCommands(program);`;
    const prefixes = findCliRegistrationPrefixes(index, "cli/src/index.ts");
    expect([...prefixes]).toEqual([["cli/src/commands/client/run.ts", ["run"]]]);
    const calls = extractCliCalls(
      "cli/src/commands/client/run.ts",
      cliFixture("run-commands"),
      { registrationPrefix: prefixes.get("cli/src/commands/client/run.ts") },
    );
    expect(calls.map((call) => call.label)).toEqual(["paperclipai run list"]);
  });

  it("expands a command-registering helper whose name contains a dollar sign", () => {
    const calls = extractCliCalls("cli/src/commands/client/note.ts", cliFixture("dollar-named-helper"));
    expect(calls.map((call) => [call.label, call.method, call.path])).toEqual([
      ["paperclipai note list", "GET", "/api/notes"],
      ["paperclipai note archive", "GET", "/api/notes/archive"],
    ]);
  });

  it("scans a long run of unbalanced generics in linear time", () => {
    const hostile = `api.get${"<<>".repeat(28)}`;
    const started = performance.now();
    extractUiCalls("ui/src/api/hostile.ts", hostile);
    extractCliCalls("cli/src/commands/client/hostile.ts", hostile);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("escapes backslashes before pipes and newlines in table cells", () => {
    expect(escapeCell("a|b\nc")).toBe("a\\|b c");
    expect(escapeCell("a\\|b")).toBe("a\\\\\\|b");
  });

  it("prefers the most literal operation when matching a call path", () => {
    const operations = loadSpecOperations({
      paths: {
        "/api/agents/{id}": { get: { summary: "Get an agent" } },
        "/api/agents/me": { get: { summary: "Get the current agent" } },
        "/api/llms/agent-configuration/{adapterType}.txt": { get: { summary: "Adapter docs" } },
      },
    });
    expect(matchOperation("GET", "/api/agents/me", operations)?.path).toBe("/api/agents/me");
    expect(matchOperation("GET", "/api/agents/{}", operations)?.path).toBe("/api/agents/{id}");
    expect(matchOperation("GET", "/api/llms/agent-configuration/{}.txt", operations)?.path).toBe(
      "/api/llms/agent-configuration/{adapterType}.txt",
    );
    expect(matchOperation("POST", "/api/agents/{}", operations)).toBeNull();
  });
});

describe("api coverage matrix against the repository", () => {
  const operations = loadSpecOperations(buildOpenApiSpec());
  const result = collectCoverage({ repoRoot: REPO_ROOT, operations, sharedConstants });
  const describeCall = (call: { method: string; path: string | null; file: string; line: number }) =>
    `${call.method} ${call.path} (${call.file}:${call.line})`;

  it("documents every route the board UI client calls", () => {
    expect(result.uiCalls.length).toBeGreaterThan(500);
    expect(result.uiUndocumented.map(describeCall)).toEqual([]);
  });

  it("documents every route the CLI calls", () => {
    expect(result.cliCalls.length).toBeGreaterThan(200);
    expect(result.cliUndocumented.map(describeCall)).toEqual([]);
  });

  it("pins the calls the scanner can't check against the document", () => {
    const keys = [...result.uiCalls, ...result.cliCalls]
      .filter((call) => call.path === null)
      .concat(result.dynamicCalls)
      .map((call) => `${call.file} ${call.method} ${call.raw.replace(/\s+/g, " ")}`);
    expect([...new Set(keys)].sort()).toEqual(KNOWN_UNRESOLVED_CALLS);
  });

  it("renders the matrix with a row per documented operation and its UI and CLI callers", () => {
    const markdown = renderCoverageMarkdown(result);
    const rows = markdown.split("\n").filter((line) => /^\| `(GET|POST|PUT|PATCH|DELETE) \//.test(line));
    expect(rows).toHaveLength(operations.length);
    expect(markdown).toContain(
      "| `PATCH /api/agents/{id}` | Update an agent | board or agent key | `agentsApi.update` | `paperclipai agent update` |",
    );
    expect(markdown).toContain("| `GET /api/companies/{companyId}/costs/by-agent` |");
    expect(rows.find((row) => row.startsWith("| `GET /api/companies/{companyId}/costs/by-agent` |"))).toContain(
      "`paperclipai cost by-agent`",
    );
  });

  it("has a paperclipai command for every API operation unless it is baselined or exempted", () => {
    const unreviewed = unreviewedCliGaps(
      findCliGaps(result),
      new Set(readParityBaseline(REPO_ROOT)),
      readParityExemptions(REPO_ROOT),
    );
    expect(
      unreviewed,
      `These API operations have no paperclipai command. Add one (AGENTS.md rule 8), or add an entry with a reason to ` +
        `${PARITY_EXEMPTIONS_FILE}. Do not add them to ${PARITY_BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it("keeps the baseline sorted and unique so diffs show only real changes", () => {
    const baseline = readParityBaseline(REPO_ROOT);
    expect(baseline.length).toBeGreaterThan(100);
    expect(baseline).toEqual([...new Set(baseline)].sort());
  });

  it("lists only documented operations in the exemptions, each with a reason", () => {
    const known = new Set(operations.map(operationId));
    const exemptions = readParityExemptions(REPO_ROOT);
    expect(Object.keys(exemptions).filter((id) => !known.has(id))).toEqual([]);
    expect(
      Object.entries(exemptions)
        .filter(([, reason]) => reason.trim().length < 10)
        .map(([id]) => id),
    ).toEqual([]);
  });
});

describe("web/API/CLI parity ratchet", () => {
  const operation = (method: string, route: string): SpecOperation => ({
    method,
    path: route,
    summary: route,
    tag: "Tests",
    access: "board-key",
  });
  const cliCall = (route: string, label: string): ClientCall => ({
    method: "GET",
    path: route,
    raw: route,
    file: "cli/src/commands/client/sample.ts",
    line: 1,
    label,
  });
  const resultFor = (operations: SpecOperation[], cliCalls: ClientCall[]): CoverageResult => {
    const cliByOperation = new Map<string, ClientCall[]>();
    for (const call of cliCalls) {
      const key = `${call.method} ${call.path}`;
      cliByOperation.set(key, [...(cliByOperation.get(key) ?? []), call]);
    }
    return {
      operations,
      uiCalls: [],
      cliCalls,
      uiByOperation: new Map(),
      cliByOperation,
      uiUndocumented: [],
      cliUndocumented: [],
      dynamicCalls: [],
    };
  };

  it("counts only a command as covering an operation, not shared helper code", () => {
    const gaps = findCliGaps(
      resultFor(
        [operation("GET", "/api/a"), operation("GET", "/api/b"), operation("GET", "/api/c")],
        [cliCall("/api/a", "paperclipai sample list"), cliCall("/api/b", "fetchB")],
      ),
    );
    expect(gaps).toEqual(["GET /api/b", "GET /api/c"]);
  });

  it("reports a new operation that is neither baselined nor exempted", () => {
    const gaps = ["GET /api/a", "GET /api/b", "POST /api/c"];
    expect(unreviewedCliGaps(gaps, new Set(["GET /api/a"]), { "POST /api/c": "Agent runtime only." })).toEqual([
      "GET /api/b",
    ]);
  });

  it("reports nothing when every gap is baselined, and ignores baseline entries that are no longer gaps", () => {
    expect(unreviewedCliGaps(["GET /api/a"], new Set(["GET /api/a", "GET /api/gone"]), {})).toEqual([]);
  });
});

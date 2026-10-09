import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCAN_ROOTS = ["server/src", "server/scripts", "cli/src", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "migrations", ".turbo"]);
const DUPLICATE_DOC = "doc/duplicate-detection.md";

/**
 * Every place that writes rows into `issues` without going through `issueService.create`, which is the
 * only path that tells the issue-created listener (and so the duplicate check). Each entry is a deliberate
 * exemption, and `docMention` must appear in the duplicate-detection doc so the exemption is visible.
 * Adding a new direct insert fails this test: route it through `issueService.create`, or add it here
 * with a reason and document it.
 */
const KNOWN_DIRECT_ISSUE_INSERTS: Record<string, { count: number; reason: string; docMention: string | null }> = {
  "server/src/services/issues.ts": {
    count: 2,
    reason:
      "issueService.create (the covered path: it notifies the listener after commit) and importIssues " +
      "(company import, exempt: bulk-restores another company's issues)",
    docMention: "Company import",
  },
  "cli/src/commands/worktree.ts": {
    count: 1,
    reason:
      "worktree:merge-history --apply mirrors issues that already exist in another instance's database, " +
      "keeping their ids and timestamps. It runs in the CLI process, where no listener exists. Exempt.",
    docMention: "worktree:merge-history",
  },
  "server/src/routes/pipelines.ts": {
    count: 1,
    reason:
      "open-conversation creates the single discussion thread of a pipeline case (one active per case, " +
      "a conversation, not a work item). Checking it would flag each reopened thread against its predecessor. Exempt.",
    docMention: "open-conversation",
  },
  "packages/db/src/seed.ts": {
    count: 1,
    reason: "Development seed data, not a production path.",
    docMention: null,
  },
};

function listSourceFiles(dir: string): string[] {
  const absolute = path.join(REPO_ROOT, dir);
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (SKIP_DIRS.has(entry)) continue;
    const relative = path.join(dir, entry);
    const stats = statSync(path.join(REPO_ROOT, relative));
    if (stats.isDirectory()) files.push(...listSourceFiles(relative));
    else if (/\.(ts|mts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      files.push(relative);
    }
  }
  return files;
}

/** Names the `issues` table goes by in a file: `issues` itself and any `issues as X` alias. */
function issueTableNames(source: string): string[] {
  const aliases = [...source.matchAll(/\bissues\s+as\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1] ?? "");
  return ["issues", ...aliases.filter(Boolean)];
}

/** Counts direct inserts into the issues table: builder inserts, chunked inserts and raw SQL. */
export function countDirectIssueInserts(source: string): number {
  let count = 0;
  for (const name of issueTableNames(source)) {
    const escaped = name.replace(/[$]/g, "\\$");
    count += (source.match(new RegExp(`\\.insert\\(\\s*(?:schema\\.)?${escaped}\\s*\\)`, "g")) ?? []).length;
    count += (source.match(new RegExp(`insertRowsInChunks\\([^,()]+,\\s*${escaped}\\s*,`, "g")) ?? []).length;
  }
  count += (source.match(/\binsert\s+into\s+"?issues"?\s*\(/gi) ?? []).length;
  return count;
}

describe("every direct insert into issues is either the covered create path or a documented exemption", () => {
  const found: Record<string, number> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const count = countDirectIssueInserts(readFileSync(path.join(REPO_ROOT, file), "utf8"));
      if (count > 0) found[file] = count;
    }
  }

  it("finds exactly the known insert sites, no more and no fewer", () => {
    const expected = Object.fromEntries(
      Object.entries(KNOWN_DIRECT_ISSUE_INSERTS).map(([file, entry]) => [file, entry.count]),
    );
    expect(found).toEqual(expected);
  });

  it("documents every production exemption in the duplicate-detection guide", () => {
    const doc = readFileSync(path.join(REPO_ROOT, DUPLICATE_DOC), "utf8");
    for (const [file, entry] of Object.entries(KNOWN_DIRECT_ISSUE_INSERTS)) {
      if (entry.docMention) expect(doc, `${file}: ${entry.reason}`).toContain(entry.docMention);
    }
  });

  it("counts builder, aliased, chunked and raw-SQL inserts (negative control)", () => {
    expect(countDirectIssueInserts("await tx.insert(issues).values(row);")).toBe(1);
    expect(countDirectIssueInserts('import { issues as issueRows } from "@paperclipai/db";\nawait tx.insert(issueRows).values(row);')).toBe(1);
    expect(countDirectIssueInserts("await insertRowsInChunks(tx, issues, rows);")).toBe(1);
    expect(countDirectIssueInserts("await db.execute(sql`INSERT INTO issues (id) VALUES (${id})`);")).toBe(1);
    expect(countDirectIssueInserts("await tx.insert(issueComments).values(row);")).toBe(0);
  });
});

describe("no production code or script reads a process-wide gateway key", () => {
  it("never reads AI_GATEWAY_API_KEY from the environment outside tests", () => {
    const readers = ["server/src", "server/scripts"]
      .flatMap(listSourceFiles)
      .filter((file) => /process\.env\.AI_GATEWAY_API_KEY|env\.AI_GATEWAY_API_KEY|env\[["']AI_GATEWAY_API_KEY["']\]/.test(
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ));
    expect(readers).toEqual([]);
  });
});

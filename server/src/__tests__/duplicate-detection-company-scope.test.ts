import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICES = fileURLToPath(new URL("../services/", import.meta.url));

const QUERY_START = /\b(?:db|tx)\s*\.\s*(?:select|selectDistinct|insert|update|delete|execute)\b/g;
const SQL_COMPANY_FILTER = /company_id\s*=\s*\$\{/;
const BUILDER_COMPANY_FILTER = /\bcompanyId\b/;

/**
 * Returns the text of each database statement in `source`, from `db.`/`tx.` through the
 * closing `;` at the same bracket depth.
 */
export function extractQueryStatements(source: string): string[] {
  const statements: string[] = [];
  for (const match of source.matchAll(QUERY_START)) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "(" || char === "{" || char === "[") depth += 1;
      else if (char === ")" || char === "}" || char === "]") depth -= 1;
      else if (char === ";" && depth <= 0) break;
      if (depth < 0) break;
    }
    statements.push(source.slice(match.index, end));
  }
  return statements;
}

/**
 * Statements that touch the database without a company filter. Raw `sql` must compare
 * `company_id = ${...}`; builder queries must reference `companyId` (the filter or the inserted value).
 */
export function findUnscopedQueries(source: string): string[] {
  return extractQueryStatements(source).filter((statement) => {
    const raw = /\bsql\s*`/.test(statement) && /\.execute\b/.test(statement);
    return raw ? !SQL_COMPANY_FILTER.test(statement) : !BUILDER_COMPANY_FILTER.test(statement);
  });
}

describe("duplicate detection company scoping contract", () => {
  it.each(["duplicate-detection.ts", "judge-client.ts"])("%s filters every query by company", (file) => {
    const source = readFileSync(`${SERVICES}${file}`, "utf8");
    expect(extractQueryStatements(source).length).toBeGreaterThan(0);
    expect(findUnscopedQueries(source)).toEqual([]);
  });

  it("requires the candidate search to compare company_id before trigram matching", () => {
    const source = readFileSync(`${SERVICES}duplicate-detection.ts`, "utf8");
    const search = extractQueryStatements(source).find((statement) => statement.includes("similarity("));
    expect(search).toBeDefined();
    expect(search).toMatch(/WHERE i\.company_id = \$\{query\.companyId\}/);
  });

  it("flags unscoped raw SQL and unscoped builder queries (negative control)", () => {
    const unscopedRaw = "const rows = await db.execute(sql`SELECT * FROM issues i WHERE i.title % ${title}`);";
    const scopedRaw = "const rows = await db.execute(sql`SELECT * FROM issues i WHERE i.company_id = ${companyId}`);";
    const unscopedBuilder = "const rows = await db.select().from(issues).where(eq(issues.id, issueId));";
    const scopedBuilder = "const rows = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));";

    expect(findUnscopedQueries(unscopedRaw)).toHaveLength(1);
    expect(findUnscopedQueries(scopedRaw)).toHaveLength(0);
    expect(findUnscopedQueries(unscopedBuilder)).toHaveLength(1);
    expect(findUnscopedQueries(scopedBuilder)).toHaveLength(0);
  });

  it("does not accept a company id that is only mentioned in a different clause of raw SQL", () => {
    const sneaky = "await db.execute(sql`SELECT ${companyId} AS c FROM issues i WHERE i.title % ${title}`);";
    expect(findUnscopedQueries(sneaky)).toHaveLength(1);
  });
});

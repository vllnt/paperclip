import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { runUsageRecordService } from "../server/src/services/run-usage-records.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function parseSince(): Date | undefined {
  const raw = parseFlag("--since");
  if (!raw) return undefined;
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`--since must be a date such as 2026-01-01, got "${raw}"`);
  }
  return since;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const rederive = process.argv.includes("--rederive");
  const companyId = parseFlag("--company") ?? undefined;
  const since = parseSince();

  console.log(
    `Deriving run usage records${companyId ? ` for company ${companyId}` : " for every company"}`
      + `${since ? ` since ${since.toISOString()}` : ""}${rederive ? ", replacing older schema versions" : ""}...`,
  );
  const result = await runUsageRecordService(db).backfill({
    companyId,
    since,
    rederive,
    onBatch: (progress) => {
      console.log(`- ${progress.companyId}: scanned ${progress.scanned}, wrote ${progress.written}`);
    },
  });
  console.log(`Run usage record backfill complete: scanned ${result.scanned}, wrote ${result.written}.`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Run usage record backfill failed: ${message}`);
  process.exitCode = 1;
});

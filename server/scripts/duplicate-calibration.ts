import { readFile, writeFile } from "node:fs/promises";
import { createDb } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import { scoreCandidates } from "../src/services/duplicate-cascade.js";
import {
  buildCalibrationReport,
  formatCalibrationReport,
  lexicalFeatures,
  parseLabelledPairRefs,
  parseLabelledPairs,
  toCascadeInput,
  type LabelledPair,
  type ScoredLabelledPair,
} from "../src/services/duplicate-calibration.js";
import { prepareCompanyCalibration } from "../src/services/duplicate-detection-factory.js";
import type { JudgeClient } from "../src/services/judge-client.js";

const USAGE = `Usage:
  pnpm --filter @paperclipai/server calibrate:duplicates <pairs.json> --tier1-only [--out report.json]
  pnpm --filter @paperclipai/server calibrate:duplicates <pairs.json> --company-id <uuid> [--out report.json]

--tier1-only   Offline. Scores the text in the file with the free lexical tier only. No database, no key,
               nothing leaves this machine. Pairs: [{ "id"?, "a": {"title", "description"?}, "b": {...}, "label" }]

--company-id   Tier 1 + Jev for ONE company, through the same governed path as production:
               - the company must have opted in (duplicateDetectionMode is suggest or comment);
               - every pair names two of that company's issues: [{ "id"?, "a": {"issueId"}, "b": {"issueId"}, "label" }];
                 their stored text is loaded from the database (text in the file is ignored);
               - the gateway key is that company's own AI_GATEWAY_API_KEY secret (audited as
                 "duplicate-calibration"); calls count against its daily cap.
               Run it where the instance's database and secrets are configured (same environment as the
               server). There is no environment-variable key.

label: "duplicate" | "keep_both" | "distinct" | true | false. Reports precision and recall by threshold and
whether the 0.9 precision target for comments is met.`;

const CONCURRENCY = 8;

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function score(
  pairs: readonly LabelledPair[],
  model: { judge: JudgeClient; companyId: string } | null,
): Promise<ScoredLabelledPair[]> {
  const scored: ScoredLabelledPair[] = new Array(pairs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < pairs.length) {
      const index = next;
      next += 1;
      const pair = pairs[index];
      if (!pair) continue;
      const { subject, candidate } = toCascadeInput(pair);
      const result = await scoreCandidates({
        mode: model ? "suggest" : "off",
        judge: model?.judge ?? { isAvailable: async () => false, ask: async () => ({ ok: false, reason: "no_key", inputHash: "" }) },
        companyId: model?.companyId ?? "offline",
        subject,
        candidates: [candidate],
      });
      const scoredPair = result.pairs[0];
      scored[index] = {
        pair,
        features: lexicalFeatures(pair),
        probability: scoredPair?.sameOutcomeProbability ?? null,
        verdict: scoredPair?.verdict ?? "lexical_only",
        modelFailed: model !== null && result.degradedReason !== null && result.degradedReason !== "mode_off",
      };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return scored;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--") && arg !== flagValue(args, "--company-id") && arg !== flagValue(args, "--out"));
  const tier1Only = args.includes("--tier1-only");
  const companyId = flagValue(args, "--company-id");
  const outPath = flagValue(args, "--out");
  if (!file || tier1Only === Boolean(companyId)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const json: unknown = JSON.parse(await readFile(file, "utf8"));

  if (tier1Only) {
    const report = buildCalibrationReport(await score(parseLabelledPairs(json), null), { withModel: false });
    console.log(formatCalibrationReport(report));
    if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const config = loadConfig();
  const db = createDb(
    process.env.DATABASE_URL?.trim() ||
      config.databaseUrl ||
      `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`,
  );
  try {
    const setup = await prepareCompanyCalibration(db, companyId ?? "", parseLabelledPairRefs(json));
    if (!setup.ok) {
      console.error(setup.reason);
      process.exitCode = 2;
      return;
    }
    const scored = await score(setup.pairs, { judge: setup.judge, companyId: companyId ?? "" });
    const report = buildCalibrationReport(scored, { withModel: true });
    console.log(formatCalibrationReport(report));
    if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

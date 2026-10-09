import { readFile, writeFile } from "node:fs/promises";
import { scoreCandidates } from "../src/services/duplicate-cascade.js";
import {
  buildCalibrationReport,
  formatCalibrationReport,
  lexicalFeatures,
  parseLabelledPairs,
  toCascadeInput,
  type ScoredLabelledPair,
} from "../src/services/duplicate-calibration.js";
import { createJudgeClient, readJudgeConfig } from "../src/services/judge-client.js";

const USAGE = `Usage: pnpm --filter @paperclipai/server calibrate:duplicates <pairs.json> [--tier1-only] [--out report.json]

Reads a JSON export of labelled pairs:
  [{ "id": "ANT-1231/ANT-1226", "a": { "title": "...", "description": "..." },
     "b": { "title": "...", "description": "..." }, "label": "duplicate" | "keep_both" | true | false }]

Reports precision and recall by threshold for tier 1 alone and for tier 1 + Jev, and whether the
0.9 precision target for comments is met. Needs AI_GATEWAY_API_KEY in the environment (a calibration run has no company, so it uses one
explicit key; the server itself reads each company's own secret) unless --tier1-only is set.
Issue text is sent to the AI Gateway, truncated and redacted exactly as in production.`;

const CONCURRENCY = 8;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  const tier1Only = args.includes("--tier1-only");
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!file) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const pairs = parseLabelledPairs(JSON.parse(await readFile(file, "utf8")));
  const config = readJudgeConfig();
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!tier1Only && !apiKey) {
    console.error("AI_GATEWAY_API_KEY is not set. Set it, or pass --tier1-only.");
    process.exitCode = 2;
    return;
  }
  const judge = createJudgeClient({
    config,
    usage: { reserve: async () => true },
    resolveApiKey: async () => apiKey,
  });

  const scored: ScoredLabelledPair[] = new Array(pairs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < pairs.length) {
      const index = next;
      next += 1;
      const pair = pairs[index];
      if (!pair) continue;
      const features = lexicalFeatures(pair);
      const { subject, candidate } = toCascadeInput(pair);
      const result = await scoreCandidates({
        mode: tier1Only ? "off" : "suggest",
        judge,
        companyId: "calibration",
        subject,
        candidates: [candidate],
      });
      const scoredPair = result.pairs[0];
      scored[index] = {
        pair,
        features,
        probability: scoredPair?.sameOutcomeProbability ?? null,
        verdict: scoredPair?.verdict ?? "lexical_only",
        modelFailed: !tier1Only && result.degradedReason !== null && result.degradedReason !== "mode_off",
      };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const report = buildCalibrationReport(scored, { withModel: !tier1Only });
  console.log(formatCalibrationReport(report));
  if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

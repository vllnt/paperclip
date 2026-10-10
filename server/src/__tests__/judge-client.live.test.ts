import { describe, expect, it } from "vitest";
import {
  JUDGE_MODEL_ID,
  createJudgeClient,
  readJudgeConfig,
  type JudgeQuestion,
} from "../services/judge-client.js";

// Test-only: this opt-in smoke test (never in CI) passes an explicit key from the environment to prove the
// gateway call works. Production and the calibration script never read a process-wide key; they resolve
// each company's own AI_GATEWAY_API_KEY secret (see duplicate-detection-factory.ts).
const live = process.env.PAPERCLIP_JUDGE_LIVE_SMOKE === "1" && Boolean(process.env.AI_GATEWAY_API_KEY);

const questions: Record<string, JudgeQuestion> = {
  same_outcome: {
    type: "predicate",
    instructions: "Would completing the new issue fully complete the existing issue, and vice versa?",
  },
  kind: {
    type: "choice",
    instructions: "What kind of work is the new issue?",
    options: { bug: "A defect", chore: "Maintenance", feature: "New capability" },
  },
};

describe.skipIf(!live)("judge client against the live Vercel AI Gateway", () => {
  const client = createJudgeClient({
    config: readJudgeConfig(),
    usage: { reserve: async () => true },
    resolveApiKey: async () => process.env.AI_GATEWAY_API_KEY,
  });

  it("scores an obvious duplicate high and an unrelated pair low", async () => {
    const duplicate = await client.ask({
      companyId: "live-smoke",
      rubricVersion: "live-smoke-1",
      state: {
        new_issue: { title: "[Chore] Remove @songtrivia/client compatibility barrels", description: "" },
        existing_issue: { title: "[Chore] Remove @songtrivia/client compatibility barrels", description: "", status: "todo" },
      },
      questions,
    });
    const unrelated = await client.ask({
      companyId: "live-smoke",
      rubricVersion: "live-smoke-1",
      state: {
        new_issue: { title: "[Chore] Remove @songtrivia/client compatibility barrels", description: "" },
        existing_issue: { title: "Add dark mode to the billing settings page", description: "", status: "todo" },
      },
      questions,
    });

    expect(duplicate.ok && unrelated.ok).toBe(true);
    if (!duplicate.ok || !unrelated.ok) return;
    expect(duplicate.modelId).toContain("jev");
    expect(JUDGE_MODEL_ID).toBe("typesafe-ai/jev");
    const high = duplicate.answers.same_outcome;
    const low = unrelated.answers.same_outcome;
    expect(high?.type === "predicate" ? high.probability : null).toBeGreaterThan(0.8);
    expect(low?.type === "predicate" ? low.probability : null).toBeLessThan(0.3);
    const kind = duplicate.answers.kind;
    expect(kind?.type === "choice" ? kind.choice : null).toBe("chore");
  }, 30_000);
});

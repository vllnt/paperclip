import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL, codexLocalReasoningEffortsForModel, models as codexModels } from "./index.js";

describe("current proxy-compatible model catalog", () => {
  it("uses the GPT-6.1 reasoning levels reported by Codex metadata", () => {
    expect(codexLocalReasoningEffortsForModel("gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("offers GPT-6.1 Sol as the Codex default without removing the previous model", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-6.1-sol");
    expect(codexModels.map((model) => model.id)).toContain("gpt-5.6-sol");
    expect(codexModels.map((model) => model.id)).toContain("gpt-6.1-sol");
  });
});

import { expect, it } from "vitest";
import { DEFAULT_CLAUDE_LOCAL_MODEL, models, resolveClaudeModel } from "./index.js";
it("offers Opus 5.5 and Sonnet 5 while preserving explicit models", () => {
  expect(models.map((model) => model.id)).toContain("claude-opus-5-5");
  expect(models.map((model) => model.id)).toContain("claude-sonnet-5");
  expect(DEFAULT_CLAUDE_LOCAL_MODEL).toBe("claude-opus-5-5");
  expect(resolveClaudeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
});

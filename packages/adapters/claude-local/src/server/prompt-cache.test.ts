import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

describe("prepareClaudePromptBundle", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const prepare = async (instructionsContents: string, resumeInstructionsContents: string) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-prompt-cache-"));
    cleanupDirs.push(home);
    vi.stubEnv("PAPERCLIP_HOME", home);
    return prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents,
      resumeInstructionsContents,
      onLog: async () => {},
    });
  };

  it("keeps the bundle key formula, so a session saved before the resume key still matches", async () => {
    const bundle = await prepare("Same instructions.", "Same instructions.");
    const savedKey = createHash("sha256")
      .update("paperclip-claude-prompt-bundle:v1\n")
      .update("instructions\n")
      .update("Same instructions.")
      .update("\n")
      .digest("hex");

    expect(bundle.bundleKey).toBe(savedKey);
    expect(bundle.resumeKey).toBe(savedKey);
  });

  it("gives instructions copies at different paths one resume key", async () => {
    const first = await prepare("Same instructions.\nLoaded from /runs/run-1/AGENTS.md.", "Same instructions.");
    const second = await prepare("Same instructions.\nLoaded from /runs/run-2/AGENTS.md.", "Same instructions.");
    const changed = await prepare("Other instructions.\nLoaded from /runs/run-3/AGENTS.md.", "Other instructions.");

    expect(second.bundleKey).not.toBe(first.bundleKey);
    expect(second.resumeKey).toBe(first.resumeKey);
    expect(changed.resumeKey).not.toBe(first.resumeKey);
  });
});

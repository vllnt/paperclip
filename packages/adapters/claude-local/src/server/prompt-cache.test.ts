import { createHash } from "node:crypto";
import fs, { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudePromptBundle, pruneIdleClaudePromptBundles } from "./prompt-cache.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("prepareClaudePromptBundle", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const tempDir = async (prefix: string) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  };

  const prepareInHome = (home: string, instructionsContents: string, companyId = "company-1") => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    return prepareClaudePromptBundle({
      companyId,
      skills: [],
      instructionsContents,
      resumeInstructionsContents: instructionsContents,
      onLog: async () => {},
    });
  };

  const prepare = async (instructionsContents: string, resumeInstructionsContents: string) => {
    vi.stubEnv("PAPERCLIP_HOME", await tempDir("paperclip-claude-prompt-cache-"));
    return prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [],
      instructionsContents,
      resumeInstructionsContents,
      onLog: async () => {},
    });
  };

  const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

  const makeIdle = async (target: string, idleMs: number) => {
    const at = new Date(Date.now() - idleMs);
    await fs.utimes(target, at, at);
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

  it("removes only bundle directories in the cache that no run used for 7 days", async () => {
    const cacheRoot = await tempDir("paperclip-claude-prompt-cache-root-");
    const outside = await tempDir("paperclip-claude-prompt-cache-outside-");
    const skillSource = path.join(outside, "skill");
    await fs.mkdir(skillSource);
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "skill");
    await makeIdle(outside, 30 * DAY_MS);

    const idle = path.join(cacheRoot, "a".repeat(64));
    await fs.mkdir(path.join(idle, ".claude", "skills"), { recursive: true });
    await fs.symlink(skillSource, path.join(idle, ".claude", "skills", "skill"));
    await fs.writeFile(path.join(idle, "agent-instructions.md"), "instructions");
    await makeIdle(idle, 8 * DAY_MS);
    const recent = path.join(cacheRoot, "b".repeat(64));
    await fs.mkdir(recent);
    await makeIdle(recent, 6 * DAY_MS);
    const kept = path.join(cacheRoot, "c".repeat(64));
    await fs.mkdir(kept);
    await makeIdle(kept, 8 * DAY_MS);
    const notABundle = path.join(cacheRoot, "notes");
    await fs.mkdir(notABundle);
    await makeIdle(notABundle, 8 * DAY_MS);
    const file = path.join(cacheRoot, "d".repeat(64));
    await fs.writeFile(file, "file");
    await makeIdle(file, 8 * DAY_MS);
    const link = path.join(cacheRoot, "e".repeat(64));
    await fs.symlink(outside, link);

    await pruneIdleClaudePromptBundles(cacheRoot, "c".repeat(64));

    expect(await exists(idle)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(kept)).toBe(true);
    expect(await exists(notABundle)).toBe(true);
    expect(await exists(file)).toBe(true);
    expect(await exists(link)).toBe(true);
    expect(await fs.readFile(path.join(skillSource, "SKILL.md"), "utf8")).toBe("skill");
  });

  it("marks the bundle of the run as used, so a prune keeps it", async () => {
    const home = await tempDir("paperclip-claude-prompt-cache-");
    const first = await prepareInHome(home, "Same instructions.");
    await makeIdle(first.rootDir, 8 * DAY_MS);

    const second = await prepareInHome(home, "Same instructions.");
    await pruneIdleClaudePromptBundles(path.dirname(second.rootDir), "another-run");

    expect(second.rootDir).toBe(first.rootDir);
    expect((await fs.stat(second.rootDir)).mtimeMs).toBeGreaterThan(Date.now() - DAY_MS);
    expect(await exists(path.join(second.rootDir, "agent-instructions.md"))).toBe(true);
  });

  it("keeps a bundle that a run marks after the prune listed it as idle", async () => {
    const home = await tempDir("paperclip-claude-prompt-cache-");
    const bundle = await prepareInHome(home, "Same instructions.");
    await makeIdle(bundle.rootDir, 8 * DAY_MS);
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementationOnce((async (...args: Parameters<typeof fs.readdir>) => {
      const listed = await readdir(...args);
      await prepareInHome(home, "Same instructions.");
      return listed;
    }) as typeof fs.readdir);

    await pruneIdleClaudePromptBundles(path.dirname(bundle.rootDir), "another-run");

    expect(await exists(path.join(bundle.rootDir, "agent-instructions.md"))).toBe(true);
  });

  it("keeps the bundle of a run that prepares it while the prune checks it", async () => {
    const home = await tempDir("paperclip-claude-prompt-cache-");
    const bundle = await prepareInHome(home, "Same instructions.");
    await makeIdle(bundle.rootDir, 8 * DAY_MS);
    const lstat = fs.lstat.bind(fs);
    let concurrentRun: Promise<unknown> = Promise.resolve();
    vi.spyOn(fs, "lstat").mockImplementationOnce((async (...args: Parameters<typeof fs.lstat>) => {
      const idleStat = await lstat(...args);
      concurrentRun = prepareInHome(home, "Same instructions.");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return idleStat;
    }) as typeof fs.lstat);

    await pruneIdleClaudePromptBundles(path.dirname(bundle.rootDir), "another-run");
    await concurrentRun;

    expect(await fs.readFile(path.join(bundle.rootDir, "agent-instructions.md"), "utf8")).toBe("Same instructions.");
  });

  it("prunes idle bundles of the company in the background when a run prepares its bundle", async () => {
    const home = await tempDir("paperclip-claude-prompt-cache-");
    const probe = await prepareInHome(home, "Probe instructions.", "company-probe");
    const cacheRoot = path.join(path.dirname(path.dirname(path.dirname(probe.rootDir))), "company-2", "claude-prompt-cache");
    const idle = path.join(cacheRoot, "a".repeat(64));
    await fs.mkdir(idle, { recursive: true });
    await makeIdle(idle, 8 * DAY_MS);

    const bundle = await prepareInHome(home, "Company two instructions.", "company-2");

    expect(path.dirname(bundle.rootDir)).toBe(cacheRoot);
    await vi.waitFor(async () => expect(await exists(idle)).toBe(false));
    expect(await exists(bundle.rootDir)).toBe(true);
  });

  it("never fails the run when the prune fails", async () => {
    const home = await tempDir("paperclip-claude-prompt-cache-");
    vi.spyOn(fs, "readdir").mockRejectedValue(new Error("EACCES: permission denied"));

    const bundle = await prepareInHome(home, "Same instructions.");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await fs.readFile(path.join(bundle.rootDir, "agent-instructions.md"), "utf8")).toBe("Same instructions.");
  });

  it("never fails the run when the bundle cannot be marked", async () => {
    const home = await tempDir("paperclip-claude-prompt-cache-");
    vi.spyOn(fs, "utimes").mockRejectedValue(new Error("EPERM: operation not permitted"));

    const bundle = await prepareInHome(home, "Same instructions.");

    expect(await fs.readFile(path.join(bundle.rootDir, "agent-instructions.md"), "utf8")).toBe("Same instructions.");
  });

  it("goes on to the next bundle when one removal fails", async () => {
    const cacheRoot = await tempDir("paperclip-claude-prompt-cache-root-");
    const first = path.join(cacheRoot, "a".repeat(64));
    const second = path.join(cacheRoot, "b".repeat(64));
    for (const dir of [first, second]) {
      await fs.mkdir(dir);
      await makeIdle(dir, 8 * DAY_MS);
    }
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("EBUSY: resource busy"));

    await expect(pruneIdleClaudePromptBundles(cacheRoot, "another-run")).resolves.toBeUndefined();

    expect([await exists(first), await exists(second)].filter(Boolean)).toHaveLength(1);
  });
});

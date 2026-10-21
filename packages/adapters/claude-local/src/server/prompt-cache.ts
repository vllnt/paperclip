import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  resolvePaperclipInstanceRootForAdapter,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

type SkillEntry = PaperclipSkillEntry;

export interface ClaudePromptBundle {
  bundleKey: string;
  /**
   * Names the instructions and skills without the paths of one run, so a run
   * can resume the session of an earlier run that read the same bundle.
   */
  resumeKey: string;
  rootDir: string;
  addDir: string;
  instructionsFilePath: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveManagedClaudePromptCacheRoot(
  env: NodeJS.ProcessEnv,
  companyId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(
    instanceRoot,
    "companies",
    companyId,
    "claude-prompt-cache",
  );
}

/** A bundle that no run has prepared for this long is removed. No run lasts this long. */
const PROMPT_BUNDLE_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Each prompt cache is pruned at most this often. */
const PROMPT_BUNDLE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PROMPT_BUNDLE_DIR_NAME = /^[0-9a-f]{64}$/;
const lastPromptBundlePruneAt = new Map<string, number>();
let promptBundleDirLock: Promise<unknown> = Promise.resolve();

/** Runs `work` alone among this process's bundle marks and bundle removals. */
function withPromptBundleDirLock<T>(work: () => Promise<T>): Promise<T> {
  const result = promptBundleDirLock.then(work);
  promptBundleDirLock = result.catch(() => undefined);
  return result;
}

/**
 * Removes the bundles in `cacheRoot` that no run has prepared for 7 days. Each
 * run marks its bundle by its modified time, so the bundle a run uses is never
 * idle. It removes only a directory named like a bundle key, never `keep`, and
 * never a symlink; the removal does not follow the skill links inside a bundle.
 * Each check and removal holds the lock that a run's mark holds, so a bundle
 * that a run marks during the prune is kept.
 *
 * @param cacheRoot The prompt cache of one company.
 * @param keep The bundle key of the calling run.
 * @param now The time to measure idleness from (epoch ms).
 */
export async function pruneIdleClaudePromptBundles(cacheRoot: string, keep: string, now = Date.now()): Promise<void> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep || !PROMPT_BUNDLE_DIR_NAME.test(entry.name)) continue;
    const bundleDir = path.join(cacheRoot, entry.name);
    await withPromptBundleDirLock(async () => {
      const stat = await fs.lstat(bundleDir);
      if (stat.isDirectory() && now - stat.mtimeMs > PROMPT_BUNDLE_MAX_IDLE_MS) {
        await fs.rm(bundleDir, { recursive: true, force: true });
      }
    }).catch(() => undefined);
  }
}

interface HashSink {
  update(data: string | Buffer): void;
}

async function hashPathContents(
  candidate: string,
  hash: HashSink,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update("missing\n");
      return;
    }
    await hashPathContents(resolved, hash, relativePath, seenDirectories);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

function hashInstructions(hash: Hash, instructionsContents: string | null): void {
  hash.update("paperclip-claude-prompt-bundle:v1\n");
  if (instructionsContents) {
    hash.update("instructions\n");
    hash.update(instructionsContents);
    hash.update("\n");
  } else {
    hash.update("instructions:none\n");
  }
}

async function buildClaudePromptBundleKeys(input: {
  skills: SkillEntry[];
  instructionsContents: string | null;
  resumeInstructionsContents: string | null;
}): Promise<{ bundleKey: string; resumeKey: string }> {
  const bundleHash = createHash("sha256");
  const resumeHash = createHash("sha256");
  hashInstructions(bundleHash, input.instructionsContents);
  hashInstructions(resumeHash, input.resumeInstructionsContents);
  // One walk of the skill files feeds both keys.
  const skillsHash: HashSink = {
    update(data) {
      bundleHash.update(data);
      resumeHash.update(data);
    },
  };

  const sortedSkills = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sortedSkills) {
    skillsHash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, skillsHash, entry.runtimeName, new Set<string>());
  }

  return { bundleKey: bundleHash.digest("hex"), resumeKey: resumeHash.digest("hex") };
}

async function ensureReadableFile(targetPath: string, contents: string): Promise<void> {
  try {
    await fs.access(targetPath, fsConstants.R_OK);
    return;
  } catch {
    // Fall through and materialize the file.
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    const targetReadable = await fs.access(targetPath, fsConstants.R_OK).then(() => true).catch(() => false);
    if (!targetReadable) {
      throw err;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Materializes the instructions file and skill links of one prompt bundle.
 *
 * @param input.instructionsContents The instructions text the run reads.
 * @param input.resumeInstructionsContents The same text without the paths of
 *   this run; the resume key hashes it. Pass `instructionsContents` when the
 *   text has no run-specific path.
 * @returns The bundle, keyed by its full contents, and its resume key.
 */
export async function prepareClaudePromptBundle(input: {
  companyId: string;
  skills: SkillEntry[];
  instructionsContents: string | null;
  resumeInstructionsContents: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsContents, resumeInstructionsContents, onLog } = input;
  const { bundleKey, resumeKey } = await buildClaudePromptBundleKeys({
    skills,
    instructionsContents,
    resumeInstructionsContents,
  });
  const cacheRoot = resolveManagedClaudePromptCacheRoot(process.env, companyId);
  const rootDir = path.join(cacheRoot, bundleKey);
  const skillsHome = path.join(rootDir, ".claude", "skills");
  // Mark the bundle as used, so a prune keeps it while this run reads it. A
  // prune that removed it just before is followed by a fresh copy below. A
  // failed mark does not fail the run.
  await withPromptBundleDirLock(async () => {
    await fs.mkdir(skillsHome, { recursive: true });
    const markedAt = new Date();
    await fs.utimes(rootDir, markedAt, markedAt).catch(() => undefined);
  });
  const lastPruneAt = lastPromptBundlePruneAt.get(cacheRoot) ?? 0;
  if (Date.now() - lastPruneAt >= PROMPT_BUNDLE_PRUNE_INTERVAL_MS) {
    lastPromptBundlePruneAt.set(cacheRoot, Date.now());
    // Never awaited and never thrown: a failed prune does not delay or fail
    // the run, and the next prune retries.
    void pruneIdleClaudePromptBundles(cacheRoot, bundleKey).catch(() => undefined);
  }

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const instructionsFilePath = instructionsContents
    ? path.join(rootDir, "agent-instructions.md")
    : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  return {
    bundleKey,
    resumeKey,
    rootDir,
    addDir: rootDir,
    instructionsFilePath,
  };
}

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Opt-in seeding of worker-level Codex files (global `AGENTS.md`, the files it
 * includes such as `RTK.md`, and `hooks.json`) from the worker user's Codex home
 * into the Codex home a run uses. Shared by every code path that builds a run's
 * `CODEX_HOME`: the codex_local CLI engine, the default ACP engine, and the
 * sandbox staging of either.
 *
 * Which files: the agent adapter config `codexHomeSeed` (string[]) wins when it
 * is present, even when empty; otherwise the worker env `PAPERCLIP_CODEX_HOME_SEED`
 * (comma separated) applies; otherwise nothing is seeded.
 *
 * Safety: plain file names only, copied (never linked), no symlinked sources, a
 * size cap, and anything that looks like a credential is refused. `auth.json`
 * and the files Paperclip owns have their own handling and can never be listed.
 *
 * Order: when the run home already has an `AGENTS.md`, the worker file is
 * appended after it inside a marked block, so agent instructions come first and
 * worker tooling notes after. The block is replaced on refresh, never stacked.
 */

export const CODEX_HOME_SEED_ENV = "PAPERCLIP_CODEX_HOME_SEED";
export const CODEX_HOME_SEED_MAX_FILES = 16;
export const CODEX_HOME_SEED_MAX_BYTES = 256 * 1024;
export const CODEX_HOME_SEED_AGENTS_FILE = "AGENTS.md";
export const CODEX_HOME_SEED_BLOCK_START = "<!-- BEGIN PAPERCLIP WORKER SEED: AGENTS.md -->";
export const CODEX_HOME_SEED_BLOCK_END = "<!-- END PAPERCLIP WORKER SEED: AGENTS.md -->";

// Files Paperclip already seeds, writes or manages in a Codex home.
const PAPERCLIP_OWNED_NAMES = new Set(["auth.json", "config.toml", "config.json", "instructions.md", "skills"]);
const PLAIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREDENTIAL_NAME = /(auth|token|secret|credential|passw|keyring|\.env|\.pem$|\.key$|\.p12$|\.pfx$|^id_(rsa|dsa|ecdsa|ed25519))/i;
const CREDENTIAL_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
  /\b(OPENAI_API_KEY|CODEX_API_KEY|refresh_token|access_token|id_token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/,
];

export interface CodexHomeSeedRejection {
  name: string;
  reason: string;
}

export interface CodexHomeSeedSelection {
  /** Validated, de-duplicated plain file names, in configured order. */
  names: string[];
  rejected: CodexHomeSeedRejection[];
}

export interface SeedCodexHomeFilesResult {
  seeded: string[];
  skipped: CodexHomeSeedRejection[];
}

type SeedLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

function checkSeedName(name: string): string | null {
  if (!PLAIN_FILE_NAME.test(name) || name.includes("..")) {
    return "must be a plain file name inside the Codex home (no paths, no leading dot)";
  }
  if (PAPERCLIP_OWNED_NAMES.has(name.toLowerCase())) return "is managed by Paperclip and cannot be seeded";
  if (CREDENTIAL_NAME.test(name)) return "looks like a credential file";
  return null;
}

export function resolveCodexHomeSeedSelection(
  configured: unknown,
  env: Record<string, string | undefined> = process.env,
): CodexHomeSeedSelection {
  let requested: string[];
  if (Array.isArray(configured)) {
    requested = configured.filter((item): item is string => typeof item === "string");
  } else {
    requested = (env[CODEX_HOME_SEED_ENV] ?? "").split(",");
  }
  const names: string[] = [];
  const rejected: CodexHomeSeedRejection[] = [];
  for (const raw of requested) {
    const name = raw.trim();
    if (!name || names.includes(name)) continue;
    const problem = checkSeedName(name);
    if (problem) {
      rejected.push({ name, reason: problem });
    } else if (names.length >= CODEX_HOME_SEED_MAX_FILES) {
      rejected.push({ name, reason: `exceeds the ${CODEX_HOME_SEED_MAX_FILES} file limit` });
    } else {
      names.push(name);
    }
  }
  return { names, rejected };
}

async function readSeedSource(sourceHome: string, name: string): Promise<{ content: string } | { skip: string } | null> {
  const source = path.join(sourceHome, name);
  const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { skip: "source is a symlink; symlinked files are never seeded" };
  if (!stat.isFile()) return { skip: "source is not a regular file" };
  // O_NOFOLLOW closes the window between the lstat above and the read.
  let handle;
  try {
    handle = await fs.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return { skip: "source is a symlink; symlinked files are never seeded" };
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { skip: "source is not a regular file" };
    if (opened.size > CODEX_HOME_SEED_MAX_BYTES) {
      return { skip: `source exceeds the ${CODEX_HOME_SEED_MAX_BYTES} byte limit` };
    }
    const content = (await handle.readFile()).toString("utf8");
    if (CREDENTIAL_CONTENT.some((pattern) => pattern.test(content))) {
      return { skip: "source content looks like it holds credentials" };
    }
    return { content };
  } finally {
    await handle.close();
  }
}

async function writeAtomically(target: string, contents: string): Promise<void> {
  const tempPath = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tempPath, contents, { mode: 0o600, flag: "wx" });
  try {
    // rename replaces a symlink at `target` itself; it never writes through it.
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function stripSeedBlock(existing: string): string {
  const start = existing.indexOf(CODEX_HOME_SEED_BLOCK_START);
  if (start < 0) return existing;
  const end = existing.indexOf(CODEX_HOME_SEED_BLOCK_END, start);
  const rest = end < 0 ? "" : existing.slice(end + CODEX_HOME_SEED_BLOCK_END.length);
  return `${existing.slice(0, start)}${rest}`;
}

function mergeAgentsFile(existing: string, workerContent: string): string {
  const agentPart = stripSeedBlock(existing).trimEnd();
  const block = [
    CODEX_HOME_SEED_BLOCK_START,
    "Worker-level tooling notes, added by Paperclip from the worker's own Codex home. The agent instructions above take precedence.",
    "",
    workerContent.trim(),
    CODEX_HOME_SEED_BLOCK_END,
  ].join("\n");
  return `${agentPart}${agentPart ? "\n\n" : ""}${block}\n`;
}

/** Copies the selected worker files into `targetHome`. Never throws for a bad file; it logs and skips it. */
export async function seedCodexHomeFiles(input: {
  sourceHome: string;
  targetHome: string;
  selection: CodexHomeSeedSelection;
  onLog: SeedLog;
}): Promise<SeedCodexHomeFilesResult> {
  const { sourceHome, targetHome, selection, onLog } = input;
  const seeded: string[] = [];
  const skipped: CodexHomeSeedRejection[] = [];
  for (const rejection of selection.rejected) {
    await onLog("stderr", `[paperclip] Not seeding "${rejection.name}" into the Codex home: ${rejection.reason}.\n`);
  }
  if (selection.names.length === 0) return { seeded, skipped };

  await fs.mkdir(targetHome, { recursive: true });
  for (const name of selection.names) {
    try {
      const source = await readSeedSource(sourceHome, name);
      if (!source) continue;
      if ("skip" in source) {
        skipped.push({ name, reason: source.skip });
        await onLog("stderr", `[paperclip] Not seeding "${name}" into the Codex home: ${source.skip}.\n`);
        continue;
      }
      const target = path.join(targetHome, name);
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && !existing.isFile() && !(existing.isSymbolicLink() && name !== CODEX_HOME_SEED_AGENTS_FILE)) {
        const reason = existing.isSymbolicLink()
          ? "the run's file is a symlink and instructions are never written through links"
          : "the run's path is not a regular file";
        skipped.push({ name, reason });
        await onLog("stderr", `[paperclip] Not seeding "${name}" into the Codex home: ${reason}.\n`);
        continue;
      }
      let next = source.content;
      if (name === CODEX_HOME_SEED_AGENTS_FILE) {
        const current = existing ? await fs.readFile(target, "utf8") : "";
        next = mergeAgentsFile(current, source.content);
        if (next === current) {
          seeded.push(name);
          continue;
        }
      }
      await writeAtomically(target, next);
      seeded.push(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ name, reason });
      await onLog("stderr", `[paperclip] Failed to seed "${name}" into the Codex home: ${reason}.\n`);
    }
  }
  if (seeded.length > 0) {
    await onLog("stdout", `[paperclip] Seeded worker Codex files into "${targetHome}": ${seeded.join(", ")}.\n`);
  }
  return { seeded, skipped };
}

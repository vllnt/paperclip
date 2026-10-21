import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { POLICY_INDEX_MAX_MENTIONS, extractPolicyMentionKeys } from "@paperclipai/shared";
import type { MentionSources } from "../application/ports.js";
import type { MentionScanCache } from "./scan-cache.js";

/** The instruction files the server stores are at most this large. A bigger file is not scanned. */
const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;

/**
 * Reads the policy mentions of the agent's committed instructions file. The caller passes the stored
 * file and never a per-run working copy, which the agent edits. The scan is cached by content hash,
 * so an unchanged file costs one read and no scan.
 */
export function createInstructionsMentionSource(cache: MentionScanCache): MentionSources["instructions"] {
  return async ({ filePath }) => {
    let bytes: Buffer;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_INSTRUCTIONS_BYTES) return [];
      bytes = await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    return cache.get(`instructions:${contentHash}`, () =>
      extractPolicyMentionKeys(bytes.toString("utf8")).slice(0, POLICY_INDEX_MAX_MENTIONS),
    );
  };
}

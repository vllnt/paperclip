import type { PolicyIndexRows } from "../domain/policy-index.js";

export interface PolicyIndexRowsPort {
  /**
   * One bounded read: the company's active policies, the project's active policies and the policies
   * the mentioned keys name, whatever their status. Mentioned rows come first, then the rest in
   * display order, at most `limit` rows. Everything is scoped to `companyId`.
   */
  load(input: {
    companyId: string;
    projectId: string | null;
    mentionedKeys: readonly string[];
    limit: number;
  }): Promise<PolicyIndexRows>;
}

/** The `policy://` keys one source of low-trust or stored text mentions. A source that fails reports no keys. */
export interface MentionSources {
  issue(input: { companyId: string; issueId: string; title: string; description: string | null }): Promise<string[]>;
  /** The committed instructions file, never a per-run working copy. */
  instructions(input: { filePath: string }): Promise<string[]>;
  skills(input: { companyId: string; skillKeys: readonly string[] }): Promise<string[]>;
}

export interface PolicyIndexDeps {
  rows: PolicyIndexRowsPort;
  sources: MentionSources;
  /** A stable content digest of a string. */
  digest(text: string): string;
  /** A source that cannot be read costs a mention, never a run. */
  onSourceError?(source: "issue" | "instructions" | "skills", error: unknown): void;
}

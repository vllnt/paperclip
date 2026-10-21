import { isUuidLike } from "@paperclipai/shared";

/**
 * The issue a heartbeat run works on, read from its context snapshot: the `issueId` key, when it is
 * a UUID. There is no fallback to `taskId` or to any other key, so a value that is not an issue id
 * can never be read as one. The caller must still check that the issue belongs to its company.
 */
export function readRunContextIssueId(context: unknown): string | null {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return null;
  const issueId = (context as Record<string, unknown>).issueId;
  return typeof issueId === "string" && isUuidLike(issueId) ? issueId : null;
}

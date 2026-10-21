import type { IssueTriagePage } from "@paperclipai/shared";
import { decodeTriageCursor, encodeTriageCursor } from "../domain/cursor.js";
import { toIssueTriage } from "./triage-issue.js";
import type { TriageStore } from "./ports.js";

export const DEFAULT_TRIAGE_PAGE_SIZE = 20;

export type ListTriageResult = { ok: true; page: IssueTriagePage } | { ok: false; error: "invalid_cursor" };

/** Reads the recorded triage of one issue, newest first, one cursor page at a time. */
export function createListTriage(deps: { store: TriageStore }) {
  return async function listTriage(input: {
    companyId: string;
    issueId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<ListTriageResult> {
    const after = input.cursor ? decodeTriageCursor(input.cursor) : null;
    if (input.cursor && !after) return { ok: false, error: "invalid_cursor" };
    const limit = input.limit ?? DEFAULT_TRIAGE_PAGE_SIZE;
    const rows = await deps.store.listRecords({
      companyId: input.companyId,
      issueId: input.issueId,
      limit: limit + 1,
      after,
    });
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      ok: true,
      page: {
        items: pageRows.map((row) => toIssueTriage(row.entry, row.id, row.createdAt.toISOString())),
        nextCursor:
          rows.length > limit && last ? encodeTriageCursor({ createdAt: last.createdAt, id: last.id }) : null,
      },
    };
  };
}

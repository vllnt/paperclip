import { z } from "zod";

/**
 * Company archive record format v1, shared by the streaming export API and the
 * archive bundles. See doc/company-archive.md for the contract.
 */
export const COMPANY_ARCHIVE_FORMAT = "paperclip.company-archive" as const;

/** Integer schema version of every record kind defined in this file. */
export const COMPANY_ARCHIVE_RECORD_VERSION = 1 as const;

/** Version of the read-time redaction chain applied to exported records. */
export const COMPANY_ARCHIVE_REDACTION_POLICY = {
  policy: "paperclip.read-redaction",
  v: 1,
} as const;

/** A run is exported only after its settle key is at least this old. */
export const COMPANY_ARCHIVE_SETTLE_DELAY_MS = 10 * 60 * 1000;

export const COMPANY_ARCHIVE_RECORD_KINDS = [
  "export.header",
  "run",
  "run_event",
  "transcript",
  "cost_event",
  "activity",
  "run.omission",
  "run.end",
  "export.end",
] as const;
export type CompanyArchiveRecordKind = (typeof COMPANY_ARCHIVE_RECORD_KINDS)[number];

export const COMPANY_ARCHIVE_INCLUDES = ["run", "events", "transcript", "costs", "activity"] as const;
export type CompanyArchiveInclude = (typeof COMPANY_ARCHIVE_INCLUDES)[number];

export const COMPANY_ARCHIVE_OMISSION_REASONS = [
  "transcript_unavailable",
  "transcript_unreadable",
  "events_unreadable",
] as const;
export type CompanyArchiveOmissionReason = (typeof COMPANY_ARCHIVE_OMISSION_REASONS)[number];

export const COMPANY_ARCHIVE_EXPORT_DEFAULT_LIMIT = 50;
export const COMPANY_ARCHIVE_EXPORT_MAX_LIMIT = 500;

/**
 * Keyset position: the run's settle key `coalesce(finished_at, created_at)`
 * as an ISO-8601 UTC string with microseconds, and the run id.
 */
export interface CompanyArchiveCursor {
  t: string;
  id: string;
}

const SETTLE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

/**
 * Encodes a keyset position as an opaque base64url token.
 * @param cursor settle key with microseconds and run id
 * @returns the token clients pass back as `cursor`
 */
export function encodeCompanyArchiveCursor(cursor: CompanyArchiveCursor): string {
  return toBase64Url(JSON.stringify({ v: 1, t: cursor.t, id: cursor.id }));
}

/**
 * Decodes and validates a cursor token.
 * @param token value from `run.end.data.cursor` or `export.end.data.next`
 * @returns the position, or null when the token is malformed
 */
export function decodeCompanyArchiveCursor(token: string): CompanyArchiveCursor | null {
  const json = fromBase64Url(token);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.t !== "string" || !SETTLE_KEY_PATTERN.test(record.t)) return null;
  // Reject calendar-invalid values (month 13, February 30): they would fail in
  // the database after the response has started.
  const millis = `${record.t.slice(0, 23)}Z`;
  const parsedTime = new Date(millis);
  if (Number.isNaN(parsedTime.getTime()) || parsedTime.toISOString() !== millis) return null;
  if (typeof record.id !== "string" || !UUID_PATTERN.test(record.id)) return null;
  return { t: record.t, id: record.id.toLowerCase() };
}

const includeListSchema = z
  .string()
  .transform((value, ctx) => {
    const parts = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
    const unknown = parts.filter((part) => !(COMPANY_ARCHIVE_INCLUDES as readonly string[]).includes(part));
    if (parts.length === 0 || unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `include must list ${COMPANY_ARCHIVE_INCLUDES.join(", ")}`,
      });
      return z.NEVER;
    }
    return parts as CompanyArchiveInclude[];
  });

/** Query string of `GET /companies/:companyId/archive/export`. */
export const companyArchiveExportQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    include: includeListSchema.optional(),
    limit: z.coerce.number().int().min(1).max(COMPANY_ARCHIVE_EXPORT_MAX_LIMIT).optional(),
    // "true": the server follows `next` itself and streams the whole window in
    // one response (browser downloads). Clients that page pass nothing.
    follow: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  })
  .strict();
export type CompanyArchiveExportQuery = z.infer<typeof companyArchiveExportQuerySchema>;

/** One NDJSON line of the export stream or an archive file. */
export interface CompanyArchiveRecord<TData = Record<string, unknown>> {
  kind: CompanyArchiveRecordKind;
  v: typeof COMPANY_ARCHIVE_RECORD_VERSION;
  companyId: string;
  runId?: string;
  data: TData;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TriagePosition {
  createdAt: Date;
  id: string;
}

/** Opaque cursor for the (created_at, id) position of the last row of a page. */
export function encodeTriageCursor(position: TriagePosition): string {
  return Buffer.from(JSON.stringify([position.createdAt.toISOString(), position.id])).toString("base64url");
}

/** Returns null when the text is not a cursor this module produced. */
export function decodeTriageCursor(cursor: string): TriagePosition | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed;
    if (typeof iso !== "string" || typeof id !== "string" || !UUID_RE.test(id)) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Opaque list cursors: base64url of a small JSON object. A bad cursor reads as `null`. */
export function encodeCursor(position: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeCursor<T extends Record<string, string | number>>(
  cursor: string | undefined,
  isPosition: (value: unknown) => value is T,
): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return isPosition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

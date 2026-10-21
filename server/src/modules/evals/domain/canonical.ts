/** Canonical JSON text: object keys sorted at every level, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** UTF-8 size of a string in bytes. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Nesting depth of a JSON value, counted without recursion so a hostile input cannot overflow the
 * stack. A scalar has depth 0; the walk stops as soon as it passes `limit`.
 * @returns The depth, or `limit + 1` when the value is deeper than `limit`.
 */
export function jsonDepth(value: unknown, limit: number): number {
  let deepest = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (typeof item.value !== "object" || item.value === null) continue;
    const depth = item.depth + 1;
    if (depth > deepest) deepest = depth;
    if (deepest > limit) return limit + 1;
    const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
    for (const child of children) stack.push({ value: child, depth });
  }
  return deepest;
}

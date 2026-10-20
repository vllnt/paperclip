import { appendWithByteCap, MAX_EXCERPT_BYTES, parseObject } from "../../adapters/utils.js";

const MAX_RUN_EVENT_PAYLOAD_STRING_CHARS = 16 * 1024;
const MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS = 50;
const MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS = 100;
const MAX_RUN_EVENT_PAYLOAD_DEPTH = 6;

export function appendExcerpt(prev: string, chunk: string) {
  return appendWithByteCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function truncateRunEventString(value: string) {
  if (value.length <= MAX_RUN_EVENT_PAYLOAD_STRING_CHARS) return value;
  const omittedChars = value.length - MAX_RUN_EVENT_PAYLOAD_STRING_CHARS;
  return `${value.slice(0, MAX_RUN_EVENT_PAYLOAD_STRING_CHARS)}\n[truncated ${omittedChars} chars]`;
}

function boundRunEventValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return truncateRunEventString(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_RUN_EVENT_PAYLOAD_DEPTH) {
      return {
        _truncated: true,
        type: "array",
        originalLength: value.length,
      };
    }
    const bounded = value
      .slice(0, MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS)
      .map((entry) => boundRunEventValue(entry, depth + 1, seen));
    if (value.length > MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS) {
      bounded.push({
        _truncated: true,
        omittedItems: value.length - MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS,
      });
    }
    return bounded;
  }
  if (typeof value !== "object" || value === undefined) {
    return null;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= MAX_RUN_EVENT_PAYLOAD_DEPTH) {
    const bounded = {
      _truncated: true,
      type: "object",
      keys: entries.map(([key]) => key).slice(0, 20),
    };
    seen.delete(value);
    return bounded;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(
    0,
    MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS,
  )) {
    out[key] = boundRunEventValue(entryValue, depth + 1, seen);
  }
  if (entries.length > MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS) {
    out._truncated = true;
    out._omittedKeys = entries.length - MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS;
  }
  seen.delete(value);
  return out;
}

export function boundHeartbeatRunEventPayloadForStorage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const bounded = boundRunEventValue(payload, 0, new WeakSet());
  return parseObject(bounded) ?? { _truncated: true };
}

// One implementation: the per-run compactor adds stream tail carry and PEM
// redaction on top of the same chunk compaction.
export { compactRunLogChunk } from "../run-log-chunk-compactor.js";


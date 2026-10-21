import { jsonDepth } from "./canonical.js";

/** Deepest nesting an input may have. An input of the schema subset is 2 deep. */
export const MAX_INPUT_DEPTH = 8;

export function isInputTooDeep(input: unknown): boolean {
  return jsonDepth(input, MAX_INPUT_DEPTH) > MAX_INPUT_DEPTH;
}

export interface RedactedInput {
  value: unknown;
  /** The number of string values that the redaction changed. Never the matched text. */
  redactionCount: number;
}

/**
 * Runs `redactText` over every string value and every string array item, in any JSON shape.
 * Object keys are left as they are. The input must not be deeper than `MAX_INPUT_DEPTH`.
 */
export function redactJsonStrings(input: unknown, redactText: (text: string) => string): RedactedInput {
  let redactionCount = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const redacted = redactText(value);
      if (redacted !== value) redactionCount += 1;
      return redacted;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      const copy: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) copy[key] = walk(child);
      return copy;
    }
    return value;
  };
  return { value: walk(input), redactionCount };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

/** True for a plain JSON object. The input must not be deeper than `MAX_INPUT_DEPTH`. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

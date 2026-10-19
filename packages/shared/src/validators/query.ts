import { z } from "zod";

/**
 * A query parameter holding a comma-separated list of enum values, such as
 * `?status=active,escalated`. Repeated parameters are merged. An absent or
 * empty value parses to `undefined` so the route can apply its default; an
 * unknown value fails validation.
 */
export function commaSeparatedEnumQuerySchema<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    const rawValues = Array.isArray(value) ? value : [value];
    const items = rawValues.flatMap((entry) =>
      typeof entry === "string"
        ? entry.split(",").map((part) => part.trim()).filter(Boolean)
        : [entry],
    );
    return items.length > 0 ? [...new Set(items)] : undefined;
  }, z.array(z.enum(values)).optional());
}

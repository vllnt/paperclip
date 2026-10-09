import { describe, expect, it } from "vitest";
import { isProviderQuotaMessage, parseProviderQuotaResetAt } from "./provider-quota.js";

const SIZE = 100_000;
const NOW = new Date("2026-10-08T23:52:00.000Z");
const inputs: Array<[string, string]> = [
  ["digits and spaces", `try again in ${"1 ".repeat(SIZE / 2)}`],
  ["digit unit repeats", `retry in ${"1m ".repeat(SIZE / 3)}x`],
  ["commas and 'and'", `resets in 5m${", and ".repeat(SIZE / 6)}x`],
  ["whitespace", `limit resets in${" ".repeat(SIZE)}`],
  ["rate limit words", `rate_limit_error ${"usage ".repeat(SIZE / 6)}`],
  ["quote runs", `"reset_seconds"${" ".repeat(SIZE)}:`],
  ["reset_time quotes", `"reset_time": "${"1h".repeat(SIZE / 2)}`],
  ["cooling down", `all credentials for model ${"a".repeat(SIZE)}`],
  ["you've hit", `you've hit your ${"a ".repeat(SIZE / 2)}`],
  ["epoch pipes", `${"|".repeat(SIZE)}`],
  ["iso", `${"2026-10-08T00:00".repeat(SIZE / 16)}`],
];

describe("provider quota parsing on pathological input", () => {
  it.each(inputs)("%s is linear", (_label, input) => {
    const startedAt = performance.now();
    isProviderQuotaMessage(input);
    parseProviderQuotaResetAt(input, NOW);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});

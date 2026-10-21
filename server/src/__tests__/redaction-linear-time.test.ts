import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

const MARKER = REDACTED_EVENT_VALUE;
const BUDGET_MS = 100;

function repeatTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function elapsedMs(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("redactSensitiveText field-name scan", () => {
  // The scan used to start every match with an unbounded run of name characters
  // and re-read that run from every start position, so the cost grew with the
  // square of the run length. These inputs are one long run of name characters
  // that is full of keywords and has no colon, so no match can succeed.
  // The sizes rise in steps, so a regression fails on a small input and not
  // after minutes on the largest one.
  const cases: Array<{ name: string; unit: string }> = [
    { name: "adjacent keywords", unit: "token" },
    { name: "underscore-joined keywords", unit: "my_api_key_token_" },
    { name: "keywords with value suffixes", unit: "token_value_prod_" },
  ];

  for (const { name, unit } of cases) {
    it(`redacts ${name} in under ${BUDGET_MS} ms for every size up to 256 KiB`, () => {
      for (const kib of [16, 64, 256]) {
        const input = repeatTo(unit, kib * 1024);
        const ms = elapsedMs(() => redactSensitiveText(input));
        expect(ms, `${kib} KiB took ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS);
      }
    });
  }

  it("still redacts a field after keyword-dense text, up to 256 KiB", () => {
    for (const kib of [16, 64, 256]) {
      const input = `${repeatTo("token_", kib * 1024)} {"clientToken": "opaque-value"}`;
      let output = "";
      const ms = elapsedMs(() => {
        output = redactSensitiveText(input);
      });
      expect(ms, `${kib} KiB took ${ms.toFixed(1)} ms`).toBeLessThan(BUDGET_MS);
      expect(output.endsWith(`{"clientToken": "${MARKER}"}`)).toBe(true);
      expect(output).not.toContain("opaque-value");
    }
  });

  // The scan no longer reads the name prefix, so these cases pin the output for
  // names that carry a prefix, a suffix and each quote style.
  it.each([
    {
      name: "a prefixed double-quoted field",
      input: String.raw`{"my_api-key_value":"s3cr3t-v4lue","name":"visible"}`,
      expected: `{"my_api-key_value":"${MARKER}","name":"visible"}`,
    },
    {
      name: "a single-quoted field with spaces in the value",
      input: String.raw`{'x-session-token': 'abc def', 'name': 'visible'}`,
      expected: `{'x-session-token': '${MARKER}', 'name': 'visible'}`,
    },
    {
      name: "an unquoted field name before a quoted value",
      input: String.raw`failed: privateKeyProduction : "line one" next`,
      expected: `failed: privateKeyProduction : "${MARKER}" next`,
    },
    {
      name: "an escaped JSON field",
      input: String.raw`{\"clientSecretPrimary\":\"esc-secret\",\"name\":\"visible\"}`,
      expected: String.raw`{\"clientSecretPrimary\":\"${MARKER}\",\"name\":\"visible\"}`,
    },
    {
      name: "an upper-case environment-style field",
      input: String.raw`GITHUB_ACCESS_TOKEN_DEV: "not-a-real-value"`,
      expected: `GITHUB_ACCESS_TOKEN_DEV: "${MARKER}"`,
    },
    {
      name: "a name that only starts with a keyword",
      input: String.raw`tokenizer: "visible words" and loginUrlTest: "https://example.test/y?z"`,
      expected: `tokenizer: "visible words" and loginUrlTest: "${MARKER}"`,
    },
  ])("keeps the output for $name", ({ input, expected }) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });
});

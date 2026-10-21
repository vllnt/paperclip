import { companyEvalInputSchemaSchema, type CompanyEvalInputSchema } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../../redaction.js";
import { compileInputValidator } from "./input-validator.js";

const CANARY = "CANARY-value-must-not-be-echoed";

function schema(properties: Record<string, unknown>, required: string[] = []): CompanyEvalInputSchema {
  return companyEvalInputSchemaSchema.parse({ type: "object", properties, required });
}

const prSchema = schema(
  {
    title: { type: "string", maxLength: 40 },
    kind: { type: "string", enum: ["bug", "feature"] },
    files_changed: { type: "integer", minimum: 0, maximum: 1000 },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    urgent: { type: "boolean" },
    labels: { type: "array", items: { type: "string", maxLength: 20 }, maxItems: 3 },
  },
  ["title"],
);

const identity = (text: string) => text;

describe("input validator", () => {
  const validate = compileInputValidator(prSchema, identity);

  it("accepts an input that matches the schema", () => {
    expect(
      validate({ title: "Fix login", kind: "bug", files_changed: 3, ratio: 0.5, urgent: false, labels: ["a", "b"] }),
    ).toEqual([]);
  });

  it("accepts an input with only the required properties", () => {
    expect(validate({ title: "Fix login" })).toEqual([]);
  });

  it("names the path and a fixed message for a type mismatch", () => {
    expect(validate({ title: 12 })).toEqual([{ path: "/title", message: "must be string" }]);
    expect(validate({ title: "ok", files_changed: 1.5 })).toEqual([{ path: "/files_changed", message: "must be integer" }]);
    expect(validate({ title: "ok", urgent: "yes" })).toEqual([{ path: "/urgent", message: "must be boolean" }]);
  });

  it("names the property that a missing required property leaves out", () => {
    const issues = validate({});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ path: "/", message: "must have required property 'title'" });
  });

  it("reports an enum mismatch without the value", () => {
    const issues = validate({ title: "ok", kind: CANARY });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("/kind");
    expect(JSON.stringify(issues)).not.toContain(CANARY);
  });

  it("reports bounds, length and item limits", () => {
    expect(validate({ title: "x".repeat(41) })).toEqual([{ path: "/title", message: "must NOT have more than 40 characters" }]);
    expect(validate({ title: "ok", files_changed: -1 })).toEqual([{ path: "/files_changed", message: "must be >= 0" }]);
    expect(validate({ title: "ok", ratio: 2 })).toEqual([{ path: "/ratio", message: "must be <= 1" }]);
    expect(validate({ title: "ok", labels: ["a", "b", "c", "d"] })).toEqual([
      { path: "/labels", message: "must NOT have more than 3 items" },
    ]);
  });

  it("points at the array item that has the wrong type", () => {
    expect(validate({ title: "ok", labels: ["fine", 7] })).toEqual([{ path: "/labels/1", message: "must be string" }]);
  });

  it("reports every mismatch, not only the first", () => {
    const paths = validate({ title: 1, kind: "other", urgent: "x" }).map((issue) => issue.path);
    expect([...paths].sort()).toEqual(["/kind", "/title", "/urgent"]);
  });

  it("rejects a value that is not an object", () => {
    for (const input of [null, "text", 7, [], true]) {
      const issues = validate(input);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("/");
      expect(issues[0]?.message).toBe("must be object");
    }
  });

  it("rejects a property that the schema does not name and says which one", () => {
    const issues = validate({ title: "ok", extra: CANARY });
    expect(issues).toEqual([{ path: "/", message: "must NOT have additional properties: extra" }]);
    expect(JSON.stringify(issues)).not.toContain(CANARY);
  });

  it("masks and shortens an additional property name that looks like a secret", () => {
    const tokenName = `${["gh", "p_"].join("")}A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8`;
    const real = compileInputValidator(prSchema, redactSensitiveText);
    const issues = real({ title: "ok", [tokenName]: 1 });
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain(tokenName);
    expect(JSON.stringify(issues)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    expect(issues[0]?.message).toContain("***REDACTED***");

    const longName = "n".repeat(300);
    const long = compileInputValidator(prSchema, identity)({ title: "ok", [longName]: 1 });
    expect(long[0]?.message).toBe(`must NOT have additional properties: ${"n".repeat(80)}`);
  });

  it("never returns an input value, whatever the kind of mismatch", () => {
    const issues = validate({
      title: [CANARY],
      kind: { nested: CANARY },
      files_changed: CANARY,
      ratio: CANARY,
      urgent: CANARY,
      labels: [CANARY, { deep: CANARY }],
      extra: CANARY,
    });
    expect(issues.length).toBeGreaterThan(3);
    expect(JSON.stringify(issues)).not.toContain(CANARY);
  });

  it("never returns a string value that is too long or outside the enum", () => {
    const long = `${CANARY}${"x".repeat(100)}`;
    const issues = validate({ title: long, kind: long, labels: [long] });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(issues)).not.toContain(CANARY);
  });

  it("caps the number of reported issues at 20", () => {
    const properties: Record<string, { type: "string" }> = {};
    const input: Record<string, number> = {};
    for (let index = 0; index < 32; index += 1) {
      properties[`p${index}`] = { type: "string" };
      input[`p${index}`] = index;
    }
    expect(compileInputValidator(schema(properties), identity)(input)).toHaveLength(20);
  });

  it("can be called again after a failure", () => {
    expect(validate({ title: 1 })).toHaveLength(1);
    expect(validate({ title: "ok" })).toEqual([]);
    expect(validate({ title: 2 })).toHaveLength(1);
  });
});

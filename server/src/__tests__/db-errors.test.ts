import { describe, expect, it } from "vitest";
import { isForeignKeyViolation, isInvalidTextRepresentation, isUniqueViolation } from "../db-errors.js";

const CONSTRAINT = "issues_open_routine_execution_uq";

describe("isUniqueViolation", () => {
  it("matches a bare postgres.js unique violation", () => {
    expect(isUniqueViolation({ code: "23505", constraint_name: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("matches the node-postgres constraint field", () => {
    expect(isUniqueViolation({ code: "23505", constraint: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("matches the error Drizzle wraps around the driver failure", () => {
    const wrapped = new Error("Failed query: update \"issues\" set \"execution_run_id\" = $1");
    (wrapped as { cause?: unknown }).cause = { code: "23505", constraint_name: CONSTRAINT };
    expect(isUniqueViolation(wrapped, CONSTRAINT)).toBe(true);
  });

  it("falls back to the driver message when the constraint name is not surfaced", () => {
    expect(isUniqueViolation({
      cause: {
        code: "23505",
        message: `duplicate key value violates unique constraint "${CONSTRAINT}"`,
      },
    }, CONSTRAINT)).toBe(true);
  });

  it("matches any unique violation when no constraint is named", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("ignores a unique violation on a different constraint", () => {
    expect(isUniqueViolation({ cause: { code: "23505", constraint_name: "issues_identifier_idx" } }, CONSTRAINT))
      .toBe(false);
  });

  it("ignores errors that are not unique violations", () => {
    expect(isUniqueViolation({ cause: { code: "23503", constraint_name: CONSTRAINT } }, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(new Error("boom"), CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(null, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(undefined, CONSTRAINT)).toBe(false);
  });

  it("stops walking a self-referential cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isUniqueViolation(looped, CONSTRAINT)).toBe(false);
  });
});

describe.each([
  ["isInvalidTextRepresentation", isInvalidTextRepresentation, "22P02"],
  ["isForeignKeyViolation", isForeignKeyViolation, "23503"],
] as const)("%s", (_name, matches, code) => {
  it("matches the code on the error itself and through Drizzle's cause", () => {
    expect(matches({ code })).toBe(true);
    expect(matches(new Error("Failed query: select 1", { cause: { code } }))).toBe(true);
  });

  it("ignores other codes, non-objects, and self-referential chains", () => {
    expect(matches({ code: "23505" })).toBe(false);
    expect(matches(code)).toBe(false);
    expect(matches(null)).toBe(false);
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(matches(looped)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  COMPANY_EVAL_LIMITS,
  COMPANY_EVAL_SLUG_PATTERN,
  companyEvalDefinitionSchema,
  companyEvalInputSchemaSchema,
  companyEvalQuestionSchema,
  companyEvalQuestionsSchema,
  companyEvalSlugSchema,
  createCompanyEvalSchema,
  createCompanyEvalVersionSchema,
  listCompanyEvalRunsQuerySchema,
  listCompanyEvalVersionsQuerySchema,
  listCompanyEvalsQuerySchema,
  predicateValue,
  publishCompanyEvalSchema,
  putCompanyEvalFeedbackSchema,
  runCompanyEvalSchema,
  updateCompanyEvalSchema,
} from "./company-evals.js";

const RUN_UUID = "5d0c2f7e-8a41-4c0b-9f3e-2b6a1d4e7c90";

function validInputSchema() {
  return {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 200 },
      labels: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 20 },
    },
    required: ["title"],
  };
}

function validQuestions() {
  return {
    needs_qa: { type: "predicate", instructions: "Does this change need QA?" },
  };
}

function validCreateBody() {
  return {
    slug: "pr-preview-needs-qa",
    title: "PR preview needs QA",
    whenToUse: "Before asking for a QA pass on a preview deployment.",
    inputSchema: validInputSchema(),
    questions: validQuestions(),
  };
}

/** A schema with `count` string properties named `p0`, `p1`, and so on. */
function schemaWithProperties(count: number) {
  const properties: Record<string, { type: "string" }> = {};
  for (let index = 0; index < count; index += 1) properties[`p${index}`] = { type: "string" };
  return { type: "object", properties };
}

/** A questions map with `count` predicate questions named `q0`, `q1`, and so on. */
function questionsWithCount(count: number) {
  const questions: Record<string, { type: "predicate"; instructions: string }> = {};
  for (let index = 0; index < count; index += 1) questions[`q${index}`] = { type: "predicate", instructions: "Yes?" };
  return questions;
}

function inputSchemaWith(property: unknown) {
  return { type: "object", properties: { field: property } };
}

function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.path.map(String).join("."));
}

describe("company eval limits", () => {
  it("fixes the run input cap at 32 KiB", () => {
    expect(COMPANY_EVAL_LIMITS.maxInputBytes).toBe(32 * 1024);
  });
});

describe("company eval slug", () => {
  it.each(["ab", "a1", "0abc", "pr-preview-needs-qa", "a-b-c", "x".repeat(63)])("accepts %s", (slug) => {
    expect(companyEvalSlugSchema.safeParse(slug).success).toBe(true);
    expect(COMPANY_EVAL_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["one character", "a"],
    ["64 characters", "x".repeat(64)],
    ["leading hyphen", "-ab"],
    ["uppercase", "Ab"],
    ["underscore", "a_b"],
    ["space", "a b"],
    ["dot", "a.b"],
    ["slash", "a/b"],
    ["path traversal", "../x"],
  ])("rejects %s", (_name, slug) => {
    expect(companyEvalSlugSchema.safeParse(slug).success).toBe(false);
  });

  it("rejects a non-string slug", () => {
    expect(companyEvalSlugSchema.safeParse(12).success).toBe(false);
  });
});

describe("company eval input schema subset", () => {
  it("accepts a root object with the five property kinds", () => {
    const parsed = companyEvalInputSchemaSchema.parse({
      type: "object",
      properties: {
        title: { type: "string", description: "The title", maxLength: 100, enum: ["a", "b"] },
        score: { type: "number", minimum: 0, maximum: 1 },
        count: { type: "integer", minimum: 0 },
        urgent: { type: "boolean" },
        files: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 100 },
      },
      required: ["title", "files"],
    });
    expect(Object.keys(parsed.properties)).toEqual(["title", "score", "count", "urgent", "files"]);
  });

  it("forces additionalProperties to false in the parsed value", () => {
    const parsed = companyEvalInputSchemaSchema.parse(validInputSchema());
    expect(parsed.additionalProperties).toBe(false);
    expect(parsed.required).toEqual(["title"]);
  });

  it("accepts an explicit additionalProperties false", () => {
    const parsed = companyEvalInputSchemaSchema.parse({ ...validInputSchema(), additionalProperties: false });
    expect(parsed.additionalProperties).toBe(false);
  });

  it("rejects additionalProperties true", () => {
    expect(companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), additionalProperties: true }).success).toBe(
      false,
    );
  });

  it("rejects an additionalProperties schema", () => {
    expect(
      companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), additionalProperties: { type: "string" } }).success,
    ).toBe(false);
  });

  it("sorts and defaults required", () => {
    const withRequired = companyEvalInputSchemaSchema.parse({
      type: "object",
      properties: { b: { type: "string" }, a: { type: "string" } },
      required: ["b", "a"],
    });
    expect(withRequired.required).toEqual(["a", "b"]);
    expect(companyEvalInputSchemaSchema.parse(schemaWithProperties(1)).required).toEqual([]);
  });

  it.each([
    ["an array", { type: "array", items: { type: "string" } }],
    ["a string", { type: "string" }],
    ["a missing type", { properties: { a: { type: "string" } } }],
  ])("rejects a root that is %s", (_name, root) => {
    expect(companyEvalInputSchemaSchema.safeParse(root).success).toBe(false);
  });

  it("rejects a root without properties", () => {
    expect(companyEvalInputSchemaSchema.safeParse({ type: "object" }).success).toBe(false);
  });

  it("needs 1 to 32 properties", () => {
    expect(companyEvalInputSchemaSchema.safeParse(schemaWithProperties(0)).success).toBe(false);
    expect(companyEvalInputSchemaSchema.safeParse(schemaWithProperties(1)).success).toBe(true);
    expect(companyEvalInputSchemaSchema.safeParse(schemaWithProperties(32)).success).toBe(true);
    expect(companyEvalInputSchemaSchema.safeParse(schemaWithProperties(33)).success).toBe(false);
  });

  it.each([
    ["starts with a digit", "1abc"],
    ["starts with an underscore", "_abc"],
    ["has a hyphen", "my-field"],
    ["has a space", "my field"],
    ["has a dot", "a.b"],
    ["is 65 characters", `a${"b".repeat(64)}`],
    ["is empty", ""],
  ])("rejects a property name that %s", (_name, name) => {
    const result = companyEvalInputSchemaSchema.safeParse({ type: "object", properties: { [name]: { type: "string" } } });
    expect(result.success).toBe(false);
  });

  it.each(["a", "A", "snake_case", "camelCase1", `a${"b".repeat(63)}`])("accepts property name %s", (name) => {
    const result = companyEvalInputSchemaSchema.safeParse({ type: "object", properties: { [name]: { type: "string" } } });
    expect(result.success).toBe(true);
  });

  it("rejects required names that are unknown or repeated", () => {
    expect(companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), required: ["missing"] }).success).toBe(false);
    expect(companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), required: ["title", "title"] }).success).toBe(
      false,
    );
  });

  describe("string properties", () => {
    it("bounds maxLength to 1-32768", () => {
      const parse = (maxLength: number) =>
        companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "string", maxLength })).success;
      expect(parse(1)).toBe(true);
      expect(parse(32_768)).toBe(true);
      expect(parse(0)).toBe(false);
      expect(parse(32_769)).toBe(false);
      expect(parse(1.5)).toBe(false);
    });

    it("accepts up to 50 unique enum values", () => {
      const values = (count: number) => Array.from({ length: count }, (_, index) => `v${index}`);
      const parse = (enumValues: string[]) =>
        companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "string", enum: enumValues })).success;
      expect(parse(values(1))).toBe(true);
      expect(parse(values(50))).toBe(true);
      expect(parse(values(51))).toBe(false);
      expect(parse([])).toBe(false);
      expect(parse(["a", "a"])).toBe(false);
    });

    it("rejects an enum value over 500 characters", () => {
      const parse = (value: string) =>
        companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "string", enum: [value] })).success;
      expect(parse("x".repeat(500))).toBe(true);
      expect(parse("x".repeat(501))).toBe(false);
    });

    it("rejects a non-string enum value", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "string", enum: [1, 2] })).success).toBe(false);
    });

    it("rejects a description over 500 characters", () => {
      const parse = (description: string) =>
        companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "string", description })).success;
      expect(parse("d".repeat(500))).toBe(true);
      expect(parse("d".repeat(501))).toBe(false);
      expect(parse("")).toBe(false);
    });

    it("rejects keywords outside the subset", () => {
      for (const extra of [{ pattern: "^a" }, { format: "email" }, { minLength: 1 }, { default: "x" }, { const: "x" }]) {
        expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "string", ...extra })).success).toBe(false);
      }
    });
  });

  describe("number and integer properties", () => {
    it("accepts bounds", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "number", minimum: -1.5, maximum: 2.5 })).success).toBe(
        true,
      );
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "integer", minimum: 0, maximum: 0 })).success).toBe(
        true,
      );
    });

    it("rejects minimum above maximum", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "number", minimum: 2, maximum: 1 })).success).toBe(
        false,
      );
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "integer", minimum: 5, maximum: 4 })).success).toBe(
        false,
      );
    });

    it("rejects non-finite bounds and string-only keywords", () => {
      expect(
        companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "number", minimum: Number.POSITIVE_INFINITY })).success,
      ).toBe(false);
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "number", maxLength: 3 })).success).toBe(false);
    });
  });

  describe("boolean properties", () => {
    it("accepts a boolean and rejects extra keywords", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "boolean" })).success).toBe(true);
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "boolean", enum: [true] })).success).toBe(false);
    });
  });

  describe("array properties", () => {
    it("accepts an array of strings with bounds", () => {
      const parse = (property: unknown) => companyEvalInputSchemaSchema.safeParse(inputSchemaWith(property)).success;
      expect(parse({ type: "array", items: { type: "string" } })).toBe(true);
      expect(parse({ type: "array", items: { type: "string", maxLength: 32_768 }, maxItems: 1_000 })).toBe(true);
    });

    it("bounds maxItems to 1-1000 and item maxLength to 1-32768", () => {
      const parse = (property: unknown) => companyEvalInputSchemaSchema.safeParse(inputSchemaWith(property)).success;
      expect(parse({ type: "array", items: { type: "string" }, maxItems: 1_001 })).toBe(false);
      expect(parse({ type: "array", items: { type: "string" }, maxItems: 0 })).toBe(false);
      expect(parse({ type: "array", items: { type: "string", maxLength: 32_769 } })).toBe(false);
      expect(parse({ type: "array", items: { type: "string", maxLength: 0 } })).toBe(false);
    });

    it("rejects items that are not plain strings", () => {
      const parse = (items: unknown) =>
        companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "array", items })).success;
      expect(parse({ type: "number" })).toBe(false);
      expect(parse({ type: "object", properties: {} })).toBe(false);
      expect(parse({ type: "array", items: { type: "string" } })).toBe(false);
      expect(parse({ type: "string", enum: ["a"] })).toBe(false);
    });

    it("rejects an array without items", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "array" })).success).toBe(false);
    });
  });

  describe("shapes outside the subset", () => {
    it("rejects a nested object property", () => {
      const nested = inputSchemaWith({ type: "object", properties: { inner: { type: "string" } } });
      expect(companyEvalInputSchemaSchema.safeParse(nested).success).toBe(false);
    });

    it("rejects a $ref property", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ $ref: "#/$defs/thing" })).success).toBe(false);
      expect(
        companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), $defs: { thing: { type: "string" } } }).success,
      ).toBe(false);
    });

    it("rejects composition keywords and unknown types", () => {
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ anyOf: [{ type: "string" }] })).success).toBe(false);
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: "null" })).success).toBe(false);
      expect(companyEvalInputSchemaSchema.safeParse(inputSchemaWith({ type: ["string", "null"] })).success).toBe(false);
    });

    it("rejects unknown keywords at the root", () => {
      expect(companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), $schema: "x" }).success).toBe(false);
      expect(companyEvalInputSchemaSchema.safeParse({ ...validInputSchema(), title: "x" }).success).toBe(false);
    });
  });
});

describe("company eval questions", () => {
  it("needs 1 to 8 questions", () => {
    expect(companyEvalQuestionsSchema.safeParse({}).success).toBe(false);
    expect(companyEvalQuestionsSchema.safeParse(questionsWithCount(1)).success).toBe(true);
    expect(companyEvalQuestionsSchema.safeParse(questionsWithCount(8)).success).toBe(true);
    expect(companyEvalQuestionsSchema.safeParse(questionsWithCount(9)).success).toBe(false);
  });

  it.each(["a", "needs_qa", "q1", `a${"b".repeat(39)}`])("accepts question id %s", (id) => {
    expect(companyEvalQuestionsSchema.safeParse({ [id]: { type: "predicate", instructions: "Yes?" } }).success).toBe(true);
  });

  it.each([
    ["uppercase", "Needs_qa"],
    ["leading digit", "1abc"],
    ["leading underscore", "_abc"],
    ["hyphen", "needs-qa"],
    ["space", "needs qa"],
    ["41 characters", `a${"b".repeat(40)}`],
    ["empty", ""],
  ])("rejects a question id with %s", (_name, id) => {
    expect(companyEvalQuestionsSchema.safeParse({ [id]: { type: "predicate", instructions: "Yes?" } }).success).toBe(false);
  });

  it("rejects an unknown question type and unknown keys", () => {
    expect(companyEvalQuestionSchema.safeParse({ type: "freeform", instructions: "Say" }).success).toBe(false);
    expect(companyEvalQuestionSchema.safeParse({ type: "predicate", instructions: "Yes?", hint: "x" }).success).toBe(false);
  });

  describe("instructions", () => {
    it("are 1 to 2000 characters after trimming", () => {
      const parse = (instructions: string) => companyEvalQuestionSchema.safeParse({ type: "predicate", instructions }).success;
      expect(parse("x")).toBe(true);
      expect(parse("x".repeat(2_000))).toBe(true);
      expect(parse("x".repeat(2_001))).toBe(false);
      expect(parse("")).toBe(false);
      expect(parse("   ")).toBe(false);
    });
  });

  describe("predicate", () => {
    const parse = (extra: Record<string, unknown>) =>
      companyEvalQuestionSchema.safeParse({ type: "predicate", instructions: "Yes?", ...extra });

    it("accepts whenTrue and whenFalse up to 2000 characters", () => {
      expect(parse({ whenTrue: "x".repeat(2_000), whenFalse: "y" }).success).toBe(true);
      expect(parse({ whenTrue: "x".repeat(2_001) }).success).toBe(false);
      expect(parse({ whenFalse: "" }).success).toBe(false);
    });

    it("accepts an abstainBand with low below high inside [0, 1]", () => {
      expect(parse({ abstainBand: [0.3, 0.7] }).success).toBe(true);
      expect(parse({ abstainBand: [0, 1] }).success).toBe(true);
    });

    it("rejects an abstainBand with low at or above high", () => {
      expect(parse({ abstainBand: [0.7, 0.3] }).success).toBe(false);
      expect(parse({ abstainBand: [0.5, 0.5] }).success).toBe(false);
    });

    it("rejects an abstainBand outside [0, 1] or with the wrong length", () => {
      expect(parse({ abstainBand: [-0.1, 0.5] }).success).toBe(false);
      expect(parse({ abstainBand: [0.5, 1.1] }).success).toBe(false);
      expect(parse({ abstainBand: [0.1, 0.5, 0.9] }).success).toBe(false);
      expect(parse({ abstainBand: [0.5] }).success).toBe(false);
      expect(parse({ abstainBand: ["0.1", "0.5"] }).success).toBe(false);
    });
  });

  describe("choice", () => {
    const options = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`opt${index}`, `Option ${index}`]));
    const parse = (extra: Record<string, unknown>) =>
      companyEvalQuestionSchema.safeParse({ type: "choice", instructions: "Which?", ...extra });

    it("needs 2 to 12 options", () => {
      expect(parse({ options: options(1) }).success).toBe(false);
      expect(parse({ options: options(2) }).success).toBe(true);
      expect(parse({ options: options(12) }).success).toBe(true);
      expect(parse({ options: options(13) }).success).toBe(false);
      expect(parse({}).success).toBe(false);
    });

    it("limits an option description to 500 characters", () => {
      expect(parse({ options: { a: "x".repeat(500), b: "y" } }).success).toBe(true);
      expect(parse({ options: { a: "x".repeat(501), b: "y" } }).success).toBe(false);
      expect(parse({ options: { a: "", b: "y" } }).success).toBe(false);
    });

    it("rejects an option key outside the pattern", () => {
      expect(parse({ options: { "bad key": "x", b: "y" } }).success).toBe(false);
      expect(parse({ options: { "-lead": "x", b: "y" } }).success).toBe(false);
      expect(parse({ options: { "ok.key-1_x": "x", b: "y" } }).success).toBe(true);
    });

    it("bounds minConfidence to [0, 1]", () => {
      expect(parse({ options: options(2), minConfidence: 0 }).success).toBe(true);
      expect(parse({ options: options(2), minConfidence: 1 }).success).toBe(true);
      expect(parse({ options: options(2), minConfidence: 1.1 }).success).toBe(false);
      expect(parse({ options: options(2), minConfidence: -0.1 }).success).toBe(false);
    });
  });

  describe("score", () => {
    const levels = (count: number) => Array.from({ length: count }, (_, index) => `Level ${index}`);
    const parse = (extra: Record<string, unknown>) =>
      companyEvalQuestionSchema.safeParse({ type: "score", instructions: "How bad?", ...extra });

    it("needs 2 to 10 levels", () => {
      expect(parse({ levels: levels(1) }).success).toBe(false);
      expect(parse({ levels: levels(2) }).success).toBe(true);
      expect(parse({ levels: levels(10) }).success).toBe(true);
      expect(parse({ levels: levels(11) }).success).toBe(false);
      expect(parse({}).success).toBe(false);
    });

    it("limits a level to 500 characters", () => {
      expect(parse({ levels: ["x".repeat(500), "y"] }).success).toBe(true);
      expect(parse({ levels: ["x".repeat(501), "y"] }).success).toBe(false);
      expect(parse({ levels: ["", "y"] }).success).toBe(false);
    });

    it("bounds minConfidence to [0, 1]", () => {
      expect(parse({ levels: levels(2), minConfidence: 0.5 }).success).toBe(true);
      expect(parse({ levels: levels(2), minConfidence: 2 }).success).toBe(false);
      expect(parse({ levels: levels(2), minConfidence: -1 }).success).toBe(false);
    });
  });
});

describe("company eval definition", () => {
  it("parses an input schema and questions together and rejects extra keys", () => {
    const body = { inputSchema: validInputSchema(), questions: validQuestions() };
    expect(companyEvalDefinitionSchema.safeParse(body).success).toBe(true);
    expect(companyEvalDefinitionSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});

describe("create company eval", () => {
  it("parses a full body and trims the text fields", () => {
    const parsed = createCompanyEvalSchema.parse({
      ...validCreateBody(),
      title: "  Title  ",
      whenToUse: "  When  ",
      changeNote: "  First version  ",
    });
    expect(parsed.title).toBe("Title");
    expect(parsed.whenToUse).toBe("When");
    expect(parsed.changeNote).toBe("First version");
    expect(parsed.inputSchema.additionalProperties).toBe(false);
  });

  it("rejects a bad slug, an empty title and an empty whenToUse", () => {
    expect(createCompanyEvalSchema.safeParse({ ...validCreateBody(), slug: "Bad Slug" }).success).toBe(false);
    expect(createCompanyEvalSchema.safeParse({ ...validCreateBody(), title: "  " }).success).toBe(false);
    expect(createCompanyEvalSchema.safeParse({ ...validCreateBody(), whenToUse: "" }).success).toBe(false);
  });

  it("limits title to 120, whenToUse to 1000 and changeNote to 500 characters", () => {
    const parse = (overrides: Record<string, unknown>) =>
      createCompanyEvalSchema.safeParse({ ...validCreateBody(), ...overrides }).success;
    expect(parse({ title: "t".repeat(120) })).toBe(true);
    expect(parse({ title: "t".repeat(121) })).toBe(false);
    expect(parse({ whenToUse: "w".repeat(1_000) })).toBe(true);
    expect(parse({ whenToUse: "w".repeat(1_001) })).toBe(false);
    expect(parse({ changeNote: "n".repeat(500) })).toBe(true);
    expect(parse({ changeNote: "n".repeat(501) })).toBe(false);
    expect(parse({ changeNote: "" })).toBe(false);
  });

  it("rejects missing fields and unknown keys", () => {
    for (const key of ["slug", "title", "whenToUse", "inputSchema", "questions"]) {
      const rest = Object.fromEntries(Object.entries(validCreateBody()).filter(([name]) => name !== key));
      expect(createCompanyEvalSchema.safeParse(rest).success).toBe(false);
    }
    expect(createCompanyEvalSchema.safeParse({ ...validCreateBody(), status: "published" }).success).toBe(false);
  });

  it("rejects an invalid input schema or invalid questions with the path of the field", () => {
    const badSchema = createCompanyEvalSchema.safeParse({ ...validCreateBody(), inputSchema: schemaWithProperties(0) });
    expect(issuePaths(badSchema)).toContain("inputSchema.properties");
    const badQuestions = createCompanyEvalSchema.safeParse({ ...validCreateBody(), questions: {} });
    expect(issuePaths(badQuestions)).toContain("questions");
  });
});

describe("update company eval", () => {
  it("needs at least one of title or whenToUse", () => {
    expect(updateCompanyEvalSchema.safeParse({}).success).toBe(false);
    expect(updateCompanyEvalSchema.safeParse({ title: "New" }).success).toBe(true);
    expect(updateCompanyEvalSchema.safeParse({ whenToUse: "When" }).success).toBe(true);
    expect(updateCompanyEvalSchema.safeParse({ title: "A", whenToUse: "B" }).success).toBe(true);
  });

  it("rejects unknown keys and empty values", () => {
    expect(updateCompanyEvalSchema.safeParse({ title: "A", slug: "other" }).success).toBe(false);
    expect(updateCompanyEvalSchema.safeParse({ title: " " }).success).toBe(false);
    expect(updateCompanyEvalSchema.safeParse({ title: "t".repeat(121) }).success).toBe(false);
  });
});

describe("create company eval version", () => {
  it("parses a definition with an optional change note", () => {
    const body = { inputSchema: validInputSchema(), questions: validQuestions() };
    expect(createCompanyEvalVersionSchema.safeParse(body).success).toBe(true);
    expect(createCompanyEvalVersionSchema.safeParse({ ...body, changeNote: "Tighter wording" }).success).toBe(true);
    expect(createCompanyEvalVersionSchema.safeParse({ ...body, changeNote: "n".repeat(501) }).success).toBe(false);
  });

  it("rejects a missing part and unknown keys", () => {
    expect(createCompanyEvalVersionSchema.safeParse({ inputSchema: validInputSchema() }).success).toBe(false);
    expect(createCompanyEvalVersionSchema.safeParse({ questions: validQuestions() }).success).toBe(false);
    expect(
      createCompanyEvalVersionSchema.safeParse({ inputSchema: validInputSchema(), questions: validQuestions(), slug: "x" })
        .success,
    ).toBe(false);
  });
});

describe("publish company eval", () => {
  it("takes an optional positive integer version number", () => {
    expect(publishCompanyEvalSchema.safeParse({}).success).toBe(true);
    expect(publishCompanyEvalSchema.safeParse({ versionNumber: 3 }).success).toBe(true);
    expect(publishCompanyEvalSchema.safeParse({ versionNumber: 0 }).success).toBe(false);
    expect(publishCompanyEvalSchema.safeParse({ versionNumber: 1.5 }).success).toBe(false);
    expect(publishCompanyEvalSchema.safeParse({ versionNumber: "2" }).success).toBe(false);
    expect(publishCompanyEvalSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe("run company eval", () => {
  it("accepts any JSON value as the input, because the service checks it", () => {
    for (const input of [{ title: "x" }, null, [], "text", 7, { deeply: { nested: [1] } }]) {
      expect(runCompanyEvalSchema.safeParse({ input }).success).toBe(true);
    }
  });

  it("requires the input key", () => {
    const result = runCompanyEvalSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("input");
  });

  it("takes an optional issue id, version number and the try_it mode", () => {
    expect(runCompanyEvalSchema.safeParse({ input: {}, issueId: RUN_UUID, versionNumber: 2, mode: "try_it" }).success).toBe(
      true,
    );
    expect(runCompanyEvalSchema.safeParse({ input: {}, issueId: "not-a-uuid" }).success).toBe(false);
    expect(runCompanyEvalSchema.safeParse({ input: {}, versionNumber: 0 }).success).toBe(false);
    expect(runCompanyEvalSchema.safeParse({ input: {}, versionNumber: 1.5 }).success).toBe(false);
  });

  it("does not let a caller ask for the live mode", () => {
    expect(runCompanyEvalSchema.safeParse({ input: {}, mode: "live" }).success).toBe(false);
    expect(runCompanyEvalSchema.safeParse({ input: {}, mode: "nonsense" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(runCompanyEvalSchema.safeParse({ input: {}, agentId: RUN_UUID }).success).toBe(false);
  });
});

describe("company eval feedback", () => {
  it("accepts a verdict alone", () => {
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct" }).success).toBe(true);
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "incorrect" }).success).toBe(true);
  });

  it("rejects a missing or unknown verdict", () => {
    expect(putCompanyEvalFeedbackSchema.safeParse({}).success).toBe(false);
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "maybe" }).success).toBe(false);
  });

  it("takes an optional question id that matches the question id pattern", () => {
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", questionId: "needs_qa" }).success).toBe(true);
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", questionId: "Needs-QA" }).success).toBe(false);
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", questionId: "" }).success).toBe(false);
  });

  it("limits the note to 2000 characters and trims it", () => {
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", note: "n".repeat(2_000) }).success).toBe(true);
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", note: "n".repeat(2_001) }).success).toBe(false);
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", note: "   " }).success).toBe(false);
    expect(putCompanyEvalFeedbackSchema.parse({ verdict: "correct", note: "  fine  " }).note).toBe("fine");
  });

  it("rejects unknown keys", () => {
    expect(putCompanyEvalFeedbackSchema.safeParse({ verdict: "correct", runId: RUN_UUID }).success).toBe(false);
  });
});

describe("company eval list queries", () => {
  it("defaults the page size to 50 and coerces a string limit", () => {
    expect(listCompanyEvalsQuerySchema.parse({}).limit).toBe(50);
    expect(listCompanyEvalVersionsQuerySchema.parse({}).limit).toBe(50);
    expect(listCompanyEvalRunsQuerySchema.parse({}).limit).toBe(50);
    expect(listCompanyEvalsQuerySchema.parse({ limit: "25" }).limit).toBe(25);
  });

  it("bounds the page size to 1-200", () => {
    for (const schema of [listCompanyEvalsQuerySchema, listCompanyEvalVersionsQuerySchema, listCompanyEvalRunsQuerySchema]) {
      expect(schema.safeParse({ limit: "200" }).success).toBe(true);
      expect(schema.safeParse({ limit: "201" }).success).toBe(false);
      expect(schema.safeParse({ limit: "0" }).success).toBe(false);
      expect(schema.safeParse({ limit: "-1" }).success).toBe(false);
      expect(schema.safeParse({ limit: "1.5" }).success).toBe(false);
    }
  });

  it("limits the cursor to 512 characters and rejects an empty one", () => {
    expect(listCompanyEvalsQuerySchema.safeParse({ cursor: "c".repeat(512) }).success).toBe(true);
    expect(listCompanyEvalsQuerySchema.safeParse({ cursor: "c".repeat(513) }).success).toBe(false);
    expect(listCompanyEvalsQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("filters the eval list by status only", () => {
    expect(listCompanyEvalsQuerySchema.safeParse({ status: "archived" }).success).toBe(true);
    expect(listCompanyEvalsQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(listCompanyEvalsQuerySchema.safeParse({ agentId: RUN_UUID }).success).toBe(false);
  });

  it("rejects unknown query parameters on the version list", () => {
    expect(listCompanyEvalVersionsQuerySchema.safeParse({ status: "draft" }).success).toBe(false);
  });

  describe("run list", () => {
    it("parses every filter", () => {
      const parsed = listCompanyEvalRunsQuerySchema.parse({
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-09T12:00:00+02:00",
        versionNumber: "3",
        agentId: RUN_UUID,
        projectId: RUN_UUID,
        outcome: "failed",
        mode: "try_it",
        limit: "10",
        cursor: "abc",
      });
      expect(parsed).toMatchObject({
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-09T12:00:00+02:00",
        versionNumber: 3,
        agentId: RUN_UUID,
        projectId: RUN_UUID,
        outcome: "failed",
        mode: "try_it",
        limit: 10,
        cursor: "abc",
      });
    });

    it("rejects a bad date, id, outcome, mode or version number", () => {
      expect(listCompanyEvalRunsQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false);
      expect(listCompanyEvalRunsQuerySchema.safeParse({ to: "2026-10-09" }).success).toBe(false);
      expect(listCompanyEvalRunsQuerySchema.safeParse({ agentId: "agent-1" }).success).toBe(false);
      expect(listCompanyEvalRunsQuerySchema.safeParse({ projectId: "p" }).success).toBe(false);
      expect(listCompanyEvalRunsQuerySchema.safeParse({ outcome: "ok" }).success).toBe(false);
      expect(listCompanyEvalRunsQuerySchema.safeParse({ mode: "dry" }).success).toBe(false);
      expect(listCompanyEvalRunsQuerySchema.safeParse({ versionNumber: "0" }).success).toBe(false);
    });

    it("accepts each outcome and mode value", () => {
      for (const outcome of ["answered", "failed", "rejected"]) {
        expect(listCompanyEvalRunsQuerySchema.safeParse({ outcome }).success).toBe(true);
      }
      for (const mode of ["live", "try_it"]) {
        expect(listCompanyEvalRunsQuerySchema.safeParse({ mode }).success).toBe(true);
      }
    });

    it("rejects unknown parameters", () => {
      expect(listCompanyEvalRunsQuerySchema.safeParse({ status: "draft" }).success).toBe(false);
    });
  });
});

describe("predicateValue", () => {
  it("is true from a probability of 0.5, false below, and null when abstained", () => {
    expect(predicateValue(0.5, false)).toBe(true);
    expect(predicateValue(0.91, false)).toBe(true);
    expect(predicateValue(1, false)).toBe(true);
    expect(predicateValue(0.4999, false)).toBe(false);
    expect(predicateValue(0, false)).toBe(false);
    expect(predicateValue(0.9, true)).toBeNull();
    expect(predicateValue(0.1, true)).toBeNull();
    expect(predicateValue(null, true)).toBeNull();
    expect(predicateValue(null, false)).toBeNull();
  });
});

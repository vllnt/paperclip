import { z } from "zod";

/**
 * Company evals: a company defines a Jev decision once (an input schema and a set of named
 * questions), any caller runs it, and every call is recorded. These are the shared constants,
 * request validators and response shapes for the API, the CLI and the UI.
 *
 * This is not the runner's developer evals (`doc/evals.md`). The prefix `company_eval` keeps the
 * two apart in code and search.
 */

export const COMPANY_EVAL_STATUSES = ["draft", "published", "archived"] as const;
export type CompanyEvalStatus = (typeof COMPANY_EVAL_STATUSES)[number];

export const COMPANY_EVAL_RUN_OUTCOMES = ["answered", "failed", "rejected"] as const;
export type CompanyEvalRunOutcome = (typeof COMPANY_EVAL_RUN_OUTCOMES)[number];

/** `live` runs count in stats; `try_it` runs are board experiments on any version. */
export const COMPANY_EVAL_RUN_MODES = ["live", "try_it"] as const;
export type CompanyEvalRunMode = (typeof COMPANY_EVAL_RUN_MODES)[number];

export const COMPANY_EVAL_CALLER_TYPES = ["agent", "user"] as const;
export type CompanyEvalCallerType = (typeof COMPANY_EVAL_CALLER_TYPES)[number];

/** Mirrors `JUDGE_FAILURE_REASONS` in the server judge client; a server test keeps them equal. */
export const COMPANY_EVAL_JUDGE_FAILURE_REASONS = ["no_key", "cap_exceeded", "timeout", "error"] as const;
export type CompanyEvalJudgeFailureReason = (typeof COMPANY_EVAL_JUDGE_FAILURE_REASONS)[number];

export const COMPANY_EVAL_REJECTION_REASONS = ["input_too_large", "input_invalid"] as const;
export type CompanyEvalRejectionReason = (typeof COMPANY_EVAL_REJECTION_REASONS)[number];

export type CompanyEvalFailureReason = CompanyEvalJudgeFailureReason | CompanyEvalRejectionReason;

/** The `code` of a 422 on the run route. */
export const COMPANY_EVAL_INPUT_ERROR_CODES = ["eval_input_too_large", "eval_input_invalid"] as const;
export type CompanyEvalInputErrorCode = (typeof COMPANY_EVAL_INPUT_ERROR_CODES)[number];

export const COMPANY_EVAL_FEEDBACK_VERDICTS = ["correct", "incorrect"] as const;
export type CompanyEvalFeedbackVerdict = (typeof COMPANY_EVAL_FEEDBACK_VERDICTS)[number];

export const COMPANY_EVAL_LIMITS = {
  /** Largest run input, in UTF-8 bytes of its JSON text. */
  maxInputBytes: 32_768,
  maxSlugLength: 63,
  maxTitleLength: 120,
  maxWhenToUseLength: 1_000,
  maxChangeNoteLength: 500,
  maxNoteLength: 2_000,
  maxProperties: 32,
  maxEnumValues: 50,
  maxStringLength: 32_768,
  maxArrayItems: 1_000,
  maxDescriptionLength: 500,
  maxQuestions: 8,
  maxInstructionsLength: 2_000,
  maxCriterionLength: 500,
  minChoiceOptions: 2,
  maxChoiceOptions: 12,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;

export const COMPANY_EVAL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PROPERTY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const OPTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const limits = COMPANY_EVAL_LIMITS;

export const companyEvalSlugSchema = z.string().regex(COMPANY_EVAL_SLUG_PATTERN, {
  message: "Slug must be 2-63 characters: lowercase letters, digits and hyphens, starting with a letter or digit.",
});
const titleSchema = z.string().trim().min(1).max(limits.maxTitleLength);
const whenToUseSchema = z.string().trim().min(1).max(limits.maxWhenToUseLength);
const changeNoteSchema = z.string().trim().min(1).max(limits.maxChangeNoteLength);
const descriptionSchema = z.string().trim().min(1).max(limits.maxDescriptionLength);

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

// ---------------------------------------------------------------------------------------------
// Input schema: a small JSON Schema subset. The root is an object; properties are strings,
// numbers, integers, booleans or arrays of strings; `additionalProperties` is always false so
// nothing the schema does not name is sent to the gateway.
// ---------------------------------------------------------------------------------------------

const stringPropertySchema = z
  .strictObject({
    type: z.literal("string"),
    description: descriptionSchema.optional(),
    maxLength: z.number().int().min(1).max(limits.maxStringLength).optional(),
    enum: z
      .array(z.string().max(limits.maxCriterionLength))
      .min(1)
      .max(limits.maxEnumValues)
      .refine(allUnique, { message: "enum values must be unique" })
      .optional(),
  });

const numericBounds = {
  description: descriptionSchema.optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
};

const numberPropertySchema = z.strictObject({ type: z.literal("number"), ...numericBounds });
const integerPropertySchema = z.strictObject({ type: z.literal("integer"), ...numericBounds });

const booleanPropertySchema = z.strictObject({
  type: z.literal("boolean"),
  description: descriptionSchema.optional(),
});

const stringArrayPropertySchema = z.strictObject({
  type: z.literal("array"),
  description: descriptionSchema.optional(),
  items: z.strictObject({
    type: z.literal("string"),
    maxLength: z.number().int().min(1).max(limits.maxStringLength).optional(),
  }),
  maxItems: z.number().int().min(1).max(limits.maxArrayItems).optional(),
});

const inputPropertySchema = z
  .discriminatedUnion("type", [
    stringPropertySchema,
    numberPropertySchema,
    integerPropertySchema,
    booleanPropertySchema,
    stringArrayPropertySchema,
  ])
  .refine(
    (property) =>
      (property.type !== "number" && property.type !== "integer") ||
      property.minimum === undefined ||
      property.maximum === undefined ||
      property.minimum <= property.maximum,
    { message: "minimum must not be greater than maximum" },
  );

export type CompanyEvalInputProperty = z.infer<typeof inputPropertySchema>;

export interface CompanyEvalInputSchema {
  type: "object";
  properties: Record<string, CompanyEvalInputProperty>;
  required: string[];
  additionalProperties: false;
}

/** Validates the input schema subset. The parsed value always has `additionalProperties: false`. */
export const companyEvalInputSchemaSchema = z
  .strictObject({
    type: z.literal("object"),
    properties: z.record(z.string().regex(PROPERTY_NAME_PATTERN), inputPropertySchema),
    required: z.array(z.string()).max(limits.maxProperties).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .superRefine((schema, ctx) => {
    const names = Object.keys(schema.properties);
    if (names.length < 1 || names.length > limits.maxProperties) {
      ctx.addIssue({
        code: "custom",
        path: ["properties"],
        message: `An input schema needs 1-${limits.maxProperties} properties.`,
      });
    }
    const required = schema.required ?? [];
    if (!allUnique(required)) {
      ctx.addIssue({ code: "custom", path: ["required"], message: "required names must be unique." });
    }
    for (const name of required) {
      if (!Object.hasOwn(schema.properties, name)) {
        ctx.addIssue({ code: "custom", path: ["required"], message: `required names an unknown property "${name}".` });
      }
    }
  })
  .transform(
    (schema): CompanyEvalInputSchema => ({
      type: "object",
      properties: schema.properties,
      required: [...(schema.required ?? [])].sort(),
      additionalProperties: false,
    }),
  );

// ---------------------------------------------------------------------------------------------
// Questions: the Jev questions of one version. Same shapes as `JudgeQuestion` in the server's
// judge client.
// ---------------------------------------------------------------------------------------------

const instructionsSchema = z.string().trim().min(1).max(limits.maxInstructionsLength);
const confidenceSchema = z.number().min(0).max(1);

const predicateQuestionSchema = z.strictObject({
  type: z.literal("predicate"),
  instructions: instructionsSchema,
  whenTrue: z.string().trim().min(1).max(limits.maxInstructionsLength).optional(),
  whenFalse: z.string().trim().min(1).max(limits.maxInstructionsLength).optional(),
  abstainBand: z
    .tuple([confidenceSchema, confidenceSchema])
    .refine(([low, high]) => low < high, { message: "abstainBand needs low < high" })
    .optional(),
});

const choiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: instructionsSchema,
  options: z
    .record(z.string().regex(OPTION_KEY_PATTERN), z.string().trim().min(1).max(limits.maxCriterionLength))
    .refine(
      (options) => {
        const count = Object.keys(options).length;
        return count >= limits.minChoiceOptions && count <= limits.maxChoiceOptions;
      },
      { message: `A choice question needs ${limits.minChoiceOptions}-${limits.maxChoiceOptions} options.` },
    ),
  minConfidence: confidenceSchema.optional(),
});

const scoreQuestionSchema = z.strictObject({
  type: z.literal("score"),
  instructions: instructionsSchema,
  levels: z
    .array(z.string().trim().min(1).max(limits.maxCriterionLength))
    .min(limits.minScoreLevels)
    .max(limits.maxScoreLevels),
  minConfidence: confidenceSchema.optional(),
});

export const companyEvalQuestionSchema = z.discriminatedUnion("type", [
  predicateQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);
export type CompanyEvalQuestion = z.infer<typeof companyEvalQuestionSchema>;

export const companyEvalQuestionsSchema = z
  .record(z.string().regex(QUESTION_ID_PATTERN), companyEvalQuestionSchema)
  .refine(
    (questions) => {
      const count = Object.keys(questions).length;
      return count >= 1 && count <= limits.maxQuestions;
    },
    { message: `An eval version needs 1-${limits.maxQuestions} questions.` },
  );
export type CompanyEvalQuestions = z.infer<typeof companyEvalQuestionsSchema>;

export const companyEvalDefinitionSchema = z.strictObject({
  inputSchema: companyEvalInputSchemaSchema,
  questions: companyEvalQuestionsSchema,
});
export type CompanyEvalDefinition = z.infer<typeof companyEvalDefinitionSchema>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const createCompanyEvalSchema = z.strictObject({
  slug: companyEvalSlugSchema,
  title: titleSchema,
  whenToUse: whenToUseSchema,
  inputSchema: companyEvalInputSchemaSchema,
  questions: companyEvalQuestionsSchema,
  changeNote: changeNoteSchema.optional(),
});
export type CreateCompanyEval = z.infer<typeof createCompanyEvalSchema>;

export const updateCompanyEvalSchema = z
  .strictObject({
    title: titleSchema.optional(),
    whenToUse: whenToUseSchema.optional(),
  })
  .refine((body) => body.title !== undefined || body.whenToUse !== undefined, {
    message: "Send at least one of title or whenToUse.",
  });
export type UpdateCompanyEval = z.infer<typeof updateCompanyEvalSchema>;

export const createCompanyEvalVersionSchema = z.strictObject({
  inputSchema: companyEvalInputSchemaSchema,
  questions: companyEvalQuestionsSchema,
  changeNote: changeNoteSchema.optional(),
});
export type CreateCompanyEvalVersion = z.infer<typeof createCompanyEvalVersionSchema>;

export const publishCompanyEvalSchema = z.strictObject({
  versionNumber: z.number().int().min(1).optional(),
});
export type PublishCompanyEval = z.infer<typeof publishCompanyEvalSchema>;

/**
 * The run body. `input` is checked by the service, not here, so that an input that is too large
 * or does not match the version's schema is recorded as a rejected run with its own `runId`.
 */
export const runCompanyEvalSchema = z
  .strictObject({
    input: z.unknown(),
    issueId: z.string().uuid().optional(),
    versionNumber: z.number().int().min(1).optional(),
    mode: z.literal("try_it").optional(),
  })
  .refine((body) => "input" in body, { message: "input is required.", path: ["input"] });
export type RunCompanyEval = z.infer<typeof runCompanyEvalSchema>;

export const putCompanyEvalFeedbackSchema = z.strictObject({
  questionId: z.string().regex(QUESTION_ID_PATTERN).optional(),
  verdict: z.enum(COMPANY_EVAL_FEEDBACK_VERDICTS),
  note: z.string().trim().min(1).max(limits.maxNoteLength).optional(),
});
export type PutCompanyEvalFeedback = z.infer<typeof putCompanyEvalFeedbackSchema>;

const pageLimitSchema = z.coerce.number().int().min(1).max(limits.maxPageSize).default(limits.defaultPageSize);
const cursorSchema = z.string().min(1).max(512).optional();
const isoDateSchema = z.string().datetime({ offset: true });

export const listCompanyEvalsQuerySchema = z.strictObject({
  status: z.enum(COMPANY_EVAL_STATUSES).optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema,
});
export type ListCompanyEvalsQuery = z.infer<typeof listCompanyEvalsQuerySchema>;

export const listCompanyEvalVersionsQuerySchema = z.strictObject({
  limit: pageLimitSchema,
  cursor: cursorSchema,
});
export type ListCompanyEvalVersionsQuery = z.infer<typeof listCompanyEvalVersionsQuerySchema>;

export const listCompanyEvalRunsQuerySchema = z.strictObject({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  versionNumber: z.coerce.number().int().min(1).optional(),
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  outcome: z.enum(COMPANY_EVAL_RUN_OUTCOMES).optional(),
  mode: z.enum(COMPANY_EVAL_RUN_MODES).optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema,
});
export type ListCompanyEvalRunsQuery = z.infer<typeof listCompanyEvalRunsQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export interface CompanyEvalPage<T> {
  items: T[];
  /** Pass as `cursor` to read the next page; null on the last page. */
  nextCursor: string | null;
}

export interface CompanyEvalPublishedVersionSummary {
  id: string;
  versionNumber: number;
  inputSchema: CompanyEvalInputSchema;
}

export interface CompanyEval {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  whenToUse: string;
  status: CompanyEvalStatus;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  latestVersionNumber: number;
  templateKey: string | null;
  templateVersion: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  archivedAt: string | null;
}

export interface CompanyEvalVersion {
  id: string;
  companyId: string;
  evalId: string;
  versionNumber: number;
  inputSchema: CompanyEvalInputSchema;
  questions: CompanyEvalQuestions;
  definitionHash: string;
  changeNote: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

/** Board view of one eval: its published and latest versions. */
export interface CompanyEvalDetail extends CompanyEval {
  publishedVersion: CompanyEvalVersion | null;
  latestVersion: CompanyEvalVersion | null;
}

/** Agent view of one eval: what it is for and what to send. Never the questions or drafts. */
export interface CompanyEvalAgentView {
  id: string;
  slug: string;
  title: string;
  whenToUse: string;
  publishedVersion: CompanyEvalPublishedVersionSummary;
}

export type CompanyEvalAnswer =
  | { type: "predicate"; probability: number | null; value: boolean | null; abstained: boolean }
  | {
      type: "choice";
      choice: string | null;
      probabilities: Record<string, number> | null;
      confidence: number | null;
      abstained: boolean;
    }
  | { type: "score"; score: number | null; confidence: number | null; abstained: boolean };

export interface CompanyEvalRunResult {
  runId: string;
  eval: { id: string; slug: string; versionId: string; versionNumber: number };
  outcome: Exclude<CompanyEvalRunOutcome, "rejected">;
  failureReason: CompanyEvalJudgeFailureReason | null;
  answers: Record<string, CompanyEvalAnswer> | null;
  cached: boolean;
  latencyMs: number;
  modelId: string | null;
  mode: CompanyEvalRunMode;
  /** Set on a `no_key` failure. */
  hint?: string;
}

export interface CompanyEvalInputIssue {
  /** JSON pointer into the input. Never the value. */
  path: string;
  message: string;
}

/** The body of a 422 on the run route. */
export interface CompanyEvalInputRejection {
  error: string;
  code: CompanyEvalInputErrorCode;
  runId: string;
  details: { errors: CompanyEvalInputIssue[] } | { maxInputBytes: number; inputBytes: number };
}

export interface CompanyEvalRun {
  id: string;
  companyId: string;
  evalId: string;
  versionId: string;
  versionNumber: number;
  callerType: CompanyEvalCallerType;
  callerAgentId: string | null;
  callerUserId: string | null;
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
  inputHash: string;
  inputRedacted: boolean;
  inputRedactionCount: number;
  inputBytes: number;
  /** The redacted input while it is retained; null after `inputExpiresAt` or when not stored. */
  input: unknown;
  inputExpiresAt: string | null;
  mode: CompanyEvalRunMode;
  outcome: CompanyEvalRunOutcome;
  failureReason: CompanyEvalFailureReason | null;
  answers: Record<string, CompanyEvalAnswer> | null;
  anyAbstained: boolean;
  cached: boolean;
  latencyMs: number;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  createdAt: string;
}

export interface CompanyEvalFeedback {
  id: string;
  companyId: string;
  runId: string;
  questionId: string | null;
  verdict: CompanyEvalFeedbackVerdict;
  note: string | null;
  authorType: CompanyEvalCallerType;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyEvalRunDetail extends CompanyEvalRun {
  feedback: CompanyEvalFeedback[];
}

/** Predicate answers carry `value` by one rule: true when P >= 0.5, false below, null on abstain. */
export function predicateValue(probability: number | null, abstained: boolean): boolean | null {
  if (abstained || probability === null) return null;
  return probability >= 0.5;
}

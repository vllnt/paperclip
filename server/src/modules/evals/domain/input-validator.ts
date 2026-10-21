import { Ajv } from "ajv";
import type { CompanyEvalInputIssue, CompanyEvalInputSchema } from "@paperclipai/shared";

const MAX_REPORTED_ISSUES = 20;

export type InputValidator = (input: unknown) => CompanyEvalInputIssue[];

/**
 * Compiles an input schema of the supported subset into a validator. An issue names the JSON
 * pointer and a fixed message. It never carries the value that failed.
 */
export function compileInputValidator(
  schema: CompanyEvalInputSchema,
  redactText: (text: string) => string,
): InputValidator {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  return (input) => {
    if (validate(input)) return [];
    const issues: CompanyEvalInputIssue[] = [];
    for (const error of validate.errors ?? []) {
      const extra =
        error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string"
          ? `: ${redactText(error.params.additionalProperty).slice(0, 80)}`
          : "";
      issues.push({ path: error.instancePath === "" ? "/" : error.instancePath, message: `${error.message ?? "is invalid"}${extra}` });
      if (issues.length >= MAX_REPORTED_ISSUES) break;
    }
    return issues;
  };
}

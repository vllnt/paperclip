import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodIssue, type ZodSchema } from "zod";
import { unprocessable } from "../errors.js";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}

// The issue create/update contract requires HTTP 422 (not the generic Zod 400)
// when a request pins an invalid executionWorkspaceSettings.workspaceStrategy
// .existingBranch: bad branch syntax, placement outside isolated_workspace +
// git_worktree, or combination with branchTemplate. All three semantic checks
// report this exact path suffix, including when an issue-creating route nests
// the settings (for example accepted-plan-decomposition children). Requests
// that also fail unrelated validation keep the long-standing 400.
const EXISTING_BRANCH_SETTINGS_PATH = [
  "executionWorkspaceSettings",
  "workspaceStrategy",
  "existingBranch",
] as const;

export function isExistingBranchSemanticsZodIssue(issue: Pick<ZodIssue, "path">): boolean {
  const pathOffset = issue.path.length - EXISTING_BRANCH_SETTINGS_PATH.length;
  return (
    pathOffset >= 0 &&
    EXISTING_BRANCH_SETTINGS_PATH.every((segment, index) => issue.path[pathOffset + index] === segment)
  );
}

// A goal title or success criteria over the length limit answers 422, the
// same status the goal service gives a plugin, so every caller sees one
// answer. Any other invalid field keeps the generic 400.
const GOAL_TEXT_FIELDS = new Set(["title", "successCriteria"]);

function isGoalTextTooLongZodIssue(issue: ZodIssue): boolean {
  return issue.code === "too_big" && issue.path.length === 1 && GOAL_TEXT_FIELDS.has(String(issue.path[0]));
}

export function validateGoalBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError && err.issues.length > 0 && err.issues.every(isGoalTextTooLongZodIssue)) {
        throw unprocessable("Validation error", err.issues);
      }
      throw err;
    }
    next();
  };
}

export function validateIssueMutationBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
    } catch (err) {
      if (
        err instanceof ZodError &&
        err.issues.length > 0 &&
        err.issues.every(isExistingBranchSemanticsZodIssue)
      ) {
        // Same body shape as the generic Zod 400 response, so the
        // field-specific details are preserved verbatim.
        throw unprocessable("Validation error", err.issues);
      }
      throw err;
    }
    next();
  };
}

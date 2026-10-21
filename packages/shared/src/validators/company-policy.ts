import { z } from "zod";
import {
  COMPANY_POLICY_BODY_MAX_LENGTH,
  COMPANY_POLICY_CHANGE_SUMMARY_MAX_LENGTH,
  COMPANY_POLICY_KEY_MAX_LENGTH,
  COMPANY_POLICY_SCOPES,
  COMPANY_POLICY_STATUSES,
  COMPANY_POLICY_SUMMARY_MAX_LENGTH,
  COMPANY_POLICY_TITLE_MAX_LENGTH,
} from "../constants.js";

export const companyPolicyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(COMPANY_POLICY_KEY_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "A policy key must be lowercase letters, numbers or -, and start with a letter or number");

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(COMPANY_POLICY_TITLE_MAX_LENGTH, `A policy title can be at most ${COMPANY_POLICY_TITLE_MAX_LENGTH} characters`);

const summarySchema = z
  .string()
  .trim()
  .max(COMPANY_POLICY_SUMMARY_MAX_LENGTH, `A policy summary can be at most ${COMPANY_POLICY_SUMMARY_MAX_LENGTH} characters`)
  .refine((value) => !/[\r\n]/.test(value), "A policy summary must be one line");

const bodySchema = z
  .string()
  .max(COMPANY_POLICY_BODY_MAX_LENGTH, `A policy body can be at most ${COMPANY_POLICY_BODY_MAX_LENGTH} characters`);

const ownerFields = {
  ownerAgentId: z.string().guid().optional().nullable(),
  ownerUserId: z.string().trim().min(1).optional().nullable(),
};

function ownerIsSingle(value: { ownerAgentId?: string | null; ownerUserId?: string | null }): boolean {
  return !(value.ownerAgentId && value.ownerUserId);
}

const singleOwnerMessage = { message: "A policy has one owner: set ownerAgentId or ownerUserId, not both", path: ["ownerUserId"] };

export const createCompanyPolicySchema = z
  .object({
    key: companyPolicyKeySchema,
    title: titleSchema,
    summary: summarySchema.optional().nullable(),
    body: bodySchema.optional().default(""),
    status: z.enum(COMPANY_POLICY_STATUSES).optional().default("draft"),
    /** Set for a project policy; omit or null for a company policy. */
    projectId: z.string().guid().optional().nullable(),
    ...ownerFields,
  })
  .strict()
  .refine(ownerIsSingle, singleOwnerMessage);

export type CreateCompanyPolicy = z.infer<typeof createCompanyPolicySchema>;

export const updateCompanyPolicySchema = z
  .object({
    title: titleSchema.optional(),
    summary: summarySchema.optional().nullable(),
    body: bodySchema.optional(),
    status: z.enum(COMPANY_POLICY_STATUSES).optional(),
    projectId: z.string().guid().optional().nullable(),
    ...ownerFields,
    /** Saved with the new revision when the title or body changes. */
    changeSummary: z.string().trim().max(COMPANY_POLICY_CHANGE_SUMMARY_MAX_LENGTH).optional().nullable(),
    /** The revision this edit started from. A newer revision on the server returns 409. */
    baseRevisionId: z.string().guid().optional().nullable(),
  })
  .strict()
  .refine(ownerIsSingle, singleOwnerMessage);

export type UpdateCompanyPolicy = z.infer<typeof updateCompanyPolicySchema>;

export const listCompanyPoliciesQuerySchema = z
  .object({
    scope: z.enum(COMPANY_POLICY_SCOPES).optional(),
    projectId: z.string().guid().optional(),
    status: z.enum(COMPANY_POLICY_STATUSES).optional(),
  });

export type ListCompanyPoliciesQuery = z.infer<typeof listCompanyPoliciesQuerySchema>;

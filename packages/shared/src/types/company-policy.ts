import type { CompanyPolicyStatus } from "../constants.js";

/**
 * A written rule or guardrail. A policy with no `projectId` applies to the whole company;
 * one with a `projectId` applies to that project's work. It is guidance for agents, not an
 * enforced setting: approvals, tool policies, the skill policy and budgets enforce rules.
 */
export interface CompanyPolicy {
  id: string;
  companyId: string;
  /** Null for a company policy. */
  projectId: string | null;
  /** Stable slug, unique in the company. Agents and documents reference it as `policy://<key>`. */
  key: string;
  title: string;
  /** One line shown in lists and to agents instead of the full body. */
  summary: string | null;
  /** Markdown. */
  body: string;
  status: CompanyPolicyStatus;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  documentId: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One saved version of a policy's title and body. */
export interface CompanyPolicyRevision {
  id: string;
  policyId: string;
  revisionNumber: number;
  title: string | null;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

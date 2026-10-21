import type { IssuePriority, IssueTriageCategory } from "@paperclipai/shared";
import { TRIAGE_NO_OWNER_KEY } from "./constants.js";
import type { TriageCandidateGroup } from "./types.js";

/** A pick-one question. The triage questions are all of this shape. */
export interface TriageChoiceQuestion {
  type: "choice";
  instructions: string;
  options: Readonly<Record<string, string>>;
}

const PRIORITY_OPTIONS: Readonly<Record<IssuePriority, string>> = {
  critical: "Production or customer work is broken or at risk now, data or money is being lost, or a hard deadline is within a day.",
  high: "Important work that blocks other work or has a near deadline, but nothing is on fire.",
  medium: "Normal planned work with no stated urgency.",
  low: "A nice to have, a cleanup, or work that can wait without cost.",
};

const CATEGORY_OPTIONS: Readonly<Record<IssueTriageCategory, string>> = {
  bug: "Something that exists is broken or behaves wrongly.",
  feature: "A new capability that does not exist yet.",
  improvement: "Make existing behavior better, faster or clearer.",
  maintenance: "Chores, refactors, upgrades or housekeeping.",
  docs: "Write or fix documentation.",
  research: "Investigate, analyze or recommend, with nothing to build.",
  ops: "Deploys, infrastructure, access, monitoring or other running of the system.",
  security: "Vulnerabilities, access control, secrets or audits.",
  other: "None of the other categories fits.",
};

export const PRIORITY_QUESTION: TriageChoiceQuestion = {
  type: "choice",
  instructions:
    "How urgent is this issue for the team that will do the work? Judge from the issue text only: the impact if it waits, " +
    "whether something is broken or blocked now, and any stated deadline. Most issues are medium.",
  options: PRIORITY_OPTIONS,
};

export const CATEGORY_QUESTION: TriageChoiceQuestion = {
  type: "choice",
  instructions: "Which kind of work is this issue? Pick the one that describes the main result asked for.",
  options: CATEGORY_OPTIONS,
};

export const PRIORITY_QUESTION_ID = "priority";
export const CATEGORY_QUESTION_ID = "category";

export function ownerQuestionId(page: number): string {
  return `owner_${page + 1}`;
}

/** How an owner option is shown to the model: the role and title only, never a name or id. */
export function describeGroup(group: Pick<TriageCandidateGroup, "role" | "title">): string {
  return group.title ? `Role: ${group.role}. Title: ${group.title}.` : `Role: ${group.role}.`;
}

/** The owner question for one page of candidate groups, plus the "no fit" option. */
export function ownerQuestion(groups: readonly TriageCandidateGroup[]): TriageChoiceQuestion {
  const options: Record<string, string> = {};
  for (const group of groups) options[group.key] = describeGroup(group);
  options[TRIAGE_NO_OWNER_KEY] =
    "No listed role is a clear fit for this issue; it needs a person or a role that is not listed.";
  return {
    type: "choice",
    instructions:
      "Which role should own this issue? Pick the option whose role and title best match the work asked for. " +
      "Choose none when no listed role is a clear fit.",
    options,
  };
}

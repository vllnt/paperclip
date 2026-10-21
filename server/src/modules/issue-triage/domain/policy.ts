import {
  ISSUE_PRIORITIES,
  ISSUE_TRIAGE_CATEGORIES,
  ISSUE_TRIAGE_MAX_MODEL_CALLS,
  ISSUE_TRIAGE_MIN_TITLE_WORDS,
  ISSUE_TRIAGE_THRESHOLDS,
  isRoutineRunIssueOriginKind,
  type IssuePriority,
  type IssueTriageApplyDecision,
  type IssueTriageCategory,
  type IssueTriageMode,
  type IssueTriageSkipReason,
} from "@paperclipai/shared";

/** Bump when a question or option text changes, so cached answers are not reused across rubrics. */
export const TRIAGE_RUBRIC_VERSION = "issue-triage-1";

/** Candidate agents offered to the model per issue. The rest are dropped by a deterministic ranking. */
export const MAX_OWNER_OPTIONS = 12;

const TITLE_MAX_CHARS = 300;
const DESCRIPTION_MAX_CHARS = 1_500;
const CAPABILITIES_MAX_CHARS = 160;
const DEFAULT_PRIORITY: IssuePriority = "medium";
const NO_OWNER_KEY = "none";

export interface TriageIssueFacts {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  status: string;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originKind: string;
}

export interface OwnerCandidate {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
}

export interface TriageQuestion {
  type: "choice";
  instructions: string;
  options: Readonly<Record<string, string>>;
}

export type TriageStateValue =
  | string
  | number
  | boolean
  | null
  | TriageStateValue[]
  | { [key: string]: TriageStateValue };

export interface TriageRequest {
  state: { [key: string]: TriageStateValue };
  questions: Readonly<Record<string, TriageQuestion>>;
  /** Maps the opaque option key sent for each candidate back to its agent id. */
  ownerKeys: ReadonlyMap<string, string>;
  /** The candidates offered to the model, in the order of their keys. */
  offered: readonly OwnerCandidate[];
}

export interface TriagePlan {
  skip: IssueTriageSkipReason | null;
  askPriority: boolean;
  askOwner: boolean;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Deterministic rules that run before any model call. An issue keeps its values when a routine
 * created it, and a title under three words is not sent. A priority other than the default was set
 * on purpose, so it is not asked about; an explicit assignee is not asked about either.
 */
export function planTriage(issue: TriageIssueFacts): TriagePlan {
  if (isRoutineRunIssueOriginKind(issue.originKind)) {
    return { skip: "routine_origin", askPriority: false, askOwner: false };
  }
  if (wordCount(issue.title) < ISSUE_TRIAGE_MIN_TITLE_WORDS) {
    return { skip: "short_title", askPriority: false, askOwner: false };
  }
  return {
    skip: null,
    askPriority: issue.priority === DEFAULT_PRIORITY,
    askOwner: issue.assigneeAgentId === null && issue.assigneeUserId === null,
  };
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/**
 * Keeps at most `MAX_OWNER_OPTIONS` candidates: the ones whose name, role, title and capabilities
 * share the most words with the issue. Ties break by name, then id, so the result is stable.
 * The kept candidates come back sorted by name then id, which keeps the model input stable.
 */
export function shortlistCandidates(
  issue: Pick<TriageIssueFacts, "title" | "description">,
  candidates: readonly OwnerCandidate[],
  max: number = MAX_OWNER_OPTIONS,
): OwnerCandidate[] {
  const byName = (a: OwnerCandidate, b: OwnerCandidate) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (candidates.length <= max) return [...candidates].sort(byName);
  const issueTokens = tokens(`${issue.title} ${(issue.description ?? "").slice(0, 500)}`);
  const scored = candidates.map((candidate) => {
    const own = tokens(`${candidate.name} ${candidate.role} ${candidate.title ?? ""} ${candidate.capabilities ?? ""}`);
    let overlap = 0;
    for (const token of own) if (issueTokens.has(token)) overlap += 1;
    return { candidate, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap || byName(a.candidate, b.candidate));
  return scored.slice(0, max).map((entry) => entry.candidate).sort(byName);
}

const PRIORITY_OPTIONS: Readonly<Record<IssuePriority, string>> = {
  critical: "Production is down, data or security is at risk, or everyone is blocked",
  high: "Important and time-sensitive; should start soon",
  medium: "Normal planned work",
  low: "Nice to have; can wait",
};

const CATEGORY_OPTIONS: Readonly<Record<IssueTriageCategory, string>> = {
  bug: "Something is broken or behaves wrongly",
  feature: "New capability or behaviour",
  chore: "Maintenance, refactor, dependency or cleanup work",
  docs: "Documentation or written guidance",
  research: "Investigation, analysis or a decision to prepare",
  ops: "Deployment, infrastructure, access or operations work",
  question: "A question or a request for information",
};

function describeCandidate(candidate: OwnerCandidate): string {
  const parts = [candidate.name, `role: ${candidate.role}`];
  if (candidate.title) parts.push(`title: ${candidate.title}`);
  if (candidate.capabilities) parts.push(`does: ${oneLine(candidate.capabilities, CAPABILITIES_MAX_CHARS)}`);
  return oneLine(parts.join("; "), 400);
}

/**
 * Builds the single model request for one issue: a category question always, a priority question and
 * an owner question when the rules ask for them. All of them travel in one call.
 */
export function buildTriageRequest(
  issue: TriageIssueFacts,
  plan: Pick<TriagePlan, "askPriority" | "askOwner">,
  candidates: readonly OwnerCandidate[],
): TriageRequest {
  const questions: Record<string, TriageQuestion> = {
    category: {
      type: "choice",
      instructions: "Which category best describes the work this issue asks for?",
      options: { ...CATEGORY_OPTIONS },
    },
  };
  if (plan.askPriority) {
    questions.priority = {
      type: "choice",
      instructions: "How urgent is this issue for the team that owns it?",
      options: { ...PRIORITY_OPTIONS },
    };
  }
  const offered = plan.askOwner ? shortlistCandidates(issue, candidates) : [];
  const ownerKeys = new Map<string, string>();
  if (offered.length > 0) {
    const options: Record<string, string> = {};
    offered.forEach((candidate, index) => {
      const key = `a${index + 1}`;
      ownerKeys.set(key, candidate.id);
      options[key] = describeCandidate(candidate);
    });
    options[NO_OWNER_KEY] = "No listed agent is a clear fit";
    questions.owner = {
      type: "choice",
      instructions: "Which agent should own this issue? Pick the one whose role and title match the work best.",
      options,
    };
  }
  return {
    state: {
      issue: {
        title: oneLine(issue.title, TITLE_MAX_CHARS),
        description: oneLine(issue.description ?? "", DESCRIPTION_MAX_CHARS),
      },
    },
    questions,
    ownerKeys,
    offered,
  };
}

export function parsePriority(choice: string | null): IssuePriority | null {
  return ISSUE_PRIORITIES.find((priority) => priority === choice) ?? null;
}

export function parseCategory(choice: string | null): IssueTriageCategory | null {
  return ISSUE_TRIAGE_CATEGORIES.find((category) => category === choice) ?? null;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface OwnerJudgement {
  suggestedAgentId: string | null;
  probabilities: Record<string, number> | null;
  topProbability: number | null;
  margin: number | null;
  decision: IssueTriageApplyDecision;
}

/**
 * Turns the model's owner answer into a suggestion and the apply decision. `applied` here means
 * "eligible": the caller still has to win the conditional write. Probabilities are re-keyed from the
 * opaque option keys to agent ids; `none` stays as it is.
 */
export function judgeOwner(input: {
  mode: IssueTriageMode;
  issueStatus: string;
  ownerKeys: ReadonlyMap<string, string>;
  choice: string | null;
  probabilities: Readonly<Record<string, number>> | null;
}): OwnerJudgement {
  const { ownerKeys } = input;
  const keyed: Record<string, number> = {};
  if (input.probabilities) {
    for (const [key, value] of Object.entries(input.probabilities)) {
      const id = ownerKeys.get(key) ?? (key === NO_OWNER_KEY ? NO_OWNER_KEY : null);
      if (id !== null && Number.isFinite(value)) keyed[id] = value;
    }
  }
  const ranked = Object.entries(keyed).sort((a, b) => b[1] - a[1]);
  const hasProbabilities = ranked.length > 0;
  const choiceId = input.choice === null ? null : (ownerKeys.get(input.choice) ?? null);
  const best = ranked[0];
  const topId = best ? best[0] : choiceId;
  const suggestedAgentId = topId !== null && topId !== NO_OWNER_KEY ? topId : null;
  const topProbability = suggestedAgentId !== null && hasProbabilities ? (keyed[suggestedAgentId] ?? null) : null;
  const next = ranked.find(([id]) => id !== suggestedAgentId);
  const margin =
    topProbability !== null ? round6(topProbability - (next ? next[1] : 0)) : null;
  const probabilities = hasProbabilities ? keyed : null;
  const base = { suggestedAgentId, probabilities, topProbability, margin };

  if (suggestedAgentId === null) return { ...base, decision: "no_owner_suggested" };
  if (input.mode !== "apply") return { ...base, decision: "mode_suggest" };
  if (input.issueStatus !== "todo") return { ...base, decision: "not_todo" };
  if (topProbability === null || margin === null) return { ...base, decision: "no_probabilities" };
  if (round6(topProbability) < ISSUE_TRIAGE_THRESHOLDS.ownerMinProbability) {
    return { ...base, decision: "below_probability" };
  }
  if (margin < ISSUE_TRIAGE_THRESHOLDS.ownerMinMargin) return { ...base, decision: "below_margin" };
  return { ...base, decision: "applied" };
}

/** Counts model calls for one issue and refuses the one that would pass the ceiling. */
export function createCallBudget(max: number = ISSUE_TRIAGE_MAX_MODEL_CALLS) {
  let used = 0;
  return {
    take(): boolean {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    used: () => used,
  };
}
export type CallBudget = ReturnType<typeof createCallBudget>;

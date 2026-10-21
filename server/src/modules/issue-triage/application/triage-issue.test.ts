import { describe, expect, it } from "vitest";
import type { IssueTriage, IssueTriageMode } from "@paperclipai/shared";
import { TRIAGE_MAX_MODEL_CALLS } from "../domain/constants.js";
import type { TriageCandidateAgent, TriageChoiceAnswer, TriageIssueFacts, TriageRecordDraft } from "../domain/types.js";
import type {
  IssueTriagePorts,
  TriageAssignmentResult,
  TriageModelFailureReason,
  TriageModelOutcome,
  TriageModelRequest,
} from "./ports.js";
import { createTriageIssue } from "./triage-issue.js";

const COMPANY = "company-1";
const REF = { id: "issue-1", companyId: COMPANY };

function issueFacts(overrides: Partial<TriageIssueFacts> = {}): TriageIssueFacts {
  return {
    id: REF.id,
    companyId: COMPANY,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    hidden: false,
    title: "Fix the login redirect loop",
    description: "Users bounce between two pages after signing in.",
    ...overrides,
  };
}

function agents(count: number): TriageCandidateAgent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(3, "0")}`,
    role: `role${index + 1}`,
    title: `Title ${index + 1}`,
    openIssues: 0,
  }));
}

type Scripted = (request: TriageModelRequest, call: number) => TriageModelOutcome;

interface Harness {
  run: ReturnType<typeof createTriageIssue>;
  asks: TriageModelRequest[];
  assignments: Array<{ companyId: string; issueId: string; agentId: string }>;
  saved: TriageRecordDraft[];
  activity: IssueTriage[];
  availabilityChecks: number;
}

function answer(probabilities: Record<string, number>, choice: string): TriageChoiceAnswer {
  return { choice, probabilities, abstained: false };
}

/**
 * Builds the ports around scripted model answers. `owner` returns the probabilities for an owner
 * question, from its option keys, so tests do not depend on how candidates are ranked.
 */
function harness(options: {
  mode?: IssueTriageMode;
  issue?: TriageIssueFacts | null;
  agents?: TriageCandidateAgent[];
  available?: boolean;
  existing?: boolean;
  model?: Scripted;
  assignment?: TriageAssignmentResult;
}): Harness {
  const asks: TriageModelRequest[] = [];
  const assignments: Harness["assignments"] = [];
  const saved: TriageRecordDraft[] = [];
  const activity: IssueTriage[] = [];
  const state = { availabilityChecks: 0 };
  const issue = options.issue === undefined ? issueFacts() : options.issue;

  const ports: IssueTriagePorts = {
    settings: { getMode: async () => options.mode ?? "apply" },
    issues: { load: async () => issue },
    agents: { listCandidates: async () => options.agents ?? agents(3) },
    model: {
      isAvailable: async () => {
        state.availabilityChecks += 1;
        return options.available ?? true;
      },
      ask: async (request) => {
        asks.push(request);
        const model = options.model ?? defaultModel();
        return model(request, asks.length - 1);
      },
    },
    records: {
      find: async () => (options.existing ? ({ id: "existing" } as IssueTriage) : null),
      save: async (companyId, issueId, draft) => {
        saved.push(draft);
        const triage = {
          id: "triage-1",
          companyId,
          issueId,
          ...draft,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        } as IssueTriage;
        return triage;
      },
    },
    assignment: {
      assignIfUnassignedTodo: async (input) => {
        assignments.push(input);
        return options.assignment ?? { applied: true };
      },
    },
    activity: { recorded: async ({ triage }) => void activity.push(triage) },
    text: { prepare: (input) => ({ title: input.title, description: input.description ?? "" }) },
    now: () => new Date("2026-01-01T00:00:00Z"),
  };

  const run = createTriageIssue(ports);
  return {
    run,
    asks,
    assignments,
    saved,
    activity,
    get availabilityChecks() {
      return state.availabilityChecks;
    },
  };
}

/** Everything is category bug, priority high, and the first owner option wins with 0.9. */
function defaultModel(ownerTop = 0.9): Scripted {
  return (request) => {
    const answers: Record<string, TriageChoiceAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (id === "category") answers[id] = answer({ bug: 0.9, feature: 0.1 }, "bug");
      else if (id === "priority") answers[id] = answer({ high: 0.7, medium: 0.2, low: 0.1 }, "high");
      else {
        const keys = Object.keys(question.options).filter((key) => key !== "none");
        const first = keys[0] as string;
        const probabilities: Record<string, number> = { none: 1 - ownerTop };
        for (const key of keys) probabilities[key] = key === first ? ownerTop : 0;
        answers[id] = answer(probabilities, first);
      }
    }
    return { ok: true, modelId: "typesafe-ai/jev", inputHash: `hash-${JSON.stringify(Object.keys(request.questions))}`, cached: false, answers };
  };
}

function failing(reason: TriageModelFailureReason, afterCalls = 0): Scripted {
  const ok = defaultModel();
  return (request, call) => (call < afterCalls ? ok(request, call) : { ok: false, reason, inputHash: `failed-${call}` });
}

describe("triage rules run before any model call", () => {
  it("does nothing when the company mode is off", async () => {
    const h = harness({ mode: "off" });
    expect(await h.run(REF)).toBe("off");
    expect(h.asks).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.availabilityChecks).toBe(0);
  });

  it("reports an issue that is not visible yet, so the caller can retry", async () => {
    const h = harness({ issue: null });
    expect(await h.run(REF)).toBe("not_visible");
    expect(h.asks).toHaveLength(0);
  });

  it("makes no call and no record for a routine-made issue", async () => {
    const h = harness({ issue: issueFacts({ originKind: "routine_execution" }) });
    expect(await h.run(REF)).toBe("ignored");
    expect(h.asks).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    expect(h.assignments).toHaveLength(0);
  });

  it("records a skip, without a model call, for a title under three words", async () => {
    const h = harness({ issue: issueFacts({ title: "Fix bug" }) });
    expect(await h.run(REF)).toBe("recorded");
    expect(h.asks).toHaveLength(0);
    expect(h.availabilityChecks).toBe(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ status: "skipped", reason: "short_title", modelCalls: 0 });
    expect(h.assignments).toHaveLength(0);
  });

  it("does not triage an issue twice", async () => {
    const h = harness({ existing: true });
    expect(await h.run(REF)).toBe("already_recorded");
    expect(h.asks).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it("records degraded no_key without a call when the company has no key", async () => {
    const h = harness({ available: false });
    expect(await h.run(REF)).toBe("recorded");
    expect(h.asks).toHaveLength(0);
    expect(h.saved[0]).toMatchObject({ status: "degraded", reason: "no_key", suggestedAssigneeAgentId: null });
    expect(h.assignments).toHaveLength(0);
  });

  it("asks only for what is still open: an explicit assignee and priority keep their values", async () => {
    const h = harness({ issue: issueFacts({ assigneeAgentId: "agent-9", priority: "high" }) });
    await h.run(REF);
    expect(h.asks).toHaveLength(1);
    expect(Object.keys(h.asks[0]?.questions ?? {})).toEqual(["category"]);
    expect(h.saved[0]).toMatchObject({ status: "scored", category: "bug", suggestedPriority: null, applyOutcome: "not_requested" });
    expect(h.assignments).toHaveLength(0);
  });

  it("sends the issue text and the role and title of the agents, and no ids", async () => {
    const h = harness({ agents: agents(2) });
    await h.run(REF);
    const request = h.asks[0];
    expect(request?.state).toEqual({
      issue: { title: "Fix the login redirect loop", description: "Users bounce between two pages after signing in." },
    });
    const owner = request?.questions.owner_1;
    expect(Object.values(owner?.options ?? {}).join(" ")).toContain("Role: role1. Title: Title 1.");
    // `companyId` routes the key and the cap in the judge client; only state and questions reach the model.
    const sent = JSON.stringify({ state: request?.state, questions: request?.questions });
    expect(sent).not.toContain("agent-001");
    expect(sent).not.toContain(COMPANY);
  });
});

describe("degraded results change nothing", () => {
  for (const reason of ["cap_exceeded", "timeout", "error"] as const) {
    it(`records degraded ${reason} and assigns nothing`, async () => {
      const h = harness({ model: failing(reason) });
      expect(await h.run(REF)).toBe("recorded");
      expect(h.saved[0]).toMatchObject({ status: "degraded", reason, suggestedAssigneeAgentId: null, appliedAt: null });
      expect(h.assignments).toHaveLength(0);
    });
  }

  it("records degraded and assigns nothing when a later page fails", async () => {
    const h = harness({ agents: agents(25), model: failing("timeout", 1) });
    await h.run(REF);
    expect(h.asks).toHaveLength(2);
    expect(h.saved[0]).toMatchObject({ status: "degraded", reason: "timeout", suggestedAssigneeAgentId: null, modelCalls: 2 });
    expect(h.saved[0]?.category).toBe("bug");
    expect(h.assignments).toHaveLength(0);
  });
});

describe("model call bound", () => {
  it("makes one call for a small company", async () => {
    const h = harness({ agents: agents(10) });
    await h.run(REF);
    expect(h.asks).toHaveLength(1);
    expect(h.saved[0]?.modelCalls).toBe(1);
  });

  it("pages ten options per call", async () => {
    const h = harness({ agents: agents(25) });
    await h.run(REF);
    expect(h.asks).toHaveLength(3);
    expect(Object.keys(h.asks[0]?.questions ?? {}).sort()).toEqual(["category", "owner_1", "priority"]);
    expect(Object.keys(h.asks[1]?.questions ?? {})).toEqual(["owner_2"]);
    expect(Object.keys(h.asks[2]?.questions ?? {})).toEqual(["owner_3"]);
  });

  it(`never makes more than ${TRIAGE_MAX_MODEL_CALLS} calls, however many agents there are`, async () => {
    const h = harness({ agents: agents(500) });
    await h.run(REF);
    expect(h.asks).toHaveLength(TRIAGE_MAX_MODEL_CALLS);
    expect(h.saved[0]?.modelCalls).toBe(TRIAGE_MAX_MODEL_CALLS);
    expect(h.saved[0]?.inputHashes.length).toBeLessThanOrEqual(TRIAGE_MAX_MODEL_CALLS);
  });

  it("makes one call when the company has no agent to offer", async () => {
    const h = harness({ agents: [] });
    await h.run(REF);
    expect(h.asks).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ status: "scored", suggestedAssigneeAgentId: null, applyOutcome: "no_suggestion" });
  });
});

describe("suggest mode", () => {
  it("records the suggestions and never assigns", async () => {
    const h = harness({ mode: "suggest" });
    await h.run(REF);
    expect(h.assignments).toHaveLength(0);
    expect(h.saved[0]).toMatchObject({
      status: "scored",
      mode: "suggest",
      suggestedPriority: "high",
      category: "bug",
      suggestedAssigneeAgentId: "agent-001",
      applyOutcome: "suggest_mode",
      appliedAt: null,
      modelId: "typesafe-ai/jev",
    });
    expect(h.saved[0]?.probabilities.priority).toEqual({ high: 0.7, medium: 0.2, low: 0.1 });
    expect(h.saved[0]?.probabilities.owner?.[0]).toMatchObject({ agentId: "agent-001", probability: 0.9 });
    expect(h.activity).toHaveLength(1);
  });
});

describe("apply mode", () => {
  it("assigns an unassigned todo when the top owner clears both thresholds", async () => {
    const h = harness({ mode: "apply", model: defaultModel(0.9) });
    await h.run(REF);
    expect(h.assignments).toEqual([{ companyId: COMPANY, issueId: REF.id, agentId: "agent-001" }]);
    expect(h.saved[0]).toMatchObject({
      applyOutcome: "applied",
      suggestedAssigneeAgentId: "agent-001",
      appliedAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("does not assign below the probability threshold", async () => {
    const h = harness({ mode: "apply", model: defaultModel(0.75) });
    await h.run(REF);
    expect(h.assignments).toHaveLength(0);
    expect(h.saved[0]).toMatchObject({ applyOutcome: "below_threshold", suggestedAssigneeAgentId: "agent-001", appliedAt: null });
  });

  it("does not assign when the lead over the next option is under 0.2", async () => {
    const model: Scripted = (request, call) => {
      const base = defaultModel()(request, call);
      if (!base.ok) return base;
      const owner = request.questions.owner_1;
      const keys = Object.keys(owner?.options ?? {});
      return {
        ...base,
        answers: { ...base.answers, owner_1: answer({ [keys[0] as string]: 0.85, [keys[1] as string]: 0.7, none: 0 }, keys[0] as string) },
      };
    };
    const h = harness({ mode: "apply", model });
    await h.run(REF);
    expect(h.assignments).toHaveLength(0);
    expect(h.saved[0]?.applyOutcome).toBe("narrow_margin");
  });

  it("does not assign an issue that is not todo", async () => {
    const h = harness({ mode: "apply", issue: issueFacts({ status: "backlog" }) });
    await h.run(REF);
    expect(h.assignments).toHaveLength(0);
    expect(h.saved[0]).toMatchObject({ applyOutcome: "not_unassigned_todo", suggestedAssigneeAgentId: "agent-001" });
  });

  it("never touches an assigned issue", async () => {
    for (const assigned of [{ assigneeAgentId: "agent-9" }, { assigneeUserId: "user-1" }]) {
      const h = harness({ mode: "apply", issue: issueFacts(assigned) });
      await h.run(REF);
      expect(h.assignments).toHaveLength(0);
      expect(h.saved[0]).toMatchObject({ applyOutcome: "not_requested", suggestedAssigneeAgentId: null });
    }
  });

  it("records the outcome when the guarded assignment loses a race", async () => {
    const h = harness({ mode: "apply", assignment: { applied: false, reason: "not_unassigned_todo" } });
    await h.run(REF);
    expect(h.assignments).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ applyOutcome: "not_unassigned_todo", appliedAt: null });
  });

  it("records an unavailable owner", async () => {
    const h = harness({ mode: "apply", assignment: { applied: false, reason: "owner_unavailable" } });
    await h.run(REF);
    expect(h.saved[0]).toMatchObject({ applyOutcome: "owner_unavailable", appliedAt: null });
  });

  it("only suggests a priority: the use case has no way to change one", async () => {
    const h = harness({ mode: "apply", issue: issueFacts({ priority: "medium" }) });
    await h.run(REF);
    expect(h.saved[0]?.suggestedPriority).toBe("high");
    expect(h.assignments.every((call) => Object.keys(call).sort().join() === "agentId,companyId,issueId")).toBe(true);
  });
});

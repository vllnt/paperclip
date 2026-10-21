import { describe, expect, it, vi } from "vitest";
import type { IssueTriageMode } from "@paperclipai/shared";
import type { OwnerCandidate, TriageIssueFacts } from "../domain/policy.js";
import { createTriageIssue } from "./triage-issue.js";
import { createListTriage } from "./list-triage.js";
import type {
  AssignOutcome,
  TriageModel,
  TriageModelOutcome,
  TriageModelRequest,
  TriageRecordInput,
  TriageRow,
  TriageStore,
  TriageWake,
} from "./ports.js";

function facts(overrides: Partial<TriageIssueFacts> = {}): TriageIssueFacts {
  return {
    id: "issue-1",
    companyId: "company-1",
    title: "Fix the login redirect loop",
    description: "Users bounce between two pages.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    ...overrides,
  };
}

const agents: OwnerCandidate[] = [
  { id: "agent-1", name: "Amy", role: "engineer", title: "Backend engineer", capabilities: null },
  { id: "agent-2", name: "Ben", role: "designer", title: null, capabilities: null },
];

function harness(options: {
  mode?: IssueTriageMode;
  issue?: TriageIssueFacts | null;
  candidates?: OwnerCandidate[];
  answers?: Record<string, { choice: string | null; probabilities: Record<string, number> | null }>;
  modelOutcome?: TriageModelOutcome;
  assign?: AssignOutcome;
  alreadyTriaged?: boolean;
}) {
  const recorded: TriageRecordInput[] = [];
  const asks: TriageModelRequest[] = [];
  const store: TriageStore = {
    getMode: async () => options.mode ?? "apply",
    loadIssue: async () => (options.issue === undefined ? facts() : options.issue),
    hasTriage: async () => options.alreadyTriaged ?? false,
    listOwnerCandidates: vi.fn(async () => options.candidates ?? agents),
    assignIfUnassignedTodo: vi.fn(async () => options.assign ?? { ok: true as const, status: "todo", statusVersion: 3 }),
    record: async (entry) => {
      recorded.push(entry);
    },
    listRecords: async () => [],
  };
  const model: TriageModel = {
    ask: vi.fn(async (request) => {
      asks.push(request);
      return (
        options.modelOutcome ?? {
          ok: true as const,
          modelId: "typesafe-ai/jev",
          inputHash: "hash-1",
          cached: false,
          answers: options.answers ?? {
            category: { choice: "bug", probabilities: { bug: 0.9, feature: 0.1 } },
            priority: { choice: "high", probabilities: { high: 0.7, medium: 0.3 } },
            owner: { choice: "a1", probabilities: { a1: 0.9, a2: 0.05, none: 0.05 } },
          },
        }
      );
    }),
  };
  const wake: TriageWake = { assigned: vi.fn(async () => {}) };
  const logger = { warn: vi.fn() };
  const run = createTriageIssue({ store, model, wake, logger });
  return { run, store, model, wake, recorded, asks, logger };
}

const ref = { id: "issue-1", companyId: "company-1" };

describe("triage rules come first", () => {
  it("does nothing when the mode is off", async () => {
    const h = harness({ mode: "off" });
    expect(await h.run(ref)).toEqual({ status: "off" });
    expect(h.model.ask).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
  });

  it("reports an issue that is not visible yet, without a model call", async () => {
    const h = harness({ issue: null });
    expect(await h.run(ref)).toEqual({ status: "not_visible" });
    expect(h.model.ask).not.toHaveBeenCalled();
  });

  it("does not triage an issue twice", async () => {
    const h = harness({ alreadyTriaged: true });
    expect(await h.run(ref)).toEqual({ status: "already_triaged" });
    expect(h.model.ask).not.toHaveBeenCalled();
  });

  it("records a routine-created issue as skipped and makes no model call", async () => {
    const h = harness({ issue: facts({ originKind: "routine_execution" }) });
    await h.run(ref);
    expect(h.model.ask).not.toHaveBeenCalled();
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({ outcome: "skipped", reason: "routine_origin", modelCalls: 0 });
  });

  it("records a short title as skipped and makes no model call", async () => {
    const h = harness({ issue: facts({ title: "Fix login" }) });
    await h.run(ref);
    expect(h.model.ask).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({ outcome: "skipped", reason: "short_title" });
  });
});

describe("model calls", () => {
  it("sends one request with every question and stays under the ceiling", async () => {
    const h = harness({});
    await h.run(ref);
    expect(h.asks).toHaveLength(1);
    expect(Object.keys(h.asks[0]?.questions ?? {}).sort()).toEqual(["category", "owner", "priority"]);
    expect(h.recorded[0]?.modelCalls).toBeLessThanOrEqual(6);
  });

  it("stays at one request and a shortlist even with hundreds of agents", async () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      role: "engineer",
      title: null,
      capabilities: null,
    }));
    const h = harness({ candidates: many });
    await h.run(ref);
    expect(h.asks).toHaveLength(1);
    expect(Object.keys(h.asks[0]?.questions.owner?.options ?? {}).length).toBeLessThanOrEqual(13);
  });

  it("asks only the category for an assigned issue with an explicit priority", async () => {
    const h = harness({
      issue: facts({ assigneeAgentId: "agent-9", priority: "high" }),
      answers: { category: { choice: "bug", probabilities: { bug: 1 } } },
    });
    await h.run(ref);
    expect(Object.keys(h.asks[0]?.questions ?? {})).toEqual(["category"]);
    expect(h.store.listOwnerCandidates).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({
      outcome: "suggested",
      owner: null,
      priority: { current: "high", suggested: null },
    });
  });
});

describe("degraded", () => {
  it.each(["no_key", "cap_exceeded", "timeout", "error"] as const)("records %s and changes nothing", async (reason) => {
    const h = harness({ modelOutcome: { ok: false, reason, inputHash: "h" } });
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.wake.assigned).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({ outcome: "degraded", reason, inputHashes: ["h"] });
  });
});

describe("suggest mode", () => {
  it("records the suggestion and never assigns", async () => {
    const h = harness({ mode: "suggest" });
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({
      outcome: "suggested",
      mode: "suggest",
      modelId: "typesafe-ai/jev",
      category: { suggested: "bug" },
      priority: { current: "medium", suggested: "high" },
      owner: { suggestedAgentId: "agent-1", suggestedAgentName: "Amy", decision: "mode_suggest", appliedAgentId: null },
    });
    expect(h.recorded[0]?.owner?.probabilities).toEqual({ "agent-1": 0.9, "agent-2": 0.05, none: 0.05 });
  });
});

describe("apply mode", () => {
  it("assigns an unassigned todo above both thresholds, wakes the agent and keeps the priority", async () => {
    const h = harness({});
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
    });
    expect(h.wake.assigned).toHaveBeenCalledWith({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      status: "todo",
      statusVersion: 3,
    });
    expect(h.recorded[0]).toMatchObject({
      outcome: "applied",
      owner: { decision: "applied", appliedAgentId: "agent-1" },
      priority: { current: "medium", suggested: "high" },
    });
  });

  it("never touches an assigned issue", async () => {
    const h = harness({ issue: facts({ assigneeAgentId: "agent-9" }) });
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.recorded[0]?.owner).toBeNull();
  });

  it("never assigns an issue that is not todo", async () => {
    const h = harness({ issue: facts({ status: "backlog" }) });
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({ outcome: "suggested", owner: { decision: "not_todo" } });
  });

  it("does not assign below the probability threshold", async () => {
    const h = harness({
      answers: {
        category: { choice: "bug", probabilities: null },
        priority: { choice: "medium", probabilities: null },
        owner: { choice: "a1", probabilities: { a1: 0.79, a2: 0.01, none: 0.2 } },
      },
    });
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.recorded[0]?.owner?.decision).toBe("below_probability");
  });

  it("does not assign below the margin threshold", async () => {
    const h = harness({
      answers: {
        category: { choice: "bug", probabilities: null },
        priority: { choice: "medium", probabilities: null },
        owner: { choice: "a1", probabilities: { a1: 0.85, a2: 0.7 } },
      },
    });
    await h.run(ref);
    expect(h.store.assignIfUnassignedTodo).not.toHaveBeenCalled();
    expect(h.recorded[0]?.owner?.decision).toBe("below_margin");
  });

  it("records the lost race when a person assigned the issue first", async () => {
    const h = harness({ assign: { ok: false, reason: "assignee_changed" } });
    await h.run(ref);
    expect(h.wake.assigned).not.toHaveBeenCalled();
    expect(h.recorded[0]).toMatchObject({
      outcome: "suggested",
      owner: { decision: "assignee_changed", appliedAgentId: null },
    });
  });

  it("keeps the assignment when the wake fails", async () => {
    const h = harness({});
    vi.mocked(h.wake.assigned).mockRejectedValueOnce(new Error("boom"));
    await h.run(ref);
    expect(h.recorded[0]?.outcome).toBe("applied");
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it("never changes the priority: the use case has no priority write", async () => {
    const h = harness({});
    await h.run(ref);
    expect(Object.keys(h.store).sort()).toEqual([
      "assignIfUnassignedTodo",
      "getMode",
      "hasTriage",
      "listOwnerCandidates",
      "listRecords",
      "loadIssue",
      "record",
    ]);
  });

  it("records no candidates when the company has no agent to offer", async () => {
    const h = harness({ candidates: [] });
    await h.run(ref);
    expect(h.recorded[0]).toMatchObject({ outcome: "suggested", owner: { decision: "no_candidates", candidateCount: 0 } });
    expect(Object.keys(h.asks[0]?.questions ?? {})).not.toContain("owner");
  });

  it("counts a cached answer as no model call", async () => {
    const h = harness({
      modelOutcome: {
        ok: true,
        modelId: "typesafe-ai/jev",
        inputHash: "h",
        cached: true,
        answers: { category: { choice: "bug", probabilities: null }, owner: { choice: "none", probabilities: null } },
      },
    });
    await h.run(ref);
    expect(h.recorded[0]?.modelCalls).toBe(0);
  });
});

describe("listTriage", () => {
  const entry = (n: number): TriageRow => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    createdAt: new Date(`2026-10-21T10:00:0${n}.000Z`),
    entry: {
      version: 1,
      issueId: "issue-1",
      companyId: "company-1",
      mode: "suggest",
      outcome: "suggested",
      reason: null,
      modelId: "typesafe-ai/jev",
      modelCalls: 1,
      inputHashes: ["h"],
      thresholds: { ownerMinProbability: 0.8, ownerMinMargin: 0.2 },
      priority: null,
      category: null,
      owner: null,
    },
  });

  function listStore(rows: TriageRow[]): TriageStore {
    const h = harness({});
    return {
      ...h.store,
      listRecords: vi.fn(async ({ limit, after }) =>
        rows
          .filter((row) => !after || row.createdAt < after.createdAt)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit),
      ),
    };
  }

  it("pages newest first with an opaque cursor", async () => {
    const list = createListTriage({ store: listStore([entry(1), entry(2), entry(3)]) });
    const first = await list({ companyId: "company-1", issueId: "issue-1", limit: 2 });
    expect(first.ok && first.page.items.map((item) => item.createdAt)).toEqual([
      "2026-10-21T10:00:03.000Z",
      "2026-10-21T10:00:02.000Z",
    ]);
    const cursor = first.ok ? first.page.nextCursor : null;
    expect(cursor).toBeTruthy();
    const second = await list({ companyId: "company-1", issueId: "issue-1", limit: 2, cursor });
    expect(second.ok && second.page.items.map((item) => item.createdAt)).toEqual(["2026-10-21T10:00:01.000Z"]);
    expect(second.ok && second.page.nextCursor).toBeNull();
  });

  it("rejects a cursor it did not produce", async () => {
    const list = createListTriage({ store: listStore([]) });
    expect(await list({ companyId: "company-1", issueId: "issue-1", cursor: "not-a-cursor" })).toEqual({
      ok: false,
      error: "invalid_cursor",
    });
  });
});

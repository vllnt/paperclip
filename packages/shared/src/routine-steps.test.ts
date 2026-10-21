import { describe, expect, it } from "vitest";
import {
  MAX_ROUTINE_STEPS,
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  evaluateRoutineStepRun,
  isRoutineRunIssueOriginKind,
  isRoutineStepRunStalled,
  orderRoutineStepsTopologically,
  readRoutineStepsRunPayload,
  routineStartingSteps,
  routineStepEdges,
  routineStepTemplateTexts,
  routineStepsHaveConditions,
  routineStepsSchema,
} from "./routine-steps.js";
import {
  createRoutineSchema,
  routineRevisionSnapshotSchema,
  runRoutineSchema,
  updateRoutineSchema,
} from "./validators/routine.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function step(key: string, after: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { key, title: `Step ${key}`, after, ...extra };
}

function issueMessages(input: unknown): string[] {
  const parsed = routineStepsSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("isRoutineRunIssueOriginKind", () => {
  it("is true for the root and the steps of a routine run and for nothing else", () => {
    expect(isRoutineRunIssueOriginKind("routine_execution")).toBe(true);
    expect(isRoutineRunIssueOriginKind("routine_step")).toBe(true);
    expect(isRoutineRunIssueOriginKind("manual")).toBe(false);
    expect(isRoutineRunIssueOriginKind("plugin:acme:operation")).toBe(false);
    expect(isRoutineRunIssueOriginKind(null)).toBe(false);
    expect(isRoutineRunIssueOriginKind(undefined)).toBe(false);
  });
});

describe("routineStepsSchema", () => {
  it("accepts a fork and join and defaults after to empty", () => {
    const parsed = routineStepsSchema.parse([
      { key: "build", title: "Build" },
      step("lint", ["build"]),
      step("types", ["build"]),
      step("ship", ["lint", "types"], { assigneeAgentId: AGENT_ID, priority: "high" }),
    ]);
    expect(parsed.map((entry) => entry.key)).toEqual(["build", "lint", "types", "ship"]);
    expect(parsed[0]?.after).toEqual([]);
    expect(parsed[3]).toMatchObject({ assigneeAgentId: AGENT_ID, priority: "high" });
  });

  it("rejects duplicate keys", () => {
    expect(issueMessages([step("a"), step("a")])).toContain('Duplicate step key "a"');
  });

  it("rejects an after entry that names no step", () => {
    expect(issueMessages([step("a", ["ghost"])])).toContain('Step "a" waits for unknown step "ghost"');
  });

  it("rejects a step that waits for itself", () => {
    expect(issueMessages([step("a", ["a"])])).toContain("A step cannot wait for itself");
  });

  it("rejects a cycle", () => {
    expect(issueMessages([step("a", ["c"]), step("b", ["a"]), step("c", ["b"])])).toContain(
      "Routine steps contain a cycle",
    );
  });

  it("rejects more than the step limit", () => {
    const many = Array.from({ length: MAX_ROUTINE_STEPS + 1 }, (_, index) => step(`s${index}`));
    expect(issueMessages(many).join(" ")).toContain(`at most ${MAX_ROUTINE_STEPS} steps`);
    expect(routineStepsSchema.safeParse(many.slice(0, MAX_ROUTINE_STEPS)).success).toBe(true);
  });

  it("accepts step keys and conditional entries in after, and nothing else", () => {
    const parsed = routineStepsSchema.parse([
      step("a"),
      step("b", [{ step: "a", when: "done" }]),
      step("c", [{ step: "a", when: "cancelled" }, "b"]),
    ]);
    expect(parsed[2]!.after).toEqual([{ step: "a", when: "cancelled" }, "b"]);
    expect(routineStepsSchema.safeParse([step("a"), step("b", [7])]).success).toBe(false);
    expect(routineStepsSchema.safeParse([step("a"), step("b", [{ step: "a" }])]).success).toBe(false);
    expect(routineStepsSchema.safeParse([step("a"), step("b", [{ step: "a", when: "failed" }])]).success).toBe(false);
    expect(
      routineStepsSchema.safeParse([step("a"), step("b", [{ step: "a", when: "done", extra: 1 }])]).success,
    ).toBe(false);
  });

  it("checks conditional entries like plain ones: unknown steps, the step itself and cycles", () => {
    expect(issueMessages([step("a"), step("b", [{ step: "x", when: "done" }])])).toContain(
      'Step "b" waits for unknown step "x"',
    );
    expect(issueMessages([step("a", [{ step: "a", when: "cancelled" }])])).toContain("A step cannot wait for itself");
    expect(issueMessages([step("a", [{ step: "b", when: "done" }]), step("b", ["a"])])).toContain(
      "Routine steps contain a cycle",
    );
  });

  it("rejects one predecessor named twice with different conditions and accepts a repeat of the same one", () => {
    expect(issueMessages([step("a"), step("b", ["a", { step: "a", when: "cancelled" }])])).toContain(
      'Step "b" waits for step "a" more than once with different conditions',
    );
    expect(
      issueMessages([step("a"), step("b", [{ step: "a", when: "done" }, { step: "a", when: "cancelled" }])]),
    ).toHaveLength(1);
    expect(issueMessages([step("a"), step("b", [{ step: "a", when: "done" }, { step: "a", when: "done" }])])).toEqual(
      [],
    );
    expect(issueMessages([step("a"), step("b", ["a", "a"])])).toEqual([]);
  });

  it("rejects an after list longer than the step limit", () => {
    const wide = [step("a"), step("b", Array.from({ length: MAX_ROUTINE_STEPS + 1 }, () => "a"))];
    expect(routineStepsSchema.safeParse(wide).success).toBe(false);
  });

  it.each(["Has Caps", "has space", "", "-leading", "x".repeat(41)])("rejects the key %j", (key) => {
    expect(routineStepsSchema.safeParse([step(key)]).success).toBe(false);
  });

  it("rejects unknown step fields", () => {
    expect(routineStepsSchema.safeParse([step("a", [], { surprise: true })]).success).toBe(false);
  });
});

describe("orderRoutineStepsTopologically", () => {
  it("places steps layer by layer, in written order within a layer", () => {
    const ordered = orderRoutineStepsTopologically([
      { key: "ship", after: ["lint", "types"] },
      { key: "lint", after: ["build"] },
      { key: "types", after: ["build"] },
      { key: "build", after: [] },
      { key: "docs", after: [] },
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(["build", "docs", "lint", "types", "ship"]);
  });

  it("places a step with a long chain behind a step written later", () => {
    const ordered = orderRoutineStepsTopologically([
      { key: "c", after: ["b"] },
      { key: "d", after: [] },
      { key: "b", after: ["a"] },
      { key: "a", after: [] },
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(["d", "a", "b", "c"]);
  });

  it("throws on an unknown key and on a cycle", () => {
    expect(() => orderRoutineStepsTopologically([{ key: "a", after: ["ghost"] }])).toThrow(/unknown step "ghost"/);
    expect(() =>
      orderRoutineStepsTopologically([
        { key: "a", after: ["b"] },
        { key: "b", after: ["a"] },
      ]),
    ).toThrow(/cycle/);
  });

  it("lists every step text that can hold a variable", () => {
    expect(
      routineStepTemplateTexts([
        { title: "Prepare {{target}}", description: "Look at {{target}}", acceptanceCriteria: ["{{target}} is ready"] },
        { title: "Ship", description: null },
        { title: "Wrap up" },
      ]),
    ).toEqual(["Prepare {{target}}", "Look at {{target}}", "{{target}} is ready", "Ship", "Wrap up"]);
    expect(routineStepTemplateTexts(undefined)).toEqual([]);
  });

  it("finds the steps that start a run", () => {
    expect(
      routineStartingSteps([
        { key: "a", after: [] },
        { key: "b", after: ["a"] },
        { key: "c", after: [] },
      ]).map((entry) => entry.key),
    ).toEqual(["a", "c"]);
  });
});

describe("isRoutineStepRunStalled", () => {
  const chain = [
    { key: "a", after: [] },
    { key: "b", after: ["a"] },
    { key: "c", after: ["b"] },
  ];
  const fork = [
    { key: "a", after: [] },
    { key: "b", after: ["a"] },
    { key: "c", after: ["a"] },
    { key: "d", after: ["b", "c"] },
  ];

  it("is stalled when a middle step was cancelled and the rest wait behind it", () => {
    expect(isRoutineStepRunStalled(chain, { a: "done", b: "cancelled", c: "blocked" })).toBe(true);
  });

  it("is stalled when the last step was cancelled and nothing waits", () => {
    expect(isRoutineStepRunStalled(chain, { a: "done", b: "done", c: "cancelled" })).toBe(true);
  });

  it("follows the wait through several blocked steps", () => {
    const longer = [...chain, { key: "d", after: ["c"] }];
    expect(isRoutineStepRunStalled(longer, { a: "done", b: "cancelled", c: "blocked", d: "blocked" })).toBe(true);
  });

  it.each(["todo", "in_progress", "in_review", "backlog"])("is live while a step is %s", (status) => {
    expect(isRoutineStepRunStalled(chain, { a: status, b: "cancelled", c: "blocked" })).toBe(false);
  });

  it("is live while one branch of a fork still runs although the other was cancelled", () => {
    expect(isRoutineStepRunStalled(fork, { a: "done", b: "cancelled", c: "in_progress", d: "blocked" })).toBe(false);
  });

  it("is stalled once the running branch of a fork finishes", () => {
    expect(isRoutineStepRunStalled(fork, { a: "done", b: "cancelled", c: "done", d: "blocked" })).toBe(true);
  });

  it("is live when no step was cancelled, even if every step is finished or blocked", () => {
    expect(isRoutineStepRunStalled(chain, { a: "done", b: "done", c: "done" })).toBe(false);
    expect(isRoutineStepRunStalled(chain, { a: "blocked", b: "blocked", c: "blocked" })).toBe(false);
  });

  it("is live when a blocked step has every predecessor done and is about to be woken", () => {
    expect(isRoutineStepRunStalled(fork, { a: "done", b: "done", c: "done", d: "blocked" })).toBe(false);
    const unrelated = [
      { key: "a", after: [] },
      { key: "b", after: [] },
      { key: "c", after: ["b"] },
    ];
    expect(isRoutineStepRunStalled(unrelated, { a: "cancelled", b: "done", c: "blocked" })).toBe(false);
  });

  it("is live when a step has no status or an unknown one, and when there are no steps", () => {
    expect(isRoutineStepRunStalled(chain, { a: "done", b: "cancelled" })).toBe(false);
    expect(isRoutineStepRunStalled(chain, { a: "done", b: "cancelled", c: "missing" })).toBe(false);
    expect(isRoutineStepRunStalled([], {})).toBe(false);
  });

  it("is not stalled when a cancel takes a conditional branch, and is stalled when nothing handles it", () => {
    const gated = [
      { key: "review", after: [] },
      { key: "merge", after: [{ step: "review", when: "done" as const }] },
      { key: "rework", after: [{ step: "review", when: "cancelled" as const }] },
    ];
    expect(isRoutineStepRunStalled(gated, { review: "cancelled", merge: "blocked", rework: "blocked" })).toBe(false);
    expect(isRoutineStepRunStalled(gated, { review: "cancelled", merge: "cancelled", rework: "done" })).toBe(false);
    const noRework = gated.slice(0, 2);
    expect(isRoutineStepRunStalled(noRework, { review: "cancelled", merge: "cancelled" })).toBe(false);
    const leaf = [...gated, { key: "notes", after: [] }];
    expect(
      isRoutineStepRunStalled(leaf, { review: "done", merge: "done", rework: "cancelled", notes: "cancelled" }),
    ).toBe(true);
  });
});

describe("evaluateRoutineStepRun", () => {
  const when = (step: string, outcome: "done" | "cancelled") => ({ step, when: outcome });
  const gated = [
    { key: "review", after: [] },
    { key: "merge", after: [when("review", "done")] },
    { key: "rework", after: [when("review", "cancelled")] },
    { key: "join", after: ["merge", "rework"] },
  ];

  it("changes nothing while the gated step is still open", () => {
    expect(
      evaluateRoutineStepRun(gated, { review: "in_review", merge: "blocked", rework: "blocked", join: "blocked" }),
    ).toEqual({ skip: [], release: {}, releaseFromRoot: [], stalled: false });
  });

  it("skips the rework branch when the gate is approved, and the join waits only for the merge", () => {
    const evaluation = evaluateRoutineStepRun(gated, {
      review: "done",
      merge: "blocked",
      rework: "blocked",
      join: "blocked",
    });
    expect(evaluation.skip).toEqual(["rework"]);
    expect(evaluation.release).toEqual({ join: ["rework"] });
    expect(evaluation.releaseFromRoot).toEqual(["rework"]);
    expect(evaluation.stalled).toBe(false);
  });

  it("takes the rework branch when the board cancels the gated step", () => {
    const evaluation = evaluateRoutineStepRun(gated, {
      review: "cancelled",
      merge: "blocked",
      rework: "blocked",
      join: "blocked",
    });
    expect(evaluation.skip).toEqual(["merge"]);
    expect(evaluation.release).toEqual({ rework: ["review"], join: ["merge"] });
    expect([...evaluation.releaseFromRoot].sort()).toEqual(["merge", "review"]);
    expect(evaluation.stalled).toBe(false);
  });

  it("is idempotent: once its changes are applied, evaluating again finds nothing more to do", () => {
    const first = evaluateRoutineStepRun(gated, { review: "done", merge: "blocked", rework: "blocked", join: "blocked" });
    expect(first.skip).toEqual(["rework"]);
    const again = evaluateRoutineStepRun(gated, { review: "done", merge: "blocked", rework: "cancelled", join: "blocked" });
    expect(again.skip).toEqual([]);
    expect(again.release).toEqual(first.release);
    expect(again.releaseFromRoot).toEqual(first.releaseFromRoot);
  });

  it("repeats the rule downstream: a step behind a skipped step is skipped too", () => {
    const chain = [
      { key: "review", after: [] },
      { key: "rework", after: [when("review", "cancelled")] },
      { key: "recheck", after: ["rework"] },
      { key: "report", after: ["recheck"] },
    ];
    const evaluation = evaluateRoutineStepRun(chain, {
      review: "done",
      rework: "blocked",
      recheck: "blocked",
      report: "blocked",
    });
    expect(evaluation.skip).toEqual(["rework", "recheck", "report"]);
    expect(evaluation.releaseFromRoot).toEqual(["rework", "recheck", "report"]);
  });

  it("keeps a plain edge from a cancelled step held: no cascade and no release", () => {
    const chain = [
      { key: "build", after: [] },
      { key: "test", after: ["build"] },
    ];
    const evaluation = evaluateRoutineStepRun(chain, { build: "cancelled", test: "blocked" });
    expect(evaluation).toEqual({ skip: [], release: {}, releaseFromRoot: [], stalled: true });
  });

  it("does not skip a step with one live edge left, and releases its dead edges", () => {
    const mixed = [
      { key: "a", after: [] },
      { key: "b", after: [] },
      { key: "c", after: [when("a", "done"), "b"] },
    ];
    const evaluation = evaluateRoutineStepRun(mixed, { a: "cancelled", b: "in_progress", c: "blocked" });
    expect(evaluation.skip).toEqual([]);
    expect(evaluation.release).toEqual({ c: ["a"] });
    expect(evaluation.releaseFromRoot).toEqual(["a"]);
    expect(evaluation.stalled).toBe(false);
  });

  it("does not skip a step someone already moved on, but releases its dead edges", () => {
    const evaluation = evaluateRoutineStepRun(gated, {
      review: "done",
      merge: "in_progress",
      rework: "todo",
      join: "blocked",
    });
    expect(evaluation.skip).toEqual([]);
    expect(evaluation.release).toEqual({});
    expect(evaluation.stalled).toBe(false);
  });

  it("never skips a step whose block a person owns, and counts it as live work", () => {
    const approved = evaluateRoutineStepRun(
      gated,
      { review: "done", merge: "blocked", rework: "blocked", join: "blocked" },
      { heldByPeople: new Set(["rework"]) },
    );
    expect(approved).toEqual({ skip: [], release: {}, releaseFromRoot: [], stalled: false });

    const chain = [
      { key: "build", after: [] },
      { key: "test", after: ["build"] },
    ];
    const statuses = { build: "cancelled", test: "blocked" };
    expect(evaluateRoutineStepRun(chain, statuses).stalled).toBe(true);
    expect(evaluateRoutineStepRun(chain, statuses, { heldByPeople: new Set(["test"]) }).stalled).toBe(false);
  });

  it("does not release a cancelled step from the root when one of its outgoing edges is plain", () => {
    const steps = [
      { key: "a", after: [] },
      { key: "b", after: [when("a", "cancelled")] },
      { key: "c", after: ["a"] },
    ];
    const evaluation = evaluateRoutineStepRun(steps, { a: "cancelled", b: "blocked", c: "blocked" });
    expect(evaluation.release).toEqual({ b: ["a"] });
    expect(evaluation.releaseFromRoot).toEqual([]);
    expect(evaluation.stalled).toBe(false);
    expect(evaluateRoutineStepRun(steps, { a: "cancelled", b: "done", c: "blocked" }).stalled).toBe(true);
  });

  it("changes nothing and keeps the run live when the recorded graph is not valid", () => {
    expect(evaluateRoutineStepRun([{ key: "a", after: ["x"] }], { a: "blocked" })).toEqual({
      skip: [],
      release: {},
      releaseFromRoot: [],
      stalled: false,
    });
  });

  it("reports whether a run has conditions and lists its edges", () => {
    expect(routineStepsHaveConditions(gated)).toBe(true);
    expect(routineStepsHaveConditions([{ after: ["a"] }, { after: [] }])).toBe(false);
    expect(routineStepEdges({ after: ["a", when("b", "cancelled"), "a"] })).toEqual([
      { step: "a", when: null },
      { step: "b", when: "cancelled" },
    ]);
  });
});

describe("routine schemas with steps", () => {
  const base = { title: "Release", assigneeAgentId: AGENT_ID };

  it("makes steps optional on create and update", () => {
    expect(createRoutineSchema.parse(base).steps).toBeUndefined();
    expect(updateRoutineSchema.parse({}).steps).toBeUndefined();
    expect(createRoutineSchema.parse({ ...base, steps: [step("a")] }).steps).toHaveLength(1);
    expect(updateRoutineSchema.parse({ steps: [] }).steps).toEqual([]);
  });

  it("rejects an invalid step list on create", () => {
    expect(createRoutineSchema.safeParse({ ...base, steps: [step("a", ["a"])] }).success).toBe(false);
  });

  it("keeps a snapshot without steps valid and accepts one with steps", () => {
    const routine = {
      id: AGENT_ID,
      companyId: AGENT_ID,
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title: "Release",
      description: null,
      assigneeAgentId: AGENT_ID,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      activityGatePolicy: "always",
      activityGateScope: "company",
      variables: [],
      env: null,
      responsibleUserId: null,
    };
    expect(routineRevisionSnapshotSchema.safeParse({ version: 1, routine, triggers: [] }).success).toBe(true);
    const withSteps = routineRevisionSnapshotSchema.safeParse({
      version: 1,
      routine: { ...routine, steps: [{ key: "a", title: "A", after: [] }] },
      triggers: [],
    });
    expect(withSteps.success).toBe(true);
  });
});

describe("readRoutineStepsRunPayload", () => {
  const recorded = {
    steps: [{ key: "a", title: "A", after: [] }],
    stepIssueIds: { a: "22222222-2222-4222-8222-222222222222" },
  };

  it("reads what a run recorded", () => {
    expect(readRoutineStepsRunPayload({ [ROUTINE_STEPS_RUN_PAYLOAD_KEY]: recorded })).toEqual(recorded);
  });

  it("returns null for a run without steps or with a malformed record", () => {
    expect(readRoutineStepsRunPayload(null)).toBeNull();
    expect(readRoutineStepsRunPayload({ variables: {} })).toBeNull();
    expect(readRoutineStepsRunPayload({ [ROUTINE_STEPS_RUN_PAYLOAD_KEY]: { steps: "nope" } })).toBeNull();
    expect(readRoutineStepsRunPayload("text")).toBeNull();
  });
});

describe("running a routine on a task", () => {
  it("accepts a task id and still accepts a run without one", () => {
    expect(runRoutineSchema.parse({ targetIssueId: AGENT_ID }).targetIssueId).toBe(AGENT_ID);
    expect(runRoutineSchema.parse({}).targetIssueId).toBeUndefined();
    expect(runRoutineSchema.parse({ targetIssueId: null }).targetIssueId).toBeNull();
  });

  it("refuses a target that is not a UUID", () => {
    expect(runRoutineSchema.safeParse({ targetIssueId: "PAP-12" }).success).toBe(false);
  });
});

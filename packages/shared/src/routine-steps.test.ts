import { describe, expect, it } from "vitest";
import {
  MAX_ROUTINE_STEPS,
  ROUTINE_STEPS_RUN_PAYLOAD_KEY,
  ROUTINE_STEP_CONDITIONS_UNSUPPORTED_MESSAGE,
  orderRoutineStepsTopologically,
  readRoutineStepsRunPayload,
  routineStartingSteps,
  routineStepTemplateTexts,
  routineStepsSchema,
} from "./routine-steps.js";
import { createRoutineSchema, routineRevisionSnapshotSchema, updateRoutineSchema } from "./validators/routine.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function step(key: string, after: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { key, title: `Step ${key}`, after, ...extra };
}

function issueMessages(input: unknown): string[] {
  const parsed = routineStepsSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

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

  it("rejects conditional after entries until conditions are supported", () => {
    expect(issueMessages([step("a"), step("b", [{ step: "a", when: "done" }])])).toContain(
      ROUTINE_STEP_CONDITIONS_UNSUPPORTED_MESSAGE,
    );
  });

  it.each(["Has Caps", "has space", "", "-leading", "x".repeat(41)])("rejects the key %j", (key) => {
    expect(routineStepsSchema.safeParse([step(key)]).success).toBe(false);
  });

  it("rejects unknown step fields", () => {
    expect(routineStepsSchema.safeParse([step("a", [], { surprise: true })]).success).toBe(false);
  });
});

describe("orderRoutineStepsTopologically", () => {
  it("puts every step after the steps it waits for and keeps written order otherwise", () => {
    const ordered = orderRoutineStepsTopologically([
      { key: "ship", after: ["lint", "types"] },
      { key: "lint", after: ["build"] },
      { key: "types", after: ["build"] },
      { key: "build", after: [] },
      { key: "docs", after: [] },
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(["build", "docs", "lint", "types", "ship"]);
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

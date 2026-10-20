import { describe, expect, it } from "vitest";
import type { RoutineStepWarning } from "@paperclipai/shared";
import {
  agentNameMap,
  describeStepWarning,
  stepWarningsHeading,
  stepWarningsToast,
} from "./routine-step-warnings";

const AGENT_ID = "3f0c5f6e-0000-4000-8000-000000000001";

function warning(overrides: Partial<RoutineStepWarning> = {}): RoutineStepWarning {
  return { code: "step_agent_unavailable", stepKey: "build", agentId: AGENT_ID, reason: "paused", ...overrides };
}

describe("describeStepWarning", () => {
  it("names the step, the agent and why it cannot start", () => {
    const names = agentNameMap([{ id: AGENT_ID, name: "Builder" }]);
    expect(describeStepWarning(warning(), names)).toBe("Step “build”: Builder is paused.");
    expect(describeStepWarning(warning({ reason: "pending_approval" }), names)).toBe(
      "Step “build”: Builder is waiting for approval.",
    );
    expect(describeStepWarning(warning({ reason: "not_invokable" }), names)).toContain("adapter");
  });

  it("falls back to a short agent ID and to the raw reason", () => {
    expect(describeStepWarning(warning())).toBe("Step “build”: agent 3f0c5f6e is paused.");
    expect(describeStepWarning(warning({ reason: "quota" }))).toContain("cannot run (quota)");
  });
});

describe("stepWarningsToast", () => {
  it("returns nothing when there are no warnings", () => {
    expect(stepWarningsToast(undefined)).toBeNull();
    expect(stepWarningsToast([])).toBeNull();
  });

  it("joins every warning into one warn toast", () => {
    const toast = stepWarningsToast([warning(), warning({ stepKey: "ship", reason: "error" })]);
    expect(toast?.tone).toBe("warn");
    expect(toast?.title).toBe("2 steps may not start");
    expect(toast?.body).toContain("Step “build”");
    expect(toast?.body).toContain("Step “ship”");
    expect(stepWarningsHeading([warning()])).toBe("1 step may not start");
  });
});

// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoutineListItem, RoutineStepWarning, RoutineVariable } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError } from "@/api/client";
import {
  RunRoutineOnIssueDialog,
  enteredVariableValues,
  routinesWithSteps,
  runOnIssueErrorMessage,
  variablesToAsk,
} from "./RunRoutineOnIssueDialog";

const { list, runOnIssue, agentsList, pushToast } = vi.hoisted(() => ({
  list: vi.fn(),
  runOnIssue: vi.fn(),
  agentsList: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("@/api/routines", () => ({ routinesApi: { list, runOnIssue } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: agentsList } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE = { id: "44444444-4444-4444-8444-444444444444", identifier: "PC-12", title: "Fix the login bug" };
const STEP = { key: "build", title: "Build" };

function routine(overrides: Partial<RoutineListItem>): RoutineListItem {
  return { id: "r", title: "Routine", status: "active", steps: [], ...overrides } as unknown as RoutineListItem;
}

function variable(overrides: Partial<RoutineVariable>): RoutineVariable {
  return { name: "target", label: null, type: "text", defaultValue: null, required: true, options: [], ...overrides };
}

const ROUTINES = [
  routine({ id: "r-plain", title: "Plain routine" }),
  routine({ id: "r-release", title: "Release", steps: [STEP, { ...STEP, key: "ship", after: ["build"] }] as never }),
  routine({ id: "r-paused", title: "Paused review", status: "paused", steps: [STEP] as never }),
  routine({ id: "r-old", title: "Archived flow", status: "archived", steps: [STEP] as never }),
  routine({
    id: "r-vars",
    title: "Deploy",
    steps: [STEP] as never,
    variables: [
      variable({ name: "environment", label: "Target environment" }),
      variable({ name: "replicas", type: "number" }),
      variable({ name: "region", defaultValue: "eu" }),
      variable({ name: "note", required: false }),
      variable({ name: "date" }),
    ],
  }),
];

let root: Root;
let container: HTMLDivElement;
let onOpenChange: Mock<(open: boolean) => void>;
let onStarted: Mock<() => void>;

async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RunRoutineOnIssueDialog
          open
          onOpenChange={onOpenChange}
          companyId={COMPANY_ID}
          issue={ISSUE}
          onStarted={onStarted}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dialogButton(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}"`);
  return match as HTMLButtonElement;
}

/** Click "Run routine" and let react-query deliver the mutation result (it notifies on a timer). */
async function submit() {
  await act(async () => dialogButton("Run routine").click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function choose(title: string) {
  const match = [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) =>
    item.textContent?.includes(title),
  );
  if (!match) throw new Error(`No routine "${title}"`);
  return act(async () => match.click());
}

/** Type into a text or number input the way a user does, so React sees the change. */
async function typeInto(selector: string, text: string) {
  const input = document.body.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`No field ${selector}`);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list.mockReset().mockResolvedValue(ROUTINES);
  runOnIssue.mockReset();
  agentsList.mockReset().mockResolvedValue([{ id: "a1", name: "Builder" }]);
  pushToast.mockReset();
  onOpenChange = vi.fn<(open: boolean) => void>();
  onStarted = vi.fn<() => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("routinesWithSteps", () => {
  it("keeps only routines that have steps and are not archived", () => {
    expect(routinesWithSteps(ROUTINES).map((item) => item.id)).toEqual(["r-release", "r-paused", "r-vars"]);
    expect(routinesWithSteps(undefined)).toEqual([]);
  });
});

describe("RunRoutineOnIssueDialog", () => {
  it("lists the routines with steps and runs the chosen one on the task", async () => {
    runOnIssue.mockResolvedValue({ id: "run-1", warnings: [] });
    await renderDialog();

    expect(document.body.textContent).toContain("Release");
    expect(document.body.textContent).toContain("2 steps");
    expect(document.body.textContent).toContain("Paused review");
    expect(document.body.textContent).toContain("1 step · paused");
    expect(document.body.textContent).not.toContain("Plain routine");
    expect(document.body.textContent).not.toContain("Archived flow");
    expect(dialogButton("Run routine").disabled).toBe(true);

    await choose("Release");
    await submit();

    expect(runOnIssue).toHaveBeenCalledWith("r-release", ISSUE.id, {});
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Routine started on this task" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the server's 409 explanation inline and lets the board pick again", async () => {
    runOnIssue.mockRejectedValueOnce(
      new ApiError("This task is in progress. Steps can only be attached to a backlog, todo or blocked task.", 409, null),
    );
    await renderDialog();
    await choose("Release");
    await submit();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("in progress");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();

    await choose("Paused review");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the dialog open to show the step warnings after a successful run", async () => {
    const warnings: RoutineStepWarning[] = [
      { code: "step_agent_unavailable", stepKey: "build", agentId: "a1", reason: "paused" },
    ];
    runOnIssue.mockResolvedValue({ id: "run-1", warnings });
    await renderDialog();
    await choose("Release");
    await submit();

    const status = document.body.querySelector('[aria-label="Step warnings"]');
    expect(status?.textContent).toContain("Step “build”: Builder is paused.");
    expect(status?.textContent).toContain("The run started.");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);

    await act(async () => dialogButton("Done").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks for the required variables and runs with the typed values", async () => {
    runOnIssue.mockResolvedValue({ id: "run-1", warnings: [] });
    await renderDialog();
    await choose("Deploy");

    expect(document.body.textContent).toContain("Target environment");
    expect(document.body.querySelector("#run-on-task-variable-environment")).not.toBeNull();
    expect(document.body.querySelector("#run-on-task-variable-replicas")).not.toBeNull();
    expect(document.body.querySelector("#run-on-task-variable-region")).toBeNull();
    expect(document.body.querySelector("#run-on-task-variable-note")).toBeNull();
    expect(document.body.querySelector("#run-on-task-variable-date")).toBeNull();
    expect(dialogButton("Run routine").disabled).toBe(true);

    await typeInto("#run-on-task-variable-environment", "staging");
    expect(dialogButton("Run routine").disabled).toBe(true);
    await typeInto("#run-on-task-variable-replicas", "3");
    expect(dialogButton("Run routine").disabled).toBe(false);

    await submit();
    expect(runOnIssue).toHaveBeenCalledWith("r-vars", ISSUE.id, { environment: "staging", replicas: 3 });
  });

  it("clears the entered values when another routine is chosen", async () => {
    await renderDialog();
    await choose("Deploy");
    await typeInto("#run-on-task-variable-environment", "staging");
    await choose("Release");
    expect(document.body.querySelector("#run-on-task-variable-environment")).toBeNull();
    await choose("Deploy");
    const field = document.body.querySelector<HTMLInputElement>("#run-on-task-variable-environment");
    expect(field?.value).toBe("");
  });

  it("points to the routine page when no routine has steps", async () => {
    list.mockResolvedValue([routine({ id: "r-plain", title: "Plain routine" })]);
    await renderDialog();
    expect(document.body.textContent).toContain("No routine has steps yet");
    expect(document.body.querySelector('a[href="/routines"]')).not.toBeNull();
    expect(dialogButton("Run routine").disabled).toBe(true);
  });
});

describe("variablesToAsk", () => {
  it("asks only for required variables without a default that Paperclip does not fill in", () => {
    const deploy = ROUTINES.find((item) => item.id === "r-vars");
    expect(variablesToAsk(deploy).map((item) => item.name)).toEqual(["environment", "replicas"]);
    expect(variablesToAsk(undefined)).toEqual([]);
    expect(
      variablesToAsk(routine({ variables: [variable({ name: "branch", defaultValue: "   " })] })).map((item) => item.name),
    ).toEqual(["branch"]);
  });
});

describe("enteredVariableValues", () => {
  it("sends numbers and booleans in their own type and leaves blanks out", () => {
    const variables = [
      variable({ name: "count", type: "number" }),
      variable({ name: "dry", type: "boolean" }),
      variable({ name: "name" }),
      variable({ name: "empty" }),
      variable({ name: "bad", type: "number" }),
    ];
    expect(enteredVariableValues(variables, { count: "4", dry: "false", name: "x", empty: "  ", bad: "abc" })).toEqual({
      count: 4,
      dry: false,
      name: "x",
    });
  });
});

describe("runOnIssueErrorMessage", () => {
  it("prefers the server message and falls back to a plain sentence", () => {
    expect(runOnIssueErrorMessage(new ApiError("Routine has no steps", 422, null))).toBe("Routine has no steps");
    expect(runOnIssueErrorMessage("boom")).toBe("Paperclip could not attach the routine to this task.");
  });
});

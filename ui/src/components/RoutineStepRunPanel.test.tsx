// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineStepRun } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { ToastProvider } from "../context/ToastContext";
import { RoutineStepRunPanel } from "./RoutineStepRunPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    routineStep: vi.fn(),
    sendBackRoutineStep: vi.fn(),
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const QA_ID = "33333333-3333-4333-8333-333333333333";
const IMPLEMENT_ID = "11111111-1111-4111-8111-111111111111";

function stepRun(overrides: Partial<RoutineStepRun> = {}): RoutineStepRun {
  return {
    routineId: "routine-1",
    routineRunId: "run-1",
    rootIssueId: "root-1",
    stepKey: "qa",
    steps: [
      { key: "implement", issueId: IMPLEMENT_ID, identifier: "PAP-11", title: "Implement the change", status: "done" },
      { key: "qa", issueId: QA_ID, identifier: "PAP-12", title: "Check the change", status: "in_progress" },
    ],
    sendBackTo: [{ stepKey: "implement", issueId: IMPLEMENT_ID, rounds: 1, maxSendBacks: 2 }],
    sendBacks: [
      {
        fromStepKey: "qa",
        toStepKey: "implement",
        actorType: "agent",
        actorId: "agent-1",
        commentId: null,
        at: new Date().toISOString(),
        outcome: "sent_back",
      },
    ],
    ...overrides,
  };
}

describe("RoutineStepRunPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(onSentBack = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <ToastProvider>
          <QueryClientProvider client={client}>
            <RoutineStepRunPanel issueId={QA_ID} companyId="company-1" onSentBack={onSentBack} />
          </QueryClientProvider>
        </ToastProvider>,
      );
    });
    await settle();
    return onSentBack;
  }

  /** Lets the query and mutation promises resolve and React commit what they changed. */
  async function settle() {
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function typeComment(text: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submit(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  }

  it("shows the steps of the run, the send-backs and the rounds left", async () => {
    vi.mocked(issuesApi.routineStep).mockResolvedValue(stepRun());
    await render();

    const steps = [...container.querySelectorAll('ol[aria-label="Steps of this run"] li')];
    expect(steps.map((item) => item.textContent)).toEqual(["DoneimplementImplement the change", "In ProgressqaCheck the changeThis step"]);
    expect(container.querySelector(`a[href="/issues/PAP-11"]`)?.textContent).toBe("Implement the change");
    expect(container.querySelector('ul[aria-label="Send-backs of this run"]')?.textContent).toContain(
      "qasent work back toimplement· by its agent",
    );
    expect(container.textContent).toContain("its agent has used 1 of 2 rounds");
  });

  it("sends the work back with the comment and tells the page", async () => {
    vi.mocked(issuesApi.routineStep).mockResolvedValue(stepRun());
    vi.mocked(issuesApi.sendBackRoutineStep).mockResolvedValue({
      outcome: "sent_back",
      routineRunId: "run-1",
      fromStepKey: "qa",
      toStepKey: "implement",
      fromIssueId: QA_ID,
      toIssueId: IMPLEMENT_ID,
      rounds: 0,
      maxSendBacks: 2,
      reblockedIssueIds: [QA_ID],
      commentId: "comment-1",
    });
    const onSentBack = await render();

    expect(submit().disabled).toBe(true);
    await act(async () => typeComment("  Handle the empty response.  "));
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    await settle();

    expect(issuesApi.sendBackRoutineStep).toHaveBeenCalledWith(QA_ID, {
      toStepKey: "implement",
      comment: "Handle the empty response.",
    });
    expect(onSentBack).toHaveBeenCalledTimes(1);
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("shows why the server refused a send-back", async () => {
    vi.mocked(issuesApi.routineStep).mockResolvedValue(stepRun());
    vi.mocked(issuesApi.sendBackRoutineStep).mockRejectedValue(
      new ApiError('Step "implement" is todo; work can only be sent back over finished steps', 409, {}),
    );
    const onSentBack = await render();

    await act(async () => typeComment("Again"));
    await act(async () => submit().click());
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Step "implement" is todo; work can only be sent back over finished steps',
    );
    expect(onSentBack).not.toHaveBeenCalled();
  });

  it("offers no form to a step that cannot send work back", async () => {
    vi.mocked(issuesApi.routineStep).mockResolvedValue(stepRun({ stepKey: "implement", sendBackTo: [], sendBacks: [] }));
    await render();

    expect(container.querySelector('ol[aria-label="Steps of this run"]')).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('ul[aria-label="Send-backs of this run"]')).toBeNull();
  });
});

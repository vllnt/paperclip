// @vitest-environment jsdom

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutinesProps } from "./Routines";
import { AgentRoutinesTab } from "./AgentRoutinesTab";

const routinesRenderMock = vi.fn((props: RoutinesProps) => props);
const routinesMountMock = vi.fn((agentId: string | undefined) => agentId);

vi.mock("./Routines", () => ({
  Routines: (props: RoutinesProps) => {
    routinesRenderMock(props);
    useEffect(() => {
      routinesMountMock(props.fixedAssigneeAgentId);
    }, []);
    return <div data-testid="routines-list" />;
  },
}));

describe("AgentRoutinesTab", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function render(element: React.ReactNode) {
    root = createRoot(container);
    flushSync(() => root!.render(element));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    routinesRenderMock.mockClear();
    routinesMountMock.mockClear();
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("embeds the routine list fixed to the agent", () => {
    render(<AgentRoutinesTab agentId="agent-ceo" />);
    expect(container.querySelector('[data-testid="routines-list"]')).toBeTruthy();
    expect(routinesRenderMock).toHaveBeenLastCalledWith({
      embedded: true,
      fixedAssigneeAgentId: "agent-ceo",
      excludeRoutineIds: undefined,
    });
  });

  it("starts a fresh list for another agent, so no rows, draft or selection carry over", () => {
    render(<AgentRoutinesTab agentId="agent-a" />);
    flushSync(() => root!.render(<AgentRoutinesTab agentId="agent-b" />));
    expect(routinesMountMock.mock.calls.map(([agentId]) => agentId)).toEqual(["agent-a", "agent-b"]);
  });

  it("puts a built-in agent's managed routine above the list and keeps it out of the list", () => {
    render(
      <AgentRoutinesTab
        agentId="agent-coach"
        managedRoutineId="routine-managed"
        builtInRoutine={<section aria-label="Built-in routine">Recent agent reflection</section>}
      />,
    );
    const builtIn = container.querySelector('[aria-label="Built-in routine"]');
    const list = container.querySelector('[data-testid="routines-list"]');
    expect(builtIn?.textContent).toBe("Recent agent reflection");
    expect(builtIn && list && builtIn.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(routinesRenderMock).toHaveBeenLastCalledWith({
      embedded: true,
      fixedAssigneeAgentId: "agent-coach",
      excludeRoutineIds: ["routine-managed"],
    });
  });
});

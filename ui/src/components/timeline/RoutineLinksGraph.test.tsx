// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { RoutineTimelineEdge, RoutineTimelineNode } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineLinksGraph, describeEdge, nodeHref } from "./RoutineLinksGraph";

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
}));

function node(overrides: Partial<RoutineTimelineNode> & Pick<RoutineTimelineNode, "id" | "kind" | "label">): RoutineTimelineNode {
  return { refId: overrides.id.split(":").at(-1)!, parentId: null, status: null, ...overrides };
}

function edge(overrides: Partial<RoutineTimelineEdge> & Pick<RoutineTimelineEdge, "id" | "kind" | "from" | "to">): RoutineTimelineEdge {
  return { label: null, enabled: true, triggerId: null, issueId: null, runId: null, ...overrides };
}

const nodes: RoutineTimelineNode[] = [
  node({ id: "event_source:s1", kind: "event_source", label: "Inbound mail" }),
  node({ id: "routine:r1", kind: "routine", label: "Triage", status: "active" }),
  node({ id: "routine:r2", kind: "routine", label: "Follow up", status: "paused" }),
  node({ id: "routine:r3", kind: "routine", label: "Lonely", status: "active" }),
  node({ id: "step:r1:a", kind: "step", label: "Read", parentId: "routine:r1" }),
  node({ id: "step:r1:b", kind: "step", label: "Reply", parentId: "routine:r1" }),
  node({ id: "goal:g1", kind: "goal", label: "Answer fast" }),
];

const edges: RoutineTimelineEdge[] = [
  edge({ id: "e1", kind: "event_trigger", from: "event_source:s1", to: "routine:r1", label: "kind: mail", enabled: false }),
  edge({ id: "e2", kind: "step_after", from: "step:r1:a", to: "step:r1:b" }),
  edge({ id: "e3", kind: "targets_issue", from: "routine:r1", to: "routine:r2", issueId: "i1", runId: "run-1" }),
  edge({ id: "e4", kind: "serves_goal", from: "routine:r1", to: "goal:g1" }),
];

describe("RoutineLinksGraph", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(n = nodes, e = edges) {
    flushSync(() => root.render(<RoutineLinksGraph nodes={n} edges={e} />));
  }

  it("draws a box per routine, event source and goal, and a curve per link", () => {
    render();
    expect(container.querySelectorAll('[data-testid="routine-link-node-routine"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="routine-link-node-event_source"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="routine-link-node-goal"]')).toHaveLength(1);
    for (const kind of ["event_trigger", "step_after", "targets_issue", "serves_goal"]) {
      expect(container.querySelectorAll(`[data-testid="routine-link-edge-${kind}"]`)).toHaveLength(1);
    }
  });

  it("draws a step edge and every edge label above the boxes, so a box's fill does not hide them", () => {
    render();
    const graph = container.querySelector('svg[aria-label="Links between routines"]')!;
    const triage = graph.querySelector('[aria-label="Routine Triage"]')!;
    const follows = (earlier: Element, later: Element) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(triage, graph.querySelector('[data-testid="routine-link-edge-step_after"]')!)).toBe(true);
    expect(follows(triage, graph.querySelector('[data-testid="routine-link-edge-label"]')!)).toBe(true);
    // The links between two boxes stay under the boxes.
    expect(follows(graph.querySelector('[data-testid="routine-link-edge-event_trigger"]')!, triage)).toBe(true);
  });

  it("cuts a long edge label to fit the gap and keeps the whole label in the tooltip", () => {
    const longLabel = "type: issue.created, issue.updated";
    render(nodes, [edge({ id: "e1", kind: "event_trigger", from: "event_source:s1", to: "routine:r1", label: longLabel })]);
    const text = container.querySelector('[data-testid="routine-link-edge-label"]')!.textContent!;
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text.endsWith("…")).toBe(true);
    expect(container.querySelector('[data-testid="routine-link-edge-event_trigger"] title')?.textContent).toContain(longLabel);
  });

  it("lists the steps inside their routine and groups routines without a link apart", () => {
    render();
    expect(container.textContent).toContain("Read");
    expect(container.textContent).toContain("Reply");
    expect(container.textContent).toContain("No links");
  });

  it("dims a link whose trigger is switched off and says so in the list", () => {
    render();
    const off = container.querySelector('[data-testid="routine-link-edge-event_trigger"]');
    expect(off?.getAttribute("opacity")).toBe("0.55");
    const items = Array.from(container.querySelectorAll('[data-testid="routine-link-item"]')).map((item) => item.textContent);
    expect(items[0]).toBe("Inbound mail starts Triage · kind: mail · switched off");
  });

  it("only names the link kinds that occur in the legend", () => {
    render();
    const legend = container.querySelector('[aria-label="Link kinds"]')?.textContent ?? "";
    expect(legend).toContain("Event trigger");
    expect(legend).toContain("Step order");
    expect(legend).toContain("Run on issue");
    expect(legend).toContain("Goal");
    expect(legend).not.toContain("Parent issue");
    expect(legend).not.toContain("Project");
  });

  it("opens the routine, goal or event source a box stands for, by click and by keyboard", () => {
    render();
    const boxes = Array.from(container.querySelectorAll<SVGGElement>('[role="link"]'));
    const byLabel = (label: string) => boxes.find((box) => box.getAttribute("aria-label") === label)!;

    flushSync(() => byLabel("Routine Triage").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mockNavigate).toHaveBeenLastCalledWith("/routines/r1");

    flushSync(() => byLabel("Goal Answer fast").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mockNavigate).toHaveBeenLastCalledWith("/goals/g1");

    flushSync(() => byLabel("Event source Inbound mail").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(mockNavigate).toHaveBeenLastCalledWith("/company/settings/event-sources");
  });

  it("renders an empty graph without links", () => {
    render([node({ id: "routine:r9", kind: "routine", label: "Solo" })], []);
    expect(container.querySelector('[aria-label="Link kinds"]')).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("Solo");
  });

  it("maps every node kind to the page it opens", () => {
    expect(nodeHref(node({ id: "routine:r1", kind: "routine", label: "x" }))).toBe("/routines/r1");
    expect(nodeHref(node({ id: "step:r1:a", kind: "step", label: "x", parentId: "routine:r1" }))).toBe("/routines/r1");
    expect(nodeHref(node({ id: "step:r1:a", kind: "step", label: "x" }))).toBeNull();
    expect(nodeHref(node({ id: "project:p1", kind: "project", label: "x" }))).toBe("/projects/p1");
  });

  it("words each link kind as one sentence", () => {
    expect(describeEdge("step_after", "A", "B")).toBe("B waits for A");
    expect(describeEdge("parent_issue", "A", "B")).toBe("B files its runs under issues made by A");
    expect(describeEdge("serves_project", "A", "B")).toBe("A belongs to the project B");
  });
});

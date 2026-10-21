import { describe, expect, it } from "vitest";
import type { RoutineTimelineEdge, RoutineTimelineNode } from "@paperclipai/shared";
import { LINK_CARD_W, LINK_HEAD_H, LINK_STEP_H, layoutRoutineLinks } from "./link-layout";

const node = (id: string, kind: RoutineTimelineNode["kind"], label: string, parentId: string | null = null): RoutineTimelineNode => ({
  id, kind, refId: id.split(":").pop()!, label, parentId, status: null,
});
const edge = (kind: RoutineTimelineEdge["kind"], from: string, to: string, extra: Partial<RoutineTimelineEdge> = {}): RoutineTimelineEdge => ({
  id: `${kind}:${from}>${to}`, kind, from, to, label: null, enabled: true, triggerId: null, issueId: null, runId: null, ...extra,
});

const nodes: RoutineTimelineNode[] = [
  node("event_source:s", "event_source", "Monitoring"),
  node("routine:alerts", "routine", "On alert"),
  node("step:alerts:a", "step", "Triage", "routine:alerts"),
  node("step:alerts:b", "step", "Fix", "routine:alerts"),
  node("step:alerts:c", "step", "Report", "routine:alerts"),
  node("routine:followup", "routine", "Follow-up"),
  node("routine:lonely", "routine", "Lonely"),
  node("routine:other", "routine", "Another loner"),
  node("goal:g", "goal", "Keep things healthy"),
];
const edges: RoutineTimelineEdge[] = [
  edge("event_trigger", "event_source:s", "routine:alerts", { label: "type alert.fired", triggerId: "t1" }),
  edge("targets_issue", "routine:alerts", "routine:followup", { issueId: "i" }),
  edge("step_after", "step:alerts:a", "step:alerts:b"),
  edge("step_after", "step:alerts:a", "step:alerts:c"),
  edge("step_after", "step:alerts:b", "step:alerts:c"),
  edge("serves_goal", "routine:alerts", "goal:g"),
];

const box = (layout: ReturnType<typeof layoutRoutineLinks>, id: string) => layout.boxes.find((candidate) => candidate.node.id === id)!;

describe("layoutRoutineLinks", () => {
  it("places boxes in columns along the flow: source, routine, the routine that works its issue, then the goal", () => {
    const layout = layoutRoutineLinks(nodes, edges);
    const columns = ["event_source:s", "routine:alerts", "routine:followup", "goal:g"].map((id) => box(layout, id).x);
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
    expect(new Set(columns).size).toBe(4);
    expect(layout.width).toBeGreaterThanOrEqual(columns[3]! + LINK_CARD_W);
  });

  it("keeps steps inside their routine box, tall enough for each, in order", () => {
    const layout = layoutRoutineLinks(nodes, edges);
    const alerts = box(layout, "routine:alerts");
    expect(alerts.steps.map((slot) => slot.node.label)).toEqual(["Triage", "Fix", "Report"]);
    expect(alerts.h).toBeGreaterThanOrEqual(LINK_HEAD_H + 3 * LINK_STEP_H);
    for (const slot of alerts.steps) {
      expect(slot.cy).toBeGreaterThan(alerts.y + LINK_HEAD_H);
      expect(slot.cy).toBeLessThan(alerts.y + alerts.h);
    }
    expect(layout.boxes.some((candidate) => candidate.node.kind === "step")).toBe(false);
  });

  it("draws one path per edge, with step edges inside the box and the others between boxes", () => {
    const layout = layoutRoutineLinks(nodes, edges);
    expect(layout.paths.map((path) => path.edge.id).sort()).toEqual(edges.map((e) => e.id).sort());
    const alerts = box(layout, "routine:alerts");
    for (const path of layout.paths.filter((p) => p.edge.kind === "step_after")) {
      const xs = [...path.d.matchAll(/(-?\d+(?:\.\d+)?),/g)].map((m) => Number(m[1]));
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(alerts.x - 30);
        expect(x).toBeLessThanOrEqual(alerts.x + alerts.w);
      }
    }
    const trigger = layout.paths.find((p) => p.edge.kind === "event_trigger")!;
    expect(trigger.d.startsWith(`M${box(layout, "event_source:s").x + LINK_CARD_W},`)).toBe(true);
    expect(trigger.d.endsWith(`${alerts.x},${alerts.y + LINK_HEAD_H / 2}`)).toBe(true);
  });

  it("puts routines with no link in a grid under the graph, not among its columns", () => {
    const layout = layoutRoutineLinks(nodes, edges);
    expect(layout.unlinked.map((b) => b.node.label)).toEqual(["Another loner", "Lonely"]);
    const graphBottom = Math.max(...layout.boxes.map((b) => b.y + b.h));
    expect(layout.unlinkedTop).not.toBeNull();
    expect(layout.unlinkedTop!).toBeGreaterThan(graphBottom);
    for (const b of layout.unlinked) expect(b.y).toBeGreaterThan(layout.unlinkedTop!);
    expect(layout.height).toBeGreaterThan(Math.max(...layout.unlinked.map((b) => b.y + b.h)));
  });

  it("counts a routine whose only link is its own step chain as linked", () => {
    const layout = layoutRoutineLinks(
      [node("routine:r", "routine", "Chain"), node("step:r:a", "step", "A", "routine:r"), node("step:r:b", "step", "B", "routine:r")],
      [edge("step_after", "step:r:a", "step:r:b")],
    );
    expect(layout.unlinked).toEqual([]);
    expect(layout.boxes.map((b) => b.node.id)).toEqual(["routine:r"]);
  });

  it("is empty and small for no routines, and lists only the grid when nothing links", () => {
    const empty = layoutRoutineLinks([], []);
    expect(empty.boxes).toEqual([]);
    expect(empty.paths).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
    const loners = layoutRoutineLinks([node("routine:a", "routine", "A"), node("routine:b", "routine", "B")], []);
    expect(loners.boxes).toEqual([]);
    expect(loners.unlinked).toHaveLength(2);
  });

  it("stays finite when routines trigger each other in a cycle", () => {
    const layout = layoutRoutineLinks(
      [node("routine:a", "routine", "A"), node("routine:b", "routine", "B")],
      [edge("targets_issue", "routine:a", "routine:b", { issueId: "i" }), edge("targets_issue", "routine:b", "routine:a", { issueId: "j" })],
    );
    expect(layout.boxes).toHaveLength(2);
    expect(layout.paths).toHaveLength(2);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(layout.paths.every((p) => !p.d.includes("NaN"))).toBe(true);
  });

  it("is the same for the same input", () => {
    expect(layoutRoutineLinks(nodes, edges)).toEqual(layoutRoutineLinks([...nodes], [...edges]));
  });
});

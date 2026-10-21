/**
 * Routines link graph — a pure layered layout of the `nodes` and `edges` of a `RoutineTimelineResult`.
 *
 * Event sources, routines, goals and projects are boxes in columns, left to right along the flow: an event
 * source fires a routine, a routine's issue is where another routine works. A routine box lists its steps,
 * and a step waits for its predecessors along a curve inside the box. Routines with no link at all go in a
 * compact grid under the graph. Everything is deterministic for one input, so it tests without a DOM.
 */
import type { RoutineTimelineEdge, RoutineTimelineNode } from "@paperclipai/shared";

export const LINK_CARD_W = 248;
export const LINK_HEAD_H = 36;
export const LINK_STEP_H = 24;
const CARD_PAD_BOTTOM = 8;
const COLUMN_GAP = 96;
const ROW_GAP = 16;
const MARGIN = 20;
const UNLINKED_COLUMNS = 3;
const UNLINKED_TITLE_H = 28;

const FLOW_KINDS = new Set<RoutineTimelineEdge["kind"]>(["event_trigger", "parent_issue", "targets_issue"]);

export interface LinkStepSlot {
  node: RoutineTimelineNode;
  /** vertical centre of the step row, in graph coordinates. */
  cy: number;
}

export interface LinkBox {
  node: RoutineTimelineNode;
  x: number;
  y: number;
  w: number;
  h: number;
  column: number;
  /** the steps of a routine box, in order. */
  steps: LinkStepSlot[];
}

export interface LinkPath {
  edge: RoutineTimelineEdge;
  /** SVG path data. */
  d: string;
  /** where the edge label sits. */
  labelX: number;
  labelY: number;
}

export interface LinkLayout {
  boxes: LinkBox[];
  paths: LinkPath[];
  /** routines with no link; laid out in a grid at `unlinkedTop`. */
  unlinked: LinkBox[];
  unlinkedTop: number | null;
  width: number;
  height: number;
}

function boxHeight(node: RoutineTimelineNode, stepCount: number): number {
  return node.kind === "routine" ? LINK_HEAD_H + stepCount * LINK_STEP_H + (stepCount > 0 ? CARD_PAD_BOTTOM : 0) : LINK_HEAD_H;
}

/** Longest-path column of each top-level node along the flow edges; a cycle stops at the pass limit. */
function assignColumns(ids: string[], flow: RoutineTimelineEdge[]): Map<string, number> {
  const column = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;
    for (const edge of flow) {
      const from = column.get(edge.from);
      const to = column.get(edge.to);
      if (from === undefined || to === undefined || edge.from === edge.to) continue;
      if (to < from + 1 && from + 1 <= ids.length) {
        column.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return column;
}

export function layoutRoutineLinks(nodes: RoutineTimelineNode[], edges: RoutineTimelineEdge[]): LinkLayout {
  const stepsOf = new Map<string, RoutineTimelineNode[]>();
  const topLevel: RoutineTimelineNode[] = [];
  for (const node of nodes) {
    if (node.kind === "step" && node.parentId) {
      const list = stepsOf.get(node.parentId) ?? [];
      list.push(node);
      stepsOf.set(node.parentId, list);
    } else {
      topLevel.push(node);
    }
  }
  const topIds = new Set(topLevel.map((node) => node.id));
  const stepToRoutine = new Map<string, string>();
  for (const [routineId, steps] of stepsOf) for (const step of steps) stepToRoutine.set(step.id, routineId);

  // A step edge stays inside its routine box; every other edge joins two top-level boxes.
  const stepEdges = edges.filter((edge) => edge.kind === "step_after");
  const boxEdges = edges.filter((edge) => edge.kind !== "step_after" && topIds.has(edge.from) && topIds.has(edge.to));

  const linkedIds = new Set<string>();
  for (const edge of boxEdges) {
    linkedIds.add(edge.from);
    linkedIds.add(edge.to);
  }
  for (const edge of stepEdges) {
    const routineId = stepToRoutine.get(edge.from);
    if (routineId) linkedIds.add(routineId);
  }
  const isUnlinked = (node: RoutineTimelineNode) => node.kind === "routine" && !linkedIds.has(node.id);
  const unlinkedNodes = topLevel.filter(isUnlinked);
  const graphNodes = topLevel.filter((node) => !isUnlinked(node));

  const flow = boxEdges.filter((edge) => FLOW_KINDS.has(edge.kind));
  const columns = assignColumns(graphNodes.map((node) => node.id), flow);
  // Goals and projects sit in a column of their own at the far right.
  const flowColumns = Math.max(0, ...graphNodes.filter((n) => n.kind === "routine" || n.kind === "event_source").map((n) => columns.get(n.id) ?? 0));
  for (const node of graphNodes) {
    if (node.kind === "goal" || node.kind === "project") columns.set(node.id, flowColumns + 1);
  }

  // Order each column: by the mean row of the neighbours already placed, then by label.
  const byColumn = new Map<number, RoutineTimelineNode[]>();
  for (const node of graphNodes) {
    const column = columns.get(node.id) ?? 0;
    byColumn.set(column, [...(byColumn.get(column) ?? []), node]);
  }
  const rowOf = new Map<string, number>();
  const columnKeys = [...byColumn.keys()].sort((a, b) => a - b);
  for (const column of columnKeys) {
    const members = byColumn.get(column)!;
    const score = (node: RoutineTimelineNode): number => {
      const neighbours = boxEdges
        .filter((edge) => edge.to === node.id || edge.from === node.id)
        .map((edge) => rowOf.get(edge.to === node.id ? edge.from : edge.to))
        .filter((row): row is number => row !== undefined);
      return neighbours.length === 0 ? Number.POSITIVE_INFINITY : neighbours.reduce((sum, row) => sum + row, 0) / neighbours.length;
    };
    members.sort((a, b) => score(a) - score(b) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    members.forEach((node, index) => rowOf.set(node.id, index));
  }

  const boxes: LinkBox[] = [];
  const boxById = new Map<string, LinkBox>();
  let graphBottom = MARGIN;
  for (const column of columnKeys) {
    let y = MARGIN;
    for (const node of byColumn.get(column)!) {
      const steps = stepsOf.get(node.id) ?? [];
      const h = boxHeight(node, steps.length);
      const x = MARGIN + columnKeys.indexOf(column) * (LINK_CARD_W + COLUMN_GAP);
      const box: LinkBox = {
        node,
        x,
        y,
        w: LINK_CARD_W,
        h,
        column,
        steps: steps.map((step, index) => ({ node: step, cy: y + LINK_HEAD_H + index * LINK_STEP_H + LINK_STEP_H / 2 })),
      };
      boxes.push(box);
      boxById.set(node.id, box);
      y += h + ROW_GAP;
    }
    graphBottom = Math.max(graphBottom, y - ROW_GAP);
  }

  const paths: LinkPath[] = [];
  for (const edge of boxEdges) {
    const from = boxById.get(edge.from);
    const to = boxById.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.w;
    const y1 = from.y + LINK_HEAD_H / 2;
    const x2 = to.x;
    const y2 = to.y + LINK_HEAD_H / 2;
    // A link that runs back (or within one column) bows out so it does not cross its own boxes.
    const forward = x2 > x1;
    const bend = forward ? (x2 - x1) / 2 : COLUMN_GAP / 2;
    paths.push({
      edge,
      d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 4,
    });
  }

  // Step edges: a curve down the left side of the routine box, one lane per distance.
  for (const edge of stepEdges) {
    const routineId = stepToRoutine.get(edge.from);
    const box = routineId ? boxById.get(routineId) : undefined;
    const fromSlot = box?.steps.find((slot) => slot.node.id === edge.from);
    const toSlot = box?.steps.find((slot) => slot.node.id === edge.to);
    if (!box || !fromSlot || !toSlot) continue;
    const gap = Math.max(1, Math.abs(box.steps.indexOf(toSlot) - box.steps.indexOf(fromSlot)));
    const x = box.x + 14;
    const bow = 6 + Math.min(gap, 6) * 3;
    paths.push({
      edge,
      d: `M${x},${fromSlot.cy + 6} C${x - bow},${fromSlot.cy + 6} ${x - bow},${toSlot.cy - 6} ${x},${toSlot.cy - 6}`,
      labelX: x,
      labelY: (fromSlot.cy + toSlot.cy) / 2,
    });
  }

  const unlinked: LinkBox[] = [];
  let unlinkedTop: number | null = null;
  let height = graphBottom + MARGIN;
  if (unlinkedNodes.length > 0) {
    unlinkedTop = graphBottom + (graphNodes.length > 0 ? MARGIN : 0);
    const rowTop = unlinkedTop + UNLINKED_TITLE_H;
    unlinkedNodes.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    unlinkedNodes.forEach((node, index) => {
      const col = index % UNLINKED_COLUMNS;
      const row = Math.floor(index / UNLINKED_COLUMNS);
      unlinked.push({
        node,
        x: MARGIN + col * (LINK_CARD_W + ROW_GAP),
        y: rowTop + row * (LINK_HEAD_H + ROW_GAP),
        w: LINK_CARD_W,
        h: LINK_HEAD_H,
        column: -1,
        steps: [],
      });
    });
    height = rowTop + Math.ceil(unlinkedNodes.length / UNLINKED_COLUMNS) * (LINK_HEAD_H + ROW_GAP) + MARGIN - ROW_GAP;
  }

  const graphWidth = MARGIN * 2 + columnKeys.length * LINK_CARD_W + Math.max(0, columnKeys.length - 1) * COLUMN_GAP;
  const unlinkedWidth = unlinked.length > 0 ? MARGIN * 2 + Math.min(unlinked.length, UNLINKED_COLUMNS) * (LINK_CARD_W + ROW_GAP) - ROW_GAP : 0;
  return { boxes, paths, unlinked, unlinkedTop, width: Math.max(graphWidth, unlinkedWidth, 320), height: Math.max(height, 120) };
}

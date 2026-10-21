/**
 * Routines link graph — draws the layered layout of `layoutRoutineLinks`: event sources, routines (with their
 * steps), goals and projects as boxes, and the stored links between them as curves. A box opens the thing it
 * stands for. Every link is also listed as text underneath, for screen readers and small screens.
 */
import { useMemo } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "@/lib/router";
import type { RoutineTimelineEdge, RoutineTimelineEdgeKind, RoutineTimelineNode } from "@paperclipai/shared";
import {
  LINK_HEAD_H,
  layoutRoutineLinks,
  type LinkBox,
  type LinkPath,
} from "@/lib/timeline/link-layout";

export const EDGE_KIND_LABEL: Record<RoutineTimelineEdgeKind, string> = {
  event_trigger: "Event trigger",
  step_after: "Step order",
  parent_issue: "Parent issue",
  targets_issue: "Run on issue",
  serves_goal: "Goal",
  serves_project: "Project",
};

/** One sentence for a link; every edge runs from the thing that comes first to the thing that follows. */
export function describeEdge(kind: RoutineTimelineEdgeKind, from: string, to: string): string {
  switch (kind) {
    case "event_trigger":
      return `${from} starts ${to}`;
    case "step_after":
      return `${to} waits for ${from}`;
    case "parent_issue":
      return `${to} files its runs under issues made by ${from}`;
    case "targets_issue":
      return `${to} runs on issues made by ${from}`;
    case "serves_goal":
      return `${from} serves the goal ${to}`;
    case "serves_project":
      return `${from} belongs to the project ${to}`;
  }
}

interface EdgeStyle {
  stroke: string;
  dash?: string;
  width: number;
}

const EDGE_STYLE: Record<RoutineTimelineEdgeKind, EdgeStyle> = {
  event_trigger: { stroke: "var(--color-primary)", width: 2 },
  step_after: { stroke: "var(--color-muted-foreground)", width: 1.5 },
  parent_issue: { stroke: "var(--chart-3)", width: 2 },
  targets_issue: { stroke: "var(--chart-3)", dash: "6 4", width: 2 },
  serves_goal: { stroke: "var(--status-neutral)", dash: "2 4", width: 1.5 },
  serves_project: { stroke: "var(--status-neutral)", dash: "2 4", width: 1.5 },
};

const DISABLED_DASH = "3 3";

/** The page a node opens; a step opens its routine. */
export function nodeHref(node: RoutineTimelineNode): string | null {
  switch (node.kind) {
    case "routine":
      return `/routines/${encodeURIComponent(node.refId)}`;
    case "step": {
      const routineId = node.parentId?.startsWith("routine:") ? node.parentId.slice("routine:".length) : null;
      return routineId ? `/routines/${encodeURIComponent(routineId)}` : null;
    }
    case "goal":
      return `/goals/${encodeURIComponent(node.refId)}`;
    case "project":
      return `/projects/${encodeURIComponent(node.refId)}`;
    case "event_source":
      return "/company/settings/event-sources";
    default:
      return null;
  }
}

const KIND_NAME: Record<RoutineTimelineNode["kind"], string> = {
  routine: "Routine",
  step: "Step",
  event_source: "Event source",
  goal: "Goal",
  project: "Project",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function activate(event: KeyboardEvent, open: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    open();
  }
}

function Box({ box, onOpen }: { box: LinkBox; onOpen: (node: RoutineTimelineNode) => void }) {
  const { node } = box;
  const isRoutine = node.kind === "routine";
  const paused = isRoutine && node.status !== null && node.status !== "active";
  return (
    <g
      role="link"
      tabIndex={0}
      aria-label={`${KIND_NAME[node.kind]} ${node.label}`}
      data-testid={`routine-link-node-${node.kind}`}
      className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-ring"
      onClick={() => onOpen(node)}
      onKeyDown={(event) => activate(event, () => onOpen(node))}
    >
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={6}
        fill="var(--color-card)"
        stroke="var(--color-border)"
        strokeWidth={1.5}
        strokeDasharray={paused ? "4 3" : undefined}
      />
      {!isRoutine && (
        <rect x={box.x} y={box.y} width={4} height={box.h} rx={2} fill="var(--color-muted-foreground)" />
      )}
      <text x={box.x + 12} y={box.y + 15} className="fill-muted-foreground text-xs">
        {KIND_NAME[node.kind]}
        {paused ? ` · ${node.status}` : ""}
      </text>
      <text x={box.x + 12} y={box.y + LINK_HEAD_H - 7} className="fill-foreground text-sm font-medium">
        {truncate(node.label, 30)}
      </text>
      {box.steps.map((slot) => (
        <text key={slot.node.id} x={box.x + 30} y={slot.cy + 4} className="fill-muted-foreground text-xs">
          {truncate(slot.node.label, 28)}
        </text>
      ))}
      <title>{node.label}</title>
    </g>
  );
}

function Curve({ path, labelOf }: { path: LinkPath; labelOf: Map<string, string> }) {
  const style = EDGE_STYLE[path.edge.kind];
  const dash = path.edge.enabled ? style.dash : DISABLED_DASH;
  return (
    <g data-testid={`routine-link-edge-${path.edge.kind}`} opacity={path.edge.enabled ? 1 : 0.55}>
      <path
        d={path.d}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.width}
        strokeDasharray={dash}
        markerEnd="url(#routine-link-arrow)"
      />
      {path.edge.label && path.edge.kind !== "step_after" && (
        <text x={path.labelX} y={path.labelY} textAnchor="middle" className="fill-muted-foreground text-xs">
          {truncate(path.edge.label, 24)}
        </text>
      )}
      <title>{`${describeEdge(path.edge.kind, labelOf.get(path.edge.from) ?? path.edge.from, labelOf.get(path.edge.to) ?? path.edge.to)}${path.edge.enabled ? "" : " (switched off)"}`}</title>
    </g>
  );
}

/** What the legend shows: only the kinds present, in a stable order. */
function presentKinds(edges: RoutineTimelineEdge[]): RoutineTimelineEdgeKind[] {
  const present = new Set(edges.map((edge) => edge.kind));
  return (Object.keys(EDGE_KIND_LABEL) as RoutineTimelineEdgeKind[]).filter((kind) => present.has(kind));
}

export function RoutineLinksGraph({
  nodes,
  edges,
}: {
  nodes: RoutineTimelineNode[];
  edges: RoutineTimelineEdge[];
}) {
  const navigate = useNavigate();
  const layout = useMemo(() => layoutRoutineLinks(nodes, edges), [nodes, edges]);
  const labelOf = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);
  const open = (node: RoutineTimelineNode) => {
    const href = nodeHref(node);
    if (href) navigate(href);
  };
  const linkCount = edges.length;
  const kinds = presentKinds(edges);

  return (
    <div className="space-y-3" data-testid="routine-links">
      {kinds.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Link kinds">
          {kinds.map((kind) => (
            <li key={kind} className="flex items-center gap-1.5">
              <svg width={28} height={8} aria-hidden="true">
                <line
                  x1={0}
                  y1={4}
                  x2={28}
                  y2={4}
                  stroke={EDGE_STYLE[kind].stroke}
                  strokeWidth={EDGE_STYLE[kind].width}
                  strokeDasharray={EDGE_STYLE[kind].dash}
                />
              </svg>
              {EDGE_KIND_LABEL[kind]}
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-auto rounded-md border border-border bg-card" tabIndex={0} aria-label="Routine link graph">
        <svg width={layout.width} height={layout.height} role="group" aria-label="Links between routines">
          <defs>
            <marker id="routine-link-arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-muted-foreground)" />
            </marker>
          </defs>
          {layout.paths.map((path) => (
            <Curve key={path.edge.id} path={path} labelOf={labelOf} />
          ))}
          {layout.boxes.map((box) => (
            <Box key={box.node.id} box={box} onOpen={open} />
          ))}
          {layout.unlinkedTop !== null && (
            <text x={20} y={layout.unlinkedTop + 18} className="fill-muted-foreground text-xs font-semibold">
              No links
            </text>
          )}
          {layout.unlinked.map((box) => (
            <Box key={box.node.id} box={box} onOpen={open} />
          ))}
        </svg>
      </div>

      {linkCount > 0 && (
        <details className="rounded-md border border-border bg-card px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none text-muted-foreground">
            All {linkCount} link{linkCount === 1 ? "" : "s"} as a list
          </summary>
          <ul className="mt-2 space-y-1">
            {edges.map((edge) => (
              <li key={edge.id} data-testid="routine-link-item">
                {describeEdge(edge.kind, labelOf.get(edge.from) ?? edge.from, labelOf.get(edge.to) ?? edge.to)}
                {edge.label ? <span className="text-muted-foreground"> · {edge.label}</span> : null}
                {edge.enabled ? null : <span className="text-muted-foreground"> · switched off</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Routines timeline page: every routine of the company on one page in two views.
 *
 * - Timeline: one row per routine. Past runs are bars coloured by outcome; the next fires of each schedule
 *   trigger are hollow bars. Routines with no schedule sit in their own section with their past runs only.
 * - Links: routines, their steps, event sources, goals and projects as boxes, with the stored links between them.
 *
 * Both views read `GET /companies/:companyId/routines/timeline`; the chart is the work timeline chart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronLeft, ChevronRight, Minus, Plus, RefreshCw, RotateCcw } from "lucide-react";
import type { RoutineTimelineResult, WorkTimelineSpan } from "@paperclipai/shared";
import { routinesApi } from "@/api/routines";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PageTabBar } from "@/components/PageTabBar";
import { RequestCollapsedSidebar } from "@/components/RequestCollapsedSidebar";
import { RoutineLinksGraph } from "@/components/timeline/RoutineLinksGraph";
import {
  WorkTimelineChart,
  clampZoomScale,
  defaultZoomForWindow,
  nearestZoomForScale,
  type ZoomLevel,
  zoomScaleForLevel,
} from "@/components/timeline/WorkTimelineChart";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import {
  ROUTINE_OUTCOME_LABEL,
  ROUTINE_OUTCOME_STYLE,
  buildRoutineTimelineChartModel,
  lastFireAt,
  nextFireAt,
  type RoutineRunOutcome,
  type RoutineSpanTarget,
} from "@/lib/timeline/routine-timeline";
import { TIMELINE_COLORS } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";

type View = "timeline" | "links";
type Span = "day" | "week";

const VIEW_ITEMS = [
  { value: "timeline", label: "Timeline" },
  { value: "links", label: "Links" },
] as const;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** How far each side of the anchor a span reaches: a day back and ahead, or a week back and ahead. */
const SPAN_MS: Record<Span, number> = { day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS };
const LEGEND_OUTCOMES: RoutineRunOutcome[] = ["success", "failure", "running", "skipped", "scheduled"];

function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function isView(value: string | null): value is View {
  return value === "timeline" || value === "links";
}

function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "px-3 py-1.5 text-xs transition-colors",
            index > 0 && "border-l border-border",
            value === option.value ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function OutcomeLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3.5 py-2 text-xs text-muted-foreground" aria-label="Bar colours">
      {LEGEND_OUTCOMES.map((outcome) => {
        const style = ROUTINE_OUTCOME_STYLE[outcome];
        return (
          <li key={outcome} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-4 rounded-sm border"
              style={{
                backgroundColor: style.fill === "none" ? "transparent" : style.fill,
                borderColor: style.stroke ?? "var(--color-foreground)",
                borderStyle: style.dashed ? "dashed" : "solid",
              }}
            />
            {ROUTINE_OUTCOME_LABEL[outcome]}
          </li>
        );
      })}
      <li className="flex items-center gap-1.5">
        <span className="h-3.5 w-0.5" style={{ backgroundColor: TIMELINE_COLORS.now }} />
        Now
      </li>
    </ul>
  );
}

function Summary({ data }: { data: RoutineTimelineResult }) {
  const scheduled = data.rows.filter((row) => row.scheduled).length;
  const next = nextFireAt(data);
  const stats: { label: string; value: string }[] = [
    { label: "Routines", value: String(data.rows.length) },
    { label: "Scheduled", value: String(scheduled) },
    { label: "Runs in window", value: String(data.runs.length) },
    { label: "Next fire", value: next ? formatInstant(next) : "None in window" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 border-y border-border py-3 md:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-foreground">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Says so when the response held back runs or fires, so the reader does not mistake a short list for the whole. */
function Truncation({ data }: { data: RoutineTimelineResult }) {
  const notes: string[] = [];
  if (data.limits.fires.truncated) {
    const last = lastFireAt(data);
    notes.push(
      `Showing the earliest ${data.limits.fires.cap} next fires${last ? `, up to ${formatInstant(last)}` : ""}. Pick a shorter span to see the rest.`,
    );
  }
  if (data.limits.runs.truncated) {
    notes.push(`Showing the newest ${data.limits.runs.cap} runs. Pick a shorter span to see the rest.`);
  }
  if (notes.length === 0) return null;
  return (
    <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      {notes.join(" ")}
    </p>
  );
}

function TimelineView({ data, anchorMs }: { data: RoutineTimelineResult; anchorMs: number }) {
  const navigate = useNavigate();
  const model = useMemo(() => buildRoutineTimelineChartModel(data), [data]);
  const windowFromMs = new Date(data.window.from).getTime();
  const windowToMs = new Date(data.window.to).getTime();
  const [zoom, setZoom] = useState<ZoomLevel>(() => defaultZoomForWindow(windowFromMs, windowToMs));
  const [zoomScale, setZoomScale] = useState<number | undefined>(undefined);
  const zoomTouched = useRef(false);

  useEffect(() => {
    if (zoomTouched.current) return;
    setZoom(defaultZoomForWindow(windowFromMs, windowToMs));
    setZoomScale(undefined);
  }, [windowFromMs, windowToMs]);

  const adjustZoom = (factor: number) => {
    zoomTouched.current = true;
    const next = clampZoomScale((zoomScale ?? zoomScaleForLevel(zoom)) * factor);
    setZoomScale(next);
    setZoom(nearestZoomForScale(next));
  };
  const resetZoom = () => {
    zoomTouched.current = false;
    setZoom(defaultZoomForWindow(windowFromMs, windowToMs));
    setZoomScale(undefined);
  };

  const open = useCallback(
    (target: RoutineSpanTarget) => {
      navigate(target.kind === "issue" ? `/issues/${encodeURIComponent(target.id)}` : `/routines/${encodeURIComponent(target.id)}`);
    },
    [navigate],
  );
  const onSpanClick = useCallback(
    (clicked: WorkTimelineSpan) => {
      const target = model.targetOf(clicked);
      // A run that made an issue opens it by its identifier, which the issue page prefers over the id.
      const run = data.runs.find((candidate) => candidate.id === clicked.runId);
      open(target.kind === "issue" && run?.linkedIssue?.identifier ? { kind: "issue", id: run.linkedIssue.identifier } : target);
    },
    [data.runs, model, open],
  );

  const rangeLabel = `${formatInstant(data.window.from)} to ${formatInstant(data.window.to)}`;
  return (
    <div className="space-y-3">
      <Card className="block py-0" data-testid="routine-timeline">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3.5 py-2">
          <p className="text-xs text-muted-foreground">
            {model.runCount} run{model.runCount === 1 ? "" : "s"} · {model.fireCount} next fire{model.fireCount === 1 ? "" : "s"} ·{" "}
            {rangeLabel}
          </p>
          <div className="flex items-center gap-1" aria-label="Timeline zoom controls">
            <Button type="button" variant="outline" size="icon-xs" onClick={() => adjustZoom(0.8)} aria-label="Zoom out" title="Zoom out">
              <Minus className="h-3 w-3" />
            </Button>
            <Button type="button" variant="outline" size="icon-xs" onClick={() => adjustZoom(1.25)} aria-label="Zoom in" title="Zoom in">
              <Plus className="h-3 w-3" />
            </Button>
            <Button type="button" variant="outline" size="icon-xs" onClick={resetZoom} aria-label="Reset zoom" title="Reset zoom">
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <OutcomeLegend />
        <WorkTimelineChart
          data={model.result}
          zoom={zoom}
          zoomScale={zoomScale}
          barStyle={model.barStyle}
          spanHint={model.spanHint}
          onSpanClick={onSpanClick}
          layoutOptions={model.layoutOptions}
          // The window reaches a day or a week each side of the anchor: the first scroll lands on the anchor.
          focusMs={anchorMs}
          onZoomScaleChange={(nextScale, nextZoom = nearestZoomForScale(nextScale)) => {
            zoomTouched.current = true;
            setZoomScale(nextScale);
            setZoom(nextZoom);
          }}
        />
      </Card>
    </div>
  );
}

export function RoutinesTimeline() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view: View = isView(searchParams.get("view")) ? (searchParams.get("view") as View) : "timeline";
  const [span, setSpan] = useState<Span>("day");
  const [anchorMs, setAnchorMs] = useState(() => floorToMinute(Date.now()));

  useEffect(() => {
    setBreadcrumbs([{ label: "Routines", href: "/routines" }, { label: "Timeline" }]);
  }, [setBreadcrumbs]);

  const from = new Date(anchorMs - SPAN_MS[span]).toISOString();
  const to = new Date(anchorMs + SPAN_MS[span]).toISOString();
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.routines.timeline(selectedCompanyId ?? "", from, to),
    queryFn: ({ signal }) => routinesApi.timeline(selectedCompanyId!, { from, to }, { signal }),
    enabled: !!selectedCompanyId,
    // Moving the window keeps the chart on screen until the next window arrives.
    placeholderData: keepPreviousData,
  });

  const setView = (next: string) => {
    if (!isView(next)) return;
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === "timeline") params.delete("view");
        else params.set("view", next);
        return params;
      },
      { replace: true },
    );
  };

  if (!selectedCompanyId) {
    return (
      <>
        <RequestCollapsedSidebar />
        <EmptyState icon={CalendarClock} message="Select an organization to view its routines timeline." />
      </>
    );
  }

  const now = () => setAnchorMs(floorToMinute(Date.now()));
  const shift = (direction: -1 | 1) => setAnchorMs((current) => current + direction * SPAN_MS[span]);

  return (
    <div className="space-y-6">
      <RequestCollapsedSidebar />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-6 w-6 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Routines timeline</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Past and next runs of every routine, and how routines, triggers and steps link together.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/routines">All routines</Link>
        </Button>
      </div>

      <Tabs value={view} onValueChange={setView}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PageTabBar items={VIEW_ITEMS} value={view} onValueChange={setView} align="start" />
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Span"
              value={span}
              onChange={setSpan}
              options={[
                { value: "day", label: "Day" },
                { value: "week", label: "Week" },
              ]}
            />
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="icon-xs" onClick={() => shift(-1)} aria-label="Earlier" title="Earlier">
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <Button type="button" variant="outline" size="xs" onClick={now}>
                Now
              </Button>
              <Button type="button" variant="outline" size="icon-xs" onClick={() => shift(1)} aria-label="Later" title="Later">
                <ChevronRight className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                onClick={() => void refetch()}
                disabled={isFetching}
                aria-label="Refresh"
                title="Refresh"
              >
                <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
              </Button>
            </div>
          </div>
        </div>
      </Tabs>

      {isLoading && <PageSkeleton />}

      {error && (
        <EmptyState
          icon={CalendarClock}
          message="Couldn't load the routines timeline. Try again in a moment."
        />
      )}

      {data && !error && (
        data.rows.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            message="No routines yet. Create a routine to see its runs here."
            action="Go to routines"
            hideActionIcon
            onAction={() => navigate("/routines")}
          />
        ) : (
          <div className="space-y-3">
            <Summary data={data} />
            <Truncation data={data} />
            {view === "timeline" ? (
              <TimelineView data={data} anchorMs={anchorMs} />
            ) : (
              <RoutineLinksGraph nodes={data.nodes} edges={data.edges} />
            )}
          </div>
        )
      )}
    </div>
  );
}

import { Fragment, useId, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import {
  EVENT_DELIVERY_STATUSES,
  eventSourcesApi,
  type EventDelivery,
  type EventDeliveryStatus,
} from "@/api/eventSources";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { DELIVERY_STATUS_META, DeliveryStatusBadge, formatLatency } from "./meta";

const selectClass = "rounded-md border border-input bg-background px-3 py-2 text-sm";
const PAGE_SIZE = 25;

/** Delivery log of one source with a status filter and "load more" paging. */
export function DeliveriesTable({ sourceId }: { sourceId: string }) {
  const ids = useId();
  const [status, setStatus] = useState<EventDeliveryStatus | "all">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: queryKeys.eventSources.deliveries(sourceId, status),
    queryFn: ({ pageParam }) =>
      eventSourcesApi.deliveries(sourceId, { status, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 15_000,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id={`${ids}-title`} className="text-base font-semibold">
            Deliveries
          </h2>
          <p className="text-sm text-muted-foreground">
            One row per authenticated event. Rejected and duplicate requests are grouped into
            one summary per minute.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-status`} className="text-xs">
            Status
          </Label>
          <select
            id={`${ids}-status`}
            className={selectClass}
            value={status}
            onChange={(event) => {
              setExpanded(null);
              setStatus(event.target.value as EventDeliveryStatus | "all");
            }}
          >
            <option value="all">All statuses</option>
            {EVENT_DELIVERY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {DELIVERY_STATUS_META[value].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading deliveries…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Couldn’t load deliveries."}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          message={
            status === "all"
              ? "No deliveries yet."
              : `No ${DELIVERY_STATUS_META[status].label.toLowerCase()} deliveries.`
          }
          description={
            status === "all"
              ? "Events appear here as soon as a sender posts to this source."
              : "Try another status, or show all deliveries."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-xl text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-8 px-3 py-2">
                  <span className="sr-only">Details</span>
                </th>
                <th scope="col" className="px-3 py-2 font-medium">Received</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Event</th>
                <th scope="col" className="px-3 py-2 font-medium">HTTP</th>
                <th scope="col" className="px-3 py-2 font-medium">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  open={expanded === delivery.id}
                  onToggle={() => setExpanded((id) => (id === delivery.id ? null : delivery.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </section>
  );
}

function DeliveryRow({
  delivery,
  open,
  onToggle,
}: {
  delivery: EventDelivery;
  open: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const outcomes = Object.entries(delivery.routineOutcomes ?? {});
  return (
    <Fragment>
      <tr>
        <td className="px-3 py-2 align-top">
          <Button
            variant="ghost"
            size="icon"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={open ? "Hide delivery details" : "Show delivery details"}
            onClick={onToggle}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </td>
        <td className="whitespace-nowrap px-3 py-2 align-top">
          <time dateTime={delivery.receivedAt} title={formatDateTime(delivery.receivedAt, { includeSeconds: true })}>
            {relativeTime(delivery.receivedAt)}
          </time>
        </td>
        <td className="px-3 py-2 align-top">
          <DeliveryStatusBadge status={delivery.status} />
        </td>
        <td className="max-w-xs px-3 py-2 align-top">
          {delivery.event ? (
            <>
              <p className="truncate font-medium">{typeof delivery.event.title === "string" ? delivery.event.title : "—"}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {typeof delivery.event.source === "string" ? delivery.event.source : "—"} · {typeof delivery.event.type === "string" ? delivery.event.type : "—"} · {typeof delivery.event.state === "string" ? delivery.event.state : "—"}
              </p>
            </>
          ) : (
            <span className="text-muted-foreground">{delivery.error ?? "No event recorded"}</span>
          )}
        </td>
        <td className="px-3 py-2 align-top tabular-nums">{delivery.httpStatus ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums">
          {formatLatency(delivery.latencyMs)}
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td id={detailId} colSpan={5} className="space-y-3 px-3 pb-4 pt-0 text-sm">
            <p className="text-xs text-muted-foreground">
              {DELIVERY_STATUS_META[delivery.status]?.description} Attempts: {delivery.attempts}.
            </p>
            {delivery.error && <p className="text-xs text-destructive">{delivery.error}</p>}
            {delivery.rejectCounts && (
              <ul className="space-y-1 text-xs">
                {Object.entries(delivery.rejectCounts).map(([outcome, count]) => (
                  <li key={outcome}>{outcome}: {count}</li>
                ))}
              </ul>
            )}
            {outcomes.length > 0 && (
              <ul className="space-y-1 text-xs">
                {outcomes.map(([routineId, outcome]) => (
                  <li key={routineId}>
                    <Link className="underline underline-offset-2" to={`/routines/${routineId}/triggers`}>
                      Routine {routineId.slice(0, 8)}
                    </Link>
                    : {outcome.status}
                    {outcome.failureClass ? ` (${outcome.failureClass})` : ""}
                    {outcome.error ? ` — ${outcome.error}` : ""}
                    {outcome.note ? ` — ${outcome.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {delivery.event && (
              <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
                {JSON.stringify(delivery.event, null, 2)}
              </pre>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

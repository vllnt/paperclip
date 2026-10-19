import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { Link } from "@/lib/router";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { EmptyState } from "../EmptyState";
import { StatusBadge } from "../StatusBadge";
import { ToneBadge, severityTone } from "../event-sources/meta";
import { eventSourcesApi, isEventTrigger, type EventGroup } from "@/api/eventSources";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { routineDetailHref } from "../RoutineContextualSidebar";
import { useRoutineDetail } from "./context";

function RelativeTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={formatDateTime(value, { includeSeconds: true })}>
      {relativeTime(value)}
    </time>
  );
}

/**
 * Open alert groups of this routine (design §3.2): one row per group key that
 * has an issue, with how often it repeated and when it was last seen.
 */
export function EventGroupsSection() {
  const { routine } = useRoutineDetail();
  const toggleId = useId();
  const [openOnly, setOpenOnly] = useState(true);
  const hasEventTrigger = routine.triggers.some(isEventTrigger);
  const query = useQuery({
    queryKey: queryKeys.eventSources.routineGroups(routine.id, openOnly),
    queryFn: () => eventSourcesApi.routineEventGroups(routine.id, { open: openOnly }),
    refetchInterval: 15_000,
  });
  const groups = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Alerts that share a group key share one issue. Repeats are counted here instead of
          opening new issues.
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id={toggleId}
            checked={openOnly}
            onCheckedChange={(checked) => setOpenOnly(checked === true)}
          />
          <Label htmlFor={toggleId} className="cursor-pointer text-sm font-normal">
            Open issues only
          </Label>
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading event groups…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Couldn’t load event groups."}
        </p>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={BellRing}
          message={
            !hasEventTrigger
              ? "This routine has no Event trigger."
              : openOnly
                ? "No open event groups."
                : "No event groups yet."
          }
          description={
            !hasEventTrigger
              ? "Add an Event trigger on the Triggers tab to wake this routine from alerts."
              : openOnly
                ? "Alerts that open an issue appear here until the issue is closed."
                : "Groups appear when a matching alert opens its first issue."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-xl text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Issue</th>
                <th scope="col" className="px-3 py-2 font-medium">Group</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Repeats</th>
                <th scope="col" className="px-3 py-2 font-medium">Last seen</th>
                <th scope="col" className="px-3 py-2 font-medium">Last comment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groups.map((group) => (
                <GroupRow key={group.id} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!hasEventTrigger && groups.length > 0 && (
        <p className="text-xs text-muted-foreground">
          This routine no longer has an Event trigger.{" "}
          <Link className="underline underline-offset-2" to={routineDetailHref(routine.id, "triggers")}>
            Manage triggers
          </Link>
        </p>
      )}
    </div>
  );
}

function GroupRow({ group }: { group: EventGroup }) {
  const issueRef = group.issueIdentifier ?? group.issueId;
  return (
    <tr>
      <td className="max-w-xs px-3 py-2 align-top">
        <Link className="font-medium underline-offset-2 hover:underline" to={`/issues/${issueRef}`}>
          {group.issueIdentifier ? `${group.issueIdentifier} ` : ""}
          {group.issueTitle ?? "Issue"}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {group.issueStatus && <StatusBadge status={group.issueStatus} />}
          {group.lastSeverity && (
            <ToneBadge tone={severityTone(group.lastSeverity)}>{group.lastSeverity}</ToneBadge>
          )}
          {group.lastState === "recovery" && <ToneBadge tone="ok">recovered</ToneBadge>}
        </div>
      </td>
      <td className="max-w-xs px-3 py-2 align-top">
        <span className="break-all font-mono text-xs" title={group.fingerprint}>
          {group.fingerprint}
        </span>
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">{group.repeatCount}</td>
      <td className="whitespace-nowrap px-3 py-2 align-top">
        <RelativeTime value={group.lastSeenAt} />
        <p className="text-xs text-muted-foreground">
          First <RelativeTime value={group.firstSeenAt} />
        </p>
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-top">
        {group.lastCommentAt ? (
          <RelativeTime value={group.lastCommentAt} />
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </td>
    </tr>
  );
}

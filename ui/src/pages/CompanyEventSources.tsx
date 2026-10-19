import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellRing, Plus } from "lucide-react";
import { Link, useSearchParams } from "@/lib/router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { CopyField } from "@/components/routine-triggers/WebhookFields";
import { DeliveriesTable } from "@/components/event-sources/DeliveriesTable";
import { SecretDialog, type RevealedSecret } from "@/components/event-sources/SecretDialog";
import { SourceFormDialog } from "@/components/event-sources/SourceFormDialog";
import { TestPanel } from "@/components/event-sources/TestPanel";
import { DELIVERY_STATUS_META, ToneBadge, signingModeLabel } from "@/components/event-sources/meta";
import { eventSourcesApi, type EventSource, type EventSourceWithSecret } from "@/api/eventSources";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { buildCreateInput, buildUpdateInput, type EventSourceFormState } from "@/lib/event-source-form";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function lastEventText(source: EventSource) {
  if (!source.lastDeliveryAt) return "No events received yet";
  const result = source.lastResult
    ? (DELIVERY_STATUS_META[source.lastResult as keyof typeof DELIVERY_STATUS_META]?.label ?? source.lastResult)
    : null;
  return `Last event ${relativeTime(source.lastDeliveryAt)}${result ? ` · ${result}` : ""}`;
}

function SourceStateBadge({ source }: { source: EventSource }) {
  if (source.archived) return <ToneBadge tone="muted">Archived</ToneBadge>;
  return source.enabled ? <ToneBadge tone="ok">Active</ToneBadge> : <ToneBadge tone="warn">Disabled</ToneBadge>;
}

export function CompanyEventSources() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedSourceId = params.get("source");
  const [showArchived, setShowArchived] = useState(false);
  const [formTarget, setFormTarget] = useState<"create" | EventSource | null>(null);
  const [formError, setFormError] = useState("");
  const [rotateTarget, setRotateTarget] = useState<EventSource | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<EventSource | null>(null);
  const [actionError, setActionError] = useState("");
  // The one-time secret lives only here. It is never cached or persisted.
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  const listQuery = useQuery({
    queryKey: [...queryKeys.eventSources.list(selectedCompanyId ?? ""), { includeArchived: true }],
    queryFn: () => eventSourcesApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: Boolean(selectedCompanyId),
  });
  const sources = listQuery.data ?? [];
  const selectedSource = selectedSourceId
    ? sources.find((source) => source.id === selectedSourceId)
    : undefined;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Organization", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      ...(selectedSource
        ? [
            { label: "Event sources", href: "/company/settings/event-sources" },
            { label: selectedSource.name },
          ]
        : [{ label: "Event sources" }]),
    ]);
  }, [selectedCompany?.name, selectedSource, setBreadcrumbs]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.eventSources.list(selectedCompanyId ?? "") });
  };
  const reveal = (response: EventSourceWithSecret, reason: RevealedSecret["reason"]) =>
    setRevealed({ ...response, reason });

  const createSource = useMutation({
    mutationFn: (state: EventSourceFormState) =>
      eventSourcesApi.create(selectedCompanyId!, buildCreateInput(state)),
    onSuccess: async (response) => {
      setFormTarget(null);
      setFormError("");
      reveal(response, "created");
      await refresh();
    },
    onError: (error) => setFormError(errorMessage(error, "Couldn’t create the event source.")),
  });
  const updateSource = useMutation({
    mutationFn: ({ id, state }: { id: string; state: EventSourceFormState }) =>
      eventSourcesApi.update(id, buildUpdateInput(state)),
    onSuccess: async (source) => {
      setFormTarget(null);
      setFormError("");
      pushToast({ title: `Saved “${source.name}”`, tone: "success" });
      await refresh();
      await queryClient.invalidateQueries({ queryKey: queryKeys.eventSources.detail(source.id) });
    },
    onError: (error) => setFormError(errorMessage(error, "Couldn’t save the event source.")),
  });
  const toggleEnabled = useMutation({
    mutationFn: (source: EventSource) => eventSourcesApi.update(source.id, { enabled: !source.enabled }),
    onSuccess: async (source) => {
      setActionError("");
      pushToast({
        title: source.enabled ? `Enabled “${source.name}”` : `Disabled “${source.name}”`,
        body: source.enabled ? undefined : "It now answers 404, like an unknown source.",
        tone: "success",
      });
      await refresh();
    },
    onError: (error) => setActionError(errorMessage(error, "Couldn’t change the event source.")),
  });
  const rotateSecret = useMutation({
    mutationFn: (source: EventSource) => eventSourcesApi.rotateSecret(source.id),
    onSuccess: async (response) => {
      setRotateTarget(null);
      setActionError("");
      reveal(response, "rotated");
      await refresh();
    },
    onError: (error) => {
      setRotateTarget(null);
      setActionError(errorMessage(error, "Couldn’t rotate the secret."));
    },
  });
  const archiveSource = useMutation({
    mutationFn: (source: EventSource) => eventSourcesApi.archive(source.id),
    onSuccess: async (_data, source) => {
      setArchiveTarget(null);
      setActionError("");
      pushToast({ title: `Archived “${source.name}”`, tone: "success" });
      if (selectedSourceId === source.id) setParams({}, { replace: true });
      await refresh();
    },
    onError: (error) => {
      setArchiveTarget(null);
      setActionError(errorMessage(error, "Couldn’t archive the event source."));
    },
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select an organization to manage event sources.
      </div>
    );
  }

  const archivedCount = sources.filter((source) => source.archived).length;
  const visibleSources = sources.filter((source) => showArchived || !source.archived);
  const actions: SourceActions = {
    onEdit: (source) => {
      setFormError("");
      setFormTarget(source);
    },
    onRotate: setRotateTarget,
    onToggleEnabled: (source) => toggleEnabled.mutate(source),
    onArchive: setArchiveTarget,
    busy: toggleEnabled.isPending,
  };

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      {selectedSourceId ? (
        <div className="space-y-6">
          <Link
            to="/company/settings/event-sources"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            All event sources
          </Link>
          {listQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading event source…</p>
          ) : selectedSource ? (
            <EventSourceDetail source={selectedSource} actions={actions} />
          ) : (
            <p role="alert" className="text-sm text-destructive">
              This event source no longer exists.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <BellRing className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                <h1 className="text-lg font-semibold">Event sources</h1>
              </div>
              <p className="max-w-2xl text-sm text-muted-foreground">
                An event source is a signed ingest URL for monitoring tools such as Gatus, Wazuh or your
                own scripts. Routines with an Event trigger listen to a source and wake their agent when
                a matching alert arrives.
              </p>
            </div>
            <Button
              onClick={() => {
                setFormError("");
                setFormTarget("create");
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New event source
            </Button>
          </div>

          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}

          {listQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading event sources…</p>
          ) : listQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(listQuery.error, "Couldn’t load event sources.")}
            </p>
          ) : visibleSources.length === 0 ? (
            <EmptyState
              icon={BellRing}
              message={
                sources.length > 0 ? "No active event sources." : "No event sources yet."
              }
              description="Create one to start receiving alerts, then add an Event trigger to a routine so the right agent is woken."
              action="New event source"
              onAction={() => {
                setFormError("");
                setFormTarget("create");
              }}
            />
          ) : (
            <ul className="space-y-3" aria-label="Event sources">
              {visibleSources.map((source) => (
                <li key={source.id}>
                  <EventSourceCard source={source} actions={actions} />
                </li>
              ))}
            </ul>
          )}

          {archivedCount > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-archived-sources"
                checked={showArchived}
                onCheckedChange={(checked) => setShowArchived(checked === true)}
              />
              <Label htmlFor="show-archived-sources" className="cursor-pointer text-sm font-normal">
                Show {archivedCount} archived
              </Label>
            </div>
          )}
        </>
      )}

      {formTarget && (
        <SourceFormDialog
          key={formTarget === "create" ? "create" : formTarget.id}
          open
          source={formTarget === "create" ? undefined : formTarget}
          busy={createSource.isPending || updateSource.isPending}
          error={formError}
          onClose={() => {
            setFormTarget(null);
            setFormError("");
          }}
          onSubmit={(state) =>
            formTarget === "create"
              ? createSource.mutate(state)
              : updateSource.mutate({ id: formTarget.id, state })
          }
        />
      )}

      <SecretDialog revealed={revealed} onClose={() => setRevealed(null)} />

      <AlertDialog open={Boolean(rotateTarget)} onOpenChange={(open) => !open && setRotateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the secret for “{rotateTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The current secret stops working immediately, and there is no grace period. Senders will
              get 401 until you give them the new secret, which is shown once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotateSecret.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rotateSecret.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (rotateTarget) rotateSecret.mutate(rotateTarget);
              }}
            >
              {rotateSecret.isPending ? "Rotating…" : "Rotate secret"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(archiveTarget)} onOpenChange={(open) => !open && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive “{archiveTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops accepting events right away: senders get 404, and routines with Event triggers on
              it receive nothing. Its delivery history is kept until the retention period ends.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveSource.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveSource.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (archiveTarget) archiveSource.mutate(archiveTarget);
              }}
            >
              {archiveSource.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type SourceActions = {
  onEdit: (source: EventSource) => void;
  onRotate: (source: EventSource) => void;
  onToggleEnabled: (source: EventSource) => void;
  onArchive: (source: EventSource) => void;
  busy: boolean;
};

function SourceBadges({ source }: { source: EventSource }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SourceStateBadge source={source} />
      <Badge variant="outline" className="font-normal">
        {signingModeLabel(source.signingMode)}
      </Badge>
      {source.normalizer === "gatus" && (
        <Badge variant="outline" className="font-normal">
          Gatus
        </Badge>
      )}
    </div>
  );
}

function SourceActionButtons({ source, actions }: { source: EventSource; actions: SourceActions }) {
  if (source.archived) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => actions.onEdit(source)}>
        Edit
      </Button>
      <Button variant="ghost" size="sm" onClick={() => actions.onRotate(source)}>
        Rotate secret
      </Button>
      <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.onToggleEnabled(source)}>
        {source.enabled ? "Disable" : "Enable"}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => actions.onArchive(source)}>
        Archive
      </Button>
    </div>
  );
}

function EventSourceCard({ source, actions }: { source: EventSource; actions: SourceActions }) {
  return (
    <section aria-label={`Event source ${source.name}`} className="space-y-4 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h2 className="text-sm font-semibold">
            <Link
              to={`/company/settings/event-sources?source=${source.id}`}
              className="underline-offset-2 hover:underline"
            >
              {source.name}
            </Link>
          </h2>
          <SourceBadges source={source} />
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/company/settings/event-sources?source=${source.id}`}>Test &amp; deliveries</Link>
        </Button>
      </div>
      <CopyField label="Ingest URL" value={source.ingressUrl} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{lastEventText(source)}</p>
        <SourceActionButtons source={source} actions={actions} />
      </div>
    </section>
  );
}

function EventSourceDetail({ source, actions }: { source: EventSource; actions: SourceActions }) {
  const pinned = Object.entries(source.pinnedLabels ?? {});
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <BellRing className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <h1 className="text-lg font-semibold">{source.name}</h1>
            </div>
            <SourceBadges source={source} />
          </div>
          <SourceActionButtons source={source} actions={actions} />
        </div>
        <CopyField label="Ingest URL" value={source.ingressUrl} />
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <DetailRow term="Secret" detail="Hidden. Rotate it to get a new one." />
          <DetailRow term="Last event" detail={lastEventText(source).replace(/^Last event /, "")} />
          <DetailRow term="Rate limit" detail={`${source.rateLimitPerMinute} events per minute`} />
          <DetailRow term="Storm breaker" detail={`${source.maxNewIssuesPerHour} new issues per hour`} />
          <DetailRow term="Delivery log" detail={`Kept ${source.retentionDays} days`} />
          {source.signingMode === "hmac_sha256" && (
            <DetailRow term="Replay window" detail={`${source.replayWindowSec} seconds`} />
          )}
          <DetailRow
            term="Pinned labels"
            detail={pinned.length > 0 ? pinned.map(([key, value]) => `${key}=${value}`).join(", ") : "None"}
          />
        </dl>
      </div>
      {source.archived ? (
        <p className="text-sm text-muted-foreground">
          This source is archived. It no longer accepts events.
        </p>
      ) : (
        <TestPanel source={source} />
      )}
      <DeliveriesTable sourceId={source.id} />
    </div>
  );
}

function DetailRow({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{detail}</dd>
    </div>
  );
}

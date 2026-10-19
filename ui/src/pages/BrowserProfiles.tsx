import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Globe,
  LogIn,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import type { BrowserProfile } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { browserProfilesApi } from "@/api/browser-profiles";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { formatDateTime } from "@/lib/utils";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  BrowserProfileDialog,
  type BrowserProfileSubmit,
} from "./browser-profiles/BrowserProfileDialog";
import { BrowserSignInDialog } from "./browser-profiles/BrowserSignInDialog";
import { errorMessage } from "./browser-profiles/browser-profile-helpers";

type FormTarget = "create" | BrowserProfile | null;

interface SaveProfileResult {
  profile: BrowserProfile;
  agentsError: string | null;
}

function allowedAgentsLabel(
  profile: BrowserProfile,
  agentNames: ReadonlyMap<string, string> | null,
): string | null {
  const count = profile.allowedAgentIds.length;
  if (count === 0) return null;
  if (!agentNames) return `${count} ${count === 1 ? "agent" : "agents"}`;
  const known = profile.allowedAgentIds.flatMap((id) => {
    const name = agentNames.get(id);
    return name ? [name] : [];
  });
  const missing = count - known.length;
  return missing > 0 ? [...known, `${missing} removed`].join(", ") : known.join(", ");
}

/** Company board page: manage shared browser profiles and sign in to a service once. */
export function BrowserProfiles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const bannerId = useId();
  const companyId = selectedCompanyId ?? "";
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [signInProfile, setSignInProfile] = useState<BrowserProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrowserProfile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Shared browser" },
    ]);
  }, [setBreadcrumbs]);

  const overviewQuery = useQuery({
    queryKey: queryKeys.browserProfiles.overview(companyId),
    queryFn: () => browserProfilesApi.overview(companyId),
    enabled: selectedCompanyId !== null,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: selectedCompanyId !== null,
  });
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const agentNames = useMemo(
    () =>
      agentsQuery.data
        ? new Map(agentsQuery.data.map((agent) => [agent.id, agent.name]))
        : null,
    [agentsQuery.data],
  );

  function refreshOverview() {
    return queryClient.invalidateQueries({
      queryKey: queryKeys.browserProfiles.overview(companyId),
    });
  }

  const settingsMutation = useMutation({
    mutationFn: (enabled: boolean) => browserProfilesApi.saveSettings(companyId, { enabled }),
    onSuccess: () => {
      setActionError(null);
      return refreshOverview();
    },
    onError: (cause) =>
      setActionError(errorMessage(cause, "Could not update the shared browser setting.")),
  });

  const saveProfileMutation = useMutation({
    mutationFn: async ({
      profile,
      value,
    }: {
      profile: BrowserProfile | null;
      value: BrowserProfileSubmit;
    }): Promise<SaveProfileResult> => {
      if (profile) {
        const updated = await browserProfilesApi.update(companyId, profile.id, {
          name: value.name,
          allowedDomains: value.allowedDomains,
          allowedAgentIds: value.allowedAgentIds,
        });
        return { profile: updated, agentsError: null };
      }
      const created = await browserProfilesApi.create(companyId, {
        name: value.name,
        allowedDomains: value.allowedDomains,
      });
      if (value.allowedAgentIds.length === 0) return { profile: created, agentsError: null };
      try {
        const updated = await browserProfilesApi.update(companyId, created.id, {
          allowedAgentIds: value.allowedAgentIds,
        });
        return { profile: updated, agentsError: null };
      } catch (cause) {
        return {
          profile: created,
          agentsError: errorMessage(cause, "The request failed."),
        };
      }
    },
    onSuccess: (result) => {
      setFormTarget(null);
      setFormError(null);
      setActionError(
        result.agentsError
          ? `"${result.profile.name}" was created, but its allowed agents were not saved: ${result.agentsError} Edit the profile to try again.`
          : null,
      );
      return refreshOverview();
    },
    onError: (cause) => setFormError(errorMessage(cause, "Could not save the profile.")),
  });

  const statusMutation = useMutation({
    mutationFn: ({ profile, suspend }: { profile: BrowserProfile; suspend: boolean }) =>
      suspend
        ? browserProfilesApi.suspend(companyId, profile.id)
        : browserProfilesApi.resume(companyId, profile.id),
    onSuccess: () => {
      setActionError(null);
      return refreshOverview();
    },
    onError: (cause) => setActionError(errorMessage(cause, "Could not change the profile status.")),
  });

  const removeMutation = useMutation({
    mutationFn: (profile: BrowserProfile) => browserProfilesApi.remove(companyId, profile.id),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteError(null);
      setActionError(null);
      return refreshOverview();
    },
    onError: (cause) => setDeleteError(errorMessage(cause, "Could not delete the profile.")),
  });

  function closeSignIn() {
    setSignInProfile(null);
    void refreshOverview();
  }

  function openForm(target: FormTarget) {
    setFormError(null);
    setFormTarget(target);
  }

  if (selectedCompanyId === null) {
    return <p className="text-sm text-muted-foreground">Select a company to manage its shared browser.</p>;
  }
  if (overviewQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading shared browser profiles…</p>;
  }
  if (overviewQuery.error || !overviewQuery.data) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-destructive">
          {errorMessage(overviewQuery.error, "Could not load shared browser profiles.")}
        </p>
        <Button size="sm" variant="outline" onClick={() => void overviewQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const overview = overviewQuery.data;
  const runtimeAvailable = overview.runtime.available;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="size-5 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Shared browser</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Keep a saved login in a browser profile that selected agents can share. Sign in to a
          service once here; agents then use the saved session without seeing your password.
        </p>
      </div>

      {runtimeAvailable ? null : (
        <div
          id={bannerId}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-todo)"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="font-medium">The browser runtime is unavailable</p>
            <p>{overview.runtime.reason ?? "No reason was reported."}</p>
            <p className="text-xs text-muted-foreground">
              You can still manage profiles. Signing in is off until the runtime is back.
            </p>
          </div>
        </div>
      )}

      {actionError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </p>
      ) : null}

      <Card className="block bg-transparent p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Let agents use shared browser profiles</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              When this is off, agents in this company cannot use any shared browser profile.
            </p>
          </div>
          <ToggleSwitch
            checked={overview.enabled}
            onCheckedChange={(enabled) => settingsMutation.mutate(enabled)}
            disabled={settingsMutation.isPending}
            aria-label="Allow agents to use shared browser profiles"
          />
        </div>
      </Card>

      <section className="space-y-3" aria-labelledby="browser-profiles-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="browser-profiles-heading" className="text-sm font-semibold">
            Profiles
          </h2>
          <Button size="sm" onClick={() => openForm("create")}>
            <Plus aria-hidden="true" />
            New profile
          </Button>
        </div>

        {overview.profiles.length === 0 ? (
          <EmptyState
            icon={Globe}
            message="No browser profiles yet"
            description="Create a profile, then sign in to a service once so allowed agents can reuse the login."
            action="New profile"
            onAction={() => openForm("create")}
          />
        ) : (
          <ul className="space-y-3">
            {overview.profiles.map((profile) => {
              const suspended = profile.status === "suspended";
              const statusPending =
                statusMutation.isPending && statusMutation.variables?.profile.id === profile.id;
              const agentsLabel = allowedAgentsLabel(profile, agentNames);
              return (
                <li key={profile.id}>
                  <Card className="block bg-transparent p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold">{profile.name}</h3>
                          <StatusBadge
                            status={suspended ? "paused" : "active"}
                            label={suspended ? "Suspended" : "Active"}
                          />
                          {profile.signIn.active ? (
                            <Badge variant="outline">Sign-in in progress</Badge>
                          ) : null}
                        </div>
                        {profile.hasSavedSession ? (
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CheckCircle2
                              className="size-3.5 text-(--status-task-icon-done)"
                              aria-hidden="true"
                            />
                            <span>
                              Saved login
                              {profile.lastSavedAt ? (
                                <>
                                  {" · "}
                                  <time dateTime={profile.lastSavedAt} className="font-mono">
                                    {formatDateTime(profile.lastSavedAt)}
                                  </time>
                                </>
                              ) : null}
                            </span>
                          </p>
                        ) : (
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CircleDashed className="size-3.5" aria-hidden="true" />
                            No saved login yet
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!runtimeAvailable}
                          aria-describedby={runtimeAvailable ? undefined : bannerId}
                          aria-label={`Sign in to ${profile.name}`}
                          onClick={() => setSignInProfile(profile)}
                        >
                          <LogIn aria-hidden="true" />
                          Sign in
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Edit ${profile.name}`}
                          onClick={() => openForm(profile)}
                        >
                          <Pencil aria-hidden="true" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={statusPending}
                          aria-label={`${suspended ? "Resume" : "Suspend"} ${profile.name}`}
                          onClick={() => statusMutation.mutate({ profile, suspend: !suspended })}
                        >
                          {suspended ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                          {suspended ? "Resume" : "Suspend"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Delete ${profile.name}`}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(profile);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </div>
                    {suspended ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Suspended: agents cannot use this profile until you resume it.
                      </p>
                    ) : null}
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Allowed domains</dt>
                        <dd className="break-words font-mono text-xs">
                          {profile.allowedDomains.length > 0
                            ? profile.allowedDomains.join(", ")
                            : <span className="font-sans text-muted-foreground">None</span>}
                        </dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Allowed agents</dt>
                        <dd className="break-words">
                          {agentsLabel ?? <span className="text-muted-foreground">None</span>}
                        </dd>
                      </div>
                    </dl>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {formTarget !== null ? (
        <BrowserProfileDialog
          key={formTarget === "create" ? "create" : formTarget.id}
          profile={formTarget === "create" ? null : formTarget}
          agents={agents}
          agentsLoading={agentsQuery.isLoading}
          pending={saveProfileMutation.isPending}
          error={formError}
          onSubmit={(value) =>
            saveProfileMutation.mutate({
              profile: formTarget === "create" ? null : formTarget,
              value,
            })
          }
          onClose={() => setFormTarget(null)}
        />
      ) : null}

      {signInProfile ? (
        <BrowserSignInDialog
          key={signInProfile.id}
          companyId={companyId}
          profile={signInProfile}
          onClose={closeSignIn}
          onSaved={closeSignIn}
        />
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases the saved login for every agent that uses this profile. They lose access
              to that account until someone signs in again with a new profile. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => {
                if (deleteTarget) removeMutation.mutate(deleteTarget);
              }}
            >
              {removeMutation.isPending ? "Deleting…" : "Delete profile"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, User, X } from "lucide-react";
import type {
  GrantProjectAccess,
  ProjectAccessMode,
  ProjectAccessPrincipal,
  ProjectAccessSource,
  ProjectAccessSummary,
} from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { useIsCompanyAdmin } from "../hooks/useCompanyInviteAccess";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SOURCE_LABELS: Record<ProjectAccessSource, string> = {
  company_mode: "Company",
  explicit: "Access list",
  company_admin: "Owner/admin",
  lead_agent: "Lead",
};

const MODE_LABELS: Record<ProjectAccessMode, string> = {
  company: "Open to company",
  restricted: "Restricted",
};

function principalKey(principal: { principalType: string; principalId: string }) {
  return `${principal.principalType}:${principal.principalId}`;
}

function parsePrincipalKey(key: string): GrantProjectAccess | null {
  const [principalType, ...rest] = key.split(":");
  const principalId = rest.join(":");
  if (!principalId) return null;
  if (principalType === "user" || principalType === "agent") return { principalType, principalId };
  return null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

/**
 * Project access: every user and agent that can reach the project with the
 * reason, the access mode, and (for company owners/admins) the access list.
 */
export function ProjectAccessSection({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const isAdmin = useIsCompanyAdmin(companyId);
  const [pendingPrincipal, setPendingPrincipal] = useState("");

  const accessQuery = useQuery({
    queryKey: queryKeys.projects.access(projectId),
    queryFn: () => projectsApi.getAccess(projectId, companyId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: isAdmin,
  });
  const directoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: isAdmin,
  });

  function onSaved(summary: ProjectAccessSummary) {
    queryClient.setQueryData(queryKeys.projects.access(projectId), summary);
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
  }

  const setMode = useMutation({
    mutationFn: (accessMode: ProjectAccessMode) => projectsApi.setAccessMode(projectId, accessMode, companyId),
    onSuccess: onSaved,
  });
  const grant = useMutation({
    mutationFn: (principal: GrantProjectAccess) => projectsApi.grantAccess(projectId, principal, companyId),
    onSuccess: (summary) => {
      setPendingPrincipal("");
      onSaved(summary);
    },
  });
  const revoke = useMutation({
    mutationFn: (principal: GrantProjectAccess) => projectsApi.revokeAccess(projectId, principal, companyId),
    onSuccess: onSaved,
  });

  const summary = accessQuery.data;
  const listed = useMemo(
    () => new Set((summary?.principals ?? []).filter((p) => p.sources.includes("explicit")).map(principalKey)),
    [summary],
  );
  const addOptions = useMemo<InlineEntityOption[]>(() => {
    const options: InlineEntityOption[] = [];
    for (const agent of agentsQuery.data ?? []) {
      if (agent.status === "terminated") continue;
      const key = principalKey({ principalType: "agent", principalId: agent.id });
      if (!listed.has(key)) options.push({ id: key, label: `${agent.name} (agent)`, searchText: agent.name });
    }
    for (const entry of directoryQuery.data?.users ?? []) {
      const key = principalKey({ principalType: "user", principalId: entry.principalId });
      const name = entry.user?.name ?? entry.user?.email ?? entry.principalId;
      if (!listed.has(key)) options.push({ id: key, label: `${name} (user)`, searchText: `${name} ${entry.user?.email ?? ""}` });
    }
    return options;
  }, [agentsQuery.data, directoryQuery.data, listed]);

  const mutationError = setMode.error ?? grant.error ?? revoke.error;

  return (
    <section className="space-y-3 py-4" aria-labelledby="project-access-heading" data-testid="project-access-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="project-access-heading" className="text-sm font-semibold">Access</h3>
        {summary ? (
          isAdmin ? (
            <Select
              value={summary.accessMode}
              onValueChange={(value) => {
                if (value === "company" || value === "restricted") setMode.mutate(value);
              }}
              disabled={setMode.isPending}
            >
              <SelectTrigger size="sm" aria-label="Project access mode" data-testid="project-access-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="company">{MODE_LABELS.company}</SelectItem>
                <SelectItem value="restricted">{MODE_LABELS.restricted}</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="outline">{MODE_LABELS[summary.accessMode]}</Badge>
          )
        ) : null}
      </div>

      {summary && summary.accessMode === "restricted" ? (
        <p className="text-xs text-muted-foreground" data-testid="project-access-enforcement-note">
          Not enforced yet. The list below shows who will keep access, but everyone in the company can still reach this
          project until the server enables enforcement.
        </p>
      ) : null}

      {accessQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading access…</p> : null}
      {accessQuery.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Could not load project access: {errorMessage(accessQuery.error)}
        </p>
      ) : null}
      {mutationError ? (
        <p className="text-sm text-destructive" role="alert">
          {errorMessage(mutationError)}
        </p>
      ) : null}

      {summary ? (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="project-access-list">
          {summary.principals.map((principal) => (
            <AccessRow
              key={principalKey(principal)}
              principal={principal}
              canRemove={isAdmin && principal.sources.includes("explicit")}
              removing={revoke.isPending}
              onRemove={() => revoke.mutate({ principalType: principal.principalType, principalId: principal.principalId })}
            />
          ))}
          {summary.principals.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">Nobody can reach this project yet.</li>
          ) : null}
        </ul>
      ) : null}

      {summary && isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Add to access list</span>
          <InlineEntitySelector
            value={pendingPrincipal}
            options={addOptions}
            placeholder="Choose a user or agent"
            noneLabel="None"
            searchPlaceholder="Search users and agents"
            emptyMessage="Everyone is already listed"
            disabled={grant.isPending}
            triggerTestId="project-access-add"
            onChange={(key) => {
              setPendingPrincipal(key);
              const principal = parsePrincipalKey(key);
              if (principal) grant.mutate(principal);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function AccessRow({
  principal,
  canRemove,
  removing,
  onRemove,
}: {
  principal: ProjectAccessPrincipal;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const Icon = principal.principalType === "agent" ? Bot : User;
  return (
    <li className="flex items-center gap-2 px-3 py-2" data-testid="project-access-row">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={principal.principalType} />
      <span className="min-w-0 flex-1 truncate text-sm">{principal.name}</span>
      <span className="flex flex-wrap justify-end gap-1">
        {principal.sources.map((source) => (
          <Badge key={source} variant="secondary">
            {SOURCE_LABELS[source]}
          </Badge>
        ))}
      </span>
      {canRemove ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${principal.name} from the access list`}
          disabled={removing}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

import { useTaskLinkColumns } from "./task-links";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

export interface TaskDestination {
  key: string;
  pluginId: string;
  action: string;
  id: string;
  label: string;
  provider: string;
  disabledReason?: string;
}
export async function listTaskDestinations(companyId: string, projectId: string) {
  const contributions = await pluginsApi.listUiContributions();
  const results = await Promise.all(contributions.filter(p => p.taskCreation).map(async plugin => {
    const provider = plugin.taskCreation!;
    const result = await pluginsApi.bridgePerformAction(plugin.pluginId, provider.listAction, { projectId }, companyId);
    const data = result.data as { destinations?: unknown };
    if (!Array.isArray(data?.destinations)) throw new Error(`${provider.label} returned invalid destinations.`);
    return data.destinations.map((destination: unknown): TaskDestination => {
      const item = destination as Record<string, unknown>;
      if (!item || typeof item.id !== "string" || !item.id || typeof item.label !== "string") throw new Error(`${provider.label} returned an invalid destination.`);
      return { key: `${plugin.pluginId}:${item.id}`, pluginId: plugin.pluginId, action: provider.publishAction,
        id: item.id, label: item.label, provider: provider.label,
        ...(typeof item.disabledReason === "string" ? { disabledReason: item.disabledReason } : {}) };
    });
  }));
  return results.flat();
}
export async function createTaskWithDestination(companyId: string, data: Record<string, unknown>, destination: TaskDestination | null) {
  if (destination?.disabledReason) throw new Error(destination.disabledReason);
  const issue = await issuesApi.create(companyId, { ...data, ...(destination ? { allowDuplicate: true } : {}) });
  let warning: string | undefined;
  if (destination) {
    try {
      const response = await pluginsApi.bridgePerformAction(destination.pluginId, destination.action, { issueId: issue.id, destinationId: destination.id }, companyId);
      warning = (response.data as { warning?: string } | undefined)?.warning;
    } catch {
      // The form retains its idempotency key. Retry reuses this exact native task.
      throw new Error(`Task ${issue.identifier ?? issue.id} was saved. Publishing to ${destination.provider} was not confirmed. Retry to finish connecting it.`);
    }
  }
  return { issue, warning };
}
export function useTaskDestination(companyId: string | null, projectId: string, open: boolean) {
  const scope = `${companyId ?? ""}:${projectId}`;
  const storageKey = `paperclip.task-destination:${scope}`;
  const [selection, setSelection] = useState({ scope: "", key: "" });
  const providersQuery = useQuery({
    queryKey: ["plugins", "task-destination-providers", companyId],
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: open && !!companyId,
    staleTime: 30_000,
    retry: false,
  });
  const query = useQuery({ queryKey: ["plugins", "task-destinations", companyId, projectId],
    queryFn: () => listTaskDestinations(companyId!, projectId), enabled: open && !!companyId && !!projectId,
    staleTime: 30_000, retry: false });
  useEffect(() => {
    let key = "";
    try { key = localStorage.getItem(storageKey) ?? ""; } catch { /* Private browsing can disable storage. */ }
    setSelection({ scope, key });
  }, [scope, open]);
  const selectedKey = selection.scope === scope ? selection.key : "";
  const options = query.data ?? [];
  const selected = options.find(option => option.key === selectedKey) ?? null;
  const error = selectedKey && !selected && !query.isLoading ? "The saved destination is unavailable. Choose Paperclip or another repository." : selected?.disabledReason;
  const choose = (key: string) => {
    setSelection({ scope, key });
    try { localStorage.setItem(storageKey, key); } catch { /* Selection still works for this form. */ }
  };
  const providerLabels = (providersQuery.data ?? [])
    .flatMap((provider) => provider.taskCreation ? [provider.taskCreation.label] : []);
  return { options, selected, selectedKey, choose, error, projectId,
    blocked: !!selectedKey && (!!error || query.isLoading), loading: query.isLoading,
    providerConfigured: providerLabels.length > 0, providerLabels,
    discoveryError: query.error instanceof Error ? query.error.message : null };
}

export function TaskDestinationPicker({ value }: { value: ReturnType<typeof useTaskDestination> }) {
  const showLoading = value.loading && !value.options.length && !value.selectedKey;
  const needsProject = value.providerConfigured && !value.projectId && !value.selectedKey && !value.options.length && !showLoading;
  if (!value.options.length && !value.selectedKey && !value.discoveryError && !showLoading && !needsProject) return null;
  return <div className="flex flex-col gap-2 px-4 py-2">
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      Create in
      <select aria-label="Create in" className="min-w-0 max-w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
        value={value.selectedKey} disabled={showLoading || needsProject} onChange={event => value.choose(event.target.value)}>
        <option value="">Paperclip</option>
        {value.selectedKey && !value.selected && <option value={value.selectedKey}>Unavailable destination</option>}
        {value.options.map(option => <option key={option.key} value={option.key}>{option.provider} · {option.label}</option>)}
      </select>
    </label>
    {showLoading && <p role="status" className="text-xs text-muted-foreground">Loading linked repositories…</p>}
    {needsProject && <p role="status" className="text-xs text-muted-foreground">
      Select a project above to enable {value.providerLabels.join(" / ")} issue creation.
    </p>}
    {(value.error || value.discoveryError) && <p role="alert" className="text-sm text-destructive">{value.error || value.discoveryError}</p>}
  </div>;
}

export function TaskSourceBadge({ originKind }: { originKind?: string | null }) {
  const taskLinks = useTaskLinkColumns();
  if (taskLinks) return null;
  if (!originKind?.startsWith("plugin:")) return null;
  return <PluginTaskSourceBadge originKind={originKind} />;
}
function PluginTaskSourceBadge({ originKind }: { originKind: string }) {
  const { data } = useQuery({ queryKey: queryKeys.plugins.uiContributions, queryFn: () => pluginsApi.listUiContributions(), staleTime: 30_000, enabled: !!originKind?.startsWith("plugin:") });
  const provider = data?.find(plugin => plugin.taskCreation && (originKind === `plugin:${plugin.pluginKey}` || originKind?.startsWith(`plugin:${plugin.pluginKey}:`)));
  if (!provider) return null;
  return <span className="shrink-0 text-xs text-muted-foreground" title={`Linked to ${provider.taskCreation!.label}`}>{provider.taskCreation!.label}</span>;
}

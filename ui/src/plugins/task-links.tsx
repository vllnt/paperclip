import { createContext, useContext, useMemo, useRef, useState, type ReactNode, type ComponentProps } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Issue, PluginTaskLink, PluginTaskLinks } from "@paperclipai/shared";
import { CircleDot, GitPullRequest, GitMerge, LockKeyhole, ExternalLink, AlertCircle } from "lucide-react";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useActiveCompanyPrefix } from "@/lib/router";
import { resolveHostNavigationHref } from "./bridge";
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Source = PluginUiContribution;
type Task = Pick<Issue, "id" | "originKind">;
export type TaskLinksRow = PluginTaskLinks & { provider: string; pluginId: string; pluginKey: string; settingsPath?: string };
type Row = TaskLinksRow;
function owns(plugin: Source, task: Task) { return task.originKind === `plugin:${plugin.pluginKey}` || task.originKind?.startsWith(`plugin:${plugin.pluginKey}:`); }
function safeLink(value: unknown, plugin: Source): PluginTaskLink | undefined {
  const link = value as PluginTaskLink | null;
  if (!link || typeof link.label !== "string" || typeof link.url !== "string") return undefined;
  try { const url = new URL(link.url); if (url.protocol !== "https:" || url.username || url.password) return undefined; } catch { return undefined; }
  const page = plugin.projectRepositories?.setupPath;
  return { label: link.label.slice(0, 80), url: link.url, title: typeof link.title === "string" ? link.title : undefined,
    state: typeof link.state === "string" ? link.state : undefined,
    panel: link.panel && typeof link.panel.recordId === "string" && link.panel.recordId.length > 0 && link.panel.recordId.length <= 512
      && plugin.slots.some(slot => slot.id === link.panel?.slotId && slot.type === "detailTab" && slot.entityTypes?.includes("issue"))
      ? { slotId: link.panel.slotId, recordId: link.panel.recordId } : undefined,
    viewPath: page && (link.viewPath === page || link.viewPath?.startsWith(`${page}?`)) ? link.viewPath : undefined };
}
export function parseTaskLinks(data: unknown, ids: string[], plugin: Source): Row[] {
  const tasks = (data as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) throw new Error("Task links could not be loaded.");
  return tasks.filter(row => row && ids.includes(row.issueId)).map(row => ({
    issueId: row.issueId, pluginId: plugin.pluginId, pluginKey: plugin.pluginKey, provider: plugin.taskCreation!.label, settingsPath: plugin.projectRepositories?.setupPath,
    issue: safeLink(row.issue, plugin),
    pullRequests: Array.isArray(row.pullRequests) ? row.pullRequests.slice(0, 10).flatMap((pr: unknown) => { const link = safeLink(pr, plugin); return link ? [link] : []; }) : [],
    pullRequestsStatus: ["ready", "error", "access_required"].includes(row.pullRequestsStatus) ? row.pullRequestsStatus : undefined,
    morePullRequests: row.morePullRequests === true,
    message: typeof row.message === "string" ? row.message : undefined,
    details: Array.isArray(row.details) ? row.details.filter((item: { label?: unknown; value?: unknown }) => typeof item?.label === "string" && typeof item.value === "string").slice(0, 20) : [],
  }));
}
export function useTaskLinks(companyId: string | null, tasks: Task[], detail = false) {
  const forceRefresh = useRef(false);
  const contributions = useQuery({ queryKey: queryKeys.plugins.uiContributions, queryFn: () => pluginsApi.listUiContributions(), staleTime: 30_000,
    enabled: !!companyId && tasks.some(task => task.originKind?.startsWith("plugin:")), retry: false });
  const batches = (contributions.data ?? []).filter(p => p.taskCreation?.linksAction).flatMap(plugin => {
    const ids = [...new Set(tasks.filter(task => owns(plugin, task)).map(task => task.id))].sort();
    return Array.from({ length: Math.ceil(ids.length / 100) }, (_, n) => ({ plugin, ids: ids.slice(n * 100, (n + 1) * 100) }));
  });
  const queries = useQueries({ queries: batches.map(({ plugin, ids }) => ({
    queryKey: ["plugins", "task-links", companyId, plugin.pluginId, plugin.taskCreation!.linksAction, detail, ids],
    queryFn: async () => parseTaskLinks((await pluginsApi.bridgePerformAction(plugin.pluginId, plugin.taskCreation!.linksAction!, { issueIds: ids, detail, ...(forceRefresh.current ? { refresh: true } : {}) }, companyId!)).data, ids, plugin),
    staleTime: 30_000, refetchInterval: 60_000, retry: false, enabled: !!companyId,
  })) });
  const rows = new Map<string, Row>();
  queries.forEach((query, index) => {
    for (const id of batches[index].ids) rows.set(id, { issueId: id, pluginId: batches[index].plugin.pluginId, pluginKey: batches[index].plugin.pluginKey, provider: batches[index].plugin.taskCreation!.label,
      settingsPath: batches[index].plugin.projectRepositories?.setupPath,
      ...(query.isError ? { pullRequestsStatus: "error" as const, message: "Task links could not be loaded. Retry in task details." } : {}) });
    for (const row of query.data ?? []) rows.set(row.issueId, row);
  });
  return { rows, loading: contributions.isLoading || queries.some(q => q.isLoading), enabled: batches.length > 0, error: contributions.isError, retry: () => { forceRefresh.current = true; void Promise.all([contributions.refetch(), ...queries.map(q => q.refetch())]).finally(() => { forceRefresh.current = false; }); } };
}
const TaskLinksContext = createContext<{ rows: Map<string, Row>; columns: string[]; toggle: (column: string, enabled: boolean) => void; reset: () => void } | null>(null);
const columns = ["issue", "pullRequests"];
export function TaskLinksProvider({ companyId, tasks, collectionKey, children }: { companyId: string | null; tasks: Task[]; collectionKey: string; children: ReactNode }) {
  const data = useTaskLinks(companyId, tasks);
  const key = `paperclip:task-link-columns:${companyId}:${collectionKey}`;
  const [stored, setStored] = useState<{ key: string; columns: string[] } | null>(null);
  const selected = useMemo(() => {
    if (stored?.key === key) return stored.columns;
    try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); if (Array.isArray(value)) return columns.filter(c => value.includes(c)); } catch { /* Optional preferences. */ }
    return columns;
  }, [key, stored]);
  const save = (next: string[]) => { setStored({ key, columns: next }); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Optional preferences. */ } };
  return <TaskLinksContext.Provider value={data.enabled ? { rows: data.rows, columns: selected, toggle: (c, enabled) => save(enabled ? [...new Set([...selected, c])] : selected.filter(v => v !== c)), reset: () => save(columns) } : null}>{children}</TaskLinksContext.Provider>;
}
export function useTaskLinkColumns() { return useContext(TaskLinksContext); }
export function TaskLinkColumnOptions() {
  const context = useTaskLinkColumns();
  if (!context) return null;
  return <><DropdownMenuSeparator />{columns.map(column => <DropdownMenuCheckboxItem key={column} checked={context.columns.includes(column)} onSelect={e => e.preventDefault()} onCheckedChange={checked => context.toggle(column, checked === true)}>
    {column === "issue" ? `${context.rows.values().next().value?.provider ?? "Source"} issue` : "Pull requests"}
  </DropdownMenuCheckboxItem>)}</>;
}
function PluginPageLink({ to, ...props }: Omit<ComponentProps<typeof Link>, "to"> & { to: string }) {
  const prefix = useActiveCompanyPrefix();
  return <Link {...props} to={resolveHostNavigationHref(to, prefix)} />;
}
export function taskRecordHref(issueId: string, pluginId: string, recordId: string) {
  return `/issues/${encodeURIComponent(issueId)}?${new URLSearchParams({ taskPlugin: pluginId, taskRecord: recordId })}`;
}
function RecordViewLink({ link, row, children }: { link: PluginTaskLink; row: Row; children: ReactNode }) {
  const to = link.panel ? taskRecordHref(row.issueId, row.pluginKey, link.panel.recordId) : link.viewPath;
  return to ? <PluginPageLink to={to} className="text-xs text-muted-foreground hover:underline" onClick={e => e.stopPropagation()}>{children}</PluginPageLink> : null;
}
function TaskRecordLink({ link, kind, provider, row }: { link: PluginTaskLink; kind: "issue" | "pull"; provider: string; row?: Row }) {
  const Icon = kind === "issue" ? CircleDot : link.state === "merged" ? GitMerge : GitPullRequest;
  const sharedProps = { onClick: (e: React.MouseEvent) => e.stopPropagation(), onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    title: `${link.title ?? link.label}${link.state ? ` · ${link.state}` : ""}`,
    className: cn("relative z-10 inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", link.state === "merged" ? "text-violet-500" : link.state === "open" ? "text-green-600 dark:text-green-400" : "text-muted-foreground") };
  if (link.panel && row) return <PluginPageLink {...sharedProps} to={taskRecordHref(row.issueId, row.pluginKey, link.panel.recordId)} aria-label={`View ${provider} ${kind === "issue" ? "issue" : "pull request"} ${link.label}`}><Icon className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{link.label}</span></PluginPageLink>;
  return <a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${provider} ${kind === "issue" ? "issue" : "pull request"} ${link.label}`} title={`${link.title ?? link.label}${link.state ? ` · ${link.state}` : ""}`}
    onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
    className={cn("relative z-10 inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", link.state === "merged" ? "text-violet-500" : link.state === "open" ? "text-green-600 dark:text-green-400" : "text-muted-foreground")}>
    <Icon className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{link.label}</span>
  </a>;
}
function PullLinks({ row, compact }: { row: Row; compact?: boolean }) {
  const prs = row.pullRequests ?? [];
  if (!prs.length) {
    if (row.pullRequestsStatus === "access_required" || row.pullRequestsStatus === "error") {
      const Icon = row.pullRequestsStatus === "access_required" ? LockKeyhole : AlertCircle;
      return row.settingsPath ? <PluginPageLink to={row.settingsPath} title={row.message} aria-label={row.message} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} className="relative z-10 inline-flex rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon className="size-3.5" /></PluginPageLink> : <span title={row.message} aria-label={row.message} className="inline-flex text-muted-foreground"><Icon className="size-3.5" /></span>;
    }
    return <span title={row.pullRequestsStatus === "ready" ? "No linked pull requests" : "Loading pull requests"} className="text-xs text-muted-foreground">{row.pullRequestsStatus === "ready" ? "—" : "…"}</span>;
  }
  if (!compact) return <div className="flex flex-col gap-2">{prs.map(pr => <div key={pr.url} className="flex items-center justify-between gap-2"><TaskRecordLink link={pr} kind="pull" provider={row.provider} row={row} /><RecordViewLink link={pr} row={row}>View PR</RecordViewLink></div>)}{row.morePullRequests && <span className="text-xs text-muted-foreground">More on the source issue</span>}</div>;
  return <><TaskRecordLink link={prs[0]} kind="pull" provider={row.provider} row={row} />{(prs.length > 1 || (prs[0].panel || prs[0].viewPath) || row.morePullRequests) && <Popover><PopoverTrigger asChild><button type="button" className="relative z-10 rounded-sm px-1 text-xs text-muted-foreground hover:bg-accent" aria-label="View linked pull requests" onKeyDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>{prs.length > 1 ? `+${prs.length - 1}` : "⌄"}</button></PopoverTrigger><PopoverContent align="end" className="w-64 space-y-3"><p className="text-sm font-medium">Pull requests</p><PullLinks row={row} /></PopoverContent></Popover>}</>;
}
export function TaskLinkCells({ issueId, mobile = false }: { issueId: string; mobile?: boolean }) {
  const context = useTaskLinkColumns(); if (!context) return null;
  const row = context.rows.get(issueId);
  if (mobile && !row) return null;
  return <span data-slot="task-link-columns" className={cn("items-center gap-3", mobile ? "flex sm:hidden" : "hidden shrink-0 sm:flex")}>
    {context.columns.includes("issue") && <span className="inline-flex w-20 items-center" data-column="source-issue">{row?.issue ? <TaskRecordLink link={row.issue} provider={row.provider} kind="issue" row={row} /> : <span className="text-xs text-muted-foreground">{row && !row.pullRequestsStatus ? "…" : "—"}</span>}</span>}
    {context.columns.includes("pullRequests") && <span className="inline-flex w-20 items-center gap-1" data-column="pull-requests">{row ? <PullLinks row={row} compact /> : <span className="text-xs text-muted-foreground">—</span>}</span>}
  </span>;
}
export function TaskLinksSidebar({ issue }: { issue: Issue }) {
  if (!issue.originKind?.startsWith("plugin:")) return null;
  return <LinkedTaskSidebar key={issue.id} issue={issue} />;
}
function LinkedTaskSidebar({ issue }: { issue: Issue }) {
  const data = useTaskLinks(issue.companyId, [issue], true);
  const row = data.rows.get(issue.id);
  if (!row && !data.error) return null;
  return <section aria-label={`${row?.provider ?? "Source"} details`} className="space-y-3 border-t border-border py-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{row?.provider ?? "Source"}</h3><button type="button" className="text-xs text-muted-foreground hover:underline" onClick={data.retry}>Refresh</button></div>
    {row?.issue && <div className="flex items-center justify-between gap-2"><TaskRecordLink link={row.issue} kind="issue" provider={row.provider} row={row} /><RecordViewLink link={row.issue} row={row}>View issue</RecordViewLink></div>}
    {!!row?.details?.length && <dl className="space-y-2">{row.details.map(item => <div className="flex items-start justify-between gap-3 text-xs" key={item.label}><dt className="shrink-0 text-muted-foreground">{item.label}</dt><dd className="min-w-0 break-words text-right">{item.label === "Updated" ? new Date(item.value).toLocaleString() : item.value}</dd></div>)}</dl>}
    {row && <div className="space-y-2"><p className="text-xs text-muted-foreground">Pull requests</p><PullLinks row={row} /></div>}
    {(row?.message || data.error) && <p role="status" className="text-xs text-muted-foreground">{row?.message ?? "Source details could not be loaded."}</p>}
    {row?.settingsPath && (row.message || row.pullRequestsStatus === "access_required") && <PluginPageLink to={row.settingsPath} className="inline-flex items-center gap-1 text-xs hover:underline">Connection settings<ExternalLink className="size-3" /></PluginPageLink>}
  </section>;
}

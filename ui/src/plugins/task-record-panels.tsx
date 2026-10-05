import type { Issue, PluginTaskLink } from "@paperclipai/shared";
import { useActiveCompanyPrefix } from "@/lib/router";
import { taskPanelPluginRecordTab, type TaskSidePanelTabPayload } from "@/lib/task-side-panel-state";
import { PluginSlotMount, usePluginSlots, type ResolvedPluginSlot } from "./slots";
import { useTaskLinks } from "./task-links";

export type TaskRecordSelection = { pluginId: string; recordId: string };
export function readTaskRecordSelection(search: string): TaskRecordSelection | null {
  const params = new URLSearchParams(search);
  if (params.get("file") || params.get("browse") === "1") return null;
  const pluginId = params.get("taskPlugin"), recordId = params.get("taskRecord");
  return pluginId && pluginId.length <= 200 && recordId && recordId.length <= 512 ? { pluginId, recordId } : null;
}
export function writeTaskRecordSelection(search: string, selection: TaskRecordSelection | null): string {
  const params = new URLSearchParams(search);
  params.delete("taskPlugin"); params.delete("taskRecord");
  if (selection) {
    // Record and file deep links share the same active pane.
    for (const key of ["file", "line", "column", "browse", "folder", "q"]) params.delete(key);
    params.set("taskPlugin", selection.pluginId); params.set("taskRecord", selection.recordId);
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}
export type TaskRecordPanel = {
  pluginId: string;
  pluginKey: string;
  recordId: string;
  kind: "issue" | "pull";
  link: PluginTaskLink;
  slot: ResolvedPluginSlot;
};
export function recordPanelTab(record: TaskRecordPanel) {
  return taskPanelPluginRecordTab({ pluginId: record.pluginId, recordId: record.recordId,
    recordKind: record.kind, label: `${record.kind === "issue" ? "Issue" : "PR"} ${record.link.label}` });
}
export function useTaskRecordPanels(issue: Issue) {
  const links = useTaskLinks(issue.companyId, [issue]);
  const slots = usePluginSlots({ slotTypes: ["detailTab"], entityType: "issue", enabled: !!issue.originKind?.startsWith("plugin:") });
  const row = links.rows.get(issue.id);
  const records: TaskRecordPanel[] = [];
  for (const [kind, values] of [["issue", row?.issue ? [row.issue] : []], ["pull", row?.pullRequests ?? []]] as const) {
    for (const link of values) {
      const slot = slots.slots.find(s => s.pluginId === row?.pluginId && s.id === link.panel?.slotId);
      if (row && link.panel && slot) records.push({ pluginId: row.pluginId, pluginKey: row.pluginKey, recordId: link.panel.recordId, kind, link, slot });
    }
  }
  return { records, loading: links.loading || slots.isLoading, retry: links.retry,
    error: row?.message ?? (links.error || slots.errorMessage ? "Source records could not be loaded." : null) };
}
export function TaskRecordPanelContent({ issue, payload, data }: {
  issue: Issue;
  payload: Extract<TaskSidePanelTabPayload, { kind: "plugin-record" }>;
  data: ReturnType<typeof useTaskRecordPanels>;
}) {
  const companyPrefix = useActiveCompanyPrefix();
  const record = data.records.find(record => (record.pluginId === payload.pluginId || record.pluginKey === payload.pluginId) && record.recordId === payload.recordId);
  if (!record) return <div className="space-y-3 text-sm text-muted-foreground" role="status">
    <p>{data.loading ? "Loading source record…" : data.error ?? "This record is no longer available for this task. Check the connection or select another tab."}</p>
    {!data.loading && <button type="button" className="hover:underline" onClick={data.retry}>Retry</button>}
  </div>;
  return <PluginSlotMount key={`${record.pluginId}:${record.recordId}`} slot={record.slot} missingBehavior="placeholder"
    context={{ companyId: issue.companyId, companyPrefix, projectId: issue.projectId, entityId: issue.id, entityType: "issue", taskRecordId: record.recordId }} />;
}

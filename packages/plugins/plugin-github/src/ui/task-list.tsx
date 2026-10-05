import { message } from "./errors.js";
import React, { useEffect, useRef, useState } from "react";
import { useHostNavigation, usePluginAction, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { PAGE_PATH, type Repository, type SyncReport, type SyncSettings } from "../contracts.js";
import { styles } from "./styles.js";
import { RepositoryWorkspace } from "./management-repository.js";
export interface SyncStatus { configured: boolean; settings: SyncSettings; busy: boolean; report: SyncReport | null; pendingCount: number }
export function GitHubTaskList({ context }: PluginWidgetProps) {
  return context.companyId ? <TaskSync key={context.companyId} companyId={context.companyId} projectId={context.projectId ?? undefined} /> : null;
}
function TaskSync({ companyId, projectId }: { companyId: string; projectId?: string }) {
  const nav = useHostNavigation(), status = usePluginAction("sync-status"), sync = usePluginAction("sync-now");
  const [value, setValue] = useState<SyncStatus | null>(null), [error, setError] = useState(""), [requesting, setRequesting] = useState(false);
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null), refresh = useRef<(force: boolean) => Promise<void>>(async () => {});
  function positionPopover() {
    const panel = details.current?.querySelector<HTMLElement>(".sync-popover");
    if (!details.current?.open || !panel) return;
    panel.style.transform = "";
    const rect = panel.getBoundingClientRect(), gap = parseFloat(getComputedStyle(panel).paddingLeft) || 0;
    const left = Math.max(gap, Math.min(rect.left, document.documentElement.clientWidth - rect.width - gap));
    panel.style.transform = `translateX(${left - rect.left}px)`;
  }
  useEffect(() => {
    let stopped = false, sequence = 0, inFlight = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      const request = ++sequence;
      let delay = 30_000;
      try {
        const data = await status({ companyId }) as SyncStatus;
        if (!stopped && request === sequence) { setValue(data); if (data.busy) delay = 1000; }
      } catch (e) { if (!stopped && request === sequence) setError(message(e)); }
      finally { if (!stopped && request === sequence) timer = setTimeout(() => { if (document.visibilityState !== "hidden") void poll(); else timer = setTimeout(() => void poll(), 30_000); }, delay); }
    };
    refresh.current = async force => {
      if (inFlight) return;
      inFlight = true; setRequesting(true); setError("");
      try { await sync({ companyId, ...(force ? { refresh: true } : {}) }); }
      catch (e) { if (!stopped) setError(message(e)); }
      finally { inFlight = false; if (!stopped) { setRequesting(false); await poll(); } }
    };
    const focus = () => { void refresh.current(false); };
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); } };
    void poll(); void refresh.current(false);
    window.addEventListener("focus", focus); document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", positionPopover);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener("focus", focus); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", positionPopover); };
  }, [companyId]);
  if (!value?.configured && !error) return null;
  const warnings = value?.report?.warnings ?? [];
  const busy = value?.busy || requesting;
  const healthy = !!value?.settings.enabled && !!value.report && !busy && !warnings.length && !value.pendingCount && !error;
  const label = error ? "GitHub needs attention" : !value?.settings.enabled ? "GitHub sync paused" : busy ? "Syncing GitHub…" : warnings.length || value.pendingCount ? "GitHub needs attention" : value.report ? "GitHub synced" : "Waiting for GitHub sync";
  return <div className="pcg sync-control"><style>{styles}</style><details ref={details} onToggle={positionPopover}>
    <summary aria-label={label} title={label}><span className="sync-dot" data-connected={healthy} data-attention={!!(warnings.length || error || value?.pendingCount)} />GitHub</summary>
    <section className="sync-popover" aria-label="GitHub sync">
      <strong>{label}</strong>
      {value?.report?.at && Number.isFinite(Date.parse(value.report.at)) && <p className="muted">Last synced {new Date(value.report.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!!warnings.length && <ul className="sync-warnings">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      {!!value?.pendingCount && <p>{value.pendingCount} tasks waiting to publish.</p>}
      <button onClick={() => { setPullRequestsOpen(true); if (details.current) details.current.open = false; }}>Pull requests</button>
      <div className="footer"><a {...nav.linkProps(PAGE_PATH)}>Review GitHub sync</a><button disabled={busy || value?.settings.enabled === false} onClick={() => void refresh.current(true)}>Sync now</button></div>
    </section>
  </details>{pullRequestsOpen && <PullRequestBrowser key={`${companyId}:${projectId ?? "all"}`} companyId={companyId} projectId={projectId} onClose={() => setPullRequestsOpen(false)} />}</div>;
}

export function PullRequestBrowser({ companyId, projectId, onClose }: { companyId: string; projectId?: string; onClose: () => void }) {
  const nav = useHostNavigation(), linked = usePluginAction("linked-repositories"), openTask = usePluginAction("open-record-task");
  const dialog = useRef<HTMLDialogElement>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]), [repositoryId, setRepositoryId] = useState("");
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void linked({ companyId, ...(projectId ? { projectId } : {}), refresh: retry > 0 }).then((result: any) => {
      if (!active) return;
      const repos = result.repositories as Repository[];
      setRepositories(repos);
      setRepositoryId(previous => repos.some(repo => String(repo.id) === previous) ? previous : String(repos.find(repo => repo.permissions?.pull_requests)?.id ?? repos[0]?.id ?? ""));
      if (result.warnings?.length) setError(result.warnings.join(" "));
    }).catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, projectId, retry]);
  const repository = repositories.find(repo => String(repo.id) === repositoryId);
  async function open(number: number) {
    const result = await openTask({ companyId, ...(projectId ? { projectId } : {}), repositoryId: Number(repositoryId), kind: "pull", number }) as { id: string; panel: { recordId: string } };
    nav.navigate(`/issues/${encodeURIComponent(result.id)}?${new URLSearchParams({ taskPlugin: "vllnt.paperclip-github", taskRecord: result.panel.recordId })}`);
    onClose();
  }
  return <dialog ref={dialog} className="pcg-dialog" aria-label="GitHub pull requests" onCancel={onClose} onClose={onClose}>
    <section className="pcg">
      <header className="footer"><h2>Pull requests</h2><button type="button" onClick={onClose}>Close</button></header>
      {loading && <p role="status">Loading repositories…</p>}
      {error && <div role="alert" className="error">{error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
      {!loading && !repositories.length && <p className="muted">Link a GitHub repository in Projects to manage its pull requests here.</p>}
      {!!repositories.length && <label>Repository<select aria-label="Pull request repository" value={repositoryId} onChange={event => setRepositoryId(event.target.value)}>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select></label>}
      {repository && <RepositoryWorkspace key={repository.id} companyId={companyId} repository={repository} repositories={repositories} kind="pull" onOpenRecord={open} />}
    </section>
  </dialog>;
}

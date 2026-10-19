import { LinkedIssueManager } from "./management.js";
import { message } from "./errors.js";
import React, { useEffect, useState } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { PAGE_PATH } from "../contracts.js";
import { SYNC_QUEUED_NOTICE } from "./task-list.js";
type Detail = { link: { repositoryId?: number; number: number; url: string | null; conflicts?: string[] } | null; pending: boolean; repositories: { id: number; fullName: string; issuesWrite?: boolean }[] };
export function TaskSyncDetail({ companyId, issueId }: { companyId: string; issueId: string }) {
  const detail = usePluginAction("task-sync-detail"), publish = usePluginAction("publish-task"), link = usePluginAction("link-task"), resolve = usePluginAction("resolve-task-sync"), sync = usePluginAction("sync-now"), nav = useHostNavigation();
  const [data, setData] = useState<Detail | null>(null), [repoId, setRepoId] = useState(""), [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const scope = { companyId, issueId };
  async function refresh() { const data = await detail(scope) as Detail; setData(data); setRepoId(id => data.repositories.some(r => String(r.id) === id) ? id : String(data.repositories[0]?.id ?? "")); }
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { const result = await fn() as { warning?: string }; if (result?.warning) setError(result.warning); await refresh(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void run(refresh); }, [companyId, issueId]);
  return <section className="pcg"><h2>GitHub issue</h2>
    {data?.link ? <>
      {data.link.url ? <a href={data.link.url} target="_blank" rel="noopener noreferrer">Open GitHub issue #{data.link.number} ↗</a> : <p>Repository access is unavailable. Check the project’s linked repository.</p>}
      {data.link.repositoryId && <LinkedIssueManager companyId={companyId} repositoryId={data.link.repositoryId} number={data.link.number} />}
      {!!data.link.conflicts?.length && <div className="panel"><p role="alert">Both sides changed: {data.link.conflicts.join(", ")}. Choose the version to keep for this task’s title, description and state.</p>
        <div className="footer"><button disabled={busy} onClick={() => void run(() => resolve({ ...scope, keep: "github" }))}>Use GitHub</button><button disabled={busy} onClick={() => void run(() => resolve({ ...scope, keep: "paperclip" }))}>Use Paperclip</button></div></div>}
    </> : <>
      {data?.pending && <p role="status">Creating the GitHub issue… Paperclip will link it automatically.</p>}
      {!!data?.repositories.length && <><label>Repository<select value={repoId} onChange={e => setRepoId(e.target.value)}>{data.repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select></label>
        {!data.pending && <button disabled={busy || !data.repositories.find(r => String(r.id) === repoId)?.issuesWrite} onClick={() => void run(() => publish({ ...scope, destinationId: repoId }))}>Create GitHub issue from task</button>}
        <details><summary>Link existing GitHub issue</summary><div className="details-content"><p className="muted">The linked GitHub issue stays in sync with this Paperclip task.</p><label>Issue number<input type="number" min="1" value={number} onChange={e => setNumber(e.target.value)} /></label><button disabled={busy || !number} onClick={() => void run(() => link({ ...scope, repositoryId: Number(repoId), number: Number(number) }))}>Link issue</button></div></details>
      </>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="muted">{notice}</p>}
    <div className="footer"><a {...nav.linkProps(PAGE_PATH)}>GitHub settings</a><button disabled={busy} onClick={() => void run(async () => { await sync({ companyId, refresh: true }); setNotice(SYNC_QUEUED_NOTICE); return {}; })}>Sync now</button></div>
  </section>;
}

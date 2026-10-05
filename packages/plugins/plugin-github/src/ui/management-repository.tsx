import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePluginAction, useHostNavigation, useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { Repository } from "../contracts.js";
import { ActionForm, Disclosure, ExternalLink, TaskLink, CacheNote, csvField, selectField, titleBody, useManagementAction, type Field, type Operation } from "./management-common.js";
import { message } from "./errors.js";
import { parseUnifiedDiff } from "./unified-diff.js";

type IdentityOption = { value: string; label: string; kind?: "user" | "agent"; login?: string };
function identityOptions(people: any[] = [], agents: any[] = []): IdentityOption[] {
  const users = people.flatMap(person => typeof person?.login === "string" ? [{ value: person.login, login: person.login, label: `@${person.login} · GitHub user`, kind: "user" as const }] : []);
  const bots = agents.flatMap(agent => agent?.githubEnabled && agent?.githubLogin ? [{ value: `agent:${agent.id}`, login: agent.githubLogin, label: `${agent.name} · @${agent.githubLogin}`, kind: "agent" as const }] : []);
  return [...users, ...bots];
}

export function RepositoryWorkspace({ companyId, repository, repositories, kind, initialNumber, onOpenRecord }: { companyId: string; repository: Repository; repositories: Repository[]; kind: "issue" | "pull"; initialNumber?: number; onOpenRecord?: (number: number) => void | Promise<void> }) {
  const host = useHostContext();
  const optionsAction = usePluginAction("pr-task-options");
  const run = useManagementAction("manage-repository", { companyId, repositoryId: repository.id, kind }, `${host.userId ?? "local"}:${companyId}:${repository.id}:${kind}`);
  const [cachedAt, setCachedAt] = useState<string>(), [rows, setRows] = useState<any[]>([]), [next, setNext] = useState<number | null>(null), [state, setState] = useState("open"), [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | null>(initialNumber ?? null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [identityChoices, setIdentityChoices] = useState<IdentityOption[]>([]);
  useEffect(() => {
    let active = true;
    void Promise.all([optionsAction({ companyId, repositoryId: repository.id }), run("assignees")]).then(([options, people]: any[]) => {
      if (active) setIdentityChoices(identityOptions(people?.rows ?? people ?? [], options?.agents ?? []));
    }).catch(() => { if (active) setIdentityChoices([]); });
    return () => { active = false; };
  }, [companyId, repository.id]);
  async function openRecord(number: number) {
    if (onOpenRecord) { try { await onOpenRecord(number); } catch (e) { setError(message(e)); } } else setSelected(number);
  }
  async function load(page = 1, refresh = false) {
    setBusy(true); setError("");
    try { const data = await run(kind === "issue" ? "issues" : "pulls", { state, page, refresh }); setCachedAt(data.cache?.fetchedAt); setRows(old => page === 1 ? data.rows : [...new Map([...old, ...data.rows].map(r => [r.id, r])).values()]); setNext(data.nextPage); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  useEffect(() => { if (!initialNumber) void load(); }, [state]);
  if (selected) return <RecordDetail key={selected} companyId={companyId} run={run} kind={kind} number={selected} repository={repository} repositories={repositories} back={() => { setSelected(null); void load(); }} />;
  const canWrite = repository.permissions?.[kind === "issue" ? "issues" : "pull_requests"] === "write";
  return <div className="details-content">
    <div className="row filters"><input aria-label="Search loaded items" placeholder="Search loaded items…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="GitHub state" disabled={busy} value={state} onChange={e => setState(e.target.value)}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option></select><button disabled={busy} onClick={() => void load(1, true)}>Refresh</button></div>
    <CacheNote fetchedAt={cachedAt} />
    <Disclosure title={kind === "issue" ? "New issue" : "New pull request"}>
      <ActionForm key={`new-${kind}-${identityChoices.length}`} fields={[...titleBody, ...(kind === "issue" ? [csvField("labels", "Labels (comma separated)", true), { key: "assignees", label: "Assignees", type: "identity-multi" as const, options: identityChoices, optional: true }] : [{ key: "head", label: "Head branch (or owner:branch)" }, { key: "base", label: "Base branch" }, { key: "draft", label: "Draft", type: "checkbox" as const }])]} initial={kind === "pull" ? { draft: true } : { assignees: [] }} submit={kind === "issue" ? "Create issue" : "Create pull request"} disabled={!canWrite} run={v => run(kind === "issue" ? "create-issue" : "create-pr", v)} onDone={r => openRecord(r.number)} />
      {!canWrite && <p className="muted">Enable {kind === "issue" ? "Issues" : "Pull requests"} read/write in connection settings.</p>}
    </Disclosure>
    <details><summary>Open by number</summary><ActionForm fields={[{ key: "number", label: "Issue or PR number", type: "number" }]} submit="Open" run={async v => { await openRecord(v.number); return {}; }} /></details>
    {error && <p role="alert" className="error">{error}</p>}{busy && <p role="status">Loading…</p>}
    <ul className="issues">{rows.filter(r => `${r.number} ${r.title}`.toLowerCase().includes(search.toLowerCase())).map(row => <li key={row.id}><button className="item-link" onClick={() => void openRecord(row.number)}>#{row.number} {row.title}</button>{kind === "issue" && <TaskLink item={row} />}<p className="muted">{row.draft ? "Draft" : row.merged_at ? "Merged" : row.state} · {row.user?.login}{row.assignees?.length ? ` · ${row.assignees.map((a: any) => a.login).join(", ")}` : ""}</p></li>)}</ul>
    {!busy && !error && !rows.length && <p className="muted">No {kind === "issue" ? "issues" : "pull requests"} on this page.</p>}
    {next && <button disabled={busy} onClick={() => void load(next)}>Load more</button>}
    <RepoTaxonomy run={run} repository={repository} />
  </div>;
}
function safeMarkdownUrl(url: string) {
  try {
    const parsed = new URL(url, "https://github.com");
    return ["https:", "http:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch { return undefined; }
}
function MarkdownContent({ value, empty = "No description." }: { value?: string | null; empty?: string }) {
  const text = (value ?? "").replace(/\n?<!-- paperclip:[a-zA-Z0-9-]+:[a-zA-Z0-9-]+ -->/g, "").trim();
  if (!text) return <p className="muted">{empty}</p>;
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl} components={{
    a: ({ href, children }) => { const safe = href ? safeMarkdownUrl(href) : undefined; return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>; },
    pre: ({ children }) => <pre className="diff">{children}</pre>,
  }}>{text}</ReactMarkdown></div>;
}

const DraftScope = createContext("");
function readDraft(key: string) { try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; } }
function saveDraft(key: string, value: unknown) { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Drafts remain in memory if storage is unavailable. */ } }
function RecordForm({ draftId, ...props }: React.ComponentProps<typeof ActionForm> & { draftId?: string }) {
  const scope = useContext(DraftScope);
  const key = `${scope}:form:${JSON.stringify([draftId,props.title,props.submit,props.fields?.map(f => f.key)])}`;
  const initial = { ...props.initial, ...readDraft(key) };
  const values = useRef<Record<string, any>>(initial);
  return <div onChangeCapture={event => {
    const input = event.target as HTMLInputElement;
    const field = props.fields?.find(f => f.label === input.getAttribute("aria-label"));
    const name = field && field.type !== "checkbox" ? field.key : null;
    if (name) { values.current = { ...values.current, [name]: input.type === "checkbox" ? input.checked : input.value }; saveDraft(key,values.current); }
  }}><ActionForm {...props} initial={initial} run={async value => { const result = await props.run(value); saveDraft(key,null); return result; }} /></div>;
}

export function RecordDialog({ title, children, triggerLabel, triggerClass, disabled }: { title: string; children: React.ReactNode; triggerLabel?: React.ReactNode; triggerClass?: string; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  function close() { dialog.current?.close(); setOpen(false); trigger.current?.focus(); }
  return <><button type="button" ref={trigger} className={triggerClass} aria-label={triggerLabel !== undefined ? title : undefined} onClick={() => setOpen(true)} disabled={disabled}>{triggerLabel ?? title}</button>{open && <dialog ref={dialog} className="pcg record-dialog" aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}><div className="footer"><h3>{title}</h3><button type="button" aria-label={`Close ${title}`} onClick={close}>Close</button></div><div className="details-content">{children}</div></dialog>}</>;
}

export function RecordDetail({ companyId, run, kind, number, repository, repositories, back, embedded = false }: { companyId: string; run: Operation; kind: "issue" | "pull"; number: number; repository: Repository; repositories: Repository[]; back: () => void; embedded?: boolean }) {
  const host = useHostContext();
  const optionsAction = usePluginAction("pr-task-options");
  const [identityChoices, setIdentityChoices] = useState<IdentityOption[]>([]);
  const [data, setData] = useState<any>(null), [meta, setMeta] = useState<any>(null), [pinStatus, setPinStatus] = useState<{ isPinned: boolean } | null>(null), [subscription, setSubscription] = useState<any>(null), [tab, setTab] = useState("Conversation"), [error, setError] = useState("");
  const [reviewerChoices, setReviewerChoices] = useState<IdentityOption[]>([]);
  const act: Operation = (op, params = {}) => run(op, { number, ...params });
  async function refresh(fresh = true) {
    setError("");
    try {
      const d = await act(kind, { refresh: fresh }); setData(d);
      if (kind === "pull") {
        const requested = Array.isArray(d?.requested_reviewers) ? d.requested_reviewers.flatMap((item: any) => typeof item?.login === "string" ? [{ value: item.login, label: `@${item.login} · GitHub user`, kind: "user" as const }] : []) : [];
        setReviewerChoices(current => [...current, ...requested.filter((item: IdentityOption) => !current.some(existing => existing.value === item.value))]);
      }
      setMeta(kind === "pull" ? await act("issue", { refresh: fresh }) : d); if (kind === "issue") setPinStatus(await act("pin-status", { refresh: fresh })); try { setSubscription(await act("subscription", { refresh: fresh })); } catch { setSubscription(null); }
    }
    catch (e) { setError(message(e)); }
  }
  useEffect(() => { void refresh(false); }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([optionsAction({ companyId, repositoryId: repository.id }), run("assignees")]).then(([options, people]: any[]) => {
      if (active) setIdentityChoices(identityOptions(people?.rows ?? people ?? [], options?.agents ?? []));
    }).catch(() => { if (active) setIdentityChoices([]); });
    return () => { active = false; };
  }, [companyId, repository.id]);
  useEffect(() => {
    let active = true;
    void Promise.all([optionsAction({ companyId, repositoryId: repository.id }), run("assignees")]).then(([options, people]: any[]) => {
      if (active) setReviewerChoices(identityOptions(people?.rows ?? people ?? [], options?.agents ?? []));
    }).catch(() => { if (active) setReviewerChoices([]); });
    return () => { active = false; };
  }, [companyId, repository.id]);
  const target = `${repository.fullName}#${number}`;
  const canWrite = repository.permissions?.[kind === "pull" ? "pull_requests" : "issues"] === "write";
  return <DraftScope.Provider value={`github-draft:${host.userId ?? "local"}:${companyId}:${repository.id}:${kind}:${number}` }><div className="details-content">{!embedded && <button onClick={back}>Back to {kind === "pull" ? "pull requests" : "issues"}</button>}
    {error && <p role="alert" className="error">{error}</p>}
    {data && <><header className="record-header"><div className="record-toolbar"><span className="muted">{repository.fullName}</span><div className="row"><button title={data.cache?.fetchedAt ? `Updated ${new Date(data.cache.fetchedAt).toLocaleTimeString()}` : "Fetch latest GitHub data"} onClick={() => void refresh()}>Refresh</button>      <RecordDialog title="Actions"><div className="record-actions">{!canWrite && <p role="status" className="muted">This App has read-only access. Enable {kind === "pull" ? "Pull requests" : "Issues"} write access in GitHub connection settings to make changes.</p>}

        {kind === "pull" && <p className="muted">{data.head?.label} → {data.base?.label}{data.state === "open" && !data.merged ? ` · ${data.mergeable === null ? "Mergeability being calculated" : data.mergeable ? "No merge conflicts" : "Has merge conflicts"} · ${data.mergeable_state ?? ""}` : ""}</p>}
        <RecordDialog title="Edit details"><RecordForm draftId="record-edit" key={`${data.updated_at}:edit`} fields={[...titleBody, ...(kind === "pull" ? [{ key: "base", label: "Base branch" }] : [])]} initial={{ title: data.title, body: data.body ?? "", base: data.base?.ref }} disabled={!canWrite} run={v => act(kind === "pull" ? "edit-pr" : "edit-issue", v)} onDone={() => refresh()} /></RecordDialog>
        <RecordDialog title="Assignees, labels & milestone"><RecordForm draftId="record-triage" key={`${meta?.updated_at}:triage:${identityChoices.length}`} fields={[{ key: "assignees", label: "Assignees", type: "identity-multi", options: identityChoices, optional: true }, csvField("labels", "Labels (comma separated)"), { key: "milestone", label: "Milestone number (blank removes it)", type: "number", optional: true }]} initial={{ assignees: (meta?.assignees ?? []).map((a: any) => identityChoices.find(option => option.login?.toLowerCase() === String(a.login).toLowerCase() || option.value === a.login)?.value ?? a.login), labels: meta?.labels?.map((l: any) => typeof l === "string" ? l : l.name).join(", ") ?? "", milestone: meta?.milestone?.number ?? "" }} disabled={!canWrite} run={v => act("edit-issue", { ...v, milestone: v.milestone ?? null })} onDone={() => refresh()} /></RecordDialog>
        {!data.merged && <RecordDialog title="State"><RecordForm key={`${data.updated_at}:state`} fields={[selectField("state", "State", ["open", "closed"]), ...(kind === "issue" ? [selectField("stateReason", "Closing reason", ["completed", "not_planned"])] : [])]} initial={{ state: data.state, stateReason: data.state_reason === "not_planned" ? "not_planned" : "completed" }} disabled={!canWrite} run={v => act(kind === "pull" ? "edit-pr" : "edit-issue", { ...v, ...(v.state === "open" && kind === "issue" ? { stateReason: "reopened" } : {}) })} onDone={() => refresh()} />
          {kind === "pull" && data.state === "open" && <RecordForm submit={data.draft ? "Ready for review" : "Convert to draft"} disabled={!canWrite} run={() => act(data.draft ? "ready-pr" : "draft-pr")} onDone={() => refresh()} />}
        </RecordDialog>}
        {kind === "pull" && data.state === "open" && <>
          <ReviewDelegation companyId={companyId} repositoryId={repository.id} number={number} sha={data.head.sha} />
          <RecordDialog title="Reviewers"><p className="muted">Requested: {[...(data.requested_reviewers ?? []).map((r: any) => r.login), ...(data.requested_teams ?? []).map((r: any) => r.slug)].join(", ") || "None"}</p><RecordForm key={`reviewers:${reviewerChoices.length}:${data.updated_at}`} fields={[selectField("action", "Action", ["request", "remove"]), { key: "reviewers", label: "Reviewers", type: "identity-multi", options: reviewerChoices, optional: true }, csvField("teams", "Team slugs (comma separated)")]} initial={{ action: "request", reviewers: (data.requested_reviewers ?? []).map((r: any) => reviewerChoices.find(option => option.login?.toLowerCase() === String(r.login).toLowerCase() || option.value === r.login)?.value ?? r.login), teams: (data.requested_teams ?? []).map((r: any) => r.slug).join(", ") }} submit="Update reviewers" disabled={!canWrite} run={v => act(v.action === "remove" ? "remove-reviewers" : "request-reviewers", { reviewers: v.reviewers, reviewerAgentIds: v.reviewersAgentIds, teams: v.teams })} onDone={() => refresh()} /></RecordDialog>
          <RecordDialog title="Merge">{repository.permissions?.contents !== "write" && <p className="muted">Contents write access is required to merge this pull request.</p>}{data.draft && <p className="muted">Mark this draft ready for review before merging.</p>}<p className="muted">GitHub enforces required checks, reviews and branch rules. The reviewed commit must still match.</p>
            <RecordForm draftId={`merge:${data.head.sha}`} key={data.head.sha} fields={[selectField("method", "Merge method", ["squash", "merge", "rebase"]), { key: "auto", label: "Merge automatically when GitHub requirements pass", type: "checkbox" }]} initial={{ method: "squash", auto: false }} submit="Confirm merge" confirmation={target} disabled={data.draft || repository.permissions?.contents !== "write"} run={v => act(v.auto ? "enable-auto-merge" : "merge-pr", { method: v.method, sha: data.head.sha, confirm: v.confirm })} onDone={() => refresh()} />
            {data.auto_merge && <RecordForm submit="Disable auto-merge" run={() => act("disable-auto-merge")} onDone={() => refresh()} />}
            <RecordForm submit="Update branch from base" disabled={!canWrite} run={() => act("update-branch", { sha: data.head.sha })} onDone={() => refresh()} />
          </RecordDialog>
        </>}
        {kind === "issue" && <RecordForm title="Repository pin" key={`${pinStatus?.isPinned ? "pinned" : "unpinned"}:${data.updated_at}`} submit={pinStatus?.isPinned ? "Unpin issue" : "Pin issue"} note={pinStatus?.isPinned ? "This issue is pinned in the repository’s issue list." : "Pin this issue to the repository’s issue list."} disabled={!canWrite || !pinStatus} run={() => act(pinStatus?.isPinned ? "unpin-issue" : "pin-issue")} onDone={() => refresh()} />}
        <RecordForm title="Notifications" key={`${subscription?.subscribed ? "subscribed" : "unsubscribed"}:${data.updated_at}`} submit={subscription?.subscribed ? "Unsubscribe" : "Subscribe"} note={subscription?.subscribed ? "GitHub notifications are enabled for this item." : "Subscribe to GitHub notifications for this item."} disabled={!canWrite || !subscription} run={() => act(subscription?.subscribed ? "unsubscribe" : "subscribe")} onDone={() => refresh()} />
        <RecordDialog title="More actions">
          <RecordForm fields={meta?.locked ? [] : [selectField("reason", "Lock reason", ["resolved", "off-topic", "too heated", "spam"])]} initial={{ reason: "resolved" }} submit={meta?.locked ? "Unlock conversation" : "Lock conversation"} disabled={!canWrite} run={v => act(meta?.locked ? "unlock" : "lock", v)} onDone={() => refresh()} />
          {kind === "issue" && <><RecordForm title="Transfer issue" fields={[{ key: "destinationRepositoryId", label: "Destination repository", options: [{ value: "", label: "Choose repository" }, ...repositories.filter(r => r.id !== repository.id).map(r => ({ value: String(r.id), label: r.fullName }))] }]} submit="Transfer issue" confirmation={target} note="The issue will move to the selected repository. GitHub may require repository admin access." run={v => act("transfer-issue", { ...v, destinationRepositoryId: Number(v.destinationRepositoryId) })} onDone={back} />
            <RecordForm title="Delete issue" submit="Delete issue" destructive confirmation={target} note="Permanently deletes the GitHub issue. Its Paperclip task is retained. GitHub may require repository admin access." run={v => act("delete-issue", v)} onDone={back} /></>}
        </RecordDialog>
      </div></RecordDialog></div></div><h2>#{number} {data.title}</h2><div className="record-byline"><span className="badge" data-state={data.merged ? "merged" : data.state}>{data.merged ? "Merged" : data.draft ? "Draft" : data.state}</span><span className="muted">{data.user?.login}</span><ExternalLink url={`https://github.com/${repository.fullName}/${kind === "pull" ? "pull" : "issues"}/${number}`}>GitHub</ExternalLink>{kind === "issue" && !embedded && <TaskLink item={data} />}</div></header>
        <dl className="record-metadata">
          {!!meta?.assignees?.length && <div><dt>Assignees</dt><dd>{meta.assignees.map((a: any) => a.login).join(", ")}</dd></div>}
          {!!meta?.labels?.length && <div><dt>Labels</dt><dd>{meta.labels.map((l: any) => typeof l === "string" ? l : l.name).join(", ")}</dd></div>}
          {kind === "issue" && pinStatus && <div><dt>Repository</dt><dd>{pinStatus.isPinned ? <span className="badge" data-state="pinned">Pinned</span> : "Not pinned"}</dd></div>}
          {subscription && <div><dt>Notifications</dt><dd><span className="badge" data-state={subscription.subscribed ? "open" : "closed"}>{subscription.subscribed ? "Subscribed" : "Muted"}</span></dd></div>}
          {meta?.milestone?.title && <div><dt>Milestone</dt><dd>{meta.milestone.title}</dd></div>}
          {!!data.requested_reviewers?.length && <div><dt>Reviewers</dt><dd>{data.requested_reviewers.map((r: any) => r.login).join(", ")}</dd></div>}
          {kind === "pull" && Number.isFinite(data.changed_files) && <div><dt>Changes</dt><dd>{data.changed_files} {data.changed_files === 1 ? "file" : "files"} · +{data.additions} −{data.deletions}</dd></div>}
        </dl>
      <div className="record-tabs" role="tablist" aria-label="Item sections">{["Conversation", ...(kind === "pull" ? ["Files", "Reviews", "Checks", "Commits"] : [])].map(t => <button role="tab" aria-selected={tab === t} key={t} onClick={() => setTab(t)}>{t}</button>)}</div>

      <div className="record-tab-panel" hidden={tab !== "Conversation"}><Conversation run={act} target={target} canWrite={canWrite} locked={!!meta?.locked} body={data.body} reactions={data.reactions} author={data.user?.login} createdAt={data.created_at} number={number} disabledReason={meta?.locked ? "GitHub conversation is locked. Unlock it in Actions to comment." : `${kind === "pull" ? "Pull requests" : "Issues"} write access is required to comment.`} /></div>
      {tab === "Files" && <Files run={act} sha={data.head.sha} canWrite={canWrite} />}
      {tab === "Reviews" && <Reviews run={act} sha={data.head.sha} target={target} canWrite={canWrite} />}
      {tab === "Checks" && <Checks run={act} canWrite={repository.permissions?.checks === "write"} />}
      {tab === "Commits" && <PagedRows run={act} op="commits" render={r => <><strong>{r.sha.slice(0, 7)}</strong> {r.commit?.message}</>} />}
    </>}
  </div></DraftScope.Provider>;
}

function PagedRows({ run, op, render, refreshKey = 0 }: { run: Operation; op: string; render: (row: any) => React.ReactNode; refreshKey?: number }) {
  const [rows, setRows] = useState<any[]>([]), [next, setNext] = useState<number | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function load(page = 1) { setBusy(true); setError(""); try { const data = await run(op, { page }); setRows(old => { const rows = page === 1 ? data.rows : [...old, ...data.rows]; return op === "comments" ? [...rows].sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "")) : rows; }); setNext(data.nextPage); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, [refreshKey]);
  return <div className="details-content">{error && <p role="alert" className="error">{error}</p>}{busy && <p role="status">Loading…</p>}
    {!busy && !error && !rows.length && <p className="muted">Nothing here yet.</p>}<ul className="issues">{rows.map((r, i) => <li key={r.id ?? r.sha ?? r.filename ?? i}>{render(r)}</li>)}</ul>{next && <button disabled={busy} onClick={() => void load(next)}>Load more</button>}</div>;
}
function Conversation({ run, target, canWrite, locked, body, reactions, author, createdAt, number, disabledReason }: { run: Operation; target: string; canWrite: boolean; locked?: boolean; body?: string; reactions?: any; author?: string; createdAt?: string; number: number; disabledReason?: string }) {
  const [version, setVersion] = useState(0), refresh = () => setVersion(v => v + 1);
  return <section className="record-conversation">
    <article className="record-comment"><div className="record-byline"><strong>{author ?? "Author"}</strong>{createdAt && <time dateTime={createdAt}>{new Date(createdAt).toLocaleString()}</time>}<ReactionPicker number={number} reactions={reactions} run={run} onDone={refresh} disabled={!canWrite} ariaLabel="Issue reactions" /></div><MarkdownContent value={body} /></article>
    <PagedRows run={run} op="comments" refreshKey={version} render={r => <article className="record-comment"><div className="record-byline"><strong>{r.user?.login}</strong>{r.created_at && <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>}<ReactionPicker commentId={r.id} reactions={r.reactions} run={run} onDone={refresh} disabled={!canWrite} ariaLabel="Comment reactions" /><RecordDialog title="Edit or delete comment"><RecordForm draftId={`comment-edit:${r.id}`} fields={[{ key: "body", label: "Comment", type: "textarea" }]} initial={{ body: r.body }} run={v => run("edit-comment", { commentId: r.id, ...v })} onDone={refresh} disabled={!canWrite} /><RecordForm submit="Delete comment" destructive confirmation={target} run={v => run("delete-comment", { commentId: r.id, ...v })} onDone={refresh} disabled={!canWrite} /></RecordDialog></div><MarkdownContent value={r.body} /></article>} />
    <CommentComposer canWrite={canWrite && !locked} run={run} onDone={refresh} disabledReason={disabledReason} />
  </section>;
}
const GITHUB_REACTIONS = [
  { content: "+1", emoji: "👍", label: "Like" },
  { content: "-1", emoji: "👎", label: "Dislike" },
  { content: "laugh", emoji: "😄", label: "Laugh" },
  { content: "hooray", emoji: "🎉", label: "Hooray" },
  { content: "confused", emoji: "😕", label: "Confused" },
  { content: "heart", emoji: "❤️", label: "Heart" },
  { content: "rocket", emoji: "🚀", label: "Rocket" },
  { content: "eyes", emoji: "👀", label: "Eyes" },
] as const;

function ReactionPicker({ commentId, number, reactions, run, onDone, disabled, ariaLabel = "Comment reactions" }: { commentId?: number; number?: number; reactions?: any; run: Operation; onDone: () => void; disabled?: boolean; ariaLabel?: string }) {
  const counts = reactions && typeof reactions === "object" ? reactions as Record<string, unknown> : {};
  const visible = GITHUB_REACTIONS.filter(reaction => Number(counts[reaction.content]) > 0);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  async function react(content: string) {
    if (busy || disabled) return;
    setBusy(content); setError("");
    try {
      if (typeof number === "number") await run("react-body", { number, content });
      else if (typeof commentId === "number") await run("react-comment", { commentId, content });
      onDone();
    }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  }
  return <div className="record-reactions" aria-label={ariaLabel}>
    {visible.map(reaction => <button key={reaction.content} type="button" className="record-reaction-chip" title={`Add ${reaction.label} reaction`} aria-label={`${reaction.label} reaction, ${Number(counts[reaction.content])} currently`} disabled={disabled || busy !== null} onClick={() => void react(reaction.content)}><span aria-hidden="true">{reaction.emoji}</span><span>{Number(counts[reaction.content])}</span></button>)}
    <RecordDialog title="Add reaction" triggerLabel={<span aria-hidden="true">＋</span>} triggerClass="record-reaction-trigger" disabled={disabled || busy !== null}>
      <div className="github-reaction-grid" role="group" aria-label="GitHub reactions">
        {GITHUB_REACTIONS.map(reaction => <button key={reaction.content} type="button" className="github-reaction-option" aria-label={`Add ${reaction.label} reaction`} title={reaction.label} disabled={busy !== null} onClick={() => void react(reaction.content)}><span aria-hidden="true">{reaction.emoji}</span><span>{reaction.label}</span>{Number(counts[reaction.content]) > 0 && <small>{Number(counts[reaction.content])}</small>}</button>)}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </RecordDialog>
  </div>;
}

function CommentComposer({ canWrite, run, onDone, disabledReason }: { canWrite: boolean; run: Operation; onDone: () => void; disabledReason?: string }) {
  const scope = useContext(DraftScope);
  const draftKey = `${scope}:comment`;
  const [body, setBody] = useState(() => readDraft(draftKey)?.body ?? ""), [preview, setPreview] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!body.trim() || busy || !canWrite) return; setBusy(true); setError(""); try { await run("comment", { body }); setBody(""); saveDraft(draftKey,null); onDone(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <form className="record-composer" onSubmit={event => void submit(event)}><div className="row" role="tablist" aria-label="Comment editor"><button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>Write</button><button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)}>Preview</button></div>
    {preview ? <div className="comment-preview"><MarkdownContent value={body} empty="Nothing to preview." /></div> : <textarea aria-label="Comment" placeholder="Leave a comment…" value={body} onChange={event => { setBody(event.target.value); saveDraft(draftKey,{body:event.target.value}); }} disabled={busy || !canWrite} />}
    {error && <p role="alert" className="error">{error}</p>}<div className="footer"><span className="muted">{canWrite ? "Comment on GitHub · posted as your GitHub App" : disabledReason ?? "Issues write access is required to comment."}</span><button className="primary" type="submit" disabled={busy || !canWrite || !body.trim()}>{busy ? "Posting…" : "Post comment"}</button></div>
  </form>;
}
function InlineComment({ run, sha, file, canWrite, line, side, triggerLabel }: { run: Operation; sha: string; file: string; canWrite: boolean; line?: number; side?: "LEFT" | "RIGHT"; triggerLabel?: React.ReactNode }) {
  return <RecordDialog title={line ? `Comment on ${side === "LEFT" ? "old" : "new"} line ${line}` : "Comment on line"} triggerLabel={triggerLabel} triggerClass={line ? "diff-line-action" : undefined}><RecordForm draftId={`inline:${file}:${sha}:${side ?? "RIGHT"}:${line ?? "manual"}`} fields={[{ key: "line", label: "Line number", type: "number" }, selectField("side", "Side", ["RIGHT", "LEFT"]), { key: "body", label: "Review comment", type: "textarea" }]} initial={{ line: line ?? "", side: side ?? "RIGHT" }} submit="Comment on line" disabled={!canWrite} run={v => run("inline-comment", { ...v, path: file, sha })} /></RecordDialog>;
}
function FilePatch({ row, run, sha, canWrite }: { row: any; run: Operation; sha: string; canWrite: boolean }) {
  const lines = typeof row.patch === "string" ? parseUnifiedDiff(row.patch) : [];
  return <section className="record-file"><h3>{row.filename} · +{row.additions} −{row.deletions}</h3>
    {lines.length ? <div className="unified-diff" role="region" aria-label={`Changes in ${row.filename}`} tabIndex={0}><table><tbody>{lines.map((line, index) => <tr key={index} data-kind={line.kind}><td className="diff-number">{line.oldLine}</td><td className="diff-number">{line.newLine}</td><td className="diff-comment-cell">{canWrite && line.comment && <InlineComment run={run} sha={sha} file={row.filename} canWrite={canWrite} line={line.comment.line} side={line.comment.side} triggerLabel="+" />}</td><td className="diff-source"><span className="diff-sign">{line.kind === "added" ? "+" : line.kind === "deleted" ? "−" : " "}</span>{line.text}</td></tr>)}</tbody></table></div> : <p className="muted">Patch unavailable. Open the file on GitHub.</p>}
    <div className="row"><ExternalLink url={row.blob_url}>Open file</ExternalLink><InlineComment run={run} sha={sha} file={row.filename} canWrite={canWrite} /></div>
  </section>;
}
function Files({ run, sha, canWrite }: { run: Operation; sha: string; canWrite: boolean }) {
  return <><p className="muted">Commit {sha.slice(0, 7)}. Binary or large file patches may be unavailable from GitHub.</p><PagedRows run={run} op="files" render={row => <FilePatch row={row} run={run} sha={sha} canWrite={canWrite} />} /></>;
}
function Reviews({ run, sha, target, canWrite }: { run: Operation; sha: string; target: string; canWrite: boolean }) {
  const [version, setVersion] = useState(0), refresh = () => setVersion(v => v + 1);
  return <><p className="muted">Reviews are submitted as your GitHub App against commit {sha.slice(0, 7)}. Required human approvals still follow repository rules.</p>
    <RecordForm draftId={`review:${sha}`} key={`review:${version}`} fields={[selectField("event", "Review decision", ["COMMENT", "APPROVE", "REQUEST_CHANGES"]), { key: "body", label: "Review summary", type: "textarea" }]} initial={{ event: "COMMENT" }} submit="Submit review" disabled={!canWrite} run={v => run("review", { ...v, sha })} onDone={() => refresh()} />
    <PagedRows run={run} op="reviews" refreshKey={version} render={r => <><strong>{r.user?.login} · {r.state}</strong><MarkdownContent value={r.body} />{["APPROVED", "CHANGES_REQUESTED"].includes(r.state) && <RecordDialog title="Dismiss review"><RecordForm draftId={`dismiss:${r.id}`} fields={[{ key: "body", label: "Dismissal reason", type: "textarea" }]} submit="Dismiss review" confirmation={target} disabled={!canWrite} run={v => run("dismiss-review", { ...v, reviewId: r.id })} onDone={() => refresh()} /></RecordDialog>}</>} />
    <section className="record-section"><h3>Review comments</h3><PagedRows run={run} op="review-comments" refreshKey={version} render={r => <><strong>{r.user?.login} · {r.path}:{r.line ?? r.original_line}</strong><ReactionPicker commentId={r.id} reactions={r.reactions} run={(op, params) => run(op, op === "react-comment" ? { ...params, review: true } : params)} onDone={() => refresh()} disabled={!canWrite} ariaLabel="Review comment reactions" /><MarkdownContent value={r.body} /><RecordForm draftId={`reply:${r.id}`} fields={[{ key: "body", label: "Reply", type: "textarea" }]} submit="Reply" run={v => run("reply-review-comment", { ...v, commentId: r.id })} onDone={() => refresh()} disabled={!canWrite} /><RecordDialog title="Edit or delete"><RecordForm draftId={`review-comment-edit:${r.id}`} fields={[{ key: "body", label: "Review comment", type: "textarea" }]} initial={{ body: r.body }} run={v => run("edit-review-comment", { ...v, commentId: r.id })} onDone={() => refresh()} disabled={!canWrite} /><RecordForm submit="Delete review comment" confirmation={target} destructive run={v => run("delete-review-comment", { ...v, commentId: r.id })} onDone={() => refresh()} disabled={!canWrite} /></RecordDialog></>} /></section>
    <Threads key={version} run={run} canWrite={canWrite} />
  </>;
}
function Threads({ run, canWrite }: { run: Operation; canWrite: boolean }) {
  const [rows, setRows] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState("");
  async function load(after?: string) { try { const d = (await run("threads", { cursor: after ?? null })).node.reviewThreads; setRows(old => after ? [...old, ...d.nodes] : d.nodes); setCursor(d.pageInfo.hasNextPage ? d.pageInfo.endCursor : null); } catch (e) { setError(message(e)); } }
  useEffect(() => { void load(); }, []);
  return <section className="record-section"><h3>Review threads</h3>{error && <p role="alert" className="error">{error}</p>}{rows.map(r => <div key={r.id} className="panel"><p><strong>{r.isResolved ? "Resolved" : "Unresolved"}</strong>{r.comments.nodes[0]?.path ? ` · ${r.comments.nodes[0].path}` : ""}</p><div className="thread-comments">{(r.comments.nodes ?? []).map((comment: any, index: number) => <article className="record-comment" key={comment.id ?? index}><MarkdownContent value={comment.body} /></article>)}</div>{r.comments.nodes?.[0]?.id && <RecordForm draftId={`thread-reply:${r.comments.nodes[0].id}`} fields={[{ key: "body", label: "Reply", type: "textarea" }]} submit="Reply to thread" disabled={!canWrite} run={v => run("reply-review-comment", { ...v, commentId: r.comments.nodes[0].id })} onDone={() => load()} />}<RecordForm submit={r.isResolved ? "Reopen thread" : "Resolve thread"} disabled={!canWrite} run={() => run(r.isResolved ? "unresolve-thread" : "resolve-thread", { threadId: r.id })} onDone={() => load()} /></div>)}{cursor && <button onClick={() => void load(cursor)}>Load more threads</button>}</section>;
}
function Checks({ run, canWrite }: { run: Operation; canWrite: boolean }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [busy, setBusy] = useState<number | null>(null);
  async function load(page = 1) { try { setError(""); const d = await run("checks", { page }); setData((old: any) => page > 1 && old ? { ...d, checks: [...old.checks, ...d.checks], statuses: [...old.statuses, ...d.statuses] } : d); } catch (e) { setError(message(e)); } }
  async function rerun(id: number) { if (!canWrite || busy !== null) return; setBusy(id); setError(""); try { await run("rerequest-check", { checkRunId: id }); await load(); } catch (e) { setError(message(e)); } finally { setBusy(null); } }
  useEffect(() => { void load(); }, []);
  return <div className="details-content"><div className="footer"><span className="muted">Commit {data?.sha?.slice(0, 7) ?? "—"}</span><button onClick={() => void load()} disabled={busy !== null}>Refresh checks</button></div>{!canWrite && <p className="muted">Enable Checks read/write on the GitHub App to re-run checks.</p>}{error && <p role="alert">{error}</p>}{data?.warnings.map((w: string) => <p role="alert" key={w}>{w}</p>)}{data && <><ul className="issues">{data.checks.map((c: any) => <li key={c.id}><div className="footer"><span><strong>{c.name}</strong> · <span className="check-state" data-state={c.conclusion ?? c.status}>{c.conclusion ?? c.status}</span></span><div className="row">{(c.html_url || c.details_url) && <ExternalLink url={c.html_url || c.details_url}>Details</ExternalLink>}<button disabled={!canWrite || busy !== null} onClick={() => void rerun(c.id)}>{busy === c.id ? "Re-running…" : "Re-run"}</button></div></div>{c.started_at && <p className="muted">Started {new Date(c.started_at).toLocaleString()}</p>}</li>)}{data.statuses.map((s: any) => <li key={s.id}><strong>{s.context}</strong> · <span className="check-state" data-state={s.state}>{s.state}</span><p className="muted">{s.description}</p></li>)}</ul>{!data.checks.length && !data.statuses.length && !data.warnings.length && <p>No checks reported.</p>}{data.nextPage && <button onClick={() => void load(data.nextPage)}>Load more checks</button>}</>}</div>;
}
function RepoTaxonomy({ run, repository }: { run: Operation; repository: Repository }) {
  const [open, setOpen] = useState(false), [version, setVersion] = useState(0), refresh = () => setVersion(v => v + 1);
  const labelFields: Field[] = [{ key: "name", label: "Label name" }, { key: "color", label: "Color (six hex digits)" }, { key: "description", label: "Description", optional: true }];
  const milestoneFields: Field[] = [...titleBody, selectField("state", "State", ["open", "closed"]), { key: "dueOn", label: "Due date", type: "date", optional: true }];
  return <details className="panel" onToggle={e => setOpen(e.currentTarget.open)}><summary>Repository labels & milestones</summary>{open && <div className="details-content">
    <Disclosure title="Labels"><PagedRows run={run} op="labels" refreshKey={version} render={r => <Disclosure title={r.name}><ActionForm fields={labelFields} initial={{ name: r.name, color: r.color, description: r.description ?? "" }} run={v => run("edit-label", { ...v, currentName: r.name })} onDone={() => refresh()} /><ActionForm submit="Delete label" confirmation={r.name} destructive run={v => run("delete-label", { ...v, name: r.name })} onDone={() => refresh()} /></Disclosure>} /><ActionForm title="New label" fields={labelFields} initial={{ color: "808080" }} submit="Create label" run={v => run("create-label", v)} onDone={() => refresh()} /></Disclosure>
    <Disclosure title="Milestones"><PagedRows run={run} op="milestones" refreshKey={version} render={r => <Disclosure title={`#${r.number} ${r.title}`}><ActionForm fields={milestoneFields} initial={{ title: r.title, body: r.description ?? "", state: r.state, dueOn: r.due_on?.slice(0, 10) ?? "" }} run={v => run("edit-milestone", { ...v, milestone: r.number, dueOn: v.dueOn ?? null })} onDone={() => refresh()} /><ActionForm submit="Delete milestone" confirmation={`${repository.fullName}/milestone/${r.number}`} destructive run={v => run("delete-milestone", { ...v, milestone: r.number })} onDone={() => refresh()} /></Disclosure>} /><ActionForm title="New milestone" fields={milestoneFields} initial={{ state: "open" }} submit="Create milestone" run={v => run("create-milestone", v)} onDone={() => refresh()} /></Disclosure>
  </div>}</details>;
}

function ReviewDelegationForm({ companyId, repositoryId, number, sha }: { companyId: string; repositoryId: number; number: number; sha: string }) {
  const [options, setOptions] = useState<any>(null), [error, setError] = useState(""), [tasks, setTasks] = useState<any[]>([]), [selected, setSelected] = useState<string[]>([]), [projectId, setProjectId] = useState(""), [wake, setWake] = useState(false), [busy, setBusy] = useState(false);
  const load = usePluginAction("pr-task-options"), create = usePluginAction("review-pr-task"), requestReviewers = useManagementAction("manage-agent-reviewers", { companyId, repositoryId }, `${companyId}:${repositoryId}:pull:reviewers`), nav = useHostNavigation();
  useEffect(() => { let active = true; void load({ companyId, repositoryId }).then((o: any) => { if (active) { setOptions(o); setProjectId(String(o?.projects?.[0]?.id ?? "")); } }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [companyId, repositoryId]);
  function toggle(agentId: string) { setSelected(current => current.includes(agentId) ? current.filter(id => id !== agentId) : [...current, agentId]); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!projectId || !selected.length || busy) return;
    setBusy(true); setError("");
    try {
      await requestReviewers("request", { number, agentIds: selected });
      const result: any = await create({ companyId, repositoryId, number, sha, projectId, agentIds: selected, reviewerAgentIds: selected, wake });
      setTasks(Array.isArray(result?.tasks) ? result.tasks : [result]); setSelected([]);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <div className="details-content">
    {error && <p role="alert" className="error">{error}</p>}
    {options && (options.projects.length ? <form onSubmit={event => void submit(event)}>
      <label>Paperclip project<select aria-label="Paperclip project" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={busy}>{options.projects.map((project: any) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <fieldset className="review-bot-list" disabled={busy}><legend>GitHub reviewers</legend>{options.agents.map((agent: any) => <label className="row review-bot-option" key={agent.id} title={agent.githubEnabled ? `@${agent.githubLogin}` : "Configure a GitHub bot identity in Agent settings first"}><input type="checkbox" aria-label={agent.name} checked={selected.includes(agent.id)} onChange={() => toggle(agent.id)} disabled={!agent.githubEnabled} /><span>{agent.name}</span><span className="muted">{agent.githubEnabled ? `@${agent.githubLogin}` : "GitHub bot not configured"}</span></label>)}{!options.agents.length && <p className="muted">No available agents.</p>}</fieldset>
      <label className="row"><input type="checkbox" checked={wake} onChange={event => setWake(event.target.checked)} disabled={busy} /> Start each agent using normal run controls</label>
      <div className="footer"><span className="muted">Revision {sha.slice(0, 7)}</span><button className="primary" type="submit" disabled={busy || !projectId || !selected.length}>{busy ? "Assigning…" : "Assign reviewers"}</button></div>
    </form> : <p>Link this repository to a Paperclip project first.</p>)}
    {!!tasks.length && <ul className="review-bot-results">{tasks.map((task: any) => <li key={task.id}><span>{task.agentName ?? task.assigneeAgentId ?? "Reviewer"} · assigned</span>{task.id && <a {...nav.linkProps(`/issues/${task.id}`)}>{task.identifier ? `Open ${task.identifier}` : "Open task"}</a>}</li>)}</ul>}
  </div>;
}

function ReviewDelegation(props: { companyId: string; repositoryId: number; number: number; sha: string }) {
  return <RecordDialog title="Delegate review to a Paperclip agent"><ReviewDelegationForm {...props} /></RecordDialog>;
}

import React, { useEffect, useState } from "react";
import { usePluginAction, useHostContext, useHostNavigation, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { Repository } from "../contracts.js";
import { RecordDetail, RecordDialog } from "./management-repository.js";
import { useManagementAction } from "./management-common.js";
import { message } from "./errors.js";
import { styles } from "./styles.js";

/** Full issue or pull request view mounted inside the native task side panel.
 * The host passes an opaque record ref as repositoryId:kind:number.
 */
export function GitHubRecordPanel({ context }: PluginDetailTabProps) {
  const host = useHostContext();
  const companyId = context?.companyId as string | undefined;
  const recordId = context?.taskRecordId as string | undefined;
  const linked = usePluginAction("management-options");
  const [repositoryId, kind, number] = recordId?.split(":") ?? [];
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const run = useManagementAction("manage-repository", { companyId, repositoryId: Number(repositoryId), kind }, `${host.userId ?? "local"}:${companyId}:${repositoryId}:${kind}`);
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    void linked({ companyId, refresh: false }).then((result: any) => {
      if (active) setRepositories(result.repositories ?? []);
    }).catch((e: unknown) => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId]);
  if (!companyId) return <p className="muted">Select a company to view this GitHub record.</p>;
  if (!recordId || !/^[1-9]\d*:(issue|pull):[1-9]\d*$/.test(recordId) || !Number.isSafeInteger(Number(repositoryId)) || !Number.isSafeInteger(Number(number)) || (kind !== "issue" && kind !== "pull")) {
    return <p role="alert" className="error">This GitHub record is unavailable.</p>;
  }
  if (error) return <p role="alert" className="error">{error}</p>;
  if (loading) return <p role="status" className="muted">Loading GitHub record…</p>;
  const repository = repositories.find(item => String(item.id) === repositoryId);
  if (!repository) return <p className="muted">This repository is not connected to the current company.</p>;
  return <div className="pcg github-record-panel"><style>{styles}</style><RecordDetail companyId={companyId} run={run} kind={kind} number={Number(number)} repository={repository} repositories={repositories} embedded back={() => {}} />{kind === "pull" && <AgentReviewPanel companyId={companyId} repositoryId={Number(repositoryId)} number={Number(number)} />}{kind === "issue" && context?.entityId && <RecordDialog title="Paperclip task sync"><RecordTaskSync companyId={companyId} issueId={String(context.entityId)} /></RecordDialog>}</div>;
}


function RecordTaskSync({ companyId, issueId }: { companyId: string; issueId: string }) {
  const detail = usePluginAction("task-sync-detail"), resolve = usePluginAction("resolve-task-sync"), sync = usePluginAction("sync-now"), publish = usePluginAction("publish-task"), link = usePluginAction("link-task");
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [repositoryId, setRepositoryId] = useState(""), [number, setNumber] = useState("");
  async function refresh() { const result = await detail({ companyId, issueId }) as any; setData(result); setRepositoryId(current => current || String(result.repositories?.[0]?.id ?? "")); }
  useEffect(() => { let active = true; void detail({ companyId, issueId }).then(result => { if (active) { setData(result); setRepositoryId(String((result as any).repositories?.[0]?.id ?? "")); } }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [companyId, issueId]);
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(""); try { const result = await action() as any; if (result?.warning) setError(result.warning); await refresh(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <section className="record-section">{error && <p role="alert" className="error">{error}</p>}{data?.link ? <><p>Linked to GitHub issue #{data.link.number}</p>{!!data.link.conflicts?.length && <><p role="alert">Both sides changed: {data.link.conflicts.join(", ")}. Choose the version to keep.</p><div className="row"><button disabled={busy} onClick={() => void run(() => resolve({ companyId, issueId, keep: "github" }))}>Use GitHub</button><button disabled={busy} onClick={() => void run(() => resolve({ companyId, issueId, keep: "paperclip" }))}>Use Paperclip</button></div></>}</> : data && <>{data.pending && <p>Publication pending. Sync checks for an existing issue before retrying.</p>}<label>Repository<select value={repositoryId} disabled={busy} onChange={event => setRepositoryId(event.target.value)}>{data.repositories.map((repo: any) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select></label>{!data.pending && <button disabled={busy || !data.repositories.find((repo: any) => String(repo.id) === repositoryId)?.issuesWrite} onClick={() => void run(() => publish({ companyId, issueId, destinationId: repositoryId }))}>Create linked GitHub issue</button>}<label>Issue number<input type="number" min="1" value={number} onChange={event => setNumber(event.target.value)} /></label><p className="muted">Linking replaces the task title, description and state with GitHub on the next sync.</p><button disabled={busy || !number || !repositoryId} onClick={() => void run(() => link({ companyId, issueId, repositoryId: Number(repositoryId), number: Number(number) }))}>Link issue</button></>}<button disabled={busy} onClick={() => void run(() => sync({ companyId }))}>Sync now</button></section>;
}


/**
 * Paperclip-first reviewer assignment for a pull request. Each selected agent gets
 * a linked review task and GitHub reviewer identity; the selected perspectives
 * can be woken using the normal Paperclip run controls.
 * The host action remains the source of truth for task creation and permissions.
 */
function AgentReviewPanel({ companyId, repositoryId, number }: { companyId: string; repositoryId: number; number: number }) {
  const optionsAction = usePluginAction("pr-task-options");
  const createReview = usePluginAction("review-pr-task");
  const manageReviewers = useManagementAction("manage-agent-reviewers", { companyId, repositoryId }, `${companyId}:${repositoryId}:pull:reviewers`);
  const readRecord = usePluginAction("manage-repository");
  const nav = useHostNavigation();
  const [options, setOptions] = useState<{ projects: { id: string; name: string }[]; agents: { id: string; name: string; githubLogin?: string | null; githubEnabled?: boolean }[] } | null>(null);
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [sha, setSha] = useState("");
  const [tasks, setTasks] = useState<{ agentId: string; agentName: string; id?: string; identifier?: string | null; error?: string }[]>([]);
  const [reviewers, setReviewers] = useState<{ agentId: string; login: string; enabled?: boolean; isBot?: boolean; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [wake, setWake] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([
      optionsAction({ companyId, repositoryId }),
      readRecord({ companyId, repositoryId, kind: "pull", op: "pull", number, refresh: false }),
    ]).then(([nextOptions, record]: any[]) => {
      if (!active) return;
      setOptions(nextOptions);
      setProjectId(String(nextOptions?.projects?.[0]?.id ?? ""));
      setSha(typeof record?.head?.sha === "string" ? record.head.sha : "");
      const requested = Array.isArray(record?.requested_reviewers) ? record.requested_reviewers : [];
      setReviewers(requested.map((item: any) => ({ agentId: nextOptions?.agents?.find((agent: any) => agent.githubLogin === item.login)?.id ?? `github:${item.login}`, login: item.login, enabled: true, isBot: Boolean(nextOptions?.agents?.some((agent: any) => agent.githubLogin === item.login)) })));
    }).catch((cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [companyId, repositoryId, number]);

  function toggle(agentId: string) {
    setSelected(current => current.includes(agentId) ? current.filter(id => id !== agentId) : [...current, agentId]);
  }
  async function removeReviewer(agentId: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await manageReviewers("remove", { number, agentIds: [agentId] });
      setReviewers(current => current.filter(item => item.agentId !== agentId));
    } catch (cause) { setError(`GitHub reviewer removal failed: ${message(cause)}`); }
    finally { setBusy(false); }
  }
  async function delegate() {
    if (!options || !projectId || !sha || !selected.length || busy) return;
    setBusy(true); setError("");
    const selectedAgents = options.agents.filter(agent => selected.includes(agent.id));
    const created: typeof tasks = [];
    try {
      let reviewerResult: any;
      try {
        reviewerResult = await manageReviewers("request", { number, agentIds: selected });
        setReviewers(current => [...current.filter(item => !selected.includes(item.agentId)), ...(reviewerResult?.reviewers ?? []).map((item: any) => ({ agentId: item.agentId, login: item.requestedLogin ?? item.login, enabled: item.enabled, isBot: true }))]);
      } catch (cause) {
        setError(`GitHub reviewer request failed: ${message(cause)}`);
      }
      try {
        const result: any = await createReview({ companyId, repositoryId, number, sha, projectId, agentIds: selected, reviewerAgentIds: selected, wake });
        const returned = Array.isArray(result?.tasks) ? result.tasks : [result];
        for (const task of returned) {
          const agent = selectedAgents.find(candidate => candidate.id === task?.agentId);
          created.push({ agentId: task?.agentId ?? agent?.id ?? selected[created.length] ?? "", agentName: task?.agentName ?? agent?.name ?? "Reviewer", id: task?.id, identifier: task?.identifier });
        }
      } catch (cause) {
        for (const agent of selectedAgents) created.push({ agentId: agent.id, agentName: agent.name, error: message(cause) });
      }
      setTasks(current => {
        const byId = new Map([...current, ...created].filter(task => task.id).map(task => [task.id, task]));
        return [...byId.values(), ...[...current, ...created].filter(task => !task.id)];
      });
      if (created.some(item => item.error)) setError("Some review tasks could not be created. Review each result below.");
      setSelected([]);
      setWake(false);
    } finally { setBusy(false); }
  }

  return <section className="record-section review-bots" aria-label="Paperclip review bots">
    <div className="record-toolbar"><div><h3>Review bots</h3><p className="muted">Assign independent Paperclip agents to this PR. Their tasks stay linked to this revision.</p></div><span className="badge" data-state={tasks.length ? "open" : "draft"}>{tasks.length ? `${tasks.length} requested` : "No reviewers"}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
    {!options?.projects?.length && <p className="muted">Link this repository to a Paperclip project before assigning review bots.</p>}
    {!!options?.projects?.length && <div className="review-bot-form">
      <label>Paperclip project<select aria-label="Review project" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={busy}>{options.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <fieldset className="review-bot-list" disabled={busy || !sha}>
        <legend>GitHub reviewers</legend>
        {options.agents.map(agent => <label className="row review-bot-option" key={agent.id} title={agent.githubEnabled ? `@${agent.githubLogin}` : "Configure a GitHub bot identity in Agent settings first"}><input type="checkbox" aria-label={agent.name} checked={selected.includes(agent.id)} onChange={() => toggle(agent.id)} disabled={!agent.githubEnabled} /><span>{agent.name}</span>{agent.githubEnabled ? <><span className="badge" data-state="open">Bot</span><span className="muted">@{agent.githubLogin}</span></> : <span className="muted">Native GitHub channel required</span>}</label>)}
        {!options.agents.length && <p className="muted">No available agents.</p>}
      </fieldset>
      <div className="footer"><label className="row"><input type="checkbox" checked={wake} onChange={event => setWake(event.target.checked)} disabled={busy || !sha} /> Start agents now</label><span className="muted">{sha ? `Revision ${sha.slice(0, 7)}` : "Loading revision…"}</span><button className="primary" type="button" disabled={busy || !projectId || !sha || !selected.length} onClick={() => void delegate()}>{busy ? "Assigning…" : "Assign reviewers"}</button></div>
    </div>}
    {!!reviewers.length && <div className="review-bot-reviewers"><strong>GitHub reviewers</strong><ul>{reviewers.map(item => <li key={item.agentId}><span>@{item.login}{item.isBot && <span className="badge" data-state="open">Bot</span>}</span><button type="button" disabled={busy} onClick={() => void removeReviewer(item.agentId)}>Remove</button></li>)}</ul></div>}
    {!!tasks.length && <ul className="review-bot-results">{tasks.map((task, index) => <li key={`${task.agentId}:${index}`}><span><strong>{task.agentName}</strong><span className="muted">{task.error ? ` · ${task.error}` : " · assigned"}</span></span>{task.id && <a {...nav.linkProps(`/issues/${task.id}`)}>{task.identifier ? `Open ${task.identifier}` : "Open task"}</a>}</li>)}</ul>}
  </section>;
}

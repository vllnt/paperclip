import React, { useEffect, useState } from "react";
import type { Repository } from "../contracts.js";
import { ActionForm, Disclosure, ExternalLink, TaskLink, CacheNote, selectField, titleBody, useManagementAction, type Field, type Operation } from "./management-common.js";
import { message } from "./errors.js";

export function ProjectsWorkspace({ companyId, owner, repositories, openRecord }: { companyId: string; owner: { login: string; type: "Organization" | "User" }; repositories: Repository[]; openRecord: (repo: Repository, kind: "issue" | "pull", number: number) => void }) {
  const run = useManagementAction("manage-project", { companyId, owner: owner.login, ownerType: owner.type });
  const [fetchedAt, setFetchedAt] = useState<string>(), [rows, setRows] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState<number | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [search, setSearch] = useState("");
  async function load(after?: string, refresh = false) {
    setBusy(true); setError("");
    try { const d = await run("list", { cursor: after ?? null, refresh }); setFetchedAt(d.cache?.fetchedAt); setRows(old => after ? [...old, ...d.rows] : d.rows); setCursor(d.nextCursor); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  if (selected) return <ProjectDetail key={selected} number={selected} run={run} repositories={repositories} openRecord={openRecord} back={() => { setSelected(null); void load(); }} />;
  return <div className="details-content"><div className="footer"><input aria-label="Search loaded projects" placeholder="Search loaded projects…" value={search} onChange={e => setSearch(e.target.value)} /><button disabled={busy} onClick={() => void load(undefined, true)}>Refresh</button></div>
    <CacheNote fetchedAt={fetchedAt} />
    <Disclosure title="New GitHub project"><ActionForm fields={[{ key: "title", label: "Project title" }]} submit="Create project" run={v => run("create", v)} onDone={r => setSelected(r.createProjectV2.projectV2.number)} /></Disclosure>
    {error && <p role="alert" className="error">{error}</p>}{busy && <p role="status">Loading projects…</p>}
    <ul className="issues">{rows.filter(r => r.title.toLowerCase().includes(search.toLowerCase())).map(r => <li key={r.id}><button className="item-link" onClick={() => setSelected(r.number)}>#{r.number} {r.title}</button><p className="muted">{r.closed ? "Closed" : "Open"} · {r.public ? "Public" : "Private"}</p></li>)}</ul>
    {!busy && !error && !rows.length && <p>No GitHub projects found.</p>}{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Load more projects</button>}
  </div>;
}
function ProjectDetail({ number, run, repositories, openRecord, back }: { number: number; run: Operation; repositories: Repository[]; openRecord: (repo: Repository, kind: "issue" | "pull", number: number) => void; back: () => void }) {
  const act: Operation = (op, p = {}) => run(op, { projectNumber: number, ...p });
  const [project, setProject] = useState<any>(null), [rows, setRows] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [archived, setArchived] = useState(false), [search, setSearch] = useState("");
  const [version, setVersion] = useState(0);
  async function load(after?: string, refresh = false) {
    setBusy(true); setError("");
    try {
      if (!after) { setProject(await act("detail", { refresh })); setVersion(v => v + 1); }
      const d = await act("items", { cursor: after ?? null, refresh }); setRows(old => after ? [...old, ...d.rows] : d.rows); setCursor(d.nextCursor);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  const repoField: Field = { key: "repositoryId", label: "Repository", options: [{ value: "", label: "Choose repository" }, ...repositories.map(r => ({ value: String(r.id), label: r.fullName }))] };
  const fields = project?.fields.filter((f: any) => ["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"].includes(f.dataType)) ?? [];
  return <div className="details-content"><div className="footer"><button onClick={back}>Back to GitHub projects</button><button disabled={busy} onClick={() => void load(undefined, true)}>Refresh</button></div>
    {error && <p role="alert" className="error">{error}</p>}{busy && <p role="status">Loading project…</p>}
    {project && <><CacheNote fetchedAt={project.cache?.fetchedAt} /><header><h2>{project.title}</h2><p className="muted">{project.shortDescription}</p><ExternalLink url={project.url}>Open on GitHub</ExternalLink></header>
      <div className="row filters"><input aria-label="Search loaded project items" placeholder="Search loaded items…" value={search} onChange={e => setSearch(e.target.value)} /><label className="row"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />Show archived</label></div>
      <Disclosure title="Add item"><ActionForm fields={[repoField, { key: "number", label: "Issue or PR number", type: "number" }]} submit="Add to project" run={v => act("add-item", { ...v, repositoryId: Number(v.repositoryId) })} onDone={() => load()} /><ActionForm title="Or create a draft" fields={titleBody} submit="Add draft" run={v => act("add-draft", v)} onDone={() => load()} /></Disclosure>
      <ul className="issues">{rows.filter(i => (archived || !i.isArchived) && (i.content?.title ?? "Restricted item").toLowerCase().includes(search.toLowerCase())).map(item => {
        const repo = repositories.find(r => r.fullName === item.content?.repository?.nameWithOwner);
        return <li key={`${item.id}:${version}`}><details className="project-item"><summary>{item.isArchived ? "Archived · " : ""}{item.content?.number ? `#${item.content.number} ` : ""}{item.content?.title ?? "Restricted item"}
          <span className="field-summary">{item.fieldValues.nodes.filter((v: any) => v.field).map((v: any) => `${v.field.name}: ${v.name ?? v.title ?? v.text ?? v.number ?? v.date ?? ""}`).join(" · ")}</span></summary>
          <div className="details-content"><TaskLink item={item} />{repo && <button onClick={() => openRecord(repo, item.content.__typename === "PullRequest" ? "pull" : "issue", item.content.number)}>Manage {item.content.__typename === "PullRequest" ? "pull request" : "issue"}</button>}
            {fields.map((field: any) => <ProjectField key={field.id} field={field} item={item} run={act} refresh={() => load()} />)}
            {item.content?.__typename === "DraftIssue" && <><ActionForm title="Edit draft" fields={titleBody} initial={{ title: item.content.title, body: item.content.body }} run={v => act("edit-draft", { ...v, itemId: item.id })} onDone={() => load()} /><ActionForm fields={[repoField]} submit="Convert draft to issue" run={v => act("convert-draft", { ...v, itemId: item.id, repositoryId: Number(v.repositoryId) })} onDone={() => load()} /></>}
            <ActionForm submit={item.isArchived ? "Restore item" : "Archive item"} run={() => act(item.isArchived ? "restore-item" : "archive-item", { itemId: item.id })} onDone={() => load()} />
            <ActionForm fields={[{ key: "afterId", label: "Position after", options: [{ value: "", label: "Move to top" }, ...rows.filter(i => i.id !== item.id).map(i => ({ value: i.id, label: i.content?.title ?? i.id }))] }]} initial={{ afterId: "" }} submit="Move item" run={v => act("move-item", { itemId: item.id, afterId: v.afterId || null })} onDone={() => load()} />
            <ActionForm submit="Remove from project" destructive confirmation={item.content?.title ?? item.id} note="Removes the project item. Its GitHub issue or PR is kept; draft-only content is removed." run={v => act("remove-item", { ...v, itemId: item.id })} onDone={() => load()} />
          </div></details></li>;
      })}</ul>
      {!busy && !rows.length && <p>No items in this project.</p>}{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Load more items</button>}
      <ProjectSettings key={`${project.id}:${version}`} project={project} run={act} repoField={repoField} refresh={() => load()} deleted={back} />
    </>}
  </div>;
}
function ProjectField({ field, item, run, refresh }: { field: any; item: any; run: Operation; refresh: () => Promise<void> }) {
  const current = item.fieldValues.nodes.find((v: any) => v.field?.id === field.id);
  const value = current?.optionId ?? current?.iterationId ?? current?.text ?? current?.number ?? current?.date ?? "";
  const definition: Field = { key: "value", label: field.name, type: field.dataType === "NUMBER" ? "number" : field.dataType === "DATE" ? "date" : "text", optional: field.dataType === "TEXT" };
  if (field.dataType === "SINGLE_SELECT") definition.options = [{ value: "", label: "Choose value" }, ...field.options.map((o: any) => ({ value: o.id, label: o.name }))];
  if (field.dataType === "ITERATION") definition.options = [{ value: "", label: "Choose iteration" }, ...[...field.configuration.iterations, ...field.configuration.completedIterations].map((i: any) => ({ value: i.id, label: i.title }))];
  return <div className="panel"><ActionForm fields={[definition]} initial={{ value }} submit={`Set ${field.name}`} run={v => run("set-field", { ...v, value: v.value ?? "", itemId: item.id, fieldId: field.id })} onDone={refresh} />{current && <ActionForm submit={`Clear ${field.name}`} run={() => run("clear-field", { itemId: item.id, fieldId: field.id })} onDone={refresh} />}</div>;
}
function ProjectSettings({ project, run, repoField, refresh, deleted }: { project: any; run: Operation; repoField: Field; refresh: () => Promise<void>; deleted: () => void }) {
  const [fieldType, setFieldType] = useState("TEXT");
  const fieldsForType = (type: string): Field[] => [{ key: "name", label: "Field name" }, ...(type === "SINGLE_SELECT" ? [{ key: "options", label: "Options (comma separated)", type: "csv" as const }] : []), ...(type === "ITERATION" ? [{ key: "startDate", label: "First iteration starts", type: "date" as const }, { key: "duration", label: "Duration (days)", type: "number" as const }, { key: "iterationCount", label: "Number of iterations", type: "number" as const }] : [])];
  return <Disclosure title="Project settings">
    <ActionForm fields={[{ key: "title", label: "Project title" }, { key: "shortDescription", label: "Summary", optional: true }, { key: "readme", label: "README", type: "textarea" }, { key: "closed", label: "Closed", type: "checkbox" }]} initial={project} run={v => run("edit", { ...v, shortDescription: v.shortDescription ?? "" })} onDone={refresh} />
    <ActionForm submit={project.public ? "Make private" : "Make public"} confirmation={project.public ? undefined : project.title} note={project.public ? undefined : "The project and its visible item metadata will be public."} run={v => run("edit", { ...v, public: !project.public })} onDone={refresh} />
    <Disclosure title="Fields">{project.fields.filter((f: any) => ["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"].includes(f.dataType)).map((f: any) => <Disclosure key={f.id} title={f.name}>
      <ActionForm fields={fieldsForType(f.dataType)} initial={{ name: f.name, options: f.options?.map((o: any) => o.name).join(", "), startDate: f.configuration?.iterations?.[0]?.startDate, duration: f.configuration?.duration ?? 14, iterationCount: 4 }} confirmation={["SINGLE_SELECT", "ITERATION"].includes(f.dataType) ? f.name : undefined} note={["SINGLE_SELECT", "ITERATION"].includes(f.dataType) ? "Replaces the options or iteration schedule. Existing item values may be cleared by GitHub." : undefined} run={v => run("edit-field", { ...v, fieldId: f.id })} onDone={refresh} />
      <ActionForm submit="Delete field" destructive confirmation={f.name} run={v => run("delete-field", { ...v, fieldId: f.id })} onDone={refresh} />
    </Disclosure>)}<label>New field type<select value={fieldType} onChange={e => setFieldType(e.target.value)}>{["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"].map(t => <option key={t}>{t}</option>)}</select></label><ActionForm key={fieldType} fields={fieldsForType(fieldType)} initial={{ duration: 14, iterationCount: 4 }} submit="Create field" run={v => run("create-field", { ...v, dataType: fieldType })} onDone={refresh} /></Disclosure>
    <Disclosure title="Linked repositories"><ActionForm fields={[repoField, selectField("action", "Action", ["link", "unlink"])]} initial={{ action: "link" }} submit="Update repository link" run={v => run(v.action === "link" ? "link-repository" : "unlink-repository", { repositoryId: Number(v.repositoryId) })} onDone={refresh} /></Disclosure>
    <ActionForm title="Delete project" submit="Delete project" confirmation={project.title} destructive note="Permanently deletes the GitHub project, fields and draft items. Repository issues and PRs are kept." run={v => run("delete", v)} onDone={deleted} />
  </Disclosure>;
}

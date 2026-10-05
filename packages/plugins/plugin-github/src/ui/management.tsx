import React, { useEffect, useRef, useState } from "react";
import type { Catalog, Repository, Status } from "../contracts.js";
import { PAGE_PATH, PLUGIN_ID } from "../contracts.js";
import { useHostLocation, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { RepositoryWorkspace } from "./management-repository.js";
import { ProjectsWorkspace } from "./management-projects.js";
import { ActionForm } from "./management-common.js";
import { ensureCanConfigure, hostApi } from "./api.js";
import { message } from "./errors.js";
import { styles } from "./styles.js";

export function GitHubWorkspace({ companyId, catalog }: { companyId: string; catalog: Catalog }) {
  const [tab, setTab] = useState<"issue" | "pull" | "project" | null>(null), [repoId, setRepoId] = useState(String(catalog.repositories[0]?.id ?? "")), [repoSearch, setRepoSearch] = useState("");
  const [owner, setOwner] = useState(""), [personal, setPersonal] = useState<{ login: string } | null>(null), [error, setError] = useState(""), [initialNumber, setInitialNumber] = useState<number | undefined>();
  const options = usePluginAction("management-options");
  const location = useHostLocation();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const kind = params.get("kind"), number = Number(params.get("number")), repository = params.get("repository");
    if ((kind === "issue" || kind === "pull") && repository && catalog.repositories.some(r => String(r.id) === repository) && Number.isSafeInteger(number) && number > 0) {
      setRepoId(repository); setInitialNumber(number); setTab(kind);
    }
  }, [location.search, companyId, catalog]);
  useEffect(() => {
    if (tab !== "project") return;
    let active = true;
    void options({ companyId }).then((v: any) => { if (active) { setPersonal(v.personal); setError(v.warnings?.join(" ") ?? ""); } }).catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [tab, companyId]);
  const repo = catalog.repositories.find(r => String(r.id) === repoId);
  const owners = [...catalog.installations.filter(i => i.accountType === "Organization" && !i.suspended).map(i => ({ login: i.login, type: "Organization" as const })), ...(personal ? [{ login: personal.login, type: "User" as const }] : [])];
  const account = owners.find(o => `${o.type}:${o.login}` === owner) ?? owners[0];
  function openRecord(repository: Repository, kind: "issue" | "pull", number: number) { setRepoId(String(repository.id)); setInitialNumber(number); setTab(kind); }
  return <section className="panel github-workspace"><div className="row" role="tablist" aria-label="GitHub workspace">{([['issue', 'Issues'], ['pull', 'Pull requests'], ['project', 'Projects']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setInitialNumber(undefined); }}>{label}</button>)}</div>
    {!tab && <p className="muted">Choose what to manage.</p>}
    {(tab === "issue" || tab === "pull") && <><div className="row filters"><input aria-label="Find repository" placeholder="Find repository…" value={repoSearch} onChange={e => setRepoSearch(e.target.value)} /><label>Repository<select value={repoId} onChange={e => { setRepoId(e.target.value); setInitialNumber(undefined); }}>{catalog.repositories.filter(r => r.id === repo?.id || r.fullName.toLowerCase().includes(repoSearch.toLowerCase())).map(r => <option key={r.id} value={r.id}>{r.fullName}</option>)}</select></label></div>
      {repo ? <RepositoryWorkspace key={`${companyId}:${repo.id}:${tab}:${initialNumber ?? ''}`} companyId={companyId} repository={repo} repositories={catalog.repositories} kind={tab} initialNumber={initialNumber} /> : <p>Choose repositories in connection settings.</p>}
    </>}
    {tab === "project" && <>{error && <p role="alert" className="error">{error}</p>}{account ? <><label>GitHub account<select value={`${account.type}:${account.login}`} onChange={e => setOwner(e.target.value)}>{owners.map(o => <option key={`${o.type}:${o.login}`} value={`${o.type}:${o.login}`}>{o.login}{o.type === "User" ? " (personal)" : ""}</option>)}</select></label><ProjectsWorkspace key={`${companyId}:${account.type}:${account.login}`} companyId={companyId} owner={account} repositories={catalog.repositories} openRecord={openRecord} /></> : <p>Install the App on an organization with Projects access, or connect personal Projects in Connection settings.</p>}</>}
  </section>;
}
export function NativeGitHubProjects({ companyId, projectId }: { companyId: string; projectId: string }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const status = usePluginAction("status"), options = usePluginAction("management-options"), linked = usePluginAction("linked-repositories"), openTask = usePluginAction("open-record-task"), nav = useHostNavigation();
  const [catalog, setCatalog] = useState<(Catalog & { personal?: { login: string } | null }) | null>(null), [repositories, setRepositories] = useState<Repository[]>([]);
  const [owner, setOwner] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [version, setVersion] = useState(0), [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true; setBusy(true); setError("");
    // An unconfigured App is a normal state, not a worker error; check it before loading the catalog.
    void (status({ companyId }) as Promise<Status>).then(async current => {
      if (!active) return;
      setConfigured(current.configured);
      if (!current.configured) return;
      const [data, sources]: any[] = await Promise.all([options({ companyId }), linked({ companyId, projectId })]);
      if (active) { setCatalog(data); setRepositories(sources.repositories); setError(sources.warnings?.join(" ") ?? ""); }
    }).catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [companyId, projectId, version]);
  const owners = catalog ? [...catalog.installations.filter(i => i.accountType === "Organization" && !i.suspended && repositories.some(r => r.owner.toLowerCase() === i.login.toLowerCase())).map(i => ({ login: i.login, type: "Organization" as const })), ...(catalog.personal ? [{ login: catalog.personal.login, type: "User" as const }] : [])] : [];
  const account = owners.find(o => `${o.type}:${o.login}` === owner) ?? owners[0];
  async function openRecord(repository: Repository, kind: "issue" | "pull", number: number) {
    setError("");
    try {
      const result = await openTask({ companyId, projectId, repositoryId: repository.id, kind, number }) as { id: string };
      if (!mounted.current) return;
      if (!result?.id) throw new Error("The associated task is unavailable.");
      const query = new URLSearchParams({ taskPlugin: PLUGIN_ID, taskRecord: `${repository.id}:${kind}:${number}` });
      nav.navigate(`/issues/${encodeURIComponent(result.id)}?${query}`);
    } catch (e) { if (mounted.current) setError(message(e)); }
  }
  return <section className="pcg"><style>{styles}</style><h2>GitHub Projects</h2>{busy && <p role="status">Loading GitHub Projects…</p>}{error && <p role="alert" className="error">{error}</p>}
    {!busy && configured === false && <><p>Connect a GitHub App in the GitHub plugin first.</p><a className="button primary" {...nav.linkProps(PAGE_PATH)}>Open GitHub settings</a></>}
    {!busy && catalog && (account ? <><label>GitHub account<select value={`${account.type}:${account.login}`} onChange={e => setOwner(e.target.value)}>{owners.map(o => <option key={`${o.type}:${o.login}`} value={`${o.type}:${o.login}`}>{o.login}</option>)}</select></label><ProjectsWorkspace key={`${companyId}:${projectId}:${account.type}:${account.login}`} companyId={companyId} owner={account} repositories={repositories} openRecord={(repo, kind, number) => { void openRecord(repo, kind, number); }} /></> : <p>Link a repository with organization Projects access, or connect personal Projects in GitHub settings.</p>)}
    {error && !busy && <button onClick={() => setVersion(n => n + 1)}>Retry</button>}
  </section>;
}
export function PersonalProjectAccess({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const verify = usePluginAction("verify-personal"), [login, setLogin] = useState(""), [version, setVersion] = useState(0);
  useEffect(() => { if (!open) return; let active = true; void hostApi<any>(`/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`).then(c => { if (active) setLogin(c?.configJson?.personalLogin ?? ""); }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [companyId, open]);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>Personal Projects access{login ? ` · ${login}` : " (optional)"}</summary><div className="details-content">{error && <p role="alert" className="error">{error}</p>}<p className="muted">Personal Projects require a user token. Organization Projects use your App. The token is encrypted in Paperclip Secrets and only used for Projects. Include repo scope only if you need private repository items; authorize organization SSO when required.</p><a href="https://github.com/settings/tokens/new?scopes=project&description=Paperclip%20personal%20Projects" target="_blank" rel="noopener noreferrer">Create a token with project scope ↗</a>
    <ActionForm key={version} fields={[{ key: "token", label: "Personal access token", type: "password" }]} submit={login ? "Replace personal access" : "Connect personal Projects"} run={async v => {
      await ensureCanConfigure(companyId);
      const user = await verify({ companyId, token: v.token }) as { login: string };
      const config = await hostApi<any>(`/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`);
      const secret = await hostApi<{ id: string }>(`/companies/${encodeURIComponent(companyId)}/secrets`, "POST", { name: `GitHub personal Projects (${user.login})`, provider: "local_encrypted", value: v.token, description: "Optional user token for personal GitHub Projects." });
      await hostApi(`/plugins/${PLUGIN_ID}/config`, "POST", { companyId, configJson: { ...config.configJson, personalLogin: user.login, personalToken: { type: "secret_ref", secretId: secret.id, version: "latest" } } });
      setLogin(user.login); setVersion(n => n + 1);
    }} />
    {login && <ActionForm submit="Disconnect personal Projects" run={async () => { await ensureCanConfigure(companyId); const config = await hostApi<any>(`/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`); const { personalToken, personalLogin, ...rest } = config.configJson; await hostApi(`/plugins/${PLUGIN_ID}/config`, "POST", { companyId, configJson: rest }); setLogin(""); }} />}
  </div></details>;
}

export function LinkedIssueManager({ companyId, repositoryId, number }: { companyId: string; repositoryId: number; number: number }) {
  const catalogAction = usePluginAction("catalog"), [open, setOpen] = useState(false), [catalog, setCatalog] = useState<Catalog | null>(null), [error, setError] = useState("");
  useEffect(() => { if (!open) return; let active = true; void catalogAction({ companyId }).then(c => { if (active) setCatalog(c as Catalog); }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [open, companyId, repositoryId]);
  const repo = catalog?.repositories.find(r => r.id === repositoryId);
  return <details className="panel" onToggle={e => setOpen(e.currentTarget.open)}><summary>Manage GitHub issue</summary>{error && <p role="alert">{error}</p>}{open && repo && <RepositoryWorkspace key={`${companyId}:${repositoryId}:${number}`} companyId={companyId} repository={repo} repositories={catalog!.repositories} kind="issue" initialNumber={number} />}{open && catalog && !repo && <p>This repository is no longer accessible.</p>}</details>;
}

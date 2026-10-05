import { ConnectionAccess } from "./connection-access.js";
import { NativeGitHubProjects, PersonalProjectAccess } from "./management.js";
import { AutomationSettings } from "./automation.js";
import { TaskSyncDetail } from "./task-detail.js";
import { GitHubRecordPanel } from "./task-record.js";
import { GitHubAgentSettings } from "./agent-settings.js";
import React, { useEffect, useRef, useState } from "react";
import { useHostNavigation, useHostLocation, usePluginAction, type PluginPageProps, type PluginDetailTabProps, type PluginSidebarProps, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { PAGE_PATH, PLUGIN_ID, type AppIdentity, type Catalog, type Credentials, type SetupStart, type Status } from "../contracts.js";
import { ensureCanConfigure, hostApi, saveConfiguration, saveCredentials, type SavedApp } from "./api.js";
import { styles } from "./styles.js";

const message = (e: unknown) => {
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return "Something went wrong. Please try again.";
};
export function GitHubLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname === nav.resolveHref(PAGE_PATH);
  return <><style>{styles}</style>
    <a className="pcg-nav" {...nav.linkProps(PAGE_PATH)} aria-current={active ? "page" : undefined} title="GitHub">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 19 4.77 5.07 5.07 0 0 0 18.91 1S17.73.65 15 2.48a13.38 13.38 0 0 0-7 0C5.27.65 4.09 1 4.09 1A5.07 5.07 0 0 0 4 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 8 18.13V22" />
      </svg>
      <span>GitHub</span>
    </a>
  </>;
}
export function GitHubPage({ context }: PluginPageProps) {
  if (!context.companyId) return <p>Select a company to connect GitHub.</p>;
  return <GitHubPageContent key={`${context.companyId}:${context.userId}`} context={context} companyId={context.companyId} />;
}
export function legacyRecord(search: string) {
  const query = new URLSearchParams(search);
  // App onboarding callbacks always retain priority over record navigation.
  if (query.has("code") || query.has("installation_id")) return null;
  if (!["repository", "kind", "number"].some(key => query.has(key))) return null;
  const repository = query.get("repository"), kind = query.get("kind"), rawNumber = query.get("number");
  if (!repository || !rawNumber || !/^[1-9][0-9]*$/.test(repository) || !/^[1-9][0-9]*$/.test(rawNumber) ||
    !Number.isSafeInteger(Number(repository)) || !Number.isSafeInteger(Number(rawNumber)) || (kind !== "issue" && kind !== "pull")) {
    return { error: "This GitHub record link is invalid." };
  }
  return { repositoryId: Number(repository), kind, number: Number(rawNumber) };
}
function GitHubPageContent(props: PluginPageProps & { companyId: string }) {
  const location = useHostLocation(), record = legacyRecord(location.search);
  if (record) return <LegacyRecordRedirect key={`${props.companyId}:${location.search}`} companyId={props.companyId} record={record} />;
  return <Setup {...props} />;
}
function LegacyRecordRedirect({ companyId, record }: { companyId: string; record: NonNullable<ReturnType<typeof legacyRecord>> }) {
  const nav = useHostNavigation(), open = usePluginAction("open-record-task");
  const [error, setError] = useState("error" in record ? record.error : ""), [retry, setRetry] = useState(0);
  useEffect(() => {
    if ("error" in record) return;
    let active = true;
    setError("");
    void open({ companyId, ...record, ...(retry ? { refresh: true } : {}) }).then((value: any) => {
      if (!active) return;
      if (!value || typeof value.id !== "string" || !value.id || value.id.length > 200) throw new Error("The associated task is unavailable.");
      const query = new URLSearchParams({ taskPlugin: PLUGIN_ID, taskRecord: `${record.repositoryId}:${record.kind}:${record.number}` });
      nav.navigate(`/issues/${encodeURIComponent(value.id)}?${query}`);
    }).catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [companyId, retry]);
  return <section className="pcg"><style>{styles}</style>{error ? <><p role="alert" className="error">{error}</p><div className="footer"><a {...nav.linkProps(PAGE_PATH)}>GitHub settings</a>{!("error" in record) && <button onClick={() => setRetry(n => n + 1)}>Retry</button>}</div></> : <p role="status">Opening task…</p>}</section>;
}
function Setup({ context, companyId }: PluginPageProps & { companyId: string }) {
  const nav = useHostNavigation();
  const statusAction = usePluginAction("status");
  const startAction = usePluginAction("start-setup");
  const completeAction = usePluginAction("complete-setup");
  const verifyAction = usePluginAction("verify-manual");
  const catalogAction = usePluginAction("catalog");
  const [status, setStatus] = useState<Status | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(() => `Paperclip-${context.companyPrefix ?? "GitHub"}`.slice(0, 27) + "-" + Math.random().toString(36).slice(2, 7));
  const [appId, setAppId] = useState("");
  const [pem, setPem] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const credentials = useRef<Credentials | null>(null);
  const savedConfig = useRef<SavedApp | null>(null);
  const initialized = useRef(false);
  const awaitingInstallation = useRef(false);
  const sessionKey = `${PLUGIN_ID}:${companyId}:${context.userId ?? "board"}`;
  const returnUrl = new URL(nav.resolveHref(PAGE_PATH), window.location.origin).href;

  async function task(fn: () => Promise<void>) {
    setError(""); setNotice(""); setBusy(true);
    try { await fn(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function refresh(fresh = true) {
    const data = await catalogAction({ companyId, refresh: fresh }) as Catalog;
    setCatalog(data);
    setStatus({ configured: true, app: data.app });

  }
  async function persist(install: boolean) {
    if (!savedConfig.current && credentials.current) {
      savedConfig.current = await saveCredentials(companyId, credentials.current);
      credentials.current.privateKey = ""; credentials.current = null;
      // Only a vault reference and public App identity survive a reload.
      sessionStorage.setItem(sessionKey + ":saved", JSON.stringify(savedConfig.current));
    }
    if (!savedConfig.current) throw new Error("Start GitHub setup again.");
    await saveConfiguration(companyId, savedConfig.current);
    const slug = savedConfig.current.appSlug;
    sessionStorage.removeItem(sessionKey + ":saved"); sessionStorage.removeItem(sessionKey);
    savedConfig.current = null;
    setPem("");
    setStatus(await statusAction({ companyId }) as Status);
    if (install && /^[a-z0-9-]+$/.test(slug)) window.location.assign(`https://github.com/apps/${slug}/installations/new`);
    else await refresh();
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const query = new URLSearchParams(window.location.search);
    const code = query.get("code"), state = query.get("state");
    if (code || query.has("installation_id")) {
      const clean = new URL(window.location.href);
      for (const key of ["code", "state", "installation_id", "setup_action"]) clean.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", clean.pathname + clean.search + clean.hash);
    }
    void task(async () => {
      const recovery = sessionStorage.getItem(sessionKey + ":saved");
      if (recovery) { savedConfig.current = JSON.parse(recovery); await persist(false); return; }
      if (code) {
        const pending = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
        if (!pending || pending.state !== state || pending.returnUrl !== returnUrl) throw new Error("This setup was started in another browser or company. Open GitHub setup here and try again.");
        await ensureCanConfigure(companyId);
        credentials.current = await completeAction({ companyId, code, state, returnUrl }) as Credentials;
        await persist(true);
        return;
      }
      const current = await statusAction({ companyId }) as Status;
      setStatus(current);
      if (current.configured) await refresh(false);
    });
  }, []);
  useEffect(() => {
    const onFocus = () => {
      if (awaitingInstallation.current && status?.configured && !busy) {
        awaitingInstallation.current = false;
        void task(() => refresh());
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [status, busy]);
  async function start() {
    await ensureCanConfigure(companyId);
    const setup = await startAction({ companyId, name, owner, returnUrl }) as SetupStart;
    sessionStorage.setItem(sessionKey, JSON.stringify({ state: setup.state, returnUrl }));
    const form = document.createElement("form");
    form.method = "post"; form.action = setup.actionUrl;
    const input = document.createElement("input");
    input.type = "hidden"; input.name = "manifest"; input.value = JSON.stringify(setup.manifest);
    form.append(input); document.body.append(form); form.submit(); form.remove();
  }
  async function manual() {
    await ensureCanConfigure(companyId);
    const app = await verifyAction({ companyId, appId, privateKey: pem }) as AppIdentity;
    credentials.current = { ...app, privateKey: pem };
    setPem(""); await persist(false);
  }
  const accounts = [...new Set([...(catalog?.installations.map(i => i.login) ?? []), ...(catalog?.app.owner ? [catalog.app.owner] : [])])];
  const connected = !!catalog?.repositories.length && !catalog.warnings.length && !catalog.truncated && !busy && !error;
  return <div className="pcg"><style>{styles}</style>
    <header><h1>GitHub</h1>{!status?.configured && <p className="muted">Connect your organizations and repositories.</p>}</header>
    {busy && <p role="status">Working…</p>}
    {error && <div role="alert" className="panel"><p className="error">{error}</p>
      {(credentials.current || savedConfig.current) && <button disabled={busy} onClick={() => void task(() => persist(true))}>Retry saving connection</button>}
    </div>}
    {notice && <p role="status">{notice}</p>}
    {!status?.configured && <section className="panel">
      <h2>Connect your GitHub organizations</h2>
      <p>Create your App, then choose which repositories to connect.</p>
      
      <details><summary>App name and owner (optional)</summary>
        <label>App name<input value={name} maxLength={34} onChange={e => setName(e.target.value)} /></label>
        <label>Organization that owns the App<input value={owner} placeholder="Leave blank to own it personally" onChange={e => setOwner(e.target.value)} /></label>
        <p className="muted">The App can be installed across your organizations. Every installation still requires GitHub approval.</p>
      </details>
      <div className="footer"><a {...nav.linkProps("/projects")}>Back to projects</a><button className="primary" disabled={busy} onClick={() => void task(start)}>Create GitHub App</button></div>
      <details><summary>Use an existing GitHub App</summary>
        <p className="muted">Enable Metadata, Checks and Commit statuses read; Issues, Pull requests, Contents and Organization Projects read/write, then use the App ID and a generated private key.</p>
        <label>App ID<input value={appId} inputMode="numeric" onChange={e => setAppId(e.target.value)} /></label>
        <label>Private key (.pem)<input type="file" accept=".pem" onChange={e => { const file = e.target.files?.[0]; if (file) { if (file.size > 30_000) setError("Choose a PEM file smaller than 30 KB."); else void file.text().then(setPem); } }} /></label>
        <label>Or paste the private key<textarea value={pem} autoComplete="off" spellCheck={false} onChange={e => setPem(e.target.value)} /></label>
        <div className="footer"><span /><button disabled={busy || !appId || !pem} onClick={() => void task(manual)}>Verify and connect</button></div>
      </details>
    </section>}
    {status?.configured && <>
      <section className="panel">
        <div className="footer"><h2>{status.app?.name ?? "GitHub App"}</h2>
          <span role="status" className="connection-status" data-connected={connected}>
            {connected ? "Connected" : busy ? "Checking…" : error || catalog?.warnings.length || catalog?.truncated ? "Check access" : "Setup needed"}
          </span>
        </div>
        {catalog && <p className="muted">{accounts.map(login => <React.Fragment key={login}><a href={`https://github.com/${encodeURIComponent(login)}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${login} on GitHub`} title={login === catalog.app.owner ? "App owner on GitHub" : "Organization on GitHub"}>{login} ↗</a> · </React.Fragment>)}{catalog.repositories.length} repositories</p>}
        {catalog?.warnings.map(w => <p role="alert" key={w} className="error">{w}</p>)}
        {catalog?.truncated && <p role="alert">Some repositories could not be listed. Check repository access.</p>}
        {catalog && !catalog.repositories.length && <p>Choose repositories to finish connecting.</p>}
        {catalog && <ConnectionAccess catalog={catalog} />}
        <div className="footer"><button disabled={busy} onClick={() => void task(() => refresh())}>Refresh</button>
          {!!catalog?.repositories.length && <a className="button primary" {...nav.linkProps("/projects")}>Open Projects</a>}
          {!catalog?.repositories.length && status.app?.slug && <a className="button primary" href={`https://github.com/apps/${status.app.slug}/installations/new`} target="_blank" rel="noopener noreferrer" onClick={() => { awaitingInstallation.current = true; }}>Choose repositories</a>}
        </div>
      </section>
      <AutomationSettings companyId={companyId} />
      <details className="panel"><summary>Connection settings</summary>
        <div className="details-content">
          {status.app?.slug && <a href={`https://github.com/apps/${status.app.slug}/installations/new`} target="_blank" rel="noopener noreferrer" onClick={() => { awaitingInstallation.current = true; }}>Manage repository access</a>}
          <PersonalProjectAccess companyId={companyId} />
          <section className="danger-zone">
            <h2>Disconnect GitHub</h2>
            <p className="muted">Projects and saved secrets will be kept.</p>
            <div className="footer">
              {disconnecting ? <><button disabled={busy} onClick={() => setDisconnecting(false)}>Cancel</button><button className="danger" disabled={busy} onClick={() => void task(async () => {
                await saveConfiguration(companyId, {}); setStatus({ configured: false, app: null }); setCatalog(null); setDisconnecting(false);
              })}>Disconnect GitHub</button></> : <><span /><button className="danger" disabled={busy} onClick={() => setDisconnecting(true)}>Disconnect…</button></>}
            </div>
          </section>
        </div>
      </details>
    </>}
  </div>;
}

export { GitHubRecordPanel, GitHubAgentSettings };

export function GitHubIssues({ context }: PluginDetailTabProps) {
  if (!context.companyId) return <p>Select a company.</p>;
  if (context.entityType === "issue" && context.entityId) return <TaskSyncDetail key={`${context.companyId}:${context.entityId}`} companyId={context.companyId} issueId={context.entityId} />;
  return context.entityType === "project" && context.entityId ? <NativeGitHubProjects key={`${context.companyId}:${context.entityId}`} companyId={context.companyId} projectId={context.entityId} /> : null;
}
// The current task chat layout hides detail tabs. The supported global toolbar
// supplies company context; resolve the task through the public API on click.
export function GitHubTaskButton({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const location = useHostLocation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [issue, setIssue] = useState<{ id: string; companyId: string; projectId: string | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function open() {
    const match = window.location.pathname.match(/^\/[^/]+\/issues\/([^/]+)\/?$/);
    if (!match) { nav.navigate(PAGE_PATH); return; }
    setBusy(true); setError(""); setIssue(null); dialog.current?.showModal();
    try {
      const task = await hostApi<{ id: string; companyId: string; projectId: string | null }>(`/issues/${encodeURIComponent(decodeURIComponent(match[1]))}`);
      if (task.companyId !== context.companyId) throw new Error("Select this task’s company before opening GitHub issues.");
      setIssue(task);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (!/^\/[^/]+\/issues\/[^/]+\/?$/.test(location.pathname)) return null;
  return <><style>{styles}</style><button className="pcg-toolbar" onClick={() => void open()} aria-label="Open GitHub issues">GitHub</button>
    <dialog className="pcg-dialog" ref={dialog} aria-label="GitHub issues" onClose={() => { setIssue(null); setError(""); }}>
      <div className="pcg"><div className="footer"><span /><button onClick={() => dialog.current?.close()}>Close</button></div>
        {busy && <p role="status">Finding linked repositories…</p>}{error && <p role="alert" className="error">{error}</p>}
      </div>
      {issue && <GitHubIssues context={{ ...context, entityType: "issue", entityId: issue.id, projectId: issue.projectId }} />}
    </dialog>
  </>;
}

export { GitHubTaskList } from "./task-list.js";

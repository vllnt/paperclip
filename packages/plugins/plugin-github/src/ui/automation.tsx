import { message } from "./errors.js";
import React, { useEffect, useState } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { hostApi } from "./api.js";
import type { AutomationRule, SyncSettings } from "../contracts.js";
import type { SyncStatus } from "./task-list.js";

function NativeGitHubPrerequisite({ companyId }: { companyId: string }) {
  const readiness = usePluginAction("native-github-readiness"), confirm = usePluginAction("confirm-native-github");
  const [ready, setReady] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const check = async () => {
    setError("");
    try {
      const endpoints = await hostApi<Array<{ provider?: string; status?: string; assignedAgentId?: string | null }>>(`/companies/${encodeURIComponent(companyId)}/chat-endpoints`);
      const active = (Array.isArray(endpoints) ? endpoints : []).some(e => e.provider === "github" && !!e.assignedAgentId && (e.status === "active" || e.status === "ready"));
      setReady(active);
      const current = await readiness({ companyId }) as { ready?: boolean };
      if (active && !current.ready) { setBusy(true); await confirm({ companyId, ready: true }); }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void check(); }, [companyId]);
  return <section className="panel"><strong>Agent GitHub channel</strong>{ready === true ? <p className="connection-status" data-connected="true">Native GitHub connector ready</p> : ready === false ? <><p>Enable Paperclip’s native GitHub chat connector and assign it to an agent before using agent routing or reviews.</p><a className="button primary" href="/apps/chat/connect?provider=github&purpose=chat">Set up GitHub channel</a></> : <p role="status" className="muted">Checking native connector…</p>}{error && <p role="alert" className="error">{error}</p>}{ready !== true && <button disabled={busy} onClick={() => void check()}>Check again</button>}</section>;
}

export function AutomationSettings({ companyId }: { companyId: string }) {
  const status = usePluginAction("sync-status"), optionsAction = usePluginAction("automation-options"), save = usePluginAction("save-sync-settings"), sync = usePluginAction("sync-now"), installSkill = usePluginAction("install-github-workflow-skill"), skillStatus = usePluginAction("github-workflow-skill-status");
  const nav = useHostNavigation();
  const [settings, setSettings] = useState<SyncSettings | null>(null), [state, setState] = useState<SyncStatus | null>(null);
  const [options, setOptions] = useState<{ agents: { id: string; name: string }[]; repositories: string[] }>({ agents: [], repositories: [] });
  const [skill, setSkill] = useState<any>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [skillBusy, setSkillBusy] = useState(false), [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([status({ companyId }), optionsAction({ companyId }), skillStatus({ companyId })]).then(([s, o, k]) => {
      if (!active) return;
      if (s.status === "fulfilled") { setState(s.value as SyncStatus); setSettings((s.value as SyncStatus).settings); }
      else setError(message(s.reason));
      if (o.status === "fulfilled") setOptions(o.value as typeof options);
      else setError(message(o.reason));
      if (k.status === "fulfilled") setSkill(k.value);
      else setError(message(k.reason));
    });
    return () => { active = false; };
  }, [companyId]);
  function patch(id: string, update: Partial<AutomationRule>) { setSettings(value => value ? { ...value, rules: value.rules.map(rule => rule.id === id ? { ...rule, ...update } : rule) } : value); setNotice(""); }
  async function persist() {
    setBusy(true); setError(""); setNotice("");
    try { setSettings(await save({ companyId, settings }) as SyncSettings); setNotice("Saved"); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <>
    {state?.report?.warnings.length ? <details className="panel"><summary>Sync needs attention · {state.report.warnings.length}</summary><div className="details-content">
      {state.report.warnings.map((warning, i) => <p key={i} className="error">{warning}</p>)}
      <button onClick={() => { void sync({ companyId }).then(() => setNotice("Sync started. Refresh to check the result.")).catch(error => setError(message(error))); }}>Retry sync</button>
    </div></details> : null}
    <details className="panel" onToggle={event => setOpen(event.currentTarget.open)}><summary>Sync & automations{settings?.rules.length ? ` · ${settings.rules.length}` : ""}</summary>
      {open && <NativeGitHubPrerequisite companyId={companyId} />}
      <div className="details-content">
        <p className="muted">New open issues become Todo tasks. Title, description and open/closed state sync both ways, every minute while Paperclip is running.</p>
        <div className="panel"><strong>GitHub workflow skill</strong><p className="muted">Review, request-changes, merge and monitoring policy lives in Paperclip Skills. Configure the skill once; agents follow it alongside the native GitHub connector.</p><p className="muted" role="status">Status: {skill?.status ?? "Checking…"}</p><div className="footer">{skill?.skillId && <button type="button" onClick={() => nav.navigate(`/skills/studio/${encodeURIComponent(skill.skillId)}`)}>Open / edit skill</button>}<button disabled={skillBusy} onClick={() => { setSkillBusy(true); setError(""); void installSkill({ companyId }).then(value => { setSkill(value); setNotice("GitHub workflow skill installed"); }).catch(cause => setError(message(cause))).finally(() => setSkillBusy(false)); }}>{skillBusy ? "Installing…" : skill?.skillId ? "Reconcile skill" : "Install workflow skill"}</button></div></div>
        {settings && <>
          <label className="row"><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} />Automatic sync</label>
          <p className="muted">Routing rules are mechanical event handling: they run in order when an issue is imported or its match changes. Review, merge and monitoring decisions belong in the workflow skill above. Assigning an agent only sets the Paperclip owner; enable wake to request a run immediately.</p>
          {settings.rules.map((rule, index) => <fieldset key={rule.id} className="rule">
            <legend>Rule {index + 1}</legend>
            <div className="row"><input aria-label={`Rule ${index + 1} name`} value={rule.name} onChange={e => patch(rule.id, { name: e.target.value })} />
              <label className="row"><input type="checkbox" checked={rule.enabled} onChange={e => patch(rule.id, { enabled: e.target.checked })} />Enabled</label></div>
            <strong>If all match</strong>
            <div className="row">
              <label>GitHub assignee<input placeholder="Any assignee" value={rule.if.assignee ?? ""} onChange={e => patch(rule.id, { if: { ...rule.if, assignee: e.target.value || undefined } })} /></label>
              <label>Repository<select value={rule.if.repository ?? ""} onChange={e => patch(rule.id, { if: { ...rule.if, repository: e.target.value || undefined } })}><option value="">Any linked repository</option>{options.repositories.map(repo => <option key={repo}>{repo}</option>)}</select></label>
              <label>GitHub label<input placeholder="Any label" value={rule.if.label ?? ""} onChange={e => patch(rule.id, { if: { ...rule.if, label: e.target.value || undefined } })} /></label>
              <label>GitHub state<select value={rule.if.state ?? ""} onChange={e => patch(rule.id, { if: { ...rule.if, state: e.target.value as "open" | "closed" || undefined } })}><option value="">Any state</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
            </div>
            <strong>Then</strong>
            <div className="row"><label>Assign to agent<select value={rule.then.agentId ?? ""} onChange={e => patch(rule.id, { then: { ...rule.then, agentId: e.target.value || undefined, wake: e.target.value ? rule.then.wake : false } })}><option value="">Keep assignee</option>{options.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
              <label>Move to<select value={rule.then.status ?? ""} onChange={e => patch(rule.id, { then: { ...rule.then, status: e.target.value as AutomationRule["then"]["status"] || undefined } })}><option value="">Keep status</option>{["todo", "backlog", "in_review", "blocked"].map(value => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></label>
              <label>Priority<select value={rule.then.priority ?? ""} onChange={e => patch(rule.id, { then: { ...rule.then, priority: e.target.value as AutomationRule["then"]["priority"] || undefined } })}><option value="">Keep priority</option>{["low", "medium", "high", "critical"].map(value => <option key={value}>{value}</option>)}</select></label></div>
            <label className="row"><input type="checkbox" disabled={!rule.then.agentId} checked={!!rule.then.wake} onChange={e => patch(rule.id, { then: { ...rule.then, wake: e.target.checked } })} />Wake assigned agent now</label><p className="muted">Off: assign and wait. On: request a run through Paperclip’s normal checkout, budget and runtime controls.</p>
            <div className="footer"><button onClick={() => setSettings({ ...settings, rules: settings.rules.filter(r => r.id !== rule.id) })}>Remove rule</button>
              {index > 0 && <button onClick={() => { const rules = [...settings.rules]; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; setSettings({ ...settings, rules }); }}>Move up</button>}
            </div>
          </fieldset>)}
          <button onClick={() => setSettings({ ...settings, rules: [...settings.rules, { id: crypto.randomUUID(), name: "Route GitHub tasks", enabled: true, if: { state: "open" }, then: { status: "todo", wake: false } }] })}>Add rule</button>
          <div className="footer"><span role="status">{notice}</span><button className="primary" disabled={busy} onClick={() => void persist()}>{busy ? "Saving…" : "Save changes"}</button></div>
        </>}
        {error && <p role="alert" className="error">{error}</p>}
      </div>
    </details>
  </>;
}

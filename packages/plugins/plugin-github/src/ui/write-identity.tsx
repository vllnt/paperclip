import { message } from "./errors.js";
import React, { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  DEFAULT_GITHUB_WRITE_IDENTITY_POLICY,
  GITHUB_SCOPABLE_PRIVILEGED_ACTIONS,
  GITHUB_WRITE_ACTIONS,
  resolveGitHubWriteIdentity,
  type GitHubPrivilegedScope,
  type GitHubScopablePrivilegedAction,
  type GitHubWriteAction,
  type GitHubWriteIdentityKind,
  type GitHubWriteIdentityPolicy,
} from "@paperclipai/shared/github-write-identity";

const ACTION_LABELS: Record<GitHubWriteAction, string> = {
  commit: "Commits", push: "Pushes", pullRequest: "Pull requests", comment: "Comments and reviews",
};
const KIND_LABELS: Record<GitHubWriteIdentityKind, string> = { user: "As the user", bot: "As the App" };
const PERMISSION_LABELS: Record<GitHubScopablePrivilegedAction, string> = { editWorkflows: "Edit workflow files", workflowDispatch: "Run and rerun workflows" };
const PERMISSION_HELP: Record<GitHubScopablePrivilegedAction, string> = {
  editWorkflows: "Push changes to .github/workflows. Merging a pull request’s base branch into it needs no grant.",
  workflowDispatch: "Dispatch a workflow, or rerun a check.",
};
type PermissionMode = "off" | "all" | "agents";
type PermissionDraft = { mode: PermissionMode; agentIds: string[] };
type AgentChoice = { id: string; name: string; status?: string };
const draftOf = (scope: GitHubPrivilegedScope): PermissionDraft => typeof scope === "boolean" ? { mode: scope ? "all" : "off", agentIds: [] } : { mode: "agents", agentIds: scope.agentIds };
const scopeOf = (draft: PermissionDraft): GitHubPrivilegedScope => draft.mode === "agents" ? { agentIds: draft.agentIds } : draft.mode === "all";

/**
 * Who may edit workflow files and run workflows: nobody, every agent of the company, or chosen agents. Each
 * permission is saved on its own by a board administrator, apart from the rest of the policy; an agent never can.
 */
function WorkflowPermissions({ companyId, policy, saved, onGranted }: {
  companyId: string; policy: GitHubWriteIdentityPolicy; saved: boolean;
  onGranted: (action: GitHubScopablePrivilegedAction, scope: GitHubPrivilegedScope) => void;
}) {
  const grant = usePluginAction("write-identity.grant"), listAgents = usePluginAction("write-identity.agents");
  const [agents, setAgents] = useState<AgentChoice[]>([]);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(GITHUB_SCOPABLE_PRIVILEGED_ACTIONS.map(action => [action, draftOf(policy.privileged[action])])) as Record<GitHubScopablePrivilegedAction, PermissionDraft>);
  const [busy, setBusy] = useState<GitHubScopablePrivilegedAction | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    if (!saved) return;
    let active = true;
    void Promise.resolve().then(() => listAgents({ companyId }))
      .then(value => { if (active) setAgents((value as { agents?: AgentChoice[] } | undefined)?.agents ?? []); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [companyId, saved]);
  if (!saved) return <p className="muted">Save the write identity to grant workflow permissions.</p>;
  const patch = (action: GitHubScopablePrivilegedAction, change: Partial<PermissionDraft>) => { setDrafts(current => ({ ...current, [action]: { ...current[action], ...change } })); setNotice(""); };
  async function save(action: GitHubScopablePrivilegedAction) {
    setBusy(action); setError(""); setNotice("");
    try {
      const result = await grant({ companyId, action, scope: scopeOf(drafts[action]) }) as { scope: GitHubPrivilegedScope };
      setDrafts(current => ({ ...current, [action]: draftOf(result.scope) }));
      onGranted(action, result.scope);
      setNotice(`Saved ${PERMISSION_LABELS[action]}`);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }
  return <section className="panel">
    <strong>Workflow permissions</strong>
    <p className="muted">Off by default. Grant a permission to chosen agents rather than to every agent. Only a board administrator can change these; an agent never can.</p>
    {GITHUB_SCOPABLE_PRIVILEGED_ACTIONS.map(action => {
      const draft = drafts[action], known = new Set(agents.map(agent => agent.id));
      const choices = [...agents, ...draft.agentIds.filter(id => !known.has(id)).map(id => ({ id, name: `Unknown agent (${id.slice(0, 8)}…)` }))];
      return <fieldset key={action} className="rule">
        <legend>{PERMISSION_LABELS[action]}</legend>
        <p className="muted">{PERMISSION_HELP[action]}</p>
        <select aria-label={PERMISSION_LABELS[action]} value={draft.mode} onChange={e => patch(action, { mode: e.target.value as PermissionMode })}>
          <option value="off">Off</option>
          <option value="all">Every agent</option>
          <option value="agents">Chosen agents</option>
        </select>
        {draft.mode === "agents" && <div className="row">{choices.map(choice => <label key={choice.id}>
          <input type="checkbox" checked={draft.agentIds.includes(choice.id)}
            onChange={e => patch(action, { agentIds: e.target.checked ? [...draft.agentIds, choice.id] : draft.agentIds.filter(id => id !== choice.id) })} />{choice.name}</label>)}</div>}
        <div className="footer">
          <button disabled={busy !== null || (draft.mode === "agents" && !draft.agentIds.length)} onClick={() => void save(action)}>{busy === action ? "Saving…" : `Save ${PERMISSION_LABELS[action]}`}</button>
        </div>
      </fieldset>;
    })}
    <span role="status">{notice}</span>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}

/** Who authors agent writes to GitHub: the company's App or the run's user. */
export function WriteIdentitySettings({ companyId, appSlug }: { companyId: string; appSlug?: string }) {
  const load = usePluginAction("write-identity.get"), save = usePluginAction("write-identity.set");
  const [policy, setPolicy] = useState<GitHubWriteIdentityPolicy | null>(null);
  /** Whether the policy shown is the one the server has: grants change a saved policy, not a draft. */
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => load({ companyId }))
      .then(value => {
        if (!active) return;
        const stored = (value as { policy?: GitHubWriteIdentityPolicy | null } | undefined)?.policy ?? null;
        setPolicy(stored); setSaved(stored !== null); setLoaded(true);
      })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [companyId]);
  const bot = appSlug ? `${appSlug}[bot]` : "the GitHub App";
  /** Dropping the policy discards the stored one from view: what is ticked again afterwards is a new draft, not what the server has. */
  function update(next: GitHubWriteIdentityPolicy | null) { setPolicy(next); if (next === null) setSaved(false); setNotice(""); }
  function patchOverride(index: number, change: Partial<GitHubWriteIdentityPolicy["overrides"][number]>) {
    if (!policy) return;
    update({ ...policy, overrides: policy.overrides.map((override, i) => {
      if (i !== index) return override;
      const merged = { ...override, ...change };
      for (const action of GITHUB_WRITE_ACTIONS) if (merged[action] === undefined) delete merged[action];
      return merged;
    }) });
  }
  async function persist() {
    setBusy(true); setError(""); setNotice("");
    try {
      const stored = (await save({ companyId, policy }) as { policy: GitHubWriteIdentityPolicy | null }).policy;
      setPolicy(stored); setSaved(stored !== null); setNotice("Saved");
    }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <details className="panel"><summary>Write identity{loaded ? ` · ${policy ? "Custom" : "Default"}` : ""}</summary>
    <div className="details-content">
      <p className="muted">Choose who authors commits, pushes, pull requests and comments made by agents. <strong>As the user</strong> uses the agent’s dedicated GitHub account if it has one, otherwise the personal GitHub connection of the person whose instructions the agent is following. <strong>As the App</strong> writes as {bot}.</p>
      {loaded && <label className="row"><input type="checkbox" checked={!!policy} onChange={e => update(e.target.checked ? DEFAULT_GITHUB_WRITE_IDENTITY_POLICY : null)} />Choose the identity per action</label>}
      {loaded && !policy && <p className="muted">Default: agent <code>git</code> and <code>gh</code> commands write as the user; GitHub tools write as the App.</p>}
      {policy && <>
        <div className="row">{GITHUB_WRITE_ACTIONS.map(action => <label key={action}>{ACTION_LABELS[action]}
          <select value={policy.default[action]} onChange={e => update({ ...policy, default: { ...policy.default, [action]: e.target.value as GitHubWriteIdentityKind } })}>
            {(["user", "bot"] as const).map(kind => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
          </select></label>)}</div>
        <strong>Repository overrides</strong>
        <p className="muted">The first matching pattern wins. Use owner/name with * for any part, such as vllnt/*. Unset actions use the defaults above.</p>
        {policy.overrides.map((override, index) => <fieldset key={index} className="rule">
          <legend>Override {index + 1}</legend>
          <label>Repositories<input value={override.match} placeholder="vllnt/*" onChange={e => patchOverride(index, { match: e.target.value })} /></label>
          <div className="row">{GITHUB_WRITE_ACTIONS.map(action => <label key={action}>{ACTION_LABELS[action]}
            <select value={override[action] ?? ""} onChange={e => patchOverride(index, { [action]: (e.target.value || undefined) as GitHubWriteIdentityKind | undefined })}>
              <option value="">Use default</option>
              {(["user", "bot"] as const).map(kind => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </select></label>)}</div>
          <div className="footer"><button onClick={() => update({ ...policy, overrides: policy.overrides.filter((_, i) => i !== index) })}>Remove override</button></div>
        </fieldset>)}
        <button onClick={() => update({ ...policy, overrides: [...policy.overrides, { match: "" }] })}>Add override</button>
        <WorkflowPermissions companyId={companyId} policy={policy} saved={saved}
          onGranted={(action, scope) => setPolicy(current => current && { ...current, privileged: { ...current.privileged, [action]: scope } })} />
        <label>When the user has no GitHub connection<select value={policy.missingUserConnection} onChange={e => update({ ...policy, missingUserConnection: e.target.value as GitHubWriteIdentityPolicy["missingUserConnection"] })}>
          <option value="fail">Stop and ask them to connect GitHub</option>
          <option value="use_bot">Write as the App instead</option>
        </select></label>
        <section className="panel">
          <label>Preview a repository<input value={preview} placeholder="owner/name" onChange={e => setPreview(e.target.value)} /></label>
          {preview.trim() && <ul aria-label="Write identity preview">{GITHUB_WRITE_ACTIONS.map(action => <li key={action}>{ACTION_LABELS[action]}: {KIND_LABELS[resolveGitHubWriteIdentity(policy, { repository: preview.trim(), action, surface: "runtime" })]}</li>)}</ul>}
        </section>
      </>}
      <p className="muted">Commands Paperclip cannot classify write as the user only when every action does. Reads keep the run’s normal identity. Low-trust runs never receive a user token.</p>
      {loaded && <div className="footer"><span role="status">{notice}</span><button className="primary" disabled={busy} onClick={() => void persist()}>{busy ? "Saving…" : "Save write identity"}</button></div>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  </details>;
}

import { message } from "./errors.js";
import React, { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  DEFAULT_GITHUB_WRITE_IDENTITY_POLICY,
  GITHUB_WRITE_ACTIONS,
  resolveGitHubWriteIdentity,
  type GitHubWriteAction,
  type GitHubWriteIdentityKind,
  type GitHubWriteIdentityPolicy,
} from "@paperclipai/shared/github-write-identity";

const ACTION_LABELS: Record<GitHubWriteAction, string> = {
  commit: "Commits", push: "Pushes", pullRequest: "Pull requests", comment: "Comments and reviews",
};
const KIND_LABELS: Record<GitHubWriteIdentityKind, string> = { user: "As the user", bot: "As the App" };

/** Who authors agent writes to GitHub: the company's App or the run's user. */
export function WriteIdentitySettings({ companyId, appSlug }: { companyId: string; appSlug?: string }) {
  const load = usePluginAction("write-identity.get"), save = usePluginAction("write-identity.set");
  const [policy, setPolicy] = useState<GitHubWriteIdentityPolicy | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => load({ companyId }))
      .then(value => { if (active) { setPolicy((value as { policy?: GitHubWriteIdentityPolicy | null } | undefined)?.policy ?? null); setLoaded(true); } })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [companyId]);
  const bot = appSlug ? `${appSlug}[bot]` : "the GitHub App";
  function update(next: GitHubWriteIdentityPolicy | null) { setPolicy(next); setNotice(""); }
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
    try { setPolicy((await save({ companyId, policy }) as { policy: GitHubWriteIdentityPolicy | null }).policy); setNotice("Saved"); }
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

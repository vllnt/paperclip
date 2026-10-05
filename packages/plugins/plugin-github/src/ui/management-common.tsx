import React, { useRef, useState } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { message } from "./errors.js";
export type Values = Record<string, any>;
export type Operation = (op: string, params?: Values) => Promise<any>;
export function useManagementAction(action: string, scope: Values, persistScope?: string): Operation {
  const invoke = usePluginAction(action), requests = useRef(new Map<string, string>());
  return async (op: string, params: Values = {}) => {
    const payload = { ...scope, ...params, op };
    const key = JSON.stringify(payload);
    let storageKey: string | undefined;
    if (persistScope) {
      // Persist only a hash and receipt ID; no form values or confirmations.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      storageKey = `github-request:${persistScope}:${action}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("")}`;
    }
    let saved: string | null = null;
    try { saved = storageKey ? sessionStorage.getItem(storageKey) : null; } catch { /* Retry identity still survives in memory. */ }
    const requestId = requests.current.get(key) ?? saved ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try { if (storageKey) sessionStorage.setItem(storageKey,requestId); } catch { /* Retry identity still survives in memory. */ }
    const result = await invoke({ ...payload, requestId });
    requests.current.delete(key);
    try { if (storageKey) sessionStorage.removeItem(storageKey); } catch { /* Successful request no longer needs a receipt. */ }
    return result;
  };
}
export type Field = { key: string; label: string; type?: "text" | "textarea" | "number" | "csv" | "checkbox" | "date" | "password" | "identity-multi"; options?: { value: string; label: string; kind?: "user" | "agent" }[]; optional?: boolean; placeholder?: string };
export function ActionForm({ title, fields = [], initial = {}, submit = "Save", run, onDone, confirmation, note, destructive, disabled = false }: {
  title?: string; fields?: Field[]; initial?: Values; submit?: string; run: (values: Values) => Promise<any>; onDone?: (result: any) => void | Promise<void>; confirmation?: string; note?: string; destructive?: boolean; disabled?: boolean;
}) {
  const [values, setValues] = useState<Values>(initial), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const input: Values = {};
      for (const f of fields) {
        const value = values[f.key];
        if (f.optional && (value === undefined || value === "")) continue;
        if (f.type === "identity-multi") {
          const selected = Array.isArray(value) ? value : [];
          input[f.key] = selected.filter((entry: string) => !f.options?.find(option => option.value === entry)?.kind || f.options?.find(option => option.value === entry)?.kind === "user");
          const agentKey = f.key === "assignees" ? "assigneeAgentIds" : f.key === "reviewers" ? "reviewerAgentIds" : `${f.key}AgentIds`;
          input[agentKey] = selected.flatMap((entry: string) => {
            const option = f.options?.find(candidate => candidate.value === entry);
            return option?.kind === "agent" ? [entry.startsWith("agent:") ? entry.slice(6) : entry] : [];
          });
        } else input[f.key] = f.type === "csv" ? String(value ?? "").split(",").map(v => v.trim()).filter(Boolean) : f.type === "number" ? Number(value) : f.type === "checkbox" ? !!value : value ?? "";
      }
      if (confirmation) input.confirm = values.confirm;
      const result = await run(input); setNotice("Saved");
      try { await onDone?.(result); } catch { setError("Saved, but the view could not refresh. Refresh before making another change."); }
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <form className="details-content" onSubmit={e => void save(e)}>
    {title && <h3>{title}</h3>}{note && <p className="muted">{note}</p>}
    <fieldset disabled={busy || disabled} className="form-fields">
      {fields.map(f => <label key={f.key} className={f.type === "checkbox" ? "row" : undefined}>{f.type !== "checkbox" && f.label}
        {f.type === "identity-multi" ? <div className="identity-picker" role="group" aria-label={f.label}>{f.options?.map(option => { const selected = Array.isArray(values[f.key]) && values[f.key].includes(option.value); return <label className="row identity-picker-option" key={option.value}><input type="checkbox" aria-label={option.label} checked={selected} onChange={event => setValues({ ...values, [f.key]: event.target.checked ? [...(values[f.key] ?? []), option.value] : (values[f.key] ?? []).filter((value: string) => value !== option.value) })} /><span>{option.label}</span>{option.kind === "agent" && <span className="badge" data-state="open">Bot</span>}</label>; })}</div>
          : f.options ? <select aria-label={f.label} value={values[f.key] ?? ""} onChange={e => setValues({ ...values, [f.key]: e.target.value })}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : f.type === "textarea" ? <textarea aria-label={f.label} value={values[f.key] ?? ""} onChange={e => setValues({ ...values, [f.key]: e.target.value })} />
            : <input aria-label={f.label} type={f.type === "csv" ? "text" : f.type ?? "text"} required={!f.optional && f.type !== "checkbox" && f.type !== "csv"} placeholder={f.placeholder} checked={f.type === "checkbox" ? !!values[f.key] : undefined} value={f.type === "checkbox" ? undefined : values[f.key] ?? ""} onChange={e => setValues({ ...values, [f.key]: f.type === "checkbox" ? e.target.checked : e.target.value })} />}
        {f.type === "checkbox" && f.label}</label>)}
      {confirmation && <label>Type {confirmation} to confirm<input aria-label="Confirm action" required value={values.confirm ?? ""} onChange={e => setValues({ ...values, confirm: e.target.value })} /></label>}
      <div className="footer"><span role="status">{notice}</span><button type="submit" className={destructive ? "danger" : "primary"} disabled={busy || disabled || (!!confirmation && values.confirm !== confirmation)}>{busy ? "Working…" : submit}</button></div>
    </fieldset>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
export function Disclosure({ title, children }: { title: string; children: React.ReactNode }) { return <details className="panel"><summary>{title}</summary><div className="details-content">{children}</div></details>; }
export function ExternalLink({ url, children }: { url?: string; children: React.ReactNode }) {
  if (!url || !url.startsWith("https://github.com/")) return null;
  return <a href={url} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
}
export const titleBody: Field[] = [{ key: "title", label: "Title" }, { key: "body", label: "Description", type: "textarea" }];
export const csvField = (key: string, label: string, optional = false): Field => ({ key, label, type: "csv", optional });
export const selectField = (key: string, label: string, options: string[]): Field => ({ key, label, options: options.map(value => ({ value, label: value.replaceAll("_", " ") })) });

export function TaskLink({ item }: { item: { paperclipTask?: { id: string; identifier?: string | null }; paperclipTaskError?: string } }) {
  const nav = useHostNavigation();
  if (item.paperclipTaskError) return <p className="error" role="status">{item.paperclipTaskError}</p>;
  return item.paperclipTask ? <a className="task-link" {...nav.linkProps(`/issues/${item.paperclipTask.id}`)}>Open {item.paperclipTask.identifier ?? "task"}</a> : null;
}
export function CacheNote({ fetchedAt }: { fetchedAt?: string }) {
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return null;
  return <p className="muted cache-note" title="GitHub reads are cached for 30 seconds. Refresh fetches the latest data.">Updated {new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>;
}

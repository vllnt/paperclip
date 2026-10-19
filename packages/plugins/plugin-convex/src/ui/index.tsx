import React, { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { usePluginAction, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID, type ReaperItem, type ReaperProjectReport, type ReaperReport } from "../contracts.js";

interface Status {
  connection: "connected" | "disconnected" | "not-configured" | "not-connected";
  configError?: string;
  teamId: string | null;
  projects: Array<{ convexProjectId: string; name: string; repository: string | null; reserved: boolean }>;
  // credentials, grants, guards and reaper are null when the config is invalid: the worker cannot know them, so nothing is claimed.
  credentials: { teamToken: boolean; github: boolean } | null;
  grants: number | null;
  guards: { activityHours: number; maxDeletesPerRun: number; callsPerMinute: number; dryRunOnly: boolean } | null;
  reaper: { enabled: boolean; ttlHours: number; quota: number; alertPercent: number } | null;
}
/** `incomplete` is why a pass stopped early (e.g. its time budget was spent). */
type Report = ReaperReport & { incomplete?: string };
type Action = "connect" | "run";

const message = (error: unknown) => error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Something went wrong. Please try again.";
const when = (at: string | number) => new Date(at).toLocaleString();
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const sum = (report: Report, pick: (project: ReaperProjectReport) => unknown[]) => report.projects.reduce((total, project) => total + pick(project).length, 0);

// This component is only mounted on the page slot: the host keeps its schema-driven config form on the plugin settings page, and the CLI is the alternative.
const CLI = `paperclipai plugin config:set ${PLUGIN_ID} -C <companyId> --payload-json '{"configJson":{...}}'`;

const CONNECTION: Record<Status["connection"], { label: string; next: string }> = {
  connected: { label: "Connected", next: "" },
  disconnected: { label: "Disconnected", next: "An instance administrator can press Verify and connect to reconnect." },
  "not-configured": { label: "Not configured", next: "Map at least one Convex project and set the team token or a project token in the plugin settings." },
  "not-connected": { label: "Not connected", next: "An instance administrator must press Verify and connect." },
};

// The host's Tailwind preflight strips UA button, heading and list styles, so everything is restated here and scoped to .pcx.
const styles = `
.pcx { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.25rem; max-width: 56rem; color: var(--foreground, inherit); }
.pcx * { box-sizing: border-box; }
.pcx h1, .pcx h2, .pcx p, .pcx ul { margin: 0; }
.pcx h1 { font-size: 1.5rem; font-weight: 650; line-height: 1.2; }
.pcx h2 { font-size: 1.125rem; font-weight: 600; line-height: 1.3; }
.pcx section { display: grid; gap: .5rem; min-width: 0; }
.pcx ul { padding-left: 1.25rem; list-style: disc; }
.pcx code { font-family: var(--font-mono, ui-monospace, monospace); font-size: .9em; overflow-wrap: anywhere; }
.pcx table { width: 100%; min-width: 30rem; border-collapse: collapse; }
.pcx th, .pcx td { text-align: left; vertical-align: top; padding: .25rem .5rem; border-bottom: 1px solid var(--border, #8884); overflow-wrap: anywhere; }
.pcx th { font-weight: 600; white-space: nowrap; overflow-wrap: normal; }
.pcx .pcx-scroll { overflow-x: auto; }
.pcx .pcx-scroll:focus-visible, .pcx summary:focus-visible, .pcx button:focus-visible { outline: 2px solid var(--ring, currentColor); outline-offset: 2px; }
.pcx .pcx-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pcx .pcx-note { color: var(--muted-foreground, inherit); overflow-wrap: anywhere; }
.pcx .pcx-error { color: var(--destructive, #b00020); overflow-wrap: anywhere; }
.pcx .pcx-warn { border-left: 3px solid var(--destructive, #b00020); padding-left: .75rem; overflow-wrap: anywhere; }
.pcx .pcx-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; }
.pcx button { border: 1px solid var(--border, #8886); border-radius: var(--radius, .5rem); padding: .375rem .875rem; background: var(--background, transparent); color: inherit; font: inherit; }
.pcx button:not(:disabled):not([aria-disabled="true"]) { cursor: pointer; }
.pcx button:not(:disabled):not([aria-disabled="true"]):hover { background: var(--accent, #8882); }
.pcx button:disabled, .pcx button[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.pcx summary { cursor: pointer; overflow-wrap: anywhere; }
.pcx details { border: 1px solid var(--border, #8884); border-radius: var(--radius, .5rem); padding: .5rem .75rem; }
.pcx details[open] > summary { margin-bottom: .5rem; }
`;

export function ConvexPage({ context }: PluginPageProps) {
  if (!context.companyId) return <p>Select a company to manage Convex.</p>;
  return <ConvexPanel key={context.companyId} companyId={context.companyId} />;
}

function ConvexPanel({ companyId }: { companyId: string }) {
  const statusAction = usePluginAction("status"), reportAction = usePluginAction("reaper.report"), runAction = usePluginAction("reaper.run"), connectAction = usePluginAction("connection.connect");
  const [status, setStatus] = useState<Status | null>(null), [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState<Action | null>(null), [notice, setNotice] = useState<{ action: Action; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setError("");
      const [nextStatus, nextReport] = await Promise.all([statusAction({ companyId }), reportAction({ companyId })]);
      setStatus(nextStatus as Status);
      setReport((nextReport ?? null) as Report | null);
    } catch (e) { setError(message(e)); }
  }, [companyId, statusAction, reportAction]);
  useEffect(() => { void load(); }, [load]);

  // The buttons stay enabled while busy (aria-disabled) so the keyboard focus is not dropped; `act` is the guard that ignores a second press.
  async function act(action: Action, run: () => Promise<string>) {
    if (busy) return;
    setBusy(action); setNotice(null); setError("");
    try { const text = await run(); await load(); setNotice({ action, text }); } catch (e) { setError(message(e)); } finally { setBusy(null); }
  }
  const connect = () => act("connect", async () => {
    const result = await connectAction({ companyId }) as { projects?: unknown[] } | null;
    return `Connected at ${new Date().toLocaleTimeString()}${Array.isArray(result?.projects) ? `: ${plural(result.projects.length, "project")} verified` : ""}.`;
  });
  const dryRun = () => act("run", async () => {
    const result = await runAction({ companyId, dryRun: true }) as Report | null;
    const at = `Dry run finished at ${new Date().toLocaleTimeString()}`;
    if (!Array.isArray(result?.projects)) return `${at}.`;
    const expiries = sum(result, project => project.setExpiry);
    return `${at}: ${sum(result, project => project.delete)} would be deleted, ${expiries === 1 ? "1 expiry would be set" : `${expiries} expiries would be set`}.${result.incomplete ? " The pass stopped early." : ""}`;
  });

  const alert = error ? <p className="pcx-error" role="alert">{error}</p> : null;
  return <div className="pcx">
    <style>{styles}</style>
    <h1>Convex</h1>
    {!status ? (error ? <div className="pcx-actions">{alert}<button type="button" onClick={() => void load()}>Retry</button></div> : <p role="status">Loading…</p>) : <>
      {alert}
      <ConnectionSection status={status} busy={busy} notice={notice?.action === "connect" ? notice.text : ""} onConnect={connect} />
      <Section title="Reaper">
        {status.configError ? null : <ReaperMode status={status} />}
        <ActionRow label="Run a dry run now" busyLabel="Running…" action="run" busy={busy} notice={notice?.action === "run" ? notice.text : ""} blocked={status.connection !== "connected"} blockedReason="Available once Convex is connected (see Connection above)." onClick={dryRun} />
      </Section>
      <ReaperReportView report={report} />
    </>}
  </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

/** A table that scrolls sideways inside its own focusable region instead of overflowing the (overflow-hidden) host page on a phone. */
function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return <div className="pcx-scroll" role="region" aria-label={label} tabIndex={0}><table><caption className="pcx-sr">{label}</caption>{children}</table></div>;
}

/** aria-disabled instead of disabled keeps the focus on the pressed button; the live region announces the outcome. */
function ActionRow({ label, busyLabel, action, busy, notice, blocked, blockedReason, hint, onClick }: {
  label: string; busyLabel: string; action: Action; busy: Action | null; notice: string; blocked?: boolean; blockedReason?: string; hint?: string; onClick: () => void;
}) {
  const id = useId(), unavailable = busy !== null || !!blocked, note = blocked ? blockedReason : hint;
  return <div className="pcx-actions">
    <button type="button" aria-disabled={unavailable} aria-busy={busy === action} aria-describedby={note ? id : undefined} onClick={() => { if (!unavailable) onClick(); }}>{busy === action ? busyLabel : label}</button>
    {note ? <span id={id} className="pcx-note">{note}</span> : null}
    <span role="status" aria-live="polite" className="pcx-note">{notice}</span>
  </div>;
}

function ConnectionSection({ status, busy, notice, onConnect }: { status: Status; busy: Action | null; notice: string; onConnect: () => void }) {
  const { label, next } = CONNECTION[status.connection] ?? { label: status.connection, next: "" };
  const known = [status.credentials ? `Credentials: team token ${status.credentials.teamToken ? "set" : "not set"}, GitHub token ${status.credentials.github ? "set" : "not set"}.` : "", typeof status.grants === "number" ? `Grants: ${status.grants}.` : ""].filter(Boolean).join(" ");
  return <Section title="Connection">
    <p>Status: <strong>{label}</strong>{status.teamId ? ` · team ${status.teamId}` : ""}</p>
    {status.configError ? <>
      <p className="pcx-error">Config problem: {status.configError}</p>
      <p>Fix the config in the plugin settings, then reload this page.</p>
    </> : next ? <p>{next}</p> : null}
    <p className="pcx-note">Tokens are company secrets referenced from this company's Convex plugin settings; they are never shown here.{known ? ` ${known}` : ""}</p>
    {status.projects.length ? <ScrollTable label="Mapped Convex projects">
      <thead><tr><th>Convex project</th><th>Repository</th><th>Connected</th></tr></thead>
      <tbody>{status.projects.map(project => <tr key={project.convexProjectId}>
        <td>{project.name} ({project.convexProjectId})</td><td>{project.repository ?? "not mapped"}</td><td>{project.reserved ? "yes" : "no"}</td>
      </tr>)}</tbody>
    </ScrollTable> : <p className="pcx-note">No Convex project is mapped yet. Map projects in the plugin settings.</p>}
    <p className="pcx-note">Edit the config in the plugin settings. From a terminal: <code>{CLI}</code></p>
    <ActionRow label="Verify and connect" busyLabel="Connecting…" action="connect" busy={busy} notice={notice} hint="Needs an instance administrator." onClick={onConnect} />
  </Section>;
}

/** Live only when the reaper is on and the guards allow deletes (reaper.ts forces a dry run when guards.dryRunOnly is set). */
function ReaperMode({ status }: { status: Status }) {
  const { reaper, guards } = status;
  if (!reaper) return null;
  if (!reaper.enabled) return <p><strong>Off, dry run only.</strong> The reaper reports what it would do and changes nothing. Turn on reaper.enabled in the plugin settings to let it delete finished previews.</p>;
  if (guards?.dryRunOnly !== false) return <p><strong>Enabled, but held to dry run.</strong> The guard dryRunOnly is on, so the reaper reports what it would do and deletes nothing. Turn dryRunOnly off in the plugin settings to let it delete.</p>;
  return <p><strong>Live.</strong> Deletes finished previews every hour, at most {guards.maxDeletesPerRun} per run.</p>;
}

function ReaperReportView({ report }: { report: Report | null }) {
  if (!report) return <Section title="Last reaper report"><p className="pcx-note">No reaper run yet.</p></Section>;
  const details = report.projects.filter(project => groups(project, report.dryRun).some(([, items]) => items.length));
  return <Section title="Last reaper report">
    <p>Last run {when(report.at)} · {report.dryRun ? "dry run" : "live"} · {report.trigger}</p>
    {report.incomplete ? <p className="pcx-warn">This pass stopped early: {report.incomplete}. The next hourly pass continues.</p> : null}
    {report.quota ? <p>
      Deployments: <strong>{report.quota.count}</strong> of {report.quota.quota} ({report.quota.percent}%){report.quota.partial ? ", mapped projects only" : ""}
      {report.quota.alert ? <strong className="pcx-error"> · at or above the alert threshold</strong> : null}
    </p> : null}
    {report.errors.map((item, index) => <p key={`${index}:${item}`} className="pcx-error">{item}</p>)}
    {report.projects.length ? <ScrollTable label="Reaper results by project">
      <thead><tr><th>Project</th><th>Previews</th><th>{report.dryRun ? "Would delete" : "Deleted"}</th><th>{report.dryRun ? "Would set expiry" : "Expiry set"}</th><th>Kept</th><th>Issues</th></tr></thead>
      <tbody>{report.projects.map(project => <ProjectRow key={project.convexProjectId} project={project} dryRun={report.dryRun} />)}</tbody>
    </ScrollTable> : <p className="pcx-note">No mapped projects were checked.</p>}
    {details.map(project => <ProjectDetails key={project.convexProjectId} project={project} dryRun={report.dryRun} />)}
    {report.projects.some(project => project.ciMatched !== undefined) ? <p className="pcx-note">{report.projects.filter(project => project.ciMatched !== undefined).map(project => `${project.name}: CI template matched ${project.ciMatched} of ${project.previews} previews`).join(" · ")}</p> : null}
    {report.projects.some(project => project.dev) ? <div>
      <h3>Dev deployments</h3>
      {report.projects.map(project => project.dev ? <p key={project.convexProjectId} className={project.dev.error || project.dev.failed.length ? "pcx-error" : undefined}>
        {project.name}: {project.dev.listed} listed, {project.dev.executed ? `${project.dev.deleted.length} deleted` : `${project.dev.delete.length} would be deleted (plan only)`}, {project.dev.kept} kept
        {project.dev.failed.length ? `, ${project.dev.failed.length} failed` : ""}{project.dev.error ? ` · ${project.dev.error}` : ""}
      </p> : null)}
    </div> : null}
  </Section>;
}

function ProjectRow({ project, dryRun }: { project: ReaperProjectReport; dryRun: boolean }) {
  const issues = [project.failed.length ? `${project.failed.length} failed` : "", project.skipped.length ? `${project.skipped.length} skipped` : ""].filter(Boolean).join(", ");
  return <tr>
    <td>{project.name}</td><td>{project.previews}</td>
    <td>{dryRun ? project.delete.length : project.deleted.length}</td><td>{dryRun ? project.setExpiry.length : project.expirySet.length}</td><td>{project.kept}</td>
    <td className={project.error || project.failed.length ? "pcx-error" : undefined}>{project.error ?? (issues || "none")}</td>
  </tr>;
}

const explain = (item: ReaperItem) => `${item.name}${item.previewIdentifier ? ` (preview ${item.previewIdentifier})` : ""}: ${item.reason}`;
/** Everything a pass did or would do, by name and reason: it must be readable without hover (touch, keyboard, screen reader). */
function groups(project: ReaperProjectReport, dryRun: boolean): Array<[string, string[]]> {
  return [
    [dryRun ? "Would delete" : "Deleted", dryRun ? project.delete.map(explain) : project.deleted],
    [dryRun ? "Would set expiry" : "Expiry set", dryRun ? project.setExpiry.map(item => `${item.name}: expiry to ${when(item.to)}`) : project.expirySet],
    ["Skipped", project.skipped.map(explain)],
    ["Failed", project.failed.map(item => `${item.name}: ${item.error}`)],
  ];
}

function ProjectDetails({ project, dryRun }: { project: ReaperProjectReport; dryRun: boolean }) {
  const shown = groups(project, dryRun).filter(([, items]) => items.length);
  // Open by default when something would be deleted: that is the pre-flight a board member needs before enabling deletes.
  return <details open={dryRun && project.delete.length > 0}>
    <summary>{project.name} ({shown.map(([title, items]) => `${title.toLowerCase()} ${items.length}`).join(", ")})</summary>
    {shown.map(([title, items]) => <div key={title}>
      <p><strong>{title}</strong></p>
      <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>)}
  </details>;
}

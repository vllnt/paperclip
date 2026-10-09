import React, { useCallback, useEffect, useState } from "react";
import { usePluginAction, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { ReaperProjectReport, ReaperReport } from "../contracts.js";

interface Status {
  connection: "connected" | "disconnected" | "not-configured" | "not-connected";
  configError?: string;
  teamId: string | null;
  projects: Array<{ convexProjectId: string; name: string; repository: string | null; reserved: boolean }>;
  credentials: { teamToken: boolean; github: boolean };
  grants: number;
  reaper: { enabled: boolean; ttlHours: number; quota: number; alertPercent: number } | null;
}

const message = (error: unknown) => error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Something went wrong. Please try again.";
const when = (iso: string) => new Date(iso).toLocaleString();

const styles = `
.pcx { display: grid; gap: 1rem; max-width: 56rem; color: var(--foreground, inherit); }
.pcx h2, .pcx h3 { margin: 0; }
.pcx table { width: 100%; border-collapse: collapse; }
.pcx th, .pcx td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid var(--border, #8884); }
.pcx .pcx-note { color: var(--muted-foreground, inherit); }
.pcx .pcx-error { color: var(--destructive, #b00020); }
.pcx button { cursor: pointer; }
`;

export function ConvexPage({ context }: PluginPageProps) {
  if (!context.companyId) return <p>Select a company to manage Convex.</p>;
  return <ConvexPanel key={context.companyId} companyId={context.companyId} />;
}

function ConvexPanel({ companyId }: { companyId: string }) {
  const statusAction = usePluginAction("status"), reportAction = usePluginAction("reaper.report"), runAction = usePluginAction("reaper.run"), connectAction = usePluginAction("connection.connect");
  const [status, setStatus] = useState<Status | null>(null), [report, setReport] = useState<ReaperReport | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const [nextStatus, nextReport] = await Promise.all([statusAction({ companyId }), reportAction({ companyId })]);
      setStatus(nextStatus as Status);
      setReport((nextReport ?? null) as ReaperReport | null);
    } catch (e) { setError(message(e)); }
  }, [companyId, statusAction, reportAction]);
  useEffect(() => { void load(); }, [load]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    try { await run(); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  return <section className="pcx" aria-label="Convex">
    <style>{styles}</style>
    <h2>Convex</h2>
    {error ? <p className="pcx-error" role="alert">{error}</p> : null}
    {!status ? <p>Loading…</p> : <>
      <div>
        <h3>Connection</h3>
        <p>Status: <strong>{status.connection}</strong>{status.teamId ? ` · team ${status.teamId}` : ""}</p>
        {status.configError ? <p className="pcx-error">Config problem: {status.configError}</p> : null}
        <p className="pcx-note">
          Tokens are company secrets referenced from this company's Convex plugin config; they are never shown here. Credentials: team token {status.credentials?.teamToken ? "set" : "not set"}, GitHub token {status.credentials?.github ? "set" : "not set"}. Grants: {status.grants}.
        </p>
        {status.projects.length ? <table>
          <thead><tr><th>Convex project</th><th>Repository</th><th>Connected</th></tr></thead>
          <tbody>{status.projects.map(project => <tr key={project.convexProjectId}>
            <td>{project.name} ({project.convexProjectId})</td><td>{project.repository ?? "not mapped"}</td><td>{project.reserved ? "yes" : "no"}</td>
          </tr>)}</tbody>
        </table> : <p className="pcx-note">No Convex project is mapped yet. Map projects in the plugin config.</p>}
        <button type="button" disabled={busy} onClick={() => act(() => connectAction({ companyId }))}>Verify and connect</button>
        <span className="pcx-note"> Requires an instance administrator.</span>
      </div>
      <div>
        <h3>Reaper</h3>
        <p>{status.reaper?.enabled ? "Enabled: deletes finished previews every hour." : "Dry run: reports what it would do and changes nothing. Set reaper.enabled in the plugin config to enable it."}</p>
        <button type="button" disabled={busy || status.connection !== "connected"} onClick={() => act(() => runAction({ companyId, dryRun: true }))}>Run a dry run now</button>
        <ReaperReportView report={report} />
      </div>
    </>}
  </section>;
}

function ReaperReportView({ report }: { report: ReaperReport | null }) {
  if (!report) return <p className="pcx-note">No reaper run yet.</p>;
  return <div aria-label="Last reaper report">
    <p>Last run {when(report.at)} · {report.dryRun ? "dry run" : "live"} · {report.trigger}</p>
    {report.quota ? <p>
      Deployments: <strong>{report.quota.count}</strong> of {report.quota.quota} ({report.quota.percent}%){report.quota.partial ? ", mapped projects only" : ""}
      {report.quota.alert ? <strong className="pcx-error"> · at or above the alert threshold</strong> : null}
    </p> : null}
    {report.errors.map(item => <p key={item} className="pcx-error">{item}</p>)}
    <table>
      <thead><tr><th>Project</th><th>Previews</th><th>{report.dryRun ? "Would delete" : "Deleted"}</th><th>Expiry set</th><th>Kept</th><th>Issues</th></tr></thead>
      <tbody>{report.projects.map(project => <ProjectRow key={project.convexProjectId} project={project} dryRun={report.dryRun} />)}</tbody>
    </table>
    {report.projects.some(project => project.dev) ? <div>
      <h3>Dev deployments</h3>
      {report.projects.map(project => project.dev ? <p key={project.convexProjectId} className={project.dev.error || project.dev.failed.length ? "pcx-error" : undefined}>
        {project.name}: {project.dev.listed} listed, {project.dev.executed ? `${project.dev.deleted.length} deleted` : `${project.dev.delete.length} would be deleted (plan only)`}, {project.dev.kept} kept
        {project.dev.failed.length ? `, ${project.dev.failed.length} failed` : ""}{project.dev.error ? ` · ${project.dev.error}` : ""}
      </p> : null)}
    </div> : null}
  </div>;
}

function ProjectRow({ project, dryRun }: { project: ReaperProjectReport; dryRun: boolean }) {
  const names = dryRun ? project.delete.map(item => item.name) : project.deleted;
  return <tr>
    <td>{project.name}</td><td>{project.previews}</td>
    <td title={names.join(", ")}>{names.length}</td><td>{dryRun ? project.setExpiry.length : project.expirySet.length}</td><td>{project.kept}</td>
    <td className={project.error || project.failed.length ? "pcx-error" : undefined}>{project.error ?? (project.failed.length ? `${project.failed.length} failed` : project.skipped.length ? `${project.skipped.length} skipped` : "none")}</td>
  </tr>;
}

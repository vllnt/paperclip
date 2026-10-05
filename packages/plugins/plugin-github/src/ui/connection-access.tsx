import React from "react";
import type { Catalog } from "../contracts.js";
const repositoryPermissions = { issues: "write", pull_requests: "write", contents: "write", checks: "read", statuses: "read" };
const names: Record<string, string> = { issues: "Issues", pull_requests: "Pull requests", contents: "Contents", checks: "Checks", statuses: "Commit statuses", organization_projects: "Organization Projects" };
const allowed = (actual: string | undefined, expected: string) => actual === "admin" || actual === "write" || (expected === "read" && actual === "read");
export function ConnectionAccess({ catalog }: { catalog: Catalog }) {
  const installations = catalog.installations.filter(i => !i.suspended);
  const required = { ...repositoryPermissions, ...(installations.some(i => i.accountType === "Organization") ? { organization_projects: "write" } : {}) };
  const missingApp = Object.entries(required).filter(([key, value]) => !allowed(catalog.app.permissions?.[key], value));
  const pending = installations.filter(i => Object.entries({ ...repositoryPermissions, ...(i.accountType === "Organization" ? { organization_projects: "write" } : {}) }).some(([key, value]) => !allowed(i.permissions?.[key], value)));
  if (!missingApp.length && !pending.length) return null;
  return <details className="access-guide"><summary>Enable PRs &amp; Projects</summary><div className="details-content">
    <p className="muted">Update these permissions, then approve access.</p>
    {missingApp.length > 0 && <div className="access-step"><strong>1. Update App access</strong>
      <ul>{missingApp.map(([key, value]) => <li key={key}><span>{names[key]}</span><span className="muted">{value === "write" ? "Read & write" : "Read"}</span></li>)}</ul>
      {catalog.app.settingsUrl && <a className="button" href={catalog.app.settingsUrl} target="_blank" rel="noopener noreferrer">Edit permissions ↗</a>}
    </div>}
    {!!pending.length && <div className="access-step"><strong>{missingApp.length ? "2. " : ""}Approve for your organization</strong><div className="row">{pending.filter(i => i.settingsUrl).map(i => <a className="button" key={i.id} href={i.settingsUrl} target="_blank" rel="noopener noreferrer">Approve for {i.login} ↗</a>)}</div></div>}
    <p className="muted">Refresh after approving.</p>
  </div></details>;
}

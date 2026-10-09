import type { ConvexDeployment } from "./contracts.js";

export const MANAGEMENT_BASE = "https://api.convex.dev/v1";
const MAX_BODY_BYTES = 5_000_000;

/** An API failure. The message is safe to show: it never contains a credential. */
export class ConvexApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ConvexApiError"; }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function millis(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && /^[0-9]+$/.test(value) ? value : null;
}

/** Normalizes one Convex deployment record; a record without a name is not a deployment. */
export function normalizeDeployment(raw: unknown): ConvexDeployment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = text(record.name);
  if (!name) return null;
  return {
    name,
    kind: text(record.kind),
    deploymentType: text(record.deploymentType),
    projectId: idText(record.projectId),
    reference: text(record.reference),
    previewIdentifier: text(record.previewIdentifier),
    createTime: millis(record.createTime),
    lastDeployTime: millis(record.lastDeployTime),
    expiresAt: millis(record.expiresAt),
    isDefault: typeof record.isDefault === "boolean" ? record.isDefault : null,
    creator: idText(record.creator),
    region: text(record.region),
    deploymentClass: text(record.class),
    deploymentUrl: text(record.deploymentUrl),
  };
}

/** Only Convex cloud hosts may receive a deploy credential. */
export function assertConvexCloudUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConvexApiError(0, "Convex returned an invalid deployment URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.convex\.cloud$/.test(url.hostname)) {
    throw new ConvexApiError(0, "Refusing to send a credential to a host that is not a Convex cloud deployment.");
  }
  return url;
}

export class ConvexClient {
  constructor(private fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  private async request<T>(method: string, url: string, scheme: "Bearer" | "Convex", token: string, body?: unknown): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method, redirect: "error", signal: abort.signal,
          headers: { Authorization: `${scheme} ${token}`, Accept: "application/json", "Convex-Client": "paperclip-convex-plugin", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // The runtime error text can echo request details, so it is replaced.
        throw new ConvexApiError(0, "Convex could not be reached.");
      }
      const raw = await readBody(res);
      if (!res.ok) throw new ConvexApiError(res.status, describeFailure(res.status, raw, token));
      if (res.status === 204 || raw === "") return undefined as T;
      try { return JSON.parse(raw) as T; } catch { throw new ConvexApiError(res.status, "Convex returned a response that is not JSON."); }
    } finally { clearTimeout(timer); }
  }

  // --- Management API (https://api.convex.dev/v1) ---
  listProjects(token: string, teamId: string, cursor?: string) {
    return this.request<{ items?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }>("GET", `${MANAGEMENT_BASE}/teams/${enc(teamId)}/projects?limit=100${cursor ? `&cursor=${enc(cursor)}` : ""}`, "Bearer", token);
  }
  async listProjectDeployments(token: string, projectId: string, deploymentType?: string): Promise<ConvexDeployment[]> {
    const query = deploymentType ? `?deploymentType=${enc(deploymentType)}` : "";
    const items = await this.request<unknown[]>("GET", `${MANAGEMENT_BASE}/projects/${enc(projectId)}/list_deployments${query}`, "Bearer", token);
    return (Array.isArray(items) ? items : []).map(normalizeDeployment).filter((item): item is ConvexDeployment => item !== null);
  }
  async listTeamDeploymentsPage(token: string, teamId: string, cursor?: string): Promise<{ items: ConvexDeployment[]; nextCursor: string | null }> {
    const page = await this.request<{ items?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }>(
      "GET", `${MANAGEMENT_BASE}/teams/${enc(teamId)}/list_deployments?limit=100${cursor ? `&cursor=${enc(cursor)}` : ""}`, "Bearer", token);
    const items = (Array.isArray(page?.items) ? page.items : []).map(normalizeDeployment).filter((item): item is ConvexDeployment => item !== null);
    return { items, nextCursor: page?.pagination?.hasMore && page.pagination.nextCursor ? page.pagination.nextCursor : null };
  }
  async getDeployment(token: string, name: string): Promise<ConvexDeployment | null> {
    return normalizeDeployment(await this.request<unknown>("GET", `${MANAGEMENT_BASE}/deployments/${enc(name)}`, "Bearer", token));
  }
  async setExpiry(token: string, name: string, expiresAt: number | null): Promise<void> {
    await this.request<void>("PATCH", `${MANAGEMENT_BASE}/deployments/${enc(name)}`, "Bearer", token, { expiresAt });
  }
  async deleteDeployment(token: string, name: string): Promise<void> {
    await this.request<void>("POST", `${MANAGEMENT_BASE}/deployments/${enc(name)}/delete`, "Bearer", token);
  }
  listCustomDomains(token: string, name: string) { return this.request<unknown>("GET", `${MANAGEMENT_BASE}/deployments/${enc(name)}/custom_domains`, "Bearer", token); }
  listDeployKeys(token: string, name: string) { return this.request<unknown>("GET", `${MANAGEMENT_BASE}/deployments/${enc(name)}/list_deploy_keys`, "Bearer", token); }
  listPreviewDeployKeys(token: string, projectId: string) { return this.request<unknown>("GET", `${MANAGEMENT_BASE}/projects/${enc(projectId)}/list_preview_deploy_keys`, "Bearer", token); }
  listDeploymentClasses(token: string, teamId: string) { return this.request<unknown>("GET", `${MANAGEMENT_BASE}/teams/${enc(teamId)}/list_deployment_classes`, "Bearer", token); }
  listDeploymentRegions(token: string, teamId: string) { return this.request<unknown>("GET", `${MANAGEMENT_BASE}/teams/${enc(teamId)}/list_deployment_regions`, "Bearer", token); }

  // --- Deployment API (<deploymentUrl>/api/v1, `Authorization: Convex <key>`) ---
  deploymentGet<T = unknown>(token: string, deploymentUrl: string, path: "deployment_info" | "get_current_usage" | "list_usage_limits" | "list_audit_log_events", query = ""): Promise<T> {
    const base = assertConvexCloudUrl(deploymentUrl);
    return this.request<T>("GET", `${base.origin}/api/v1/${path}${query}`, "Convex", token);
  }
}

const enc = encodeURIComponent;

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ConvexApiError(res.status, "Convex returned a response that is too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Status plus the Convex error `code` and `message` when present, with the credential removed and the length bounded. */
function describeFailure(status: number, raw: string, token: string): string {
  let detail = "";
  try {
    const body = JSON.parse(raw) as { code?: unknown; message?: unknown };
    detail = [typeof body.code === "string" ? body.code : "", typeof body.message === "string" ? body.message : ""].filter(Boolean).join(": ");
  } catch { /* a non-JSON body is not shown */ }
  // Remove the whole Authorization value a server might echo, not just the token inside it.
  const redacted = token ? [`Bearer ${token}`, `Convex ${token}`, token].reduce((text, secret) => text.split(secret).join("[redacted]"), detail) : detail;
  const safe = redacted.replace(/\s+/g, " ").slice(0, 200);
  return `Convex answered ${status}${safe ? `: ${safe}` : ""}.`;
}

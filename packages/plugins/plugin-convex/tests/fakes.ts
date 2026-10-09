import type { FetchLike } from "../src/convex-client.js";

export const HOUR = 3_600_000;
export const NOW = Date.parse("2026-10-09T12:00:00Z");

export interface FakeDeployment {
  name: string; deploymentType: string; projectId: number; isDefault: boolean; reference: string; kind?: string;
  previewIdentifier?: string | null; createTime: number; lastDeployTime?: number | null; expiresAt?: number | null; creator?: number | null;
  region?: string; class?: string; deploymentUrl?: string;
}

export function deployment(name: string, overrides: Partial<FakeDeployment> = {}): FakeDeployment {
  return {
    name, deploymentType: "preview", projectId: 100, isDefault: false, reference: `preview/${name}`, kind: "cloud",
    previewIdentifier: name, createTime: NOW - 100 * HOUR, lastDeployTime: NOW - 50 * HOUR, expiresAt: null, creator: 7,
    region: "aws-us-east-1", class: "s16", deploymentUrl: `https://${name}.convex.cloud`, ...overrides,
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bare = (status: number) => new Response(null, { status });

/** In-memory Convex Management and Deployment API. It records every call and the credential used. */
export class FakeConvex {
  deployments = new Map<string, FakeDeployment>();
  calls: Array<{ method: string; url: string; authorization: string | null; body: unknown }> = [];
  validTokens = new Set<string>();
  /** Makes error bodies echo the Authorization header, as a hostile or buggy server could. */
  echoCredentialInErrors = false;
  failDeleteFor = new Set<string>();

  add(...items: FakeDeployment[]) { for (const item of items) this.deployments.set(item.name, item); return this; }
  mutations() { return this.calls.filter(call => call.method !== "GET"); }
  deletes() { return this.calls.filter(call => call.url.endsWith("/delete")); }

  fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, authorization, body });
    const token = authorization?.replace(/^(Bearer|Convex) /, "") ?? "";
    const fail = (status: number, code: string) => json(status, { code, message: this.echoCredentialInErrors ? `rejected credential ${authorization}` : code });
    if (!this.validTokens.has(token)) return fail(401, "Unauthorized");
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (parsed.hostname.endsWith(".convex.cloud")) {
      if (path.endsWith("/get_current_usage")) return json(200, { metrics: { functionCalls: { unit: "calls", usage: { current_day: 10, current_month: 100 } } }, seedStatus: "complete" });
      if (path.endsWith("/list_usage_limits")) return json(200, { usageLimits: [] });
      if (path.endsWith("/deployment_info")) return json(200, { kind: "cloud", teamId: 1, projectId: 100, id: 5, deploymentType: "preview" });
      return fail(404, "NotFound");
    }
    const v1 = path.replace(/^\/v1/, "");
    let match = /^\/deployments\/([^/]+)$/.exec(v1);
    if (match && method === "GET") {
      const found = this.deployments.get(decodeURIComponent(match[1]));
      return found ? json(200, found) : fail(404, "DeploymentNotFound");
    }
    if (match && method === "PATCH") {
      const found = this.deployments.get(decodeURIComponent(match[1]));
      if (!found) return fail(404, "DeploymentNotFound");
      found.expiresAt = (body as { expiresAt: number | null }).expiresAt;
      return bare(200);
    }
    match = /^\/deployments\/([^/]+)\/delete$/.exec(v1);
    if (match && method === "POST") {
      const name = decodeURIComponent(match[1]);
      if (this.failDeleteFor.has(name)) return fail(500, "InternalError");
      return this.deployments.delete(name) ? bare(200) : fail(404, "DeploymentNotFound");
    }
    match = /^\/projects\/([^/]+)\/list_deployments$/.exec(v1);
    if (match) {
      const type = parsed.searchParams.get("deploymentType");
      return json(200, [...this.deployments.values()].filter(item => String(item.projectId) === match![1] && (!type || item.deploymentType === type)));
    }
    match = /^\/teams\/([^/]+)\/list_deployments$/.exec(v1);
    if (match) {
      const all = [...this.deployments.values()];
      const start = Number(parsed.searchParams.get("cursor") ?? 0);
      const items = all.slice(start, start + 100);
      const more = start + 100 < all.length;
      return json(200, { items, pagination: { hasMore: more, nextCursor: more ? String(start + 100) : null } });
    }
    match = /^\/teams\/([^/]+)\/projects$/.exec(v1);
    if (match) return json(200, { items: [{ id: 100, name: "app" }, { id: 200, name: "other" }], pagination: { hasMore: false, nextCursor: null } });
    return fail(404, "NotFound");
  };
}

export interface FakePull { number: number; ref: string; state?: "open" | "closed"; merged?: boolean }

/** In-memory GitHub REST subset used by the preview guard. */
export class FakeGitHub {
  pulls: FakePull[] = [];
  branches = new Map<string, string>();
  calls: string[] = [];
  down = false;
  validTokens = new Set<string>(["gh-token"]);

  fetch: FetchLike = async (url, init) => {
    this.calls.push(url);
    if (this.down) throw new Error("network down");
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validTokens.has(token)) return json(401, { message: "Bad credentials" });
    const parsed = new URL(url);
    const repoPath = parsed.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    if (repoPath === "/pulls") {
      const state = parsed.searchParams.get("state");
      const head = parsed.searchParams.get("head");
      const list = this.pulls.filter(pull => state === "open" ? (pull.state ?? "open") === "open" : true)
        .filter(pull => !head || head.endsWith(`:${pull.ref}`));
      return json(200, list.map(pull => ({ number: pull.number, state: pull.state ?? "open", merged_at: pull.merged ? "2026-10-01T00:00:00Z" : null, head: { ref: pull.ref } })));
    }
    const branch = /^\/branches\/(.+)$/.exec(repoPath);
    if (branch) {
      const name = decodeURIComponent(branch[1]);
      const date = this.branches.get(name);
      return date ? json(200, { name, commit: { commit: { committer: { date } } } }) : json(404, { message: "Branch not found" });
    }
    return json(404, { message: "Not Found" });
  };
}

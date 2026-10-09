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
  /** Deletes the deployment, then answers 502, as a proxy that drops the response could. */
  dropDeleteResponseFor = new Set<string>();
  /** Answers 200 to a delete but keeps the deployment, as a backend that only queued the deletion could. */
  keepAfterDelete = new Set<string>();
  /** After one of these is deleted, reading it answers 500 instead of 404 (a check that cannot tell). */
  flakyAfterDelete = new Set<string>();
  /** After one of these is deleted, reading it answers 200 with a body that is not a deployment. */
  junkAfterDelete = new Set<string>();
  private deletedNames = new Set<string>();
  /** Project list requests for these deployment types answer 403 (a token that may not list them). */
  listDenied = new Set<string>();
  /** GET answers with this name instead of the requested one. */
  answerAs = new Map<string, string>();

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
      if (path.endsWith("/get_current_usage")) return json(200, { metrics: { functionCalls: { unit: "calls", usage: { current_day: 10, current_month: 100 }, internalNote: "LEAK-ME-usage" } }, seedStatus: "complete", billingToken: "LEAK-ME-billing" });
      if (path.endsWith("/list_usage_limits")) return json(200, { usageLimits: [{ id: "u1", metric: "functionCalls", window: "day", limitType: "warning", limit: 1000, enabled: true, webhookSecret: "LEAK-ME-limit" }] });
      if (path.endsWith("/list_audit_log_events")) return json(200, { items: [{ actor: { kind: "member", member_id: 3 }, action: "push_config", createTime: NOW - HOUR, metadata: { note: "pushed" }, clientIp: "203.0.113.9", clientUserAgent: "convex-cli" }], pagination: { hasMore: false, nextCursor: null } });
      if (path.endsWith("/deployment_info")) return json(200, { kind: "cloud", teamId: 1, projectId: 100, id: 5, deploymentType: "preview", adminKey: "LEAK-ME-info" });
      return fail(404, "NotFound");
    }
    const v1 = path.replace(/^\/v1/, "");
    let match = /^\/deployments\/([^/]+)$/.exec(v1);
    if (match && method === "GET") {
      const asked = decodeURIComponent(match[1]);
      const found = this.deployments.get(asked);
      if (!found && this.flakyAfterDelete.has(asked) && this.deletedNames.has(asked)) return fail(500, "InternalError");
      if (!found && this.junkAfterDelete.has(asked) && this.deletedNames.has(asked)) return json(200, { unexpected: true });
      if (found && this.answerAs.has(asked)) return json(200, { ...found, name: this.answerAs.get(asked) });
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
      if (this.dropDeleteResponseFor.has(name)) { this.deployments.delete(name); return fail(502, "BadGateway"); }
      if (this.keepAfterDelete.has(name)) return bare(200);
      this.deletedNames.add(name);
      return this.deployments.delete(name) ? bare(200) : fail(404, "DeploymentNotFound");
    }
    match = /^\/projects\/([^/]+)\/list_deployments$/.exec(v1);
    if (match) {
      const type = parsed.searchParams.get("deploymentType");
      if (type && this.listDenied.has(type)) return fail(403, "Forbidden");
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
    match = /^\/deployments\/([^/]+)\/custom_domains$/.exec(v1);
    if (match) return json(200, { domains: [{ domain: "api.example.com", requestDestination: "convexCloud", creationTime: NOW - 5 * HOUR, verificationTime: null, deploymentName: match[1], internal: "LEAK-ME-domain" }] });
    match = /^\/deployments\/([^/]+)\/list_deploy_keys$/.exec(v1);
    if (match) return json(200, { items: [{ id: 9, name: "ci", creationTime: NOW - 9 * HOUR, lastUsedTime: NOW - HOUR, expiresAt: null, creator: 7, allowedActions: ["deployment:deploy"], adminKey: "LEAK-ME-key-material", token: "LEAK-ME-token" }] });
    match = /^\/teams\/([^/]+)\/list_deployment_classes$/.exec(v1);
    if (match) return json(200, { items: [{ type: "s16", available: true }, { type: "d1024", available: false }] });
    match = /^\/teams\/([^/]+)\/list_deployment_regions$/.exec(v1);
    if (match) return json(200, { items: [{ name: "aws-us-east-1", displayName: "US East", available: true }] });
    match = /^\/teams\/([^/]+)\/projects$/.exec(v1);
    if (match) return json(200, { items: [{ id: 100, name: "app" }, { id: 200, name: "other" }], pagination: { hasMore: false, nextCursor: null } });
    return fail(404, "NotFound");
  };
}

export interface FakePull { number: number; ref: string; state?: "open" | "closed"; merged?: boolean }

/** In-memory GitHub REST subset used by the preview guard. Lists are paged by 100, like GitHub. */
export class FakeGitHub {
  pulls: FakePull[] = [];
  branches = new Map<string, string>();
  /** Extra branch names without a commit date, to build large repositories. */
  extraBranches = 0;
  extraOpenPulls = 0;
  calls: string[] = [];
  down = false;
  /** The token can read pull requests but not branches (answers 404, as a restricted fine-grained token does). */
  branchesHidden = false;
  validTokens = new Set<string>(["gh-token"]);

  fetch: FetchLike = async (url, init) => {
    this.calls.push(url);
    if (this.down) throw new Error("network down");
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validTokens.has(token)) return json(401, { message: "Bad credentials" });
    const parsed = new URL(url);
    const repoPath = parsed.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const page = Number(parsed.searchParams.get("page") ?? 1);
    const slice = <T>(items: T[]) => items.slice((page - 1) * 100, page * 100);
    if (repoPath === "/pulls") {
      const closed = parsed.searchParams.get("state") === "closed";
      const real = this.pulls.filter(pull => (pull.state ?? "open") === (closed ? "closed" : "open"));
      const filler = closed ? [] : Array.from({ length: this.extraOpenPulls }, (_, i) => ({ number: 100000 + i, ref: `filler-${i}` }));
      return json(200, slice([...real, ...filler]).map(pull => ({ number: pull.number, state: closed ? "closed" : "open", merged_at: (pull as FakePull).merged ? "2026-10-01T00:00:00Z" : null, head: { ref: pull.ref } })));
    }
    if (repoPath === "/branches") {
      if (this.branchesHidden) return json(404, { message: "Not Found" });
      const names = [...this.branches.keys(), ...Array.from({ length: this.extraBranches }, (_, i) => `filler-branch-${i}`)];
      return json(200, slice(names).map(name => ({ name })));
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

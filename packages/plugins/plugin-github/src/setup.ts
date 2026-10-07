import { createHash, randomBytes } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { PAGE_PATH, PLUGIN_ID, type SetupStart } from "./contracts.js";
import type { GitHubClient } from "./github.js";

export function boardScope(params: Record<string, unknown>, context: PluginPerformActionContext): { companyId: string; userId: string | null } {
  if (context.actor.type !== "user" || !context.companyId || context.actor.companyId !== context.companyId || params.companyId !== context.companyId) {
    throw new Error("Open this plugin as a Paperclip board user in the selected company.");
  }
  return { companyId: context.companyId, userId: context.actor.userId };
}
export function requireInstanceAdmin(context: PluginPerformActionContext): void {
  if (context.actor.type !== "user" || context.actor.isInstanceAdmin !== true) {
    throw new Error("Instance administrator access is required for GitHub connection changes.");
  }
}
export function callbackUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Open setup from Paperclip.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Open setup from Paperclip."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(PAGE_PATH)) {
    throw new Error("Use HTTPS for Paperclip setup, or localhost for local development.");
  }
  return url.href;
}
const hash = (state: string) => createHash("sha256").update(state).digest("hex");
export class SetupService {
  private busy = new Set<string>();
  constructor(private ctx: PluginContext, private github: GitHubClient, private now = Date.now) {}
  async start(params: Record<string, unknown>, context: PluginPerformActionContext): Promise<SetupStart> {
    const { companyId, userId } = boardScope(params, context);
    requireInstanceAdmin(context);
    const returnUrl = callbackUrl(params.returnUrl);
    const owner = typeof params.owner === "string" ? params.owner.trim() : "";
    if (owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw new Error("Enter the GitHub organization name, without a URL.");
    const name = typeof params.name === "string" ? params.name.trim() : "Paperclip GitHub";
    if (!name || name.length > 34) throw new Error("Use an App name between 1 and 34 characters.");
    const state = randomBytes(32).toString("hex");
    // One pending registration per company/user. State is random, hashed, time-limited and consumed before exchange.
    await this.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "setup", stateKey: userId ?? "local-board" }, {
      stateHash: hash(state), companyId, userId, returnUrl, expiresAt: this.now() + 55 * 60_000
    });
    return {
      state, actionUrl: `https://github.com/${owner ? `organizations/${owner}/settings` : "settings"}/apps/new?state=${state}`,
      manifest: { name, url: new URL(returnUrl).origin, description: "Sync GitHub issues with Paperclip tasks using your own GitHub App.",
        redirect_url: returnUrl, setup_url: returnUrl, setup_on_update: true, public: true,
        // This Paperclip is Tailnet-only. GitHub cannot deliver callbacks here,
        // so keep the required manifest placeholder inactive and use polling.
        request_oauth_on_install: false, hook_attributes: { url: "https://example.com/events", active: false },
        default_permissions: { metadata: "read", issues: "write", pull_requests: "write", contents: "write", checks: "write", statuses: "read", organization_projects: "write" },
        default_events: [] }
    };
  }
  async complete(params: Record<string, unknown>, context: PluginPerformActionContext) {
    const { companyId, userId } = boardScope(params, context);
    // complete() returns the new App's private key once, so only an instance
    // administrator, who can also save the plugin config, may receive it.
    requireInstanceAdmin(context);
    const key = `${companyId}:${userId ?? "local-board"}`;
    if (this.busy.has(key)) throw new Error("GitHub setup is already completing. Wait a moment.");
    this.busy.add(key);
    try {
      const scope = { scopeKind: "company" as const, scopeId: companyId, namespace: "setup", stateKey: userId ?? "local-board" };
      const pending = await this.ctx.state.get(scope) as any;
      if (!pending || typeof params.state !== "string" || pending.stateHash !== hash(params.state) || pending.companyId !== companyId || pending.userId !== userId || pending.expiresAt <= this.now() || pending.returnUrl !== callbackUrl(params.returnUrl)) {
        throw new Error("This GitHub setup has expired or belongs to another session. Start setup again.");
      }
      await this.ctx.state.delete(scope);
      const credentials = await this.github.convert(String(params.code ?? ""));
      await this.ctx.activity.log({ companyId, message: "GitHub App registration verified", metadata: { appId: credentials.id } });
      // The instance-admin UI immediately writes the PEM to Paperclip Secrets.
      // Never put credentials in plugin state, config, logs, browser storage or a URL.
      return credentials;
    } finally { this.busy.delete(key); }
  }
}

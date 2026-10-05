import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { boardScope } from "./setup.js";
import { text } from "./management-repository.js";

/**
 * A mapping deliberately stores only a GitHub handle. Authentication always
 * comes from the company's GitHub App installation; per-agent tokens are not
 * accepted or persisted by this plugin.
 */
export interface AgentBotMapping {
  agentId: string;
  login: string;
  identity: "github-account" | "github-app";
  /** This login is a reviewer/assignee target; it never impersonates the author. */
  targetType: "reviewer-login";
  enabled: boolean;
  updatedAt: string;
}

const namespace = "agent-bots";
const key = (agentId: string) => `agent:${agentId}`;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function agentBotStateKey(companyId: string, agentId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace, stateKey: key(agentId) };
}

export async function getAgentBot(ctx: PluginContext, companyId: string, agentId: string): Promise<AgentBotMapping | null> {
  return await ctx.state.get(agentBotStateKey(companyId, agentId)) as AgentBotMapping | null;
}

export async function listAgentBots(ctx: PluginContext, companyId: string): Promise<AgentBotMapping[]> {
  const result: AgentBotMapping[] = [];
  for (let offset = 0; ; offset += 100) {
    const agents = await ctx.agents.list({ companyId, limit: 100, offset });
    for (const agent of agents) {
      const mapping = await getAgentBot(ctx, companyId, agent.id);
      if (mapping) result.push(mapping);
    }
    if (agents.length < 100) return result;
  }
}

export async function resolveAgentBots(ctx: PluginContext, companyId: string, agentIds: string[]): Promise<{ agents: AgentBotMapping[]; logins: string[] }> {
  if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > 15) throw new Error("Choose between 1 and 15 review agents.");
  const ids = [...new Set(agentIds.map(id => text(id, "agent", 100)))];
  const resolved: AgentBotMapping[] = [];
  for (const agentId of ids) {
    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent || agent.status === "terminated") throw new Error("Choose available agents in this company.");
    const mapping = await getAgentBot(ctx, companyId, agentId);
    if (!mapping || !mapping.enabled) throw new Error(`Configure a GitHub bot identity for ${agent.name} first.`);
    resolved.push(mapping);
  }
  const logins = [...new Set(resolved.map(mapping => mapping.login.toLowerCase()))];
  if (logins.length !== resolved.length) throw new Error("Each selected agent must map to a different GitHub login.");
  return { agents: resolved, logins };
}

export function registerAgentBots(ctx: PluginContext) {
  ctx.actions.register("agent-bot-options", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const agents = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.agents.list({ companyId, limit: 100, offset });
      agents.push(...page.filter(agent => agent.status !== "terminated").map(agent => ({ id: agent.id, name: agent.name, status: agent.status })));
      if (page.length < 100) break;
    }
    const mappings = await listAgentBots(ctx, companyId);
    return { agents, mappings };
  });

  ctx.actions.register("save-agent-bot", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const agentId = text(params.agentId, "agent", 100);
    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent || agent.status === "terminated") throw new Error("Choose an available agent in this company.");
    const login = text(params.login, "GitHub login", 39);
    if (!loginPattern.test(login)) throw new Error("Enter a valid GitHub login.");
    const identity = params.identity === "github-app" ? "github-app" : "github-account";
    const mapping: AgentBotMapping = { agentId, login, identity, targetType: "reviewer-login", enabled: params.enabled !== false, updatedAt: new Date().toISOString() };
    // This state contains no credential material; requests use the existing App installation.
    await ctx.state.set(agentBotStateKey(companyId, agentId), mapping);
    await ctx.activity.log({ companyId, message: "GitHub agent identity configured", metadata: { agentId, login, identity } });
    return mapping;
  });

  ctx.actions.register("remove-agent-bot", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    const agentId = text(params.agentId, "agent", 100);
    await ctx.state.delete(agentBotStateKey(companyId, agentId));
    await ctx.activity.log({ companyId, message: "GitHub agent identity removed", metadata: { agentId } });
    return { agentId, removed: true };
  });
}

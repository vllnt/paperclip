import type { PluginContext } from "@paperclipai/plugin-sdk";
import { boardScope } from "./setup.js";

/** Native Paperclip owns GitHub chat channels, agent identities and formal reviews. */
export const NATIVE_GITHUB_CHAT_SETUP_PATH = "/apps/chat/connect?provider=github&purpose=chat";
export type NativeGitHubEndpoint = Awaited<ReturnType<PluginContext["chat"]["listEndpoints"]>>["endpoints"][number];
export type NativeGitHubReadiness = { required: true; ready: boolean; setupPath: string; owner: "paperclip-native-connector"; pluginScope: "repository-and-task-sync"; endpoints: NativeGitHubEndpoint[]; message: string };
const activeStatuses = new Set(["active", "verifying"]);

/** Query host-owned GitHub channels. No plugin state or credentials are trusted. */
export async function nativeGitHubEndpoints(ctx: PluginContext, companyId: string, agentId?: string): Promise<NativeGitHubEndpoint[]> {
  const result = await ctx.chat.listEndpoints({ companyId, agentId, provider: "github" });
  if (!result.chatConnectorsEnabled) return [];
  return result.endpoints.filter(endpoint => activeStatuses.has(endpoint.status));
}
const stateKey = "native-github-chat";
export async function nativeGitHubReady(ctx: PluginContext, companyId: string, agentId?: string): Promise<boolean> {
  return (await nativeGitHubEndpoints(ctx, companyId, agentId)).length > 0;
}
export async function requireNativeGitHubAgents(ctx: PluginContext, companyId: string, agentIds: string[]): Promise<NativeGitHubEndpoint[]> {
  if (!agentIds.length) return [];
  const endpoints = (await Promise.all(agentIds.map(agentId => nativeGitHubEndpoints(ctx, companyId, agentId)))).flat();
  if (agentIds.some(agentId => !endpoints.some(endpoint => endpoint.assignedAgentId === agentId))) throw nativeConnectorRequiredError();
  return endpoints;
}
export function registerNativeGitHub(ctx: PluginContext) {
  ctx.actions.register("native-github-readiness", async (params, actor): Promise<NativeGitHubReadiness> => {
    const { companyId } = boardScope(params, actor), endpoints = await nativeGitHubEndpoints(ctx, companyId), ready = await nativeGitHubReady(ctx, companyId);
    return { required: true, ready, setupPath: NATIVE_GITHUB_CHAT_SETUP_PATH, owner: "paperclip-native-connector", pluginScope: "repository-and-task-sync", endpoints, message: ready ? "Native Paperclip GitHub channel is enabled for agent routing." : "Enable a native Paperclip GitHub chat channel and assign it to an agent before configuring GitHub automations." };
  });
  // Kept as an idempotent compatibility receipt for the UI onboarding flow.
  // Agent-facing operations never trust this receipt; they query ctx.chat directly.
  ctx.actions.register("confirm-native-github", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    if (params.ready !== true || !(await nativeGitHubReady(ctx, companyId))) throw new Error("Confirm the native Paperclip GitHub channel after assigning it to an agent.");
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "integration", stateKey }, { ready: true, confirmedAt: new Date().toISOString() });
    await ctx.activity.log({ companyId, message: "Native Paperclip GitHub channel enabled for plugin routing", metadata: { owner: "paperclip-native-connector" } });
    return { ready: true, setupPath: NATIVE_GITHUB_CHAT_SETUP_PATH };
  });
  ctx.actions.register("reset-native-github", async (params, actor) => {
    const { companyId } = boardScope(params, actor);
    await ctx.state.delete({ scopeKind: "company", scopeId: companyId, namespace: "integration", stateKey });
    return { ready: false };
  });
}
export function nativeConnectorRequiredError(): Error { return new Error("Enable and assign Paperclip’s native GitHub chat connector first. The GitHub plugin manages repositories and tasks; native Paperclip owns agent channels and review identity."); }

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The agent behind a plugin call. The worker calls the host back as the
 * plugin, so the original caller is lost unless the host keeps it. The host
 * records the agent when it starts a `performAction` or `executeTool` call
 * (from the authenticated request or run context, never from the worker) and
 * exposes it while it serves that call's worker-to-host requests.
 */
export type PluginHostCallAgent = {
  agentId: string;
  runId: string | null;
  companyId: string;
};

const pluginHostCallAgentStorage = new AsyncLocalStorage<PluginHostCallAgent | null>();

/** Runs `fn` with `agent` as the agent behind the current plugin host call. */
export function runWithPluginHostCallAgent<T>(agent: PluginHostCallAgent | null, fn: () => T): T {
  return pluginHostCallAgentStorage.run(agent, fn);
}

/** Returns the agent behind the current plugin host call, or null for a user, system, or proactive call. */
export function currentPluginHostCallAgent(): PluginHostCallAgent | null {
  return pluginHostCallAgentStorage.getStore() ?? null;
}

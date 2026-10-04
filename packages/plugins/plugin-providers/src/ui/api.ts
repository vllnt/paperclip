import type { AiManagedConnectionSummary, AiGatewayTestResult, TestAiGateway } from "@paperclipai/shared";
export type Provider = "openai" | "anthropic";
export type ProviderConnection = AiManagedConnectionSummary;
export type GatewayConnection = ProviderConnection & {
  provider: Provider;
  method: "api_key";
  gateway: { baseUrl: string };
};
export function isGatewayConnection(
  connection: ProviderConnection,
): connection is GatewayConnection {
  return (
    Boolean(connection.gateway) &&
    connection.method === "api_key" &&
    (connection.provider === "openai" || connection.provider === "anthropic")
  );
}

export interface Agent {
  id: string;
  name: string;
  adapterType: string;
  adapterConfig?: { provider?: string; acpxAgent?: string; model?: string };
  runtimeConfig?: { aiConnection?: { connectionId?: string; mode?: string } };
}
export type GatewayTestResult = AiGatewayTestResult;
export type GatewayTestInput = TestAiGateway;
export interface ConnectInput {
  name: string;
  provider: Provider;
  apiKey: string;
  gateway: { baseUrl: string };
  testModel: string;
  allAgents: boolean;
  agentIds: string[];
  connectionId?: string;
  ownership?: "personal" | "shared";
}
export function gatewayApi(companyId: string, request: typeof fetch = fetch) {
  const company = `/api/companies/${encodeURIComponent(companyId)}`;
  async function call<T>(
    path: string,
    input?: unknown,
    signal?: AbortSignal,
    method = input ? "POST" : "GET",
  ): Promise<T> {
    const response = await request(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      ...(input
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `Paperclip returned HTTP ${response.status}. Check the connection and try again.`,
      );
    }
    return response.json() as Promise<T>;
  }
  return {
    list: (signal?: AbortSignal) =>
      call<{ connections: ProviderConnection[] }>(
        `${company}/ai-connections`,
        undefined,
        signal,
      ),
    agents: (signal?: AbortSignal) =>
      call<Agent[]>(`${company}/agents`, undefined, signal),
    test: (input: GatewayTestInput, signal?: AbortSignal) =>
      call<GatewayTestResult>(
        `${company}/ai-connections/gateway/test`,
        input,
        signal,
      ),
    grantCapabilities: (connectionId: string, signal?: AbortSignal) =>
      call<{
        grants: Array<{ id: string; capabilities?: { canRevoke: boolean } }>;
      }>(
        `/api/tool-connections/${encodeURIComponent(connectionId)}/grants`,
        undefined,
        signal,
      ),
    disconnect: (connectionId: string, grantId: string) =>
      call(
        `/api/tool-connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grantId)}`,
        undefined,
        undefined,
        "DELETE",
      ),
    connect: (input: ConnectInput) =>
      call<{ connectionId: string; grantId: string }>(
        `${company}/ai-connections`,
        { ...input, method: "api_key", ownership: input.ownership ?? "shared" },
      ),
  };
}

/** Match the host's supported managed AI clients without changing the agent. */
export function agentHarnessProvider(agent: Agent): Provider | undefined {
  if (agent.adapterType === "claude_local") return "anthropic";
  if (agent.adapterType === "codex_local") return "openai";
  if (agent.adapterType === "paperclip_runner") {
    if (agent.adapterConfig?.provider === "codex") return "openai";
    if (
      agent.adapterConfig?.provider === "claude" ||
      (agent.adapterConfig?.provider === "acpx" &&
        agent.adapterConfig.acpxAgent === "claude")
    )
      return "anthropic";
  }
  return undefined;
}

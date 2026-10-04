import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { gatewayApi, agentHarnessProvider } from "../src/ui/api.js";

describe("Providers setup", () => {
  it("contributes a Providers page and sidebar and requests no secret or background-write capabilities", () => {
    expect(manifest.capabilities).toEqual([
      "ui.page.register",
      "ui.sidebar.register",
      "ui.action.register",
    ]);
    expect(manifest.displayName).toBe("Providers");
    expect(manifest.ui?.slots?.[1]).toMatchObject({
      type: "sidebar",
      displayName: "Providers",
      exportName: "ProvidersSidebar",
      sidebarSection: "org",
    });
    expect(manifest.ui?.slots?.[0]).toMatchObject({
      type: "page",
      routePath: "providers",
      displayName: "Providers",
    });
  });
  it("creates a company-scoped managed connection through the authenticated host API", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ connectionId: "connection", grantId: "grant" }),
        ),
      );
    const api = gatewayApi("company", fetch);
    await api.connect({
      name: "CLIProxyAPI Codex",
      provider: "openai",
      apiKey: "fixture",
      gateway: { baseUrl: "https://proxy.example" },
      testModel: "model",
      allAgents: true,
      agentIds: [],
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/companies/company/ai-connections",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      method: "api_key",
      ownership: "shared",
      allAgents: true,
    });
  });
  it("preserves selected-agent access and reconnect identity", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    await gatewayApi("company", fetch).connect({
      name: "Claude",
      provider: "anthropic",
      apiKey: "new-key",
      gateway: { baseUrl: "https://proxy.example" },
      testModel: "claude-test",
      allAgents: false,
      agentIds: ["agent"],
      connectionId: "existing",
      ownership: "personal",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      ownership: "personal",
      connectionId: "existing",
      agentIds: ["agent"],
      allAgents: false,
    });
  });
  it("surfaces failures and never retries credential submissions automatically", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"The gateway rejected this API key."}', {
        status: 422,
      }),
    );
    await expect(
      gatewayApi("company", fetch).test({
        provider: "openai",
        gateway: { baseUrl: "https://proxy.example" },
        apiKey: "fixture",
      }),
    ).rejects.toThrow("rejected");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("agent harness choices", () => {
  it("recognizes supported clients without modifying their settings", () => {
    const agent = {
      id: "a",
      name: "Agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "claude", model: "custom" },
    };
    expect(agentHarnessProvider(agent)).toBe("anthropic");
    expect(agent.adapterConfig.model).toBe("custom");
    expect(
      agentHarnessProvider({ ...agent, adapterConfig: { provider: "codex" } }),
    ).toBe("openai");
    expect(
      agentHarnessProvider({
        ...agent,
        adapterConfig: { provider: "acpx", acpxAgent: "claude" },
      }),
    ).toBe("anthropic");
    expect(agentHarnessProvider({ ...agent, adapterType: "codex_local" })).toBe(
      "openai",
    );
    expect(
      agentHarnessProvider({ ...agent, adapterType: "claude_local" }),
    ).toBe("anthropic");
    expect(
      agentHarnessProvider({ ...agent, adapterType: "process" }),
    ).toBeUndefined();
  });
});

describe("standalone tests and disconnect", () => {
  it("tests a draft without creating a connection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            models: ["one", "two"],
            provider: "openai",
            checkedAt: "2026-10-04T00:00:00Z",
          }),
        ),
      );
    const result = await gatewayApi("company", fetch).test({
      provider: "openai",
      gateway: { baseUrl: "https://proxy.example" },
      apiKey: "fixture",
    });
    expect(result.models).toEqual(["one", "two"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/companies/company/ai-connections/gateway/test",
    );
  });
  it("tests a saved connection by identity without exposing or replacing its key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    await gatewayApi("company", fetch).test({
      connectionId: "connection",
      grantId: "grant",
      testModel: "two",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      connectionId: "connection",
      grantId: "grant",
      testModel: "two",
    });
  });
  it("disconnects through the existing authenticated grant revocation API", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    await gatewayApi("company", fetch).disconnect("connection", "grant");
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/tool-connections/connection/grants/grant",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "DELETE",
      credentials: "same-origin",
    });
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
  });
  it("surfaces a denied disconnect without retrying or deleting the connection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"Not permitted"}', { status: 403 }),
      );
    await expect(
      gatewayApi("company", fetch).disconnect("connection", "grant"),
    ).rejects.toThrow("Not permitted");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

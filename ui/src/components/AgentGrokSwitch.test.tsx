// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGrokSwitchNotice } from "./AgentGrokSwitch";

const mockPushToast = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };

function makeAgent(overrides: Record<string, unknown> = {}): AgentDetail {
  return {
    id: "agent-1",
    companyId: "company-1",
    urlKey: "alpha",
    name: "Alpha",
    adapterType: "codex_local",
    adapterConfig: { model: "grok-4.7", modelReasoningEffort: "high", cwd: "/work", env: { OPENAI_API_KEY: SECRET } },
    runtimeConfig: {},
    ...overrides,
  } as unknown as AgentDetail;
}

async function flush() {
  flushSync(() => {});
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("AgentGrokSwitchNotice", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(agent: AgentDetail) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <AgentGrokSwitchNotice agent={agent} companyId="company-1" />
        </QueryClientProvider>,
      ),
    );
  }

  it("offers the switch to a codex_local agent running a Grok model, lists what changes, and applies the shared plan", async () => {
    mockAgentsApi.update.mockResolvedValue({});
    render(makeAgent());

    expect(container.querySelector("[data-testid='agent-grok-switch']")).not.toBeNull();
    expect(container.textContent).toContain("OPENAI_API_KEY -> XAI_API_KEY");
    const button = container.querySelector<HTMLButtonElement>("[data-testid='agent-grok-switch-apply']")!;
    flushSync(() => button.click());
    await flush();

    expect(mockAgentsApi.update).toHaveBeenCalledTimes(1);
    const [id, body, companyId] = mockAgentsApi.update.mock.calls[0]!;
    expect([id, companyId]).toEqual(["agent-1", "company-1"]);
    expect(body).toMatchObject({
      adapterType: "grok_local",
      replaceAdapterConfig: true,
      adapterConfig: { model: "grok-4.7", reasoningEffort: "high", cwd: "/work", env: { XAI_API_KEY: SECRET } },
    });
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("sends the gateway URL typed into the page, because the API returns the Codex base URL redacted", async () => {
    mockAgentsApi.update.mockResolvedValue({});
    render(makeAgent({
      adapterConfig: {
        model: "grok-4.7",
        env: { OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: { type: "plain", value: "***REDACTED***" } },
      },
    }));
    expect(container.textContent).toContain("OPENAI_BASE_URL was not carried");

    const input = container.querySelector<HTMLInputElement>("[data-testid='agent-grok-switch-base-url']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setValue.call(input, "https://gateway.example/v1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("OPENAI_BASE_URL was not carried");
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-testid='agent-grok-switch-apply']")!.click());
    await flush();

    expect(mockAgentsApi.update.mock.calls[0]![1].adapterConfig.env).toEqual({
      XAI_API_KEY: SECRET,
      GROK_XAI_API_BASE_URL: { type: "plain", value: "https://gateway.example/v1" },
    });
  });

  it("blocks the button while the typed gateway URL is not an http(s) URL", () => {
    render(makeAgent());
    const input = container.querySelector<HTMLInputElement>("[data-testid='agent-grok-switch-base-url']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setValue.call(input, "gateway.example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='agent-grok-switch-apply']")).toBeNull();
    expect(container.querySelector("[data-testid='agent-grok-switch-blocked']")?.textContent).toContain("not an http(s) URL");
    expect(container.querySelector("[data-testid='agent-grok-switch-base-url']")).not.toBeNull();
  });

  it("shows the server's refusal instead of a success", async () => {
    mockAgentsApi.update.mockRejectedValue(new Error("Adapter \"grok_local\" is not available on this instance."));
    render(makeAgent());
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-testid='agent-grok-switch-apply']")!.click());
    await flush();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("not available on this instance");
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("explains why an agent cannot move, without a button", () => {
    render(makeAgent({ adapterConfig: { model: "grok-4.7", filesystemScope: "workspace" } }));
    expect(container.querySelector("[data-testid='agent-grok-switch-apply']")).toBeNull();
    expect(container.textContent).toContain("filesystemScope");
  });

  it.each([
    ["a GPT model on Codex", makeAgent({ adapterConfig: { model: "gpt-5.5" } })],
    ["an agent already on grok_local", makeAgent({ adapterType: "grok_local", adapterConfig: { model: "grok-4.7" } })],
    ["a Claude agent", makeAgent({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } })],
  ])("shows nothing for %s", (_label, agent) => {
    render(agent);
    expect(container.querySelector("[data-testid='agent-grok-switch']")).toBeNull();
  });
});

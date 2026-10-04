// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { ManagedAiConnectionDetails } from "./ManagedAiConnectionDetails";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  gateway: { baseUrl: "https://proxy.example" } as
    | { baseUrl: string }
    | undefined,
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: {
    activeRuns: async () => [],
    list: async () => ({
      currentUserId: "owner",
      connections: [
        {
          id: "c1",
          grantId: "g1",
          provider: "openai",
          method: "api_key",
          ownership: "shared",
          name: "Proxy",
          gateway: state.gateway,
        },
      ],
    }),
    create: state.create,
  },
}));
vi.mock("@/api/tools", () => ({
  toolsApi: { listConnectionGrants: async () => ({ grants: [{ id: "g1" }] }) },
}));
vi.mock("./AiConnectionAccountControls", () => ({
  AiConnectionAccountControls: ({
    onReconnect,
  }: {
    onReconnect: () => void;
  }) => <button onClick={onReconnect}>Reconnect</button>,
}));
let root: Root | undefined;
let client: QueryClient;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  state.gateway = { baseUrl: "https://proxy.example" };
});
async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (id = "c1") =>
    act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <ManagedAiConnectionDetails
            connection={{ id, companyId: "co" } as ToolConnection}
          />
        </QueryClientProvider>,
      ),
    );
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Reconnect"));
  return { container, render };
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("managed gateway reconnect", () => {
  it("uses the immutable gateway and clears the key after a failed probe", async () => {
    state.create.mockRejectedValueOnce(new Error("Gateway rejected key"));
    const { container } = await mount();
    await act(async () => container.querySelector("button")!.click());
    await type(
      container.querySelector('input[type="password"]')!,
      "fixture-proxy",
    );
    await type(
      container.querySelector('input:not([type="password"])')!,
      "proxy-model",
    );
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Gateway rejected key"),
    );
    expect(state.create).toHaveBeenCalledWith(
      "co",
      expect.objectContaining({
        connectionId: "c1",
        gateway: state.gateway,
        testModel: "proxy-model",
        apiKey: "fixture-proxy",
      }),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[type="password"]')!
        .value,
    ).toBe("");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("drops entered credentials when the connection changes", async () => {
    const { container, render } = await mount();
    await act(async () => container.querySelector("button")!.click());
    await type(
      container.querySelector('input[type="password"]')!,
      "fixture-proxy",
    );
    await render("c2");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("retains the direct provider reconnect flow", async () => {
    state.gateway = undefined;
    const { container } = await mount();
    await act(async () => container.querySelector("button")!.click());
    expect(state.navigate).toHaveBeenCalledWith(
      "/apps/connect?source=openai&reconnect=c1&method=ai-api_key",
    );
    expect(container.querySelector("form")).toBeNull();
  });
});

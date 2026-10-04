// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersPage } from "../src/ui/index.js";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostContext: () => ({ companyId: "company" }),
  useHostLocation: () => ({ pathname: "/CLI/providers", search: "" }),
  useHostNavigation: () => ({
    linkProps: (path: string) => ({ href: `/CLI${path}` }),
  }),
}));
let root: Root;
let container: HTMLDivElement;
const fixture = (
  id: string,
  method: "subscription" | "api_key",
  provider: string = "openai",
) => ({
  id,
  grantId: `${id}-grant`,
  companyId: "company",
  provider,
  method,
  name: id,
  ownership: "personal",
  status: "connected",
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Providers page", () => {
  it("lists subscriptions, direct keys and gateways together without a harness tab", async () => {
    const connections = [
      fixture("My ChatGPT", "subscription"),
      fixture("My Claude", "subscription", "anthropic"),
      fixture("Direct API", "api_key", "openrouter"),
      {
        ...fixture("Proxy", "api_key"),
        gateway: { baseUrl: "https://proxy.example" },
      },
    ];
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/ai-connections")
              ? { connections }
              : url.endsWith("/agents")
                ? []
                : { grants: [] },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<ProvidersPage />));
    expect(
      Array.from(container.querySelectorAll("article")).map((a) =>
        a.getAttribute("aria-label"),
      ),
    ).toEqual(connections.map((c) => c.name));
    expect(container.textContent).not.toContain("Harnesses");
    const subscription = container.querySelector(
      'article[aria-label="My ChatGPT"]',
    )!;
    expect(subscription.textContent).toContain("Subscription");
    expect(subscription.querySelector("a")?.getAttribute("href")).toBe(
      "/CLI/apps/My%20ChatGPT/permissions",
    );
    expect(subscription.textContent).not.toContain("Test connection");
    expect(
      container.querySelector('article[aria-label="Proxy"]')?.textContent,
    ).toContain("Test connection");
    expect(
      fetch.mock.calls.every(([url]) => !url.includes("gateway/test")),
    ).toBe(true);
    const add = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add API provider",
    )!;
    await act(async () => add.click());
    expect(container.querySelector("form")?.textContent).toContain(
      "API format",
    );
    expect(container.querySelector("form")?.textContent).not.toContain(
      "Harness",
    );
  });
  it("shows the connection-list error instead of pretending the company has no providers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Not permitted" }), {
            status: 403,
          }),
      ),
    );
    await act(async () => root.render(<ProvidersPage />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Not permitted",
    );
    expect(container.textContent).not.toContain("No providers yet");
  });
});

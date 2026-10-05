// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { GitHubAgentSettings } from "../src/ui/agent-settings.js";

const nav = { linkProps: (path: string) => ({ href: path }) };
vi.mock("@paperclipai/plugin-sdk/ui", () => ({ useHostNavigation: () => nav }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const context = { companyId: "company-1", entityId: "agent-1" } as any;

describe("GitHub agent channel settings", () => {
  it("shows the assigned native GitHub bot and links to chat settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: "github-endpoint", provider: "github", assignedAgentId: "agent-1", botUsername: "paperclip_bot", status: "active" },
      { id: "slack-endpoint", provider: "slack", assignedAgentId: "agent-1", botUsername: "other_bot", status: "active" },
    ]), { status: 200 })));
    render(<GitHubAgentSettings context={context} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("@paperclip_bot")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open chat settings" }).getAttribute("href")).toBe("/settings");
  });

  it("guides setup when this agent has no native GitHub channel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    render(<GitHubAgentSettings context={context} />);
    expect(await screen.findByText("No native GitHub channel is assigned to this agent.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up GitHub channel" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Save identity|GitHub login/)).toBeNull());
  });
});

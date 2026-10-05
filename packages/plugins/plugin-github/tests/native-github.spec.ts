import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { registerNativeGitHub, NATIVE_GITHUB_CHAT_SETUP_PATH } from "../src/native-github.js";

const actor = { companyId: "c1", actor: { type: "user" as const, userId: "u1", companyId: "c1", agentId: null, runId: null } };

describe("native GitHub connector boundary", () => {
  it("requires native readiness before routing is considered enabled", async () => {
    const h = createTestHarness({ manifest }); vi.spyOn(h.ctx.chat, "listEndpoints").mockResolvedValue({ chatConnectorsEnabled: true, endpoints: [{ id: "ep", companyId: "c1", connectionId: "conn", provider: "github", status: "active", assignedAgentId: "a1", botUsername: "bot", capabilities: {} }] }); registerNativeGitHub(h.ctx);
    await expect(h.performAction("native-github-readiness", {}, actor)).resolves.toMatchObject({ ready: true, owner: "paperclip-native-connector", setupPath: NATIVE_GITHUB_CHAT_SETUP_PATH });
    await expect(h.performAction("confirm-native-github", { ready: false }, actor)).rejects.toThrow("Confirm the native");
  });
  it("stores only a readiness receipt and can reset it", async () => {
    const h = createTestHarness({ manifest }); vi.spyOn(h.ctx.chat, "listEndpoints").mockResolvedValue({ chatConnectorsEnabled: true, endpoints: [{ id: "ep", companyId: "c1", connectionId: "conn", provider: "github", status: "active", assignedAgentId: "a1", botUsername: "bot", capabilities: {} }] }); registerNativeGitHub(h.ctx);
    await expect(h.performAction("confirm-native-github", { ready: true }, actor)).resolves.toMatchObject({ ready: true });
    await expect(h.performAction("native-github-readiness", {}, actor)).resolves.toMatchObject({ ready: true });
    expect(JSON.stringify(h.logs)).not.toMatch(/token|private|secret/i);
    await expect(h.performAction("reset-native-github", {}, actor)).resolves.toMatchObject({ ready: false });
  });
});

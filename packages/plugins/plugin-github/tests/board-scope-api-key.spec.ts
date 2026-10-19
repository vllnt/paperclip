import { describe, expect, it } from "vitest";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { boardScope, requireInstanceAdmin } from "../src/setup.js";

const companyId = "22222222-2222-4222-8222-222222222222";

/**
 * The actor the server forwards for a board API key (pinned by the server test
 * plugin-action-board-key.test.ts). Board-only GitHub actions must accept it.
 */
function boardKeyContext(isInstanceAdmin: boolean): PluginPerformActionContext {
  return {
    companyId,
    actor: {
      type: "user",
      userId: "admin-user",
      agentId: null,
      runId: null,
      companyId,
      ...(isInstanceAdmin ? { isInstanceAdmin: true } : {}),
    },
  };
}

describe("board-only GitHub actions with an API key", () => {
  it("accept the actor a board API key produces", () => {
    expect(boardScope({ companyId }, boardKeyContext(false))).toEqual({ companyId, userId: "admin-user" });
    expect(() => requireInstanceAdmin(boardKeyContext(true))).not.toThrow();
  });

  it("explain an agent credential instead of asking for a browser", () => {
    const context: PluginPerformActionContext = {
      companyId,
      actor: { type: "agent", userId: null, agentId: "agent-1", runId: "run-1", companyId },
    };
    expect(() => boardScope({ companyId }, context)).toThrow(/board-only, but it was called with an agent credential/);
  });

  it("explain a missing company", () => {
    const context: PluginPerformActionContext = {
      companyId: null,
      actor: { type: "user", userId: "admin-user", agentId: null, runId: null, companyId: null },
    };
    expect(() => boardScope({}, context)).toThrow(/needs the company/);
  });

  it("explain a missing instance admin role for a board key", () => {
    expect(() => requireInstanceAdmin(boardKeyContext(false))).toThrow(/board key whose user is an instance admin/);
  });

  it("still refuse a company mismatch", () => {
    expect(() => boardScope({ companyId: "other" }, boardKeyContext(false))).toThrow(/selected company/);
  });
});

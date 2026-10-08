// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { AgentStatusBadge } from "../components/StatusBadge";
import { agentDisplayStatus, agentWaitTitle } from "./agent-display-status";

const waitState = { activeWaitCount: 2, nextCheckAt: "2026-10-09T01:20:00.000Z" };

describe("agent display status", () => {
  it("shows an idle agent with active waits as waiting", () => {
    expect(agentDisplayStatus({ status: "idle", waitState })).toBe("waiting");
    expect(agentDisplayStatus({ status: "active", waitState })).toBe("waiting");
    expect(agentWaitTitle({ status: "idle", waitState })).toMatch(/^Waiting on 2 issues, next check at /);
  });

  it("keeps running, paused and error ahead of waiting, and idle without waits", () => {
    for (const status of ["running", "paused", "error"] as const) {
      expect(agentDisplayStatus({ status, waitState })).toBe(status);
      expect(agentWaitTitle({ status, waitState })).toBeUndefined();
    }
    expect(agentDisplayStatus({ status: "idle", waitState: null })).toBe("idle");
    expect(agentDisplayStatus({ status: "idle", waitState: { activeWaitCount: 0, nextCheckAt: null } })).toBe("idle");
  });

  it("renders the waiting badge with its tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(AgentStatusBadge, { status: "waiting", title: "Waiting on 1 issue" }),
    );
    expect(html).toContain(">waiting<");
    expect(html).toContain('title="Waiting on 1 issue"');
    expect(html).toContain("var(--status-agent-idle)");
  });
});

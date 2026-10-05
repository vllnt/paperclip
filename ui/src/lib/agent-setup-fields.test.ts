// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";
import { buildCodexLocalConfig } from "@paperclipai/adapter-codex-local/ui";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { setupEfforts, setupEngineValues } from "./agent-setup-fields";

describe("new-agent execution engine for the selected environment", () => {
  it.each([buildClaudeLocalConfig, buildCodexLocalConfig])("selects CLI for an SSH worker", (build) => {
    const binding = { type: "secret_ref" as const, secretId: "provider-key", version: "latest" as const };
    const config = build({ ...defaultCreateValues, ...setupEngineValues("ssh"), envBindings: { OPENAI_API_KEY: binding } });
    expect(config.engine).toBe("cli");
    expect(config.env).toEqual({ OPENAI_API_KEY: binding });
  });
  it.each([undefined, "local", "sandbox"])("preserves adapter engine defaults for %s", (driver) => {
    for (const build of [buildClaudeLocalConfig, buildCodexLocalConfig]) {
      expect(build({ ...defaultCreateValues, ...setupEngineValues(driver) })).not.toHaveProperty("engine");
    }
  });
});

describe("model-specific setup efforts", () => {
  it("offers current Claude efforts without offering them on Haiku", () => {
    expect(setupEfforts("claude_local", "claude-fable-5-1")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-haiku-4-5")).toEqual([]);
  });

  it("offers xhigh on Grok 4.7 and 4.6, with the lower limit on 4.5", () => {
    expect(setupEfforts("grok_local", "grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(setupEfforts("grok_local", "grok-4.6")).toContain("xhigh");
    expect(setupEfforts("grok_local", "grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("caps Luna at max while exposing ultra on Sol", () => {
    expect(setupEfforts("codex_local", "gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("codex_local", "gpt-6-sol")).toContain("ultra");
  });
});

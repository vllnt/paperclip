import { describe, expect, it } from "vitest";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";
import { buildCodexLocalConfig } from "@paperclipai/adapter-codex-local/ui";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { setupEngineValues } from "./agent-setup-fields";

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

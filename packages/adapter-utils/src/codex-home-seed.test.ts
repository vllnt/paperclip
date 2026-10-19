import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_HOME_SEED_MAX_BYTES,
  CODEX_HOME_SEED_MAX_FILES,
  resolveCodexHomeSeedSelection,
  seedCodexHomeFiles,
} from "./codex-home-seed.js";

describe("codex home seed", () => {
  let root: string;
  let sourceHome: string;
  let targetHome: string;
  let logs: string[];
  const onLog = async (_stream: "stdout" | "stderr", chunk: string) => {
    logs.push(chunk);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-files-"));
    sourceHome = path.join(root, "worker-codex");
    targetHome = path.join(root, "run-codex-home");
    logs = [];
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(targetHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(configured: unknown, env: Record<string, string> = {}) {
    return seedCodexHomeFiles({
      sourceHome,
      targetHome,
      selection: resolveCodexHomeSeedSelection(configured, env),
      onLog,
    });
  }

  describe("resolveCodexHomeSeedSelection", () => {
    it("defaults to nothing", () => {
      expect(resolveCodexHomeSeedSelection(undefined, {})).toEqual({ names: [], rejected: [] });
      expect(resolveCodexHomeSeedSelection(null, {})).toEqual({ names: [], rejected: [] });
    });

    it("falls back to the comma separated worker env when nothing is configured", () => {
      expect(
        resolveCodexHomeSeedSelection(undefined, {
          PAPERCLIP_CODEX_HOME_SEED: "AGENTS.md, RTK.md,,hooks.json",
        }).names,
      ).toEqual(["AGENTS.md", "RTK.md", "hooks.json"]);
    });

    it("lets an explicit adapter config (even empty) win over the worker env", () => {
      const env = { PAPERCLIP_CODEX_HOME_SEED: "AGENTS.md" };
      expect(resolveCodexHomeSeedSelection([], env).names).toEqual([]);
      expect(resolveCodexHomeSeedSelection(["RTK.md"], env).names).toEqual(["RTK.md"]);
    });

    it("rejects traversal, nested and absolute paths", () => {
      const selection = resolveCodexHomeSeedSelection(
        ["../secret.md", "/etc/passwd", "sub/RTK.md", "..", ".", "a\\b.md", "RTK.md"],
        {},
      );
      expect(selection.names).toEqual(["RTK.md"]);
      expect(selection.rejected.map((entry) => entry.name)).toEqual([
        "../secret.md",
        "/etc/passwd",
        "sub/RTK.md",
        "..",
        ".",
        "a\\b.md",
      ]);
    });

    it("rejects credential-looking and Paperclip-owned names", () => {
      const selection = resolveCodexHomeSeedSelection(
        ["auth.json", "config.toml", "config.json", "instructions.md", "skills", ".env", "token.txt", "id_rsa", "hooks.json"],
        {},
      );
      expect(selection.names).toEqual(["hooks.json"]);
      expect(selection.rejected).toHaveLength(8);
    });

    it("dedupes and caps the number of files", () => {
      const many = Array.from({ length: CODEX_HOME_SEED_MAX_FILES + 5 }, (_, index) => `f${index}.md`);
      const selection = resolveCodexHomeSeedSelection(["a.md", "a.md", ...many], {});
      expect(selection.names).toHaveLength(CODEX_HOME_SEED_MAX_FILES);
      expect(selection.names.filter((name) => name === "a.md")).toHaveLength(1);
      expect(selection.rejected.length).toBeGreaterThan(0);
    });
  });

  describe("seedCodexHomeFiles", () => {
    it("copies the configured files, hooks.json included, owner-only", async () => {
      const hooks = '{"hooks":{"PreToolUse":[{"command":"rtk hook"}]}}\n';
      await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "# Worker tooling\n@RTK.md\n");
      await fs.writeFile(path.join(sourceHome, "RTK.md"), "# RTK\nUse rtk.\n");
      await fs.writeFile(path.join(sourceHome, "hooks.json"), hooks);
      await fs.writeFile(path.join(sourceHome, "notes.md"), "not configured");

      const result = await seed(["AGENTS.md", "RTK.md", "hooks.json"]);

      expect(result.seeded).toEqual(["AGENTS.md", "RTK.md", "hooks.json"]);
      expect(await fs.readFile(path.join(targetHome, "hooks.json"), "utf8")).toBe(hooks);
      expect(await fs.readFile(path.join(targetHome, "RTK.md"), "utf8")).toBe("# RTK\nUse rtk.\n");
      expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toContain("@RTK.md");
      expect((await fs.lstat(path.join(targetHome, "hooks.json"))).mode & 0o777).toBe(0o600);
      expect((await fs.lstat(path.join(targetHome, "hooks.json"))).isSymbolicLink()).toBe(false);
      await expect(fs.access(path.join(targetHome, "notes.md"))).rejects.toThrow();
    });

    it("changes nothing when nothing is configured", async () => {
      await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "# Worker tooling\n");
      await fs.writeFile(path.join(targetHome, "AGENTS.md"), "agent only\n");

      const result = await seed(undefined);

      expect(result.seeded).toEqual([]);
      expect(await fs.readdir(targetHome)).toEqual(["AGENTS.md"]);
      expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toBe("agent only\n");
      expect(logs).toEqual([]);
    });

    it("skips a configured file the worker does not have", async () => {
      const result = await seed(["RTK.md"]);
      expect(result.seeded).toEqual([]);
      expect(await fs.readdir(targetHome)).toEqual([]);
    });

    it("refuses a symlinked source file", async () => {
      const outside = path.join(root, "outside.md");
      await fs.writeFile(outside, "host secret notes");
      await fs.symlink(outside, path.join(sourceHome, "RTK.md"));

      const result = await seed(["RTK.md"]);

      expect(result.seeded).toEqual([]);
      expect(result.skipped).toEqual([{ name: "RTK.md", reason: expect.stringMatching(/symlink/i) }]);
      await expect(fs.access(path.join(targetHome, "RTK.md"))).rejects.toThrow();
      expect(logs.join("")).toMatch(/RTK\.md/);
    });

    it("refuses a source that is a directory", async () => {
      await fs.mkdir(path.join(sourceHome, "RTK.md"));
      const result = await seed(["RTK.md"]);
      expect(result.seeded).toEqual([]);
      expect(result.skipped).toHaveLength(1);
    });

    it("refuses names that traverse out of the worker home", async () => {
      await fs.writeFile(path.join(root, "secret.md"), "outside the worker home");
      const result = await seed(["../secret.md"]);
      expect(result.seeded).toEqual([]);
      expect(await fs.readdir(targetHome)).toEqual([]);
      expect(logs.join("")).toMatch(/secret\.md/);
    });

    it("refuses oversize files", async () => {
      await fs.writeFile(path.join(sourceHome, "RTK.md"), "x".repeat(CODEX_HOME_SEED_MAX_BYTES + 1));
      const result = await seed(["RTK.md"]);
      expect(result.seeded).toEqual([]);
      expect(result.skipped[0]?.reason).toMatch(/exceeds/);
    });

    it("refuses files whose content looks like credentials", async () => {
      await fs.writeFile(
        path.join(sourceHome, "RTK.md"),
        // Built from parts so repo secret scanners do not flag the fixture.
        ["-----BEGIN ", "OPENSSH PRIVATE KEY-----\nabc\n-----END ", "OPENSSH PRIVATE KEY-----\n"].join(""),
      );
      await fs.writeFile(path.join(sourceHome, "hooks.json"), '{"env":{"OPENAI_API_KEY":"sk-abcdefghijklmnopqrstuvwxyz"}}');
      const result = await seed(["RTK.md", "hooks.json"]);
      expect(result.seeded).toEqual([]);
      expect(result.skipped.map((entry) => entry.name)).toEqual(["RTK.md", "hooks.json"]);
      expect(await fs.readdir(targetHome)).toEqual([]);
    });

    it("never writes through a symlink in the run home", async () => {
      const outside = path.join(root, "operator-hooks.json");
      await fs.writeFile(outside, "operator owned");
      await fs.symlink(outside, path.join(targetHome, "hooks.json"));
      await fs.writeFile(path.join(sourceHome, "hooks.json"), '{"hooks":{}}');

      await seed(["hooks.json"]);

      expect(await fs.readFile(outside, "utf8")).toBe("operator owned");
      const seeded = await fs.lstat(path.join(targetHome, "hooks.json"));
      expect(seeded.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(targetHome, "hooks.json"), "utf8")).toBe('{"hooks":{}}');
    });

    it("refreshes a previously seeded file when the worker copy changes", async () => {
      await fs.writeFile(path.join(sourceHome, "RTK.md"), "v1");
      await seed(["RTK.md"]);
      await fs.writeFile(path.join(sourceHome, "RTK.md"), "v2");
      await seed(["RTK.md"]);
      expect(await fs.readFile(path.join(targetHome, "RTK.md"), "utf8")).toBe("v2");
    });

    describe("AGENTS.md merge", () => {
      it("keeps existing agent instructions first and appends worker notes after a separator", async () => {
        await fs.writeFile(path.join(targetHome, "AGENTS.md"), "# Agent instructions\nDo the agent thing.\n");
        await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "# Worker tooling\nUse rtk.\n");

        await seed(["AGENTS.md"]);

        const merged = await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8");
        expect(merged.startsWith("# Agent instructions\nDo the agent thing.\n")).toBe(true);
        const agentAt = merged.indexOf("Do the agent thing.");
        const separatorAt = merged.indexOf("BEGIN PAPERCLIP WORKER SEED");
        const workerAt = merged.indexOf("Use rtk.");
        expect(agentAt).toBeGreaterThanOrEqual(0);
        expect(separatorAt).toBeGreaterThan(agentAt);
        expect(workerAt).toBeGreaterThan(separatorAt);
      });

      it("is idempotent and replaces only its own block on refresh", async () => {
        await fs.writeFile(path.join(targetHome, "AGENTS.md"), "agent instructions\n");
        await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "worker v1\n");
        await seed(["AGENTS.md"]);
        const first = await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8");
        await seed(["AGENTS.md"]);
        expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toBe(first);

        await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "worker v2\n");
        await seed(["AGENTS.md"]);
        const refreshed = await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8");
        expect(refreshed).toContain("agent instructions");
        expect(refreshed).toContain("worker v2");
        expect(refreshed).not.toContain("worker v1");
        expect(refreshed.match(/BEGIN PAPERCLIP WORKER SEED/g)).toHaveLength(1);
      });

      it("does not write through a symlinked AGENTS.md in the run home", async () => {
        const outside = path.join(root, "operator-agents.md");
        await fs.writeFile(outside, "operator owned");
        await fs.symlink(outside, path.join(targetHome, "AGENTS.md"));
        await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "worker notes\n");

        const result = await seed(["AGENTS.md"]);

        expect(await fs.readFile(outside, "utf8")).toBe("operator owned");
        expect(result.seeded).toEqual([]);
        expect(result.skipped[0]?.name).toBe("AGENTS.md");
      });
    });
  });
});

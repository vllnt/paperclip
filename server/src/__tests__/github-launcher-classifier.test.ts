import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "@paperclipai/adapter-utils/github-launcher";
import { classifyGitHubOperation, readGitHubOperation } from "../services/github-write-identity.js";

const exec = promisify(execFile);
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PAPERCLIP_")));
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// The real launcher reports a command, the real classifier decides, and a refusal never runs (round 5, m1).
describe("managed gh launcher and the server classifier, end to end", () => {
  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-launcher-classifier-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), real = path.join(root, "real"), repo = path.join(root, "repo"), log = path.join(root, "gh.jsonl");
    for (const dir of [bin, real, repo]) await mkdir(dir);
    await writeFile(path.join(bin, "package.json"), '{"type":"commonjs"}\n');
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(real, "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), repo: process.env.GH_REPO ?? null }) + '\\n');
`, { mode: 0o700 });
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const operation = readGitHubOperation(JSON.parse(raw));
        const classified = operation ? classifyGitHubOperation(operation) : null;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(!classified || classified.denied
          ? { status: "unavailable", reason: classified?.denied ?? "unreadable", failClosed: true, env: {} }
          : { status: "available", env: { GH_TOKEN: "user-token" }, ...(classified.repository ? { repository: classified.repository } : {}) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const env = { ...hostEnv, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "run-capability" }), PATH: `${bin}:${real}:${process.env.PATH}` };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...hostEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    const gh = (args: string[], extra: Record<string, string> = {}) => exec(path.join(bin, "gh"), args, { cwd: repo, env: { ...env, ...extra } })
      .then(result => ({ code: 0, ...result }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }));
    const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { git, gh, calls };
  }

  it("m1: GH_REPO cannot stand in for the saved default or remote that gh repo edit really acts on", async () => {
    const f = await setup();
    f.git("remote", "add", "origin", "https://github.com/Anthm-FR/linkzic.git");
    f.git("config", "remote.origin.gh-resolved", "base");
    for (const args of [["repo", "edit", "--description", "x"], ["repo", "archive", "--yes"]]) {
      const refused = await f.gh(args, { GH_REPO: "Anthm-FR/songtrivia" });
      expect(refused.code, args.join(" ")).toBe(1);
      expect(refused.stderr, args.join(" ")).toContain("cannot tell which repository");
    }
    // A saved default other than the remote counts the same way.
    f.git("config", "remote.origin.gh-resolved", "Anthm-FR/wordzic");
    expect((await f.gh(["repo", "edit", "--description", "x"], { GH_REPO: "Anthm-FR/songtrivia" })).code).toBe(1);
    expect(await f.calls()).toEqual([]);
    // When GH_REPO and the checkout agree, the command runs.
    f.git("config", "remote.origin.gh-resolved", "base");
    const agreed = await f.gh(["repo", "edit", "--description", "x"], { GH_REPO: "Anthm-FR/linkzic" });
    expect(agreed.code, agreed.stderr).toBe(0);
    expect(await f.calls()).toEqual([{ args: ["repo", "edit", "--description", "x"], repo: "Anthm-FR/linkzic" }]);
  }, 60_000);
});

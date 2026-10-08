import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
import { classifyGitHubCommand } from "@paperclipai/shared";
import { runInNewContext } from "node:vm";
const exec = promisify(execFile);
// A test run inside a Paperclip run must not hand the launcher that run's API route.
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PAPERCLIP_")));
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
  it.each(["repository", "command"])("uses explicit %s identity for local commits without managed credentials", async (identitySource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-identity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const env = { ...hostEnv, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_COMMITTER_NAME: "Host",
    }, { url: "", token: "" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: root, env })).stdout.trim();
    // No configured identity must fail, rather than guessing the host user's.
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    await expect(git("var", "GIT_COMMITTER_IDENT")).rejects.toThrow();
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.name", "Local Author"]);
    await exec("git", ["-C", root, "config", "user.email", "local@example.test"]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    if (failure === "broker-offline") await new Promise<void>(resolve => server.close(() => resolve()));
    else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const configRoot = path.join(root, "config");
    if (failure === "config-unwritable") await writeFile(configRoot, "not a directory");
    const result = await exec(path.join(bin, "git"), ["status", "--porcelain"], { cwd: root, env: {
      ...hostEnv, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...hostEnv, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
  }, 15_000); // broker-offline retries the transport twice per command before it falls back

  it("explains unavailable access while allowing local work without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-diagnostic-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"unavailable",reason:"More than one managed GitHub identity matches this run",env:{GH_TOKEN:"must-not-be-used"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...hostEnv,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("More than one managed GitHub identity matches this run");
    expect(result.stderr).not.toMatch(/host-token|must-not-be-used|run-capability/);
  });
  // The first broker request fails, the second succeeds: the managed token must still reach gh.
  it.each([
    ["connection drops before the response", (res: import("node:http").ServerResponse) => { res.socket?.destroy(); }],
    ["body read fails mid-response", (res: import("node:http").ServerResponse) => {
      res.writeHead(200, {"content-type":"application/json"}); res.write('{"status":'); setTimeout(() => res.socket?.destroy(), 20);
    }],
  ])("retries when the %s and still uses managed credentials", async (_label, fail) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-retry-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    let requests = 0;
    const server = createServer((_req,res) => {
      requests++;
      if (requests === 1) return fail(res);
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"available",env:{GH_TOKEN:"managed-token"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...hostEnv,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:"managed-token"});
    expect(requests).toBe(2);
    expect(result.stderr).not.toContain("broker_transport_unavailable");
    expect(result.stderr).not.toMatch(/host-token|run-capability/);
  });
  // A sandbox reaches Paperclip through its callback bridge (PAPERCLIP_API_URL);
  // the server's public broker URL may not resolve there.
  it.each([
    { label: "a bridged run uses its bridge, not an unresolvable broker URL", bridged: true, broker: "unresolvable", bridge: "up", used: "bridge" },
    { label: "a bridged run falls back to the broker URL when its bridge is down", bridged: true, broker: "up", bridge: "offline", used: "broker" },
    { label: "a run falls back to its API URL when the broker is offline", bridged: false, broker: "offline", bridge: "up", used: "bridge" },
    { label: "a run keeps the broker URL first", bridged: false, broker: "up", bridge: "up", used: "broker" },
  ] as const)("$label", async ({ bridged, broker, bridge, used }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-route-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const requests = { broker: [] as Array<string | undefined>[], bridge: [] as Array<string | undefined>[] };
    const listen = async (name: "broker" | "bridge", state: "up" | "offline") => {
      const server = createServer((req,res) => {
        requests[name].push([req.headers.authorization, req.headers["x-paperclip-github-capability"] as string | undefined]);
        res.setHeader("content-type","application/json");
        res.end(JSON.stringify({status:"available",env:{GH_TOKEN:`${name}-managed-token`}}));
      });
      await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
      const {port} = server.address() as {port:number};
      if (state === "offline") await new Promise<void>(resolve => server.close(() => resolve()));
      else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      return `http://127.0.0.1:${port}`;
    };
    const brokerUrl = broker === "unresolvable" ? "https://paperclip-broker.invalid" : await listen("broker", broker);
    const bridgeUrl = await listen("bridge", bridge);
    const result = await exec(path.join(bin,"gh"), [], {env:{
      ...hostEnv, ...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:brokerUrl,token:"run-capability"}),
      PAPERCLIP_API_URL:`${bridgeUrl}/api`, PAPERCLIP_API_KEY:"bridge-auth",
      ...(bridged ? {PAPERCLIP_API_BRIDGE_MODE:"queue_v1"} : {}),
      PATH:`${bin}:${realBin}:${process.env.PATH}`,
    }});
    expect(JSON.parse(result.stdout)).toEqual({token:`${used}-managed-token`});
    expect(result.stderr).not.toContain("Paperclip: GitHub");
    // The capability check is unchanged on either route.
    expect(requests[used]).toEqual([["Bearer bridge-auth","run-capability"]]);
    if (broker !== "offline" && bridge !== "offline") expect(requests[used === "broker" ? "bridge" : "broker"]).toEqual([]);
  });
  it("does not try another route when the broker answers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-route-rejected-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const requests = { broker: 0, bridge: 0 };
    const listen = async (name: "broker" | "bridge", status: number) => {
      const server = createServer((_req,res) => {
        requests[name]++;
        res.setHeader("content-type","application/json");
        res.writeHead(status);
        res.end(JSON.stringify({status:"available",env:{GH_TOKEN:`${name}-managed-token`}}));
      });
      await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
      cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    };
    const result = await exec(path.join(bin,"gh"), [], {env:{
      ...hostEnv, ...githubBrokerEnvironment({},{url:await listen("broker", 200),token:"run-capability"}),
      PAPERCLIP_API_URL:await listen("bridge", 403), PAPERCLIP_API_BRIDGE_MODE:"queue_v1", PAPERCLIP_API_KEY:"bridge-auth",
      PATH:`${bin}:${realBin}:${process.env.PATH}`,
    }});
    // The bridge is tried first and rejects the capability; that answer stands.
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("capability_rejected");
    expect(requests).toEqual({ broker: 0, bridge: 1 });
  });
  // Agents can act as a person's GitHub account; their work must stay distinguishable.
  async function attributedLauncher(name: "git" | "gh", realSource?: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-attribution-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real"), repo = path.join(root,"repo");
    for (const dir of [bin, realBin, repo]) await mkdir(dir);
    await writeFile(path.join(bin,name), githubLauncherSource(), {mode:0o700});
    if (realSource) await writeFile(path.join(realBin,name), realSource, {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"available",env:{GH_TOKEN:"managed-token"},attribution:{agentName:"Peter\nInjected: yes",runId:"run-1"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const env = {...hostEnv,...githubBrokerEnvironment({},{url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,token:"run-capability"}),
      PATH:`${bin}:${realBin}:${process.env.PATH}`};
    return { root, repo, env, launcher: path.join(bin,name) };
  }
  // Records each real gh invocation, including body-file contents, then fails or succeeds like GitHub.
  const fakeGh = (log: string) => `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2);
const file=args.indexOf('--body-file');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, file: file<0 ? null : fs.readFileSync(args[file+1],'utf8')})+'\\n');
if (args.includes('--approve') || args.includes('-r')) { process.stderr.write('failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)\\n'); process.exit(1); }
`;
  const calls = async (log: string) => (await import("node:fs/promises")).readFile(log, "utf8")
    .then(text => text.trim().split("\n").map(line => JSON.parse(line) as {args: string[]; file: string | null}));
  it("never adds an attribution trailer to commits", async () => {
    const { repo, env, launcher } = await attributedLauncher("git");
    const git = async (...args: string[]) => (await exec(launcher, args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("-c", "user.name=agent-owner", "-c", "user.email=b@example.test", "commit", "--allow-empty", "-m", "Work\n\nRefs: ANT-1");
    expect(await git("log", "-1", "--format=%B")).toBe("Work\n\nRefs: ANT-1");
  });
  it("adds an attribution footer to every gh body form without editing the agent's files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-footer-log-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const log = path.join(root, "calls.jsonl");
    const { repo, env, launcher } = await attributedLauncher("gh", fakeGh(log));
    const footer = "_Posted by Paperclip agent Peter Injected: yes (run run-1)._";
    await writeFile(path.join(repo, "body.md"), "From a file\n");
    for (const args of [
      ["pr", "create", "--title", "T", "--body", "Long body"],
      ["pr", "comment", "12", "-b", "Short"],
      ["pr", "review", "12", "--comment", "--body=Equals"],
      ["issue", "comment", "12", "--body-file", "body.md"],
      ["pr", "comment", "12", "--body", `Already signed\n\n---\n${footer}`],
      ["pr", "edit", "12", "--add-label", "bug"],
      ["pr", "list"],
    ]) await exec(launcher, args, { cwd: repo, env });
    const piped = exec(launcher, ["pr", "comment", "12", "-F", "-"], { cwd: repo, env });
    piped.child.stdin!.end("From stdin");
    await piped;
    const recorded = await calls(log);
    expect(recorded.map(call => call.args.at(-1))).toEqual([
      `Long body\n\n---\n${footer}`, `Short\n\n---\n${footer}`, `Equals\n\n---\n${footer}`,
      expect.stringContaining("body-"), `Already signed\n\n---\n${footer}`, "bug", "list", expect.stringContaining("body-"),
    ]);
    expect(recorded[3]!.file).toBe(`From a file\n\n---\n${footer}`);
    expect(recorded[7]!.file).toBe(`From stdin\n\n---\n${footer}`);
    expect(await (await import("node:fs/promises")).readFile(path.join(repo, "body.md"), "utf8")).toBe("From a file\n");
  });
  it("posts a verdict as a comment review when GitHub refuses it on the account's own pull request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-review-log-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const log = path.join(root, "calls.jsonl");
    const { repo, env, launcher } = await attributedLauncher("gh", fakeGh(log));
    const result = await exec(launcher, ["pr", "review", "12", "--approve"], { cwd: repo, env });
    expect(result.stderr).toContain("posting it as a comment review");
    const bodyOf = (args: string[]) => args[args.indexOf("--body") + 1];
    const [refused, fallback] = await calls(log);
    expect(refused!.args).toEqual(["pr", "review", "12", "--approve", "--body", "_Posted by Paperclip agent Peter Injected: yes (run run-1)._"]);
    expect(fallback!.args).toEqual(["pr", "review", "12", "--body", expect.any(String), "--comment"]);
    expect(bodyOf(fallback!.args)).toMatch(/^\*\*Review verdict: approve\.\*\* GitHub does not let an author approve their own pull request, so[\s\S]*\n\n_Posted by Paperclip agent/);
    await exec(launcher, ["pr", "review", "12", "-r", "-b", "Fix the test"], { cwd: repo, env });
    const requested = (await calls(log)).at(-1)!;
    expect(requested.args).toEqual(["pr", "review", "12", "--body", expect.any(String), "--comment"]);
    expect(bodyOf(requested.args)).toMatch(/^\*\*Review verdict: request changes\.\*\*[\s\S]*\n\nFix the test\n\n---\n_Posted by/);
  });
  it("captures each command's identity and clears host credentials when the next person has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const identity=execFileSync('git',['var','GIT_AUTHOR_IDENT'],{encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({identity, token:process.env.GH_TOKEN ?? null, global:process.env.GIT_CONFIG_GLOBAL, config:process.env.GH_CONFIG_DIR}));
`, { mode: 0o700 });
    let user: string | null = "A", captures = 0;
    let heldCapture: (() => void) | null = null;
    let releaseCapture: (() => void) | null = null;
    const server = createServer((req, res) => {
      captures++;
      expect(req.headers.authorization).toBe("Bearer run-capability");
      const selected = user;
      res.setHeader("content-type", "application/json");
      const finish = () => res.end(JSON.stringify(selected ? { status: "available", env: {
        GH_TOKEN: `credential-${selected}`, GITHUB_TOKEN: `credential-${selected}`,
        GIT_AUTHOR_NAME: selected, GIT_AUTHOR_EMAIL: `${selected}@example.test`,
        GIT_COMMITTER_NAME: selected, GIT_COMMITTER_EMAIL: `${selected}@example.test`,
      } } : { status: "absent", env: {} }));
      if (heldCapture) { const captured = heldCapture; heldCapture = null; releaseCapture = finish; captured(); }
      else finish();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...hostEnv, ...githubBrokerEnvironment({
      GH_TOKEN: "ambient-host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Repository Author");
    await git("config", "user.email", "repository@example.test");
    await git("commit", "--allow-empty", "-m", "A");
    user = "B";
    await git("commit", "--allow-empty", "-m", "B");
    user = "A";
    await git("commit", "--allow-empty", "-m", "A again");
    expect(await git("log", "--format=%an <%ae>|%cn <%ce>" )).toBe("A <A@example.test>|A <A@example.test>\nB <B@example.test>|B <B@example.test>\nA <A@example.test>|A <A@example.test>");
    const before = captures;
    const gh = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(gh.identity).toContain("A <A@example.test>");
    expect(gh.token).toBe("credential-A");
    expect(captures - before).toBe(1); // gh's child Git retains the same capture.
    const captured = new Promise<void>(resolve => { heldCapture = resolve; });
    const operationA = exec(path.join(bin, "gh"), [], { cwd: repo, env });
    await captured;
    user = "B";
    const operationB = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    releaseCapture!();
    const completedA = JSON.parse((await operationA).stdout);
    expect(completedA.token).toBe("credential-A");
    expect(operationB.token).toBe("credential-B");
    expect(completedA.config).not.toBe(operationB.config);
    user = null;
    await git("commit", "--allow-empty", "-m", "Local identity");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Repository Author <repository@example.test>|Repository Author <repository@example.test>");
    const anonymous = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(anonymous.token).toBeNull();
    await git("config", "--unset", "user.name");
    await git("config", "--unset", "user.email");
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });
  it("reports each command and its repository so the broker can choose the write identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-operation-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const bodies: Array<{ operation: { program: string; args: string[]; remote: string | null } }> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "absent", env: {} }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...hostEnv, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const run = (program: string, ...args: string[]) => exec(path.join(bin, program), args, { cwd: repo, env }).catch(() => undefined);
    await run("git", "init");
    await run("git", "remote", "add", "origin", "https://github.com/vllnt/paperclip.git");
    await run("git", "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "--allow-empty", "-m", "x");
    await run("git", "push", "https://github.com/acme/elsewhere.git", "HEAD");
    await run("git", "status");
    await run("gh", "pr", "create", "-R", "acme/explicit");
    await run("gh", "issue", "comment", "1", "--body", "hi");
    const operations = bodies.map(body => body.operation);
    expect(operations.find(op => op.args.includes("commit"))).toEqual({
      program: "git", args: ["-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "--allow-empty", "-m", "x"],
      remote: "https://github.com/vllnt/paperclip.git",
    });
    // A URL push target and an explicit --repo need no remote lookup.
    expect(operations.find(op => op.args[0] === "push")).toMatchObject({ remote: null });
    expect(operations.find(op => op.args[0] === "status")).toEqual({ program: "git", args: ["status"], remote: null });
    expect(operations.find(op => op.args[1] === "create")).toEqual({ program: "gh", args: ["pr", "create", "-R", "acme/explicit"], remote: null });
    expect(operations.find(op => op.args[0] === "issue")).toMatchObject({ program: "gh", remote: "https://github.com/vllnt/paperclip.git" });
  }, 30_000); // many launcher runs, each spawning git
  // A managed launcher directory, a recording real `gh`, and a broker answering `answer(body, path)`.
  async function brokered(answer: (body: any, url: string) => { status?: number; body: unknown } | null) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-brokered-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo"), log = path.join(root, "gh-calls.jsonl");
    for (const dir of [bin, realBin, repo]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(bin, "package.json"), '{"type":"commonjs"}\n');
    for (const name of ["git", "gh", "paperclip-ssh-sign"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    // Like the worker's wrapper, this "real" gh would write as a bot when GH_TOKEN is empty.
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN || 'bot-token' }) + '\\n');
`, { mode: 0o700 });
    const requests: Array<{ url: string; body: any }> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : null;
        requests.push({ url: req.url ?? "", body });
        const reply = answer(body, req.url ?? "");
        if (!reply) { req.socket.destroy(); return; }
        res.setHeader("content-type", "application/json");
        res.writeHead(reply.status ?? 200);
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const env: NodeJS.ProcessEnv = { ...hostEnv, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "run-capability" }),
      PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const run = (program: string, args: string[], cwd = repo) => exec(path.join(bin, program), args, { cwd, env })
      .then(result => ({ code: 0, ...result }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }));
    const ghCalls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { root, bin, repo, env, run, requests, ghCalls };
  }
  const identity = { GIT_AUTHOR_NAME: "agent-owner", GIT_AUTHOR_EMAIL: "32437578+agent-owner@users.noreply.github.com", GIT_COMMITTER_NAME: "agent-owner", GIT_COMMITTER_EMAIL: "32437578+agent-owner@users.noreply.github.com" };

  it("reports the remote of reads and what a push sends: branch, refs, commits and workflow changes", async () => {
    const f = await brokered(() => ({ body: { status: "available", env: { GH_TOKEN: "t", ...identity } } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("commit", "--allow-empty", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-b", "feature/x");
    await writeFile(path.join(f.repo, "app.ts"), "x\n");
    git("add", "app.ts"); git("commit", "-m", "app");
    git("tag", "engine@1.4.0");
    await f.run("git", ["push", "origin", "feature/x"]);
    await f.run("git", ["push", "origin", "engine@1.4.0"]);
    await mkdir(path.join(f.repo, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(f.repo, ".github", "workflows", "ci.yml"), "on: push\n");
    git("add", "."); git("commit", "-m", "ci");
    await f.run("git", ["push"]);
    await f.run("git", ["fetch", "origin"]);
    await f.run("gh", ["pr", "view", "1"]);
    const ops = f.requests.map(request => request.body.operation);
    const head = (ref: string) => git("rev-parse", ref).toString().trim();
    expect(ops[0]).toMatchObject({ args: ["push", "origin", "feature/x"], remote: "https://github.com/Anthm-FR/songtrivia.git", currentBranch: "feature/x",
      refs: { "feature/x": "refs/heads/feature/x" }, shas: [head("HEAD~1")], touchesWorkflows: false });
    expect(ops[1]).toMatchObject({ refs: { "engine@1.4.0": "refs/tags/engine@1.4.0" }, shas: [head("HEAD~1")] });
    expect(ops[2]).toMatchObject({ args: ["push"], currentBranch: "feature/x", shas: [head("HEAD")], touchesWorkflows: true });
    expect(ops[3]).toEqual({ program: "git", args: ["fetch", "origin"], remote: "https://github.com/Anthm-FR/songtrivia.git" });
    expect(ops[4]).toEqual({ program: "gh", args: ["pr", "view", "1"], remote: "https://github.com/Anthm-FR/songtrivia.git" });
  }, 30_000); // many launcher runs, each spawning git

  it("reports where a push really goes and what could make it go elsewhere", async () => {
    const f = await brokered(() => ({ body: { status: "available", env: { GH_TOKEN: "t", ...identity } } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "feat");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("remote", "add", "staged", "https://github.com/Anthm-FR/linkzic.git");
    git("commit", "--allow-empty", "-m", "x");
    const op = async (...args: string[]) => { await f.run("git", args); return f.requests.at(-1)!.body.operation; };
    // --repo names the remote when no positional one is given (a positional one wins, as in git).
    expect(await op("push", "--repo", "staged")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/linkzic.git"] });
    expect(await op("push", "--repo", "https://github.com/Anthm-FR/songtrivia.git", "staged", "HEAD:x")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/linkzic.git"] });
    // branch.<name>.pushRemote and remote.pushDefault are honoured.
    git("config", "branch.feat.pushRemote", "staged");
    expect(await op("push")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/linkzic.git"] });
    git("config", "--unset", "branch.feat.pushRemote");
    // Every push URL is reported, since git pushes to all of them.
    git("remote", "set-url", "--add", "--push", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("remote", "set-url", "--add", "--push", "origin", "https://github.com/Anthm-FR/linkzic.git");
    expect(await op("push", "origin", "feat")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/songtrivia.git", "https://github.com/Anthm-FR/linkzic.git"] });
    // URL rewrites beyond Paperclip's own, and config that pushes more than the branch.
    expect(await op("-c", "url.https://github.com/Anthm-FR/linkzic.pushInsteadOf=https://github.com/Anthm-FR/songtrivia", "push", "https://github.com/Anthm-FR/songtrivia", "HEAD:x")).toMatchObject({ urlRewrites: true });
    expect(await op("push", "origin", "feat")).not.toHaveProperty("urlRewrites");
    expect(await op("-c", "push.default=matching", "push")).toMatchObject({ implicitPush: true });
    expect(await op("-c", "push.followTags=true", "push")).toMatchObject({ implicitPush: true });
    expect(await op("push", "origin", "feat")).not.toHaveProperty("implicitPush");
    // gh may choose any remote, so all of them are reported; a very long command says it was cut.
    await f.run("gh", ["pr", "view", "1"]);
    expect(f.requests.at(-1)!.body.operation).toMatchObject({ remotes: ["https://github.com/Anthm-FR/songtrivia.git", "https://github.com/Anthm-FR/linkzic.git"] });
    await f.run("gh", ["pr", "view", "1", ...Array.from({ length: 300 }, () => "--json")]);
    expect(f.requests.at(-1)!.body.operation).toMatchObject({ truncated: true });
    expect(f.requests.at(-1)!.body.operation.args).toHaveLength(256);
  }, 30_000); // many launcher runs, each spawning git

  it("treats attached gh api flags as writes when no credential was obtained", async () => {
    const f = await brokered(() => null);
    for (const args of [["api", "-XPOST", "repos/o/r/issues"], ["api", "repos/o/r/issues", "-ftitle=x"], ["api", "repos/o/r/issues", "-Ftitle=x"]]) {
      const result = await f.run("gh", args);
      expect(result.code, args.join(" ")).toBe(1);
    }
    // An explicit GET reads (round 4, N4); a plain read runs.
    expect((await f.run("gh", ["api", "-XGET", "repos/o/r/pulls"])).code).toBe(0);
    expect((await f.run("gh", ["api", "repos/o/r/pulls"])).code).toBe(0);
  }, 30_000);

  it("never runs a write the broker refused, so no other credential can perform it", async () => {
    const f = await brokered(body => body.operation.args[1] === "view"
      ? { body: { status: "unavailable", reason: "anthm-fr/linkzic is not in this company's GitHub write allowlist", env: {} } }
      : { body: { status: "unavailable", reason: "This is a privileged GitHub action (tagPush) and it is turned off for this company", failClosed: true, env: {} } });
    const refused = await f.run("gh", ["pr", "create", "--fill"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("GitHub refused this command: This is a privileged GitHub action (tagPush)");
    const push = await f.run("git", ["push", "origin", "v1"]);
    expect(push.code).toBe(1);
    expect(push.stderr).toContain("It does not run with any other GitHub credential");
    // A refused read still runs, without credentials.
    expect((await f.run("gh", ["pr", "view", "1"])).code).toBe(0);
    expect(await f.ghCalls()).toEqual([{ args: ["pr", "view", "1"], token: "bot-token" }]);
  });

  it.each([
    ["the broker is unreachable", () => null],
    ["the run has no managed identity", () => ({ body: { status: "absent", env: {} } })],
    ["the broker rejects the capability", () => ({ status: 403, body: { error: "no" } })],
  ])("does not let gh fall back to another credential for writes when %s", async (_label, answer) => {
    const f = await brokered(answer as never);
    for (const args of [["pr", "merge", "1", "--admin"], ["api", "-X", "POST", "repos/o/r/issues", "-f", "title=x"], ["release", "create", "v1"], ["issue", "comment", "1", "-b", "x"]]) {
      const result = await f.run("gh", args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("does not run with any other GitHub credential");
    }
    for (const args of [["pr", "view", "1"], ["api", "repos/o/r/pulls"], ["search", "issues", "x"], ["run", "watch", "1"]]) {
      expect((await f.run("gh", args)).code, args.join(" ")).toBe(0);
    }
    expect((await f.ghCalls()).map(call => call.args[0])).toEqual(["pr", "api", "search", "run"]);
  }, 30_000);

  // Security review round 2, F1: gh only ever talks to github.com, and GH_REPO is a destination the broker checks.
  it("F1: pins gh to github.com, drops CODESPACES and reports GH_REPO as a named repository", async () => {
    const f = await brokered(() => ({ body: { status: "available", env: { GH_TOKEN: "t", ...identity } } }));
    const seen = path.join(f.root, "gh-env.jsonl");
    await writeFile(path.join(f.root, "real", "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ host: process.env.GH_HOST ?? null, codespaces: process.env.CODESPACES ?? null }) + '\\n');
`, { mode: 0o700 });
    await exec(path.join(f.bin, "gh"), ["pr", "list"], { cwd: f.repo, env: { ...f.env, GH_HOST: "tenant.ghe.com", CODESPACES: "true", GH_REPO: "tenant.ghe.com/Anthm-FR/songtrivia" } });
    expect(JSON.parse((await readFile(seen, "utf8")).trim())).toEqual({ host: "github.com", codespaces: null });
    expect(f.requests.at(-1)!.body.operation).toMatchObject({ program: "gh", args: ["pr", "list"], remote: null, ghRepo: "tenant.ghe.com/Anthm-FR/songtrivia" });
  }, 30_000);

  it("F1: never runs a gh command naming another host without a managed credential", async () => {
    const f = await brokered(() => null);
    for (const args of [["pr", "view", "1", "-R", "tenant.ghe.com/o/r"], ["api", "--hostname", "github.localhost", "user"], ["pr", "view", "https://tenant.ghe.com/o/r/pull/1"], ["api", "https://evil.invalid/x"]]) {
      const result = await f.run("gh", args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("names a host other than github.com");
    }
    expect((await f.run("gh", ["pr", "view", "1", "-R", "o/r"])).code).toBe(0);
    expect((await f.run("gh", ["api", "https://api.github.com/repos/o/r"])).code).toBe(0);
    expect((await f.ghCalls()).map(call => call.args[0])).toEqual(["pr", "api"]);
  }, 60_000);

  it("F1: reports the URL a fetch reads from, not the remote's push URL", async () => {
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "refused in this test", failClosed: true, env: {} } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://evil.invalid/Anthm-FR/songtrivia.git");
    git("remote", "set-url", "--push", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    await f.run("git", ["fetch", "origin"]);
    expect(f.requests.at(-1)!.body.operation).toMatchObject({ args: ["fetch", "origin"], remote: "https://evil.invalid/Anthm-FR/songtrivia.git" });
    await f.run("git", ["push", "origin", "main"]);
    expect(f.requests.at(-1)!.body.operation).toMatchObject({ args: ["push", "origin", "main"], remote: "https://github.com/Anthm-FR/songtrivia.git" });
  }, 30_000);

  // Independent review of round 2 (round 2b): reports the launcher made that hid where a command goes.
  it("R2/R3: never takes an option's value for the remote, and knows git's --attr-source", async () => {
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "refused in this test", failClosed: true, env: {} } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("remote", "add", "upstream", "https://github.com/Anthm-FR/linkzic.git");
    git("remote", "add", "team/mirror", "https://github.com/Anthm-FR/wordzic.git");
    git("commit", "--allow-empty", "-m", "x");
    const op = async (...args: string[]) => { await f.run("git", args); return f.requests.at(-1)!.body.operation; };
    expect(await op("fetch", "--depth", "1", "upstream")).toMatchObject({ remote: "https://github.com/Anthm-FR/linkzic.git" });
    expect(await op("fetch", "--shallow-since", "2024-01-01T00:00:00", "origin")).toMatchObject({ remote: "https://github.com/Anthm-FR/songtrivia.git" });
    // A remote name with a slash is a remote, not a path.
    expect(await op("fetch", "team/mirror")).toMatchObject({ remote: "https://github.com/Anthm-FR/wordzic.git" });
    expect(await op("push", "team/mirror", "main")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/wordzic.git"] });
    expect(await op("--attr-source", "HEAD", "push", "upstream", "main")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/linkzic.git"], currentBranch: "main" });
  }, 60_000);

  it("N4 (round 2c): reads clustered short options as git does, so their value is never the remote", async () => {
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "refused in this test", failClosed: true, env: {} } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("remote", "add", "decoy", "https://github.com/Anthm-FR/linkzic.git");
    git("commit", "--allow-empty", "-m", "x");
    const op = async (...args: string[]) => { await f.run("git", args); return f.requests.at(-1)!.body.operation; };
    // -fo takes "decoy" as the push option: git pushes to origin.
    expect(await op("push", "-fo", "decoy", "origin", "main")).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/songtrivia.git"] });
    expect(await op("fetch", "-j4", "decoy")).toMatchObject({ remote: "https://github.com/Anthm-FR/linkzic.git" });
  }, 60_000);

  it("regression (round 2d): a long PR body does not refuse the command; other long arguments still do", async () => {
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "refused in this test", failClosed: true, env: {} } }));
    const long = "x".repeat(9000);
    await f.run("gh", ["pr", "create", "--title", "T", "--body", long]);
    expect(f.requests.at(-1)!.body.operation).not.toHaveProperty("truncated");
    await f.run("gh", ["pr", "create", "--title", "T", `--body=${long}`]);
    expect(f.requests.at(-1)!.body.operation).not.toHaveProperty("truncated");
    await f.run("gh", ["pr", "view", `https://github.com/o/r/pull/1?${long}`]);
    expect(f.requests.at(-1)!.body.operation).toMatchObject({ truncated: true });
  }, 60_000);

  it("E (round 2e): an option before the gh command or verb never lets a write run without a managed credential", async () => {
    const f = await brokered(() => null);
    for (const args of [["-R", "o/r", "pr", "create", "--fill"], ["pr", "-R", "o/r", "create", "--fill"], ["pr", "--title", "x", "create"], ["", "pr", "merge", "1"], ["pr", "", "merge", "1"]]) {
      const result = await f.run("gh", args);
      expect(result.code, JSON.stringify(args)).toBe(1);
      expect(result.stderr, JSON.stringify(args)).toContain("does not run with any other GitHub credential");
    }
    expect((await f.run("gh", ["-R", "o/r", "pr", "view", "1"])).code).toBe(0);
    expect((await f.ghCalls()).map(call => call.args)).toEqual([["-R", "o/r", "pr", "view", "1"]]);
  }, 120_000);

  it("R5: an unreadable or oversized config counts as a rewrite, and more push URLs than reported is a cut report", async () => {
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "refused in this test", failClosed: true, env: {} } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("commit", "--allow-empty", "-m", "x");
    const op = async (...args: string[]) => { await f.run("git", args); return f.requests.at(-1)!.body.operation; };
    // 17 push URLs: git pushes to all of them, so a report of 16 must say it was cut.
    for (let n = 0; n < 17; n++) git("remote", "set-url", "--add", "--push", "origin", `https://github.com/Anthm-FR/songtrivia-${n}.git`);
    expect(await op("push", "origin", "main")).toMatchObject({ truncated: true });
    // A config padded past what the launcher reads hides nothing: the rewrite counts as present.
    const config = path.join(f.repo, ".git", "config");
    const padding = Array.from({ length: 45_000 }, (_, n) => `[url "https://github.com/Anthm-FR/linkzic-${n}"]\n\tpushInsteadOf = https://github.com/Anthm-FR/songtrivia-${n}\n`).join("");
    await writeFile(config, (await readFile(config, "utf8")) + padding);
    expect(await op("fetch", "origin")).toMatchObject({ urlRewrites: true });
  }, 120_000);

  // Security review round 3: each test is an attack 45f8d6287 let through.
  it("B1 (round 3): a bare GIT_CONFIG cannot hide where a push goes or the tags it sends", async () => {
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "refused in this test", failClosed: true, env: {} } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    git("remote", "add", "other", "https://github.com/Anthm-FR/linkzic.git");
    git("config", "remote.pushDefault", "other");
    git("commit", "--allow-empty", "-m", "x");
    const op = async (env: Record<string, string>, ...args: string[]) => {
      await exec(path.join(f.bin, "git"), args, { cwd: f.repo, env: { ...f.env, ...env } }).catch(() => undefined);
      return f.requests.at(-1)!.body.operation;
    };
    for (const hide of [{ GIT_CONFIG: "/dev/null" }, { GIT_CONFIG: "" }, { GIT_CONFIG: path.join(f.root, "missing") }]) {
      expect(await op(hide, "push"), JSON.stringify(hide)).toMatchObject({ pushUrls: ["https://github.com/Anthm-FR/linkzic.git"] });
      // push.followTags sends annotated tags with any refspec, in any boolean spelling git accepts.
      for (const value of ["true", "yes", "1"]) {
        git("config", "push.followTags", value);
        expect(await op(hide, "push"), `${JSON.stringify(hide)} ${value}`).toMatchObject({ implicitPush: true, followTags: true });
        expect(await op(hide, "push", "origin", "main"), `${JSON.stringify(hide)} ${value}`).toMatchObject({ followTags: true });
      }
      git("config", "--unset", "push.followTags");
    }
    expect(await op({}, "push", "origin", "main")).not.toHaveProperty("followTags");
    // The run's environment never carries one into the launcher either.
    const env = githubBrokerEnvironment({ GIT_CONFIG: "/dev/null", GIT_CONFIG_PARAMETERS: "'remote.pushdefault'='other'", GIT_CONFIG_KEY_9: "x" }, { url: "", token: "" });
    expect([env.GIT_CONFIG, env.GIT_CONFIG_PARAMETERS, env.GIT_CONFIG_KEY_9]).toEqual(["", "", ""]);
  }, 60_000);

  it("B2 (round 3): gh acts on the repository Paperclip checked, never on a saved gh default (gh-resolved)", async () => {
    const f = await brokered(() => ({ body: { status: "available", repository: "Anthm-FR/songtrivia", env: { GH_TOKEN: "t" } } }));
    const seen = path.join(f.root, "gh-repo.jsonl");
    await writeFile(path.join(f.root, "real", "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.GH_REPO ?? null) + '\\n');
`, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    // gh repo set-default: gh would act on linkzic, whatever the remotes say.
    git("config", "remote.origin.gh-resolved", "Anthm-FR/linkzic");
    for (const args of [["issue", "comment", "1", "-b", "x"], ["pr", "create", "--fill"], ["api", "-X", "POST", "repos/{owner}/{repo}/issues/1/comments", "-f", "body=x"]]) {
      expect((await f.run("gh", args)).code, args.join(" ")).toBe(0);
      expect(f.requests.at(-1)!.body.operation, args.join(" ")).toMatchObject({ ghResolved: ["Anthm-FR/linkzic"] });
    }
    expect((await readFile(seen, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual(["Anthm-FR/songtrivia", "Anthm-FR/songtrivia", "Anthm-FR/songtrivia"]);
    // An explicit -R stays as given (the broker checked that repository).
    await f.run("gh", ["pr", "view", "1", "-R", "Anthm-FR/anthm-fr"]);
    expect((await readFile(seen, "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1)).toBeNull();
  }, 60_000);

  it("B3 (round 3): a push never recurses into submodules, whatever the repository config says", async () => {
    const f = await brokered(() => ({ body: { status: "available", env: { GH_TOKEN: "t", ...identity } } }));
    const plain = { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env: plain }).toString().trim();
    const subRemote = path.join(f.root, "sub.git"), superRemote = path.join(f.root, "super.git"), subWork = path.join(f.root, "sub-work");
    git(f.root, "init", "--bare", "-b", "main", subRemote);
    git(f.root, "init", "--bare", "-b", "main", superRemote);
    git(f.root, "clone", subRemote, subWork);
    git(subWork, "commit", "--allow-empty", "-m", "sub 1");
    git(subWork, "push", "origin", "HEAD:main");
    git(f.repo, "init", "-b", "main");
    git(f.repo, "remote", "add", "origin", superRemote);
    git(f.repo, "submodule", "add", subRemote, "sub");
    git(f.repo, "commit", "-m", "add sub");
    git(f.repo, "push", "origin", "main");
    // A submodule commit that exists only locally; the repository asks git to push submodules on demand.
    git(path.join(f.repo, "sub"), "commit", "--allow-empty", "-m", "sub 2 (never pushed)");
    const secret = git(path.join(f.repo, "sub"), "rev-parse", "HEAD");
    git(f.repo, "add", "sub");
    git(f.repo, "commit", "-m", "bump sub");
    for (const [key, value] of [["submodule.recurse", "true"], ["push.recurseSubmodules", "on-demand"], ["protocol.file.allow", "always"]]) git(f.repo, "config", key, value!);
    git(path.join(f.repo, "sub"), "config", "protocol.file.allow", "always");
    const pushed = await f.run("git", ["push", "origin", "HEAD:refs/heads/feature"]);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(() => execFileSync("git", ["cat-file", "-e", `${secret}^{commit}`], { cwd: subRemote, env: plain, stdio: "ignore" })).toThrow();
    expect((await f.run("git", ["config", "--get", "push.recurseSubmodules"])).stdout.trim()).toBe("no");
    // Only this command line can override it (-c outranks the launcher's own setting); the broker then sees it and refuses.
    expect(f.requests.at(-2)!.body.operation).not.toHaveProperty("recurseSubmodules");
    for (const args of [["-c", "push.recurseSubmodules=on-demand", "push", "origin", "HEAD:refs/heads/x"], ["-c", "push.recurseSubmodules=only", "push"]]) {
      await f.run("git", [...args, "--dry-run"]);
      expect(f.requests.at(-1)!.body.operation, args.join(" ")).toMatchObject({ recurseSubmodules: args[1]!.split("=")[1] });
    }
  }, 60_000);

  it("A1 (round 3): a method hidden in a cluster of short options never runs without a managed credential", async () => {
    const f = await brokered(() => ({ body: { status: "absent", env: {} } }));
    const forms = [["-iXPOST"], ["-hXPOST"], ["-iX", "POST"], ["-XPOST"], ["--method=POST"], ["-X=POST"], ["-X", "POST"], ["--method", "POST"], ["-ihXPOST"], ["-zXPOST"], ["-Xpost"], ["-iX=PATCH"]];
    for (const form of forms) {
      const args = ["api", ...form, "repos/o/r/issues"];
      const result = await f.run("gh", args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("does not run with any other GitHub credential");
    }
    expect(await f.ghCalls()).toEqual([]);
  }, 120_000);

  it("A1 (round 3): whenever the classifier says a gh command writes, the launcher does not run it without a managed credential", async () => {
    const f = await brokered(() => ({ body: { status: "absent", env: {} } }));
    const clusters = ["", "-i", "-h", "-ih", "-z"], methods = [[], ["-X", "POST"], ["-XPOST"], ["-X=POST"], ["--method", "POST"], ["--method=POST"], ["-X", "GET"], ["M"]];
    const paths = ["repos/o/r/issues", "graphql", "repositories/1/issues", "repos/{owner}/r/issues", "https://evil.invalid/x", "repos/o/r/../x", "user"];
    const bodies = [[], ["-f", "title=x"], ["-Ftitle=x"], ["--input", "body.json"], ["--raw-field=a=b"]];
    const generated: string[][] = [];
    for (const cluster of clusters) for (const method of methods) for (const endpoint of paths) for (const body of bodies) {
      const methodArgs = method[0] === "M" ? (cluster ? [`${cluster}XPOST`] : []) : [...(cluster ? [cluster] : []), ...method];
      generated.push(["api", ...methodArgs, endpoint, ...body]);
    }
    for (const other of [["pr", "merge", "1"], ["pr", "-dRo/r", "list"], ["pr", "list", "-dRo/r"], ["issue", "--web", "create"], ["codespace", "list"], ["repo", "delete", "o/r"], ["", "pr", "list"],
      ["auth", "status", "-t"], ["auth", "status", "--show-token=true"], ["auth", "status", "-at"], ["auth", "token"], ["config", "get", "oauth_token"], ["config", "get", "-h", "github.com", "oauth_token"],
      ["auth", "status"], ["config", "get", "git_protocol"], ["api", "-X", "GET", "search/issues", "-f", "q=x"]]) generated.push(other);
    const writes = generated.filter(args => { const c = classifyGitHubCommand("gh", args); return c.access === "write" || c.privileged.length > 0; });
    expect(writes.length).toBeGreaterThan(100);
    // The launcher process is run for a spread of them; the embedded grammar is checked for all of them below.
    const sample = writes.filter((_, index) => index % 9 === 0);
    for (let at = 0; at < sample.length; at += 8) {
      const results = await Promise.all(sample.slice(at, at + 8).map(args => f.run("gh", args).then(result => ({ args, result }))));
      for (const { args, result } of results) expect(result.code, JSON.stringify(args)).toBe(1);
    }
    expect(await f.ghCalls()).toEqual([]);
    // The launcher's own copy of the grammar, run outside this package: self-contained, and it says "may write" for every write.
    const source = githubLauncherSource();
    const embedded = source.slice(source.indexOf("const parseGhCommand = "), source.indexOf("// A gh command that names a host other than github.com"));
    const ghMayWrite = runInNewContext(`${embedded}\nghMayWrite`, { URL }) as (args: string[]) => boolean;
    for (const args of writes) expect(ghMayWrite(args), JSON.stringify(args)).toBe(true);
    // And the other way round: whatever the launcher runs without a credential, the classifier reads, unrefused.
    for (const args of generated.filter(args => !ghMayWrite(args))) {
      expect(classifyGitHubCommand("gh", args), JSON.stringify(args)).toEqual({ access: "read", action: null, privileged: [] });
    }
    for (const read of [["api", "repos/o/r/pulls"], ["pr", "view", "1"], ["-R", "o/r", "pr", "list"], ["search", "issues", "x"], ["api", "-i", "user"]]) expect(ghMayWrite(read), read.join(" ")).toBe(false);
  }, 180_000);

  // Security review round 4.
  it("N1 (round 4): a command-line submodule.recurse (or include) never pushes submodules, and an injected GIT_CONFIG_COUNT is dropped", async () => {
    // The broker classifies with the real classifier and refuses what it refuses.
    const f = await brokered(body => {
      const operation = body?.operation;
      const classified = operation ? classifyGitHubCommand(operation.program, operation.args, { recurseSubmodules: operation.recurseSubmodules, followTags: operation.followTags }) : null;
      return classified?.denied
        ? { body: { status: "unavailable", reason: classified.denied, failClosed: true, env: {} } }
        : { body: { status: "available", env: { GH_TOKEN: "t", ...identity } } };
    });
    const plain = { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env: plain }).toString().trim();
    const subRemote = path.join(f.root, "sub.git"), superRemote = path.join(f.root, "super.git"), subWork = path.join(f.root, "sub-work");
    git(f.root, "init", "--bare", "-b", "main", subRemote);
    git(f.root, "init", "--bare", "-b", "main", superRemote);
    git(f.root, "clone", subRemote, subWork);
    git(subWork, "commit", "--allow-empty", "-m", "sub 1");
    git(subWork, "push", "origin", "HEAD:main");
    git(f.repo, "init", "-b", "main");
    git(f.repo, "remote", "add", "origin", superRemote);
    git(f.repo, "submodule", "add", subRemote, "sub");
    git(f.repo, "commit", "-m", "add sub");
    git(f.repo, "push", "origin", "main");
    git(f.repo, "config", "protocol.file.allow", "always");
    git(path.join(f.repo, "sub"), "config", "protocol.file.allow", "always");
    const pushedToSubmodule = (sha: string) => { try { execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: subRemote, env: plain, stdio: "ignore" }); return true; } catch { return false; } };
    const bump = (message: string) => {
      git(path.join(f.repo, "sub"), "commit", "--allow-empty", "-m", message);
      const sha = git(path.join(f.repo, "sub"), "rev-parse", "HEAD");
      git(f.repo, "add", "sub");
      git(f.repo, "commit", "-m", `bump: ${message}`);
      return sha;
    };
    const recurse = path.join(f.root, "recurse.cfg");
    await writeFile(recurse, "[submodule]\n\trecurse = true\n");
    for (const globalArgs of [["-c", "submodule.recurse=true"], ["-c", "Submodule.Recurse=yes"], ["-c", "push.recurseSubmodules=on-demand"], ["-c", `include.path=${recurse}`]]) {
      const secret = bump(globalArgs.join(" "));
      const pushed = await f.run("git", [...globalArgs, "push", "origin", "HEAD:refs/heads/f3"]);
      expect(pushed.code, globalArgs.join(" ")).toBe(1);
      expect(pushed.stderr, globalArgs.join(" ")).toContain("command-line config");
      expect(pushedToSubmodule(secret), globalArgs.join(" ")).toBe(false);
    }
    // The same through the environment: the launcher removes GIT_CONFIG_COUNT/KEY/VALUE and GIT_CONFIG_PARAMETERS before git runs.
    const secret = bump("environment");
    const injected = await exec(path.join(f.bin, "git"), ["push", "origin", "HEAD:refs/heads/f4"], { cwd: f.repo, env: { ...f.env,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "submodule.recurse", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_PARAMETERS: "'submodule.recurse'='true'" } }).then(() => 0, (error: any) => error.code);
    expect(injected).toBe(0);
    expect(pushedToSubmodule(secret)).toBe(false);
    expect(f.requests.at(-1)!.body.operation).not.toHaveProperty("recurseSubmodules");
  }, 120_000);

  it("N4 (round 4): an explicit GET (gh api -X GET search/issues -f q=…) runs without a managed credential; other methods do not", async () => {
    const f = await brokered(() => ({ body: { status: "absent", env: {} } }));
    for (const form of [["-X", "GET"], ["-XGET"], ["--method=get"], ["-iXHEAD"]]) {
      const args = ["api", ...form, "search/issues", "-f", "q=repo:o/r is:open"];
      expect((await f.run("gh", args)).code, args.join(" ")).toBe(0);
    }
    for (const form of [["-X", "POST"], ["-XPATCH"], ["-X", "GET", "--input", "body.json"]]) {
      const args = ["api", ...form, "search/issues", "-f", "q=x"];
      expect((await f.run("gh", args)).code, args.join(" ")).toBe(1);
    }
    expect((await f.ghCalls()).map(call => call.args[1])).toEqual(["-X", "-XGET", "--method=get", "-iXHEAD"]);
  }, 120_000);

  it("round 4: a gh command that prints a credential never runs, with or without one, and the no-credential path carries no ambient token", async () => {
    for (const answer of [() => null, () => ({ body: { status: "available", env: { GH_TOKEN: "managed-token" } } })] as const) {
      const f = await brokered(answer as never);
      for (const args of [["auth", "status", "-t"], ["auth", "status", "--show-token=true"], ["config", "get", "oauth_token"], ["auth", "status", "-at"], ["config", "get", "-h", "github.com", "oauth_token"], ["auth", "token"]]) {
        const before = f.requests.length;
        const result = await f.run("gh", args);
        expect(result.code, args.join(" ")).toBe(1);
        expect(result.stderr, args.join(" ")).toContain("prints a GitHub credential");
        expect(f.requests.length, args.join(" ")).toBe(before);
      }
      expect(await f.ghCalls()).toEqual([]);
    }
    // Without a managed credential, no token variable of the run reaches gh.
    const f = await brokered(() => ({ body: { status: "unavailable", reason: "none here", env: { GH_TOKEN: "must-not-be-used" } } }));
    const seen = path.join(f.root, "gh-tokens.jsonl");
    await writeFile(path.join(f.root, "real", "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].map(key => process.env[key] ?? null)) + '\\n');
`, { mode: 0o700 });
    await exec(path.join(f.bin, "gh"), ["pr", "view", "1"], { cwd: f.repo, env: { ...f.env, GH_TOKEN: "ambient-1", GITHUB_TOKEN: "ambient-2", GH_ENTERPRISE_TOKEN: "ambient-3", GITHUB_ENTERPRISE_TOKEN: "ambient-4" } });
    expect(JSON.parse((await readFile(seen, "utf8")).trim())).toEqual([null, null, null, null]);
  }, 120_000);

  it("m6 (round 5): a credentialed command never goes through a proxy or other TLS trust", async () => {
    const f = await brokered(() => ({ body: { status: "available", env: { GH_TOKEN: "user-token", ...identity } } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, env: { ...hostEnv, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Anthm-FR/songtrivia.git");
    // git itself runs with a verified, direct connection.
    expect((await f.run("git", ["config", "--get", "http.sslVerify"])).stdout.trim()).toBe("true");
    expect((await f.run("git", ["config", "--get-all", "http.proxy"])).stdout.split("\n").at(-2)).toBe("");
    // Generic repository settings are overridden by the launcher's own.
    git("config", "http.proxy", "http://127.0.0.1:9");
    git("config", "http.sslVerify", "false");
    expect((await f.run("git", ["config", "--get-urlmatch", "http.proxy", "https://github.com/Anthm-FR/songtrivia.git"])).stdout.trim()).toBe("");
    expect((await f.run("git", ["config", "--type=bool", "--get-urlmatch", "http.sslVerify", "https://github.com/Anthm-FR/songtrivia.git"])).stdout.trim()).toBe("true");
    git("config", "--unset", "http.proxy");
    git("config", "--unset", "http.sslVerify");
    // Config that outranks them (URL-specific keys) or adds other trust refuses the command before it runs.
    for (const [key, value] of [["http.https://github.com/.proxy", "http://127.0.0.1:9"], ["http.https://github.com/.sslVerify", "false"],
      ["http.sslCAInfo", "/tmp/evil-ca.pem"], ["http.https://github.com/Anthm-FR/.sslCAPath", "/tmp/evil"], ["http.curloptResolve", "github.com:443:127.0.0.1"]] as const) {
      git("config", key, value);
      const refused = await f.run("git", ["fetch", "origin"]);
      expect(refused.code, key).toBe(1);
      expect(refused.stderr, key).toContain("through a proxy or with other TLS trust");
      git("config", "--unset", key);
    }
    expect((await f.run("git", ["-c", "http.sslVerify=false", "fetch", "origin"])).stderr).toContain("other TLS trust");
    // Proxy and trust variables of the run never reach a child that holds the token.
    const seen = path.join(f.root, "gh-env.jsonl");
    await writeFile(path.join(f.root, "real", "gh"), `#!/usr/bin/env node
const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GH_CONFIG_DIR', 'GH_TOKEN'];
require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))) + '\\n');
`, { mode: 0o700 });
    const runEnv = { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "socks5://127.0.0.1:9", GIT_SSL_NO_VERIFY: "1",
      GIT_SSL_CAINFO: "/tmp/evil-ca.pem", SSL_CERT_FILE: "/tmp/evil-ca.pem", SSL_CERT_DIR: "/tmp/evil", NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem", GH_CONFIG_DIR: path.join(f.root, "run-gh-config") };
    await exec(path.join(f.bin, "gh"), ["pr", "view", "1"], { cwd: f.repo, env: { ...f.env, ...runEnv } });
    const child = JSON.parse((await readFile(seen, "utf8")).trim());
    expect(child).toMatchObject({ HTTPS_PROXY: null, https_proxy: null, HTTP_PROXY: null, ALL_PROXY: null, GIT_SSL_NO_VERIFY: null, GIT_SSL_CAINFO: null,
      SSL_CERT_FILE: null, SSL_CERT_DIR: null, NODE_EXTRA_CA_CERTS: null, GH_TOKEN: "user-token" });
    // gh gets a fresh, private config directory, never the run's.
    expect(child.GH_CONFIG_DIR).not.toBe(runEnv.GH_CONFIG_DIR);
    expect(path.dirname(child.GH_CONFIG_DIR)).toBe(runEnv.GH_CONFIG_DIR);
  }, 120_000);

  const sshKeygen = (() => { try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (error: any) { return error?.code !== "ENOENT"; } })();
  it.skipIf(!sshKeygen)("signs commits through the broker with a key that never reaches the run, and verifies them", async () => {
    const keys = await mkdtemp(path.join(os.tmpdir(), "paperclip-signing-key-"));
    cleanups.push(() => rm(keys, { recursive: true, force: true }));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "paperclip", "-f", path.join(keys, "key")]);
    const publicKey = (await readFile(path.join(keys, "key.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ");
    let refuse = false;
    const f = await brokered((body, url) => {
      if (url.endsWith("/runtime-tools/github/sign")) {
        if (refuse) return { body: { unavailable: "GitHub writes are switched off for this company (write identity kill switch)." } };
        const object = path.join(keys, "object");
        execFileSync("sh", ["-c", `cat > ${JSON.stringify(object)}`], { input: Buffer.from(body.payload, "base64") });
        execFileSync("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", path.join(keys, "key"), object], { stdio: "ignore" });
        return { body: { signature: execFileSync("cat", [`${object}.sig`]).toString() } };
      }
      return { body: { status: "available", signingKey: publicKey, env: { ...identity, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" } } };
    });
    await f.run("git", ["init", "-b", "main"]);
    const commit = await f.run("git", ["commit", "--allow-empty", "-m", "Signed by Paperclip"]);
    expect(commit.code, commit.stderr).toBe(0);
    await writeFile(path.join(keys, "allowed"), `32437578+agent-owner@users.noreply.github.com ${publicKey}\n`);
    const plainGit = { ...hostEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${path.join(keys, "allowed")}`, "verify-commit", "HEAD"],
      { cwd: f.repo, env: plainGit, stdio: ["ignore", "pipe", "pipe"] });
    expect(execFileSync("git", ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${path.join(keys, "allowed")}`, "log", "-1", "--format=%G?|%an"], { cwd: f.repo, env: plainGit }).toString().trim()).toBe("G|agent-owner");
    // The private key stayed with the broker; the run only ever saw the public key.
    expect(JSON.stringify(f.requests)).not.toContain("PRIVATE KEY");
    // Signature checks inside the run go to the real ssh-keygen through the same program.
    const shown = await f.run("git", ["-c", `gpg.ssh.allowedSignersFile=${path.join(keys, "allowed")}`, "log", "-1", "--format=%G?"]);
    expect(shown.stdout.trim()).toBe("G");
    refuse = true;
    const refused = await f.run("git", ["commit", "--allow-empty", "-m", "Refused"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("commit signing failed: GitHub writes are switched off");
  }, 30_000);
});

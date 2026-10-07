import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
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
  it("marks every agent commit with a sanitized attribution trailer, once", async () => {
    const { repo, env, launcher } = await attributedLauncher("git");
    const git = async (...args: string[]) => (await exec(launcher, args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("-c", "user.name=bntvllnt", "-c", "user.email=b@example.test", "commit", "--allow-empty", "-m", "Work\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>");
    await git("-C", repo, "-c", "user.name=bntvllnt", "-c", "user.email=b@example.test", "commit", "--amend", "--no-edit", "--allow-empty");
    expect(await git("log", "-1", "--format=%B")).toBe(
      "Work\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\nPaperclip-Agent: Peter Injected: yes (run run-1)");
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
    expect(bodyOf(fallback!.args)).toMatch(/^\*\*Review verdict: approve\.\*\* GitHub does not let a pull request author approve[\s\S]*\n\n_Posted by Paperclip agent/);
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
});

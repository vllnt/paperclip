/**
 * Starts the Paperclip server of a checkout as a child process against a
 * given database, for the route-level fault runs (F4). Test code only.
 *
 * The server runs from source with the checkout's tsx loader, in its own
 * temporary home, with a minimal environment: nothing from the caller's
 * environment selects a database, a config file or a secret.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const BUDGET_WARNING = "database retry budget refused retries";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** A free loopback port. */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const secret = () => randomBytes(32).toString("hex");

/**
 * @param {{
 *   checkout: string,
 *   databaseUrl: string,
 *   migrationUrl: string,
 *   mode: "local_trusted" | "authenticated",
 *   cloudTenantToken?: string,
 *   readyTimeoutMs?: number,
 * }} options
 */
export async function startServer(options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-perf-f4-"));
  const started = { child: null, exit: null };
  try {
    return await launch(home, started, options);
  } catch (error) {
    // The caller has no handle to `stop()` on a failed start: stop the child and remove the home here.
    if (started.child && started.child.exitCode === null && started.child.signalCode === null) {
      started.child.kill("SIGKILL");
      await started.exit;
    }
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

async function launch(home, started, { checkout, databaseUrl, migrationUrl, mode, cloudTenantToken, readyTimeoutMs = 180_000 }) {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: os.tmpdir(),
    NODE_ENV: "production",
    PAPERCLIP_LOG_LEVEL: "warn",
    PORT: String(port),
    HOST: "127.0.0.1",
    PAPERCLIP_BIND: "loopback",
    PAPERCLIP_BIND_HOST: "127.0.0.1",
    PAPERCLIP_HOME: home,
    PAPERCLIP_INSTANCE_ID: "perf-f4",
    PAPERCLIP_DISABLE_CWD_ENV_FILE: "true",
    DATABASE_URL: databaseUrl,
    DATABASE_MIGRATION_URL: migrationUrl,
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_DEPLOYMENT_MODE: mode,
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    BETTER_AUTH_SECRET: secret(),
    PAPERCLIP_AGENT_JWT_SECRET: secret(),
    PAPERCLIP_DECISION_SIGNING_SECRET: secret(),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: secret(),
    PAPERCLIP_STORAGE_PROVIDER: "local_disk",
    PAPERCLIP_STORAGE_LOCAL_DIR: path.join(home, "storage"),
    PAPERCLIP_SECRETS_PROVIDER: "local_encrypted",
    SERVE_UI: "false",
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    HEARTBEAT_SCHEDULER_ENABLED: "false",
    PAPERCLIP_STOP_TIMEOUT_MS: "30000",
    ...(cloudTenantToken ? { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: cloudTenantToken } : {}),
  };
  const child = spawn(
    process.execPath,
    ["--import", path.join(checkout, "server/node_modules/tsx/dist/loader.mjs"), path.join(checkout, "server/src/index.ts")],
    // The home is the working directory, so the server finds no config file of a checkout.
    { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  started.child = child;
  const log = { budgetWarnings: [], errors: 0, tail: [] };
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  started.exit = exit;
  let exited = null;
  exit.then((value) => { exited = value; });
  const onLine = (line) => {
    log.tail.push(line);
    if (log.tail.length > 40) log.tail.shift();
    if (!line.startsWith("{")) return;
    try {
      const entry = JSON.parse(line);
      if (entry.level >= 50) log.errors += 1;
      if (entry.msg === BUDGET_WARNING) log.budgetWarnings.push({ time: entry.time, refusedRetries: entry.refusedRetries });
    } catch {
      // Not a log line.
    }
  };
  // One buffer per stream: chunks of stdout and stderr interleave, and a shared buffer would merge two lines.
  const lineReader = () => {
    let buffered = "";
    return (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) onLine(line);
    };
  };
  child.stdout.on("data", lineReader());
  child.stderr.on("data", lineReader());

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exited) throw new Error(`server exited during start (${JSON.stringify(exited)}): ${log.tail.slice(-10).join("\n")}`);
    if (Date.now() > deadline) {
      throw new Error(`server not ready in ${readyTimeoutMs} ms: ${log.tail.slice(-10).join("\n")}`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await response.json()).status === "ok") break;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }

  return {
    url,
    log,
    /** The exit of the server, or null while it runs. */
    exited: () => exited,
    async stop() {
      if (!exited) {
        child.kill("SIGTERM");
        let killTimer;
        const done = await Promise.race([exit, new Promise((resolve) => { killTimer = setTimeout(() => resolve(null), 30_000); })]);
        clearTimeout(killTimer);
        if (!done) {
          child.kill("SIGKILL");
          await exit;
        }
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SshConnectionConfig } from "./ssh.js";

/**
 * Shared SSH connections for the short commands of the callback bridge.
 *
 * Every bridge step (a queue listing, a read, a write) is one `ssh` command.
 * Without reuse each command is a new connection: a handshake and a login on
 * both hosts. With OpenSSH multiplexing, the first command of a scope becomes
 * the master connection and later commands open a channel on it.
 *
 * Rules:
 * - A scope is one environment, one target and one set of credentials. Its
 *   socket lives in a private (0700) directory that only this scope uses, so
 *   a command never reaches another target or runs with other credentials.
 * - Only the callers that opt in use a scope. The agent's own session stays
 *   on a direct connection.
 * - At most {@link SSH_MULTIPLEX_MAX_CHANNELS} commands share one master at a
 *   time, well under the usual `MaxSessions 20` of sshd. A command over the cap
 *   uses a direct connection. When sshd refuses a channel anyway, or the
 *   master died, OpenSSH itself falls back to a direct connection to the same
 *   target.
 * - The last user of a scope ends the master and removes the directory. An
 *   exit hook removes the directories this process still holds, and a master
 *   with no user exits after {@link SSH_MULTIPLEX_PERSIST_SECONDS}.
 */

/** Commands that may share one master connection at the same time. */
export const SSH_MULTIPLEX_MAX_CHANNELS = 10;
/** Idle seconds a master outlives its last command. */
export const SSH_MULTIPLEX_PERSIST_SECONDS = 60;

// `sun_path` holds 104 bytes on macOS (108 on Linux), and OpenSSH first binds
// the socket as `<ControlPath>.<16 random characters>`. A path over the limit
// makes every command fail, so such a scope uses direct connections instead.
const MAX_SOCKET_PATH_BYTES = 103 - 17;
// `%C` expands to a 40-character hash of the local host, remote host, port and
// user.
const SOCKET_NAME_BYTES = 40;
const DIRECT_ARGS = ["-o", "ControlPath=none"] as const;

/** One command's SSH options and the release of its channel slot. */
export interface SshMultiplexChannel {
  args: readonly string[];
  /** Ends the command's hold on its channel slot. Safe to call more than once. */
  done(): void;
}

/** One user's hold on a scope. */
export interface SshMultiplex {
  /** The options for one short command: multiplexed, or direct over the cap. */
  channel(): Promise<SshMultiplexChannel>;
  /** Ends this hold. The last hold ends the master and removes its directory. */
  release(): Promise<void>;
}

interface ScopeState {
  target: Pick<SshConnectionConfig, "host" | "port" | "username">;
  dir: Promise<string | null>;
  resolvedDir: string | null;
  users: number;
  channels: number;
}

// Kept on globalThis so two loaded copies of this module share one registry,
// and so the channel cap holds for the whole process.
const REGISTRY_KEY = Symbol.for("paperclip.sshMultiplexScopes");

function registry(): Map<string, ScopeState> {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (existing instanceof Map) return existing as Map<string, ScopeState>;
  const created = new Map<string, ScopeState>();
  Reflect.set(globalThis, REGISTRY_KEY, created);
  // Remove the sockets of this process at exit, so no later process can reach
  // a master through them. Each master then exits after its idle time.
  process.once("exit", () => {
    for (const state of created.values()) {
      if (state.resolvedDir) rmSync(state.resolvedDir, { recursive: true, force: true });
    }
  });
  return created;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeKey(config: SshConnectionConfig, scopeId: string | null | undefined): string {
  return sha256(JSON.stringify([
    scopeId ?? "",
    config.host,
    config.port,
    config.username,
    sha256(config.privateKey ?? ""),
    sha256(config.knownHosts ?? ""),
    config.strictHostKeyChecking,
  ]));
}

/** Whether OpenSSH can use a socket in `dir` (length, and no characters it would expand or split). */
export function sshControlDirFits(dir: string): boolean {
  return Buffer.byteLength(dir) + 1 + SOCKET_NAME_BYTES <= MAX_SOCKET_PATH_BYTES && !/[\s%"'\\]/.test(dir);
}

async function createControlDir(): Promise<string | null> {
  // A long os.tmpdir() (macOS) leaves no room for the socket name; /tmp is
  // sticky, and mkdtemp makes a fresh 0700 directory this user owns.
  const name = "paperclip-ssh-mux-XXXXXX";
  for (const root of [os.tmpdir(), "/tmp"]) {
    if (!sshControlDirFits(path.join(root, name))) continue;
    try {
      const dir = await fs.mkdtemp(path.join(root, "paperclip-ssh-mux-"));
      await fs.chmod(dir, 0o700);
      return dir;
    } catch {
      // Try the next root; with none, the scope uses direct connections.
    }
  }
  return null;
}

/**
 * Takes a hold on the shared connection for one environment and target.
 *
 * @param config - The SSH target and credentials.
 * @param scopeId - The environment id; holds with different ids never share a master.
 * @returns The hold. Call `release` when the run's bridge stops.
 */
export function openSshMultiplex(config: SshConnectionConfig, scopeId: string | null | undefined): SshMultiplex {
  const scopes = registry();
  const key = scopeKey(config, scopeId);
  let state = scopes.get(key);
  if (!state) {
    const created: ScopeState = {
      target: { host: config.host, port: config.port, username: config.username },
      dir: createControlDir(),
      resolvedDir: null,
      users: 0,
      channels: 0,
    };
    void created.dir.then((dir) => {
      created.resolvedDir = dir;
    });
    scopes.set(key, created);
    state = created;
  }
  const scope = state;
  scope.users += 1;
  let released = false;

  return {
    channel: async () => {
      const dir = released ? null : await scope.dir;
      if (!dir || scope.channels >= SSH_MULTIPLEX_MAX_CHANNELS) {
        return { args: DIRECT_ARGS, done: () => {} };
      }
      scope.channels += 1;
      let open = true;
      return {
        args: [
          "-o", "ControlMaster=auto",
          "-o", `ControlPath=${path.join(dir, "%C")}`,
          "-o", `ControlPersist=${SSH_MULTIPLEX_PERSIST_SECONDS}s`,
          // A master whose connection died silently exits within about 30 s,
          // and the next command connects again.
          "-o", "ServerAliveInterval=10",
          "-o", "ServerAliveCountMax=3",
        ],
        done: () => {
          if (!open) return;
          open = false;
          scope.channels -= 1;
        },
      };
    },
    release: async () => {
      if (released) return;
      released = true;
      scope.users -= 1;
      if (scope.users > 0) return;
      if (scopes.get(key) === scope) scopes.delete(key);
      const dir = await scope.dir;
      if (!dir) return;
      await new Promise<void>((resolve) => {
        execFile("ssh", [
          "-o", "BatchMode=yes",
          "-o", `ControlPath=${path.join(dir, "%C")}`,
          "-O", "exit",
          "-p", String(scope.target.port),
          `${scope.target.username}@${scope.target.host}`,
        ], { timeout: 5_000 }, () => resolve());
      });
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

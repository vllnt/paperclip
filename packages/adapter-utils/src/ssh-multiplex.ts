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
 *   a command never reaches another target or runs with other credentials. A
 *   hold gives a direct connection for any other target or credentials, and
 *   without an environment id there is no scope at all.
 * - Only the callers that opt in use a scope. The agent's own session stays
 *   on a direct connection.
 * - At most {@link SSH_MULTIPLEX_MAX_CHANNELS} commands share one master at a
 *   time: the stock sshd default `MaxSessions 10`. A command over the cap uses
 *   a direct connection. When sshd refuses a channel anyway, or the master
 *   died, OpenSSH itself falls back to a direct connection to the same target.
 * - A command this process killed (timeout or abort) retires its master
 *   (`ssh -O stop`): a master whose connection hangs would hold every later
 *   command until its keep-alives give up.
 * - The last user of a scope stops the master (commands on it finish) and
 *   removes the directory. An exit hook removes the directories this process
 *   still holds, and a master with no user exits after
 *   {@link SSH_MULTIPLEX_PERSIST_SECONDS}.
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
  /**
   * Ends the command's hold on its channel slot. `killed`: this process killed
   * the command (timeout or abort), so the master may be dead or hung; it is
   * then retired, and the returned promise settles once it no longer takes
   * commands, so the next command connects again. A command from an older
   * master than the current one retires nothing. Safe to call more than once.
   */
  done(outcome?: { killed?: boolean }): Promise<void> | void;
}

/** One user's hold on a scope. */
export interface SshMultiplex {
  /**
   * The options for one short command to `config`: multiplexed, or direct over
   * the cap, for a hold without a scope, or for any config other than the
   * hold's own.
   */
  channel(config: SshConnectionConfig): Promise<SshMultiplexChannel>;
  /** Ends this hold. The last hold ends the master and removes its directory. */
  release(): Promise<void>;
}

interface ScopeState {
  target: Pick<SshConnectionConfig, "host" | "port" | "username">;
  dir: Promise<string | null>;
  resolvedDir: string | null;
  users: number;
  channels: number;
  // Bumped when the master is retired; a channel retires only its own master.
  generation: number;
}

// Kept on globalThis so two loaded copies of this module share one registry,
// and so the channel cap holds for the whole process.
const REGISTRY_KEY = Symbol.for("paperclip.sshMultiplexScopes");
// Directories of scopes whose last hold is being released.
const CLOSING_KEY = Symbol.for("paperclip.sshMultiplexClosingDirs");

function closingDirs(): Set<string> {
  const existing: unknown = Reflect.get(globalThis, CLOSING_KEY);
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  Reflect.set(globalThis, CLOSING_KEY, created);
  return created;
}

function registry(): Map<string, ScopeState> {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (existing instanceof Map) return existing as Map<string, ScopeState>;
  const created = new Map<string, ScopeState>();
  Reflect.set(globalThis, REGISTRY_KEY, created);
  // Remove the sockets of this process at exit, so no later process can reach
  // a master through them. Each master then exits after its idle time.
  process.once("exit", () => {
    const dirs = [...created.values()].map((state) => state.resolvedDir).concat([...closingDirs()]);
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort at exit.
      }
    }
  });
  return created;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeKey(config: SshConnectionConfig, scopeId: string): string {
  return sha256(JSON.stringify([
    scopeId,
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
  return Buffer.byteLength(dir) + 1 + SOCKET_NAME_BYTES <= MAX_SOCKET_PATH_BYTES && !/[\s%$"'\\]/.test(dir) && !dir.startsWith("~");
}

// A parent another user may write could have the directory swapped for one of
// theirs after it is made: it must be sticky or writable by its owner only (no
// group or other write), and owned by this user or root. The directory itself
// must be this user's, 0700.
async function controlDirIsPrivate(root: string, dir: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  // The root may be a link (macOS `/tmp`); what it points at is checked.
  const [parent, own] = await Promise.all([fs.stat(root), fs.lstat(dir)]);
  const parentSafe = parent.isDirectory() && (parent.uid === uid || parent.uid === 0)
    && ((parent.mode & 0o022) === 0 || (parent.mode & 0o1000) !== 0);
  return parentSafe && own.isDirectory() && own.uid === uid && (own.mode & 0o777) === 0o700;
}

async function createControlDir(): Promise<string | null> {
  // A long os.tmpdir() (macOS) leaves no room for the socket name; /tmp is
  // sticky, and mkdtemp makes a fresh 0700 directory this user owns.
  const name = "paperclip-ssh-mux-XXXXXX";
  for (const root of [os.tmpdir(), "/tmp"]) {
    if (!sshControlDirFits(path.join(root, name))) continue;
    let dir: string | null = null;
    try {
      dir = await fs.mkdtemp(path.join(root, "paperclip-ssh-mux-"));
      await fs.chmod(dir, 0o700);
      if (await controlDirIsPrivate(root, dir)) return dir;
    } catch {
      // Try the next root; with none, the scope uses direct connections.
    }
    // Still empty: nothing used it.
    if (dir) await fs.rmdir(dir).catch(() => undefined);
  }
  return null;
}

// Sends a control command (`stop`) to a scope's master; it never fails.
function controlMaster(state: ScopeState, dir: string, command: "stop"): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("ssh", [
      "-o", "BatchMode=yes",
      "-o", `ControlPath=${path.join(dir, "%C")}`,
      "-O", command,
      "-p", String(state.target.port),
      `${state.target.username}@${state.target.host}`,
    ], { timeout: 5_000 }, () => resolve());
  });
}

const DIRECT_CHANNEL: SshMultiplexChannel = { args: DIRECT_ARGS, done: () => {} };

/**
 * Takes a hold on the shared connection for one environment and target.
 *
 * @param config - The SSH target and credentials.
 * @param scopeId - The environment id; holds with different ids never share a
 *   master. Without one, every command connects directly.
 * @returns The hold. Call `release` when the run's bridge stops.
 */
export function openSshMultiplex(config: SshConnectionConfig, scopeId: string | null | undefined): SshMultiplex {
  if (!scopeId) {
    return { channel: async () => DIRECT_CHANNEL, release: async () => {} };
  }
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
      generation: 0,
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

  // Stops the master from taking new commands (`-O stop`); the next command
  // starts a new one. Commands already on it finish. Only for the master the
  // killed command ran on: a later master is left alone.
  const retire = (dir: string, generation: number): Promise<void> | void => {
    if (generation !== scope.generation) return;
    scope.generation += 1;
    return controlMaster(scope, dir, "stop");
  };

  return {
    channel: async (callConfig) => {
      if (released || scopeKey(callConfig, scopeId) !== key) return DIRECT_CHANNEL;
      const dir = await scope.dir;
      if (released || !dir || scope.channels >= SSH_MULTIPLEX_MAX_CHANNELS) return DIRECT_CHANNEL;
      scope.channels += 1;
      const generation = scope.generation;
      let open = true;
      return {
        args: [
          "-o", "ControlMaster=auto",
          "-o", `ControlPath=${path.join(dir, "%C")}`,
          "-o", `ControlPersist=${SSH_MULTIPLEX_PERSIST_SECONDS}s`,
          // A master whose connection died silently exits within about 30 s.
          // A command this process kills retires its master sooner.
          "-o", "ServerAliveInterval=10",
          "-o", "ServerAliveCountMax=3",
        ],
        done: (outcome) => {
          if (!open) return;
          open = false;
          scope.channels -= 1;
          return outcome?.killed ? retire(dir, generation) : undefined;
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
      closingDirs().add(dir);
      try {
        // `stop`, not `exit`: a command still on the master (a response write)
        // finishes instead of being cut off; the master then exits.
        await controlMaster(scope, dir, "stop");
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      } finally {
        closingDirs().delete(dir);
      }
    },
  };
}

/**
 * A TCP fault proxy between a Postgres client and the database, for the fault
 * runs of doc/plans/2026-10-10-backend-effect.md (F1 slow failure, F4).
 *
 * It forwards bytes unchanged and reads the Postgres wire protocol on the
 * side, to count what the client sends:
 * - statements: Query ('Q') and Execute ('E') messages,
 * - in flight: Query and Sync messages not yet answered by ReadyForQuery,
 * - connections accepted per second, open connections and their peak.
 *
 * Modes, switched at run time with `setMode`:
 * - `pass`: forward everything.
 * - `flap`: hold each new connection `holdMs` before connecting it, and reset
 *   each connection `lifeMs` after it was accepted.
 * - `refuse`: close the listener, so every new connection is refused, and
 *   reset the open ones.
 * - `stall`: stop forwarding on every connection, open or new, for `stallMs`,
 *   then reset them all and return to `pass`.
 *
 * Node built-ins only.
 */
import net from "node:net";

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

/**
 * Splits one direction of a Postgres stream into messages and calls
 * `onMessage(type)` for each. The client side starts with untyped startup
 * messages; the server side may start with one unframed SSL answer byte.
 */
function messageReader({ untypedFirst, onMessage }) {
  let pending = Buffer.alloc(0);
  let untyped = untypedFirst;
  let skipOneByte = false;
  return {
    expectSslAnswer() {
      skipOneByte = true;
    },
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let offset = 0;
      for (;;) {
        if (skipOneByte) {
          if (pending.length - offset < 1) break;
          offset += 1;
          skipOneByte = false;
          continue;
        }
        if (untyped) {
          if (pending.length - offset < 8) break;
          const length = pending.readInt32BE(offset);
          if (pending.length - offset < length) break;
          const code = pending.readInt32BE(offset + 4);
          offset += length;
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) onMessage("ssl-request");
          else if (code !== CANCEL_REQUEST) untyped = false;
          continue;
        }
        if (pending.length - offset < 5) break;
        const length = pending.readInt32BE(offset + 1);
        if (pending.length - offset < length + 1) break;
        onMessage(String.fromCharCode(pending[offset]));
        offset += length + 1;
      }
      pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
    },
  };
}

function emptyStats() {
  return {
    statements: 0,
    statementsPerSecond: new Map(),
    accepted: 0,
    acceptedPerSecond: new Map(),
    refused: 0,
    peakOpen: 0,
    peakInFlight: 0,
  };
}

function bump(map, second) {
  map.set(second, (map.get(second) ?? 0) + 1);
}

/**
 * Starts the proxy.
 *
 * @param {{ targetHost?: string, targetPort: number, listenHost?: string, listenPort?: number }} options
 * @returns {Promise<{ port: number, setMode: Function, stats: Function, resetStats: Function, close: Function }>}
 */
export async function startFaultProxy({ targetHost = "127.0.0.1", targetPort, listenHost = "127.0.0.1", listenPort = 0 }) {
  const connections = new Set();
  let mode = { name: "pass" };
  let stats = emptyStats();
  let inFlight = 0;
  let stallTimer = null;
  const startedAt = performance.now();
  const second = () => Math.floor((performance.now() - startedAt) / 1000);

  function forget(connection) {
    if (connection.closed) return false;
    connection.closed = true;
    clearTimeout(connection.lifeTimer);
    inFlight -= connection.inFlight;
    connection.inFlight = 0;
    connections.delete(connection);
    return true;
  }

  /** A fault: both sockets end with a TCP reset. */
  function reset(connection) {
    if (!forget(connection)) return;
    connection.client.resetAndDestroy();
    connection.upstream?.resetAndDestroy();
  }

  /** One side closed on its own: close the other side the same way. */
  function closeBoth(connection) {
    if (!forget(connection)) return;
    connection.client.destroy();
    connection.upstream?.destroy();
  }

  function connectUpstream(connection) {
    if (connection.closed) return;
    const upstream = net.connect({ host: targetHost, port: targetPort });
    connection.upstream = upstream;
    upstream.setNoDelay(true);
    const serverReader = messageReader({
      untypedFirst: false,
      onMessage(type) {
        if (type !== "Z") return;
        if (!connection.ready) {
          connection.ready = true;
          return;
        }
        if (connection.inFlight > 0) {
          connection.inFlight -= 1;
          inFlight -= 1;
        }
      },
    });
    connection.serverReader = serverReader;
    upstream.on("data", (chunk) => {
      serverReader.push(chunk);
      if (!connection.stalled) connection.client.write(chunk);
    });
    upstream.on("error", () => reset(connection));
    upstream.on("close", () => closeBoth(connection));
    connection.client.resume();
    for (const chunk of connection.queued) upstream.write(chunk);
    connection.queued = [];
  }

  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    const connection = {
      client,
      upstream: null,
      queued: [],
      closed: false,
      ready: false,
      stalled: mode.name === "stall",
      inFlight: 0,
      lifeTimer: null,
    };
    connections.add(connection);
    stats.accepted += 1;
    bump(stats.acceptedPerSecond, second());
    stats.peakOpen = Math.max(stats.peakOpen, connections.size);
    client.setNoDelay(true);
    const clientReader = messageReader({
      untypedFirst: true,
      onMessage(type) {
        if (type === "ssl-request") {
          connection.serverReader?.expectSslAnswer();
          return;
        }
        if (type === "Q" || type === "E") {
          stats.statements += 1;
          bump(stats.statementsPerSecond, second());
        }
        if (type === "Q" || type === "S") {
          connection.inFlight += 1;
          inFlight += 1;
          stats.peakInFlight = Math.max(stats.peakInFlight, inFlight);
        }
      },
    });
    client.on("data", (chunk) => {
      clientReader.push(chunk);
      if (connection.stalled) return;
      if (connection.upstream) connection.upstream.write(chunk);
      else connection.queued.push(chunk);
    });
    client.on("error", () => reset(connection));
    client.on("close", () => closeBoth(connection));

    if (mode.name === "flap") {
      connection.lifeTimer = setTimeout(() => reset(connection), mode.lifeMs);
      setTimeout(() => connectUpstream(connection), mode.holdMs);
    } else if (mode.name === "stall") {
      client.resume();
    } else {
      connectUpstream(connection);
    }
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort || server.boundPort || 0, listenHost, () => {
        server.off("error", reject);
        server.boundPort = server.address().port;
        resolve();
      });
    });
  }

  await listen();

  return {
    port: server.boundPort,
    /**
     * @param {"pass" | "flap" | "refuse" | "stall"} name
     * @param {{ lifeMs?: number, holdMs?: number, stallMs?: number }} [options]
     */
    async setMode(name, options = {}) {
      const previous = mode.name;
      clearTimeout(stallTimer);
      stallTimer = null;
      mode = { name, ...options };
      if (previous === "refuse" && name !== "refuse") await listen();
      if (name === "refuse") {
        if (previous !== "refuse") await new Promise((resolve) => server.close(() => resolve()));
        for (const connection of [...connections]) reset(connection);
      } else if (name === "flap") {
        for (const connection of connections) {
          clearTimeout(connection.lifeTimer);
          connection.lifeTimer = setTimeout(() => reset(connection), mode.lifeMs);
        }
      } else if (name === "stall") {
        for (const connection of connections) connection.stalled = true;
        stallTimer = setTimeout(() => {
          for (const connection of [...connections]) reset(connection);
          mode = { name: "pass" };
        }, mode.stallMs);
      } else {
        for (const connection of connections) clearTimeout(connection.lifeTimer);
      }
    },
    /** Counters since the last `resetStats`. */
    stats() {
      const busiest = (map) => Math.max(0, ...map.values());
      return {
        statements: stats.statements,
        busiestStatementSecond: busiest(stats.statementsPerSecond),
        accepted: stats.accepted,
        busiestAcceptSecond: busiest(stats.acceptedPerSecond),
        open: connections.size,
        peakOpen: stats.peakOpen,
        inFlight,
        peakInFlight: stats.peakInFlight,
      };
    },
    resetStats() {
      stats = emptyStats();
      stats.peakOpen = connections.size;
      stats.peakInFlight = inFlight;
    },
    async close() {
      clearTimeout(stallTimer);
      for (const connection of [...connections]) reset(connection);
      if (mode.name !== "refuse") await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

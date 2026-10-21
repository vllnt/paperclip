// Entry of the Next.js child process. The server (server/src/ui-runtime/next-child.ts)
// spawns it with an IPC channel and proxies every non-API GET and HEAD request to
// the port reported here. Next.js never listens on a public address, and never
// sees a websocket upgrade except hot reload in development.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";

// The parent also sets this in the environment; the child must not depend on it.
process.env.NEXT_TELEMETRY_DISABLED = "1";

const dev = process.env.NODE_ENV === "development";
const hostname = "127.0.0.1";
const dir = path.dirname(fileURLToPath(import.meta.url));

if (typeof process.send !== "function") {
  console.error("next-server.mjs must be started with an IPC channel (see server/src/ui-runtime/next-child.ts)");
  process.exit(1);
}
// The parent is gone: nothing can reach this process any more.
process.on("disconnect", () => process.exit(0));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));

const app = next({ dev, dir, hostname, port: 0 });
const handle = app.getRequestHandler();
await app.prepare();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("next request failed", err);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});
if (dev) {
  // Hot reload: the parent replays the websocket upgrade onto this port.
  const upgrade = app.getUpgradeHandler();
  server.on("upgrade", (req, socket, head) => {
    upgrade(req, socket, head).catch(() => socket.destroy());
  });
}
server.listen(0, hostname, () => {
  process.send({ type: "ready", port: server.address().port });
});

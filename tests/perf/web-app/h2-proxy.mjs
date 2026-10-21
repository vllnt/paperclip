/**
 * A TLS proxy that speaks HTTP/2 to the browser and HTTP/1.1 to the local server, so
 * the probes see production-like multiplexing instead of Chrome's 6 HTTP/1.1
 * connections (plan section 7, "HTTP/2"). It also accepts HTTP/1.1, so websocket
 * upgrades pass through to the server unchanged.
 *
 *   node tests/perf/web-app/h2-proxy.mjs --upstream http://127.0.0.1:3192 --port 3443
 *   node tests/perf/web-app/measure.mjs --base https://127.0.0.1:3443 ...
 *
 * The certificate is self-signed and made with `openssl` at start, in a temporary
 * directory; the probes open https bases with `ignoreHTTPSErrors`. Node built-ins only.
 * Local measuring tool: never put it in front of a shared or production instance.
 */
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "./lib/common.mjs";

const args = parseArgs();
const upstream = new URL(args.upstream ?? "http://127.0.0.1:3192");
const port = Number(args.port ?? 3443);

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "http2-settings", "te", "host"]);

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-h2-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const pair = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return pair;
}

/** Forwards one request (HTTP/2 stream or HTTP/1.1) to the upstream over HTTP/1.1. */
function forward(req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!name.startsWith(":") && !HOP_BY_HOP.has(name)) headers[name] = value;
  }
  // The server sees the browser's origin, as behind the production ingress.
  headers.host = req.headers[":authority"] ?? req.headers.host ?? upstream.host;
  headers["x-forwarded-proto"] = "https";
  const out = http.request(
    { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers },
    (up) => {
      const resHeaders = {};
      for (const [name, value] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(name)) resHeaders[name] = value;
      res.writeHead(up.statusCode ?? 502, resHeaders);
      up.pipe(res);
    },
  );
  out.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.code ?? err.message}`);
  });
  req.pipe(out);
}

const server = http2.createSecureServer({ ...selfSignedCert(), allowHTTP1: true }, forward);

// Websocket upgrades arrive as HTTP/1.1; replay the request line and headers on a raw socket.
server.on("upgrade", (req, socket, head) => {
  const target = net.connect(Number(upstream.port), upstream.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    target.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) target.write(head);
    target.pipe(socket).pipe(target);
  });
  const close = () => {
    socket.destroy();
    target.destroy();
  };
  target.on("error", close);
  socket.on("error", close);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`h2 proxy https://127.0.0.1:${port} -> ${upstream.origin} (HTTP/2 and HTTP/1.1)`);
});

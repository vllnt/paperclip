import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import net from "node:net";
import { pipeline, type Duplex } from "node:stream";
import type { Request, RequestHandler, Response } from "express";
import type { NextChild, NextChildLogger } from "./next-child.js";

type ProxyChild = Pick<NextChild, "state" | "port" | "remainingStartMs" | "waitForSettled">;

export interface NextProxyOptions {
  child: ProxyChild;
  /** Development also passes `POST /__nextjs_*`, which the error overlay uses. */
  dev: boolean;
  logger: Pick<NextChildLogger, "warn">;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Headers that let a shared cache or CDN keep a response in spite of
// `Cache-Control: private, no-store`.
const SHARED_CACHE_HEADERS = ["expires", "surrogate-control", "cdn-cache-control", "cloudflare-cdn-cache-control"];

const UNAVAILABLE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Paperclip is unavailable</title></head>
<body><main><h1>The web app is unavailable</h1>
<p>The server is running, but the web app did not start. The API still works. Try again in a moment.</p>
</main></body></html>`;

/** Lowercased, decoded, with repeated slashes collapsed, so `//_next/%69mage` cannot slip past a prefix test. */
function normalizePath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path: a malformed escape never matches a blocked prefix, and Next.js rejects it.
  }
  return decoded.replace(/\/{2,}/g, "/").toLowerCase();
}

function isBlockedNextPath(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  return ["/_next/image", "/_next/mcp"].some((blocked) => normalized === blocked || normalized.startsWith(`${blocked}/`));
}

function isAllowedMethod(req: Request, dev: boolean): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  return dev && req.method === "POST" && normalizePath(req.path).startsWith("/__nextjs_");
}

/** Adds `Cookie` to a `Vary` value, keeping what is there (`RSC, Next-Router-State-Tree, ...`). */
export function mergeVaryWithCookie(value: string | string[] | number | undefined): string {
  const tokens = String(Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.includes("*")) return "*";
  if (!tokens.some((token) => token.toLowerCase() === "cookie")) tokens.push("Cookie");
  return tokens.join(", ");
}

function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const dropped = new Set(HOP_BY_HOP_HEADERS);
  for (const token of String(headers.connection ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) dropped.add(name);
  }
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !dropped.has(name)) forwarded[name] = value;
  }
  return forwarded;
}

function sendPlain(res: Response, status: number, text: string, headers: Record<string, string> = {}) {
  res.status(status).set({ "Cache-Control": "no-store", ...headers }).type("text/plain").send(text);
}

function sendUnavailable(res: Response) {
  res
    .status(503)
    .set({ "Cache-Control": "no-store", "Retry-After": "5" })
    .type("html")
    .send(UNAVAILABLE_PAGE);
}

async function waitForReady(child: ProxyChild, res: Response): Promise<"ready" | "failed" | "gone"> {
  let timer: NodeJS.Timeout | undefined;
  let onClose: (() => void) | undefined;
  try {
    return await Promise.race([
      child.waitForSettled(),
      new Promise<"failed">((resolve) => {
        timer = setTimeout(() => resolve("failed"), child.remainingStartMs());
      }),
      new Promise<"gone">((resolve) => {
        onClose = () => resolve("gone");
        res.once("close", onClose);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onClose) res.off("close", onClose);
  }
}

/**
 * Express handler for every request that no earlier route answered: it passes
 * GET and HEAD to the Next.js child over loopback and owns everything around it
 * (method policy, blocked paths, the 503 page and the cache headers).
 *
 * Every response from the child is treated as personal: whatever it sends,
 * `Cache-Control` becomes `private, no-store` and `Vary` includes `Cookie`.
 *
 * Mount it last, after the API, the plugin routes and the static routes.
 */
export function createNextProxy(options: NextProxyOptions): RequestHandler {
  const { child, dev, logger } = options;
  const agent = new http.Agent({ keepAlive: true });

  function forward(req: Request, res: Response, port: number) {
    const headers = endToEndHeaders(req.headers);
    // The global JSON parser has already drained the body of a dev-only POST;
    // it kept the bytes it read.
    const rawBody = (req as { rawBody?: Buffer }).rawBody;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    if (!hasBody) {
      delete headers["content-length"];
    } else if (rawBody) {
      headers["content-length"] = rawBody.length;
      delete headers["content-encoding"];
    }

    let upstream: http.ClientRequest;
    try {
      upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.originalUrl, headers, agent });
    } catch {
      sendPlain(res, 400, "Bad Request");
      return;
    }

    upstream.on("response", (upstreamRes: IncomingMessage) => {
      const responseHeaders = endToEndHeaders(upstreamRes.headers);
      for (const name of SHARED_CACHE_HEADERS) delete responseHeaders[name];
      responseHeaders["cache-control"] = "private, no-store";
      responseHeaders.vary = mergeVaryWithCookie(responseHeaders.vary);
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
      // pipeline() destroys the response when the child drops mid-body.
      pipeline(upstreamRes, res, () => undefined);
    });
    upstream.on("error", (err) => {
      logger.warn({ err, method: req.method }, "UI child request failed");
      if (res.headersSent) res.destroy();
      else sendPlain(res, 502, "Bad Gateway");
    });
    res.once("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });

    if (!hasBody) upstream.end();
    else if (rawBody) upstream.end(rawBody);
    else req.pipe(upstream);
  }

  return async (req, res, next) => {
    try {
      if (!isAllowedMethod(req, dev)) {
        sendPlain(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
        return;
      }
      if (isBlockedNextPath(req.path)) {
        sendPlain(res, 404, "Not Found");
        return;
      }

      let state: "starting" | "ready" | "failed" | "gone" = child.state();
      if (state === "starting") state = await waitForReady(child, res);
      if (state === "gone") return;
      const port = state === "ready" ? child.port() : null;
      if (port === null) {
        sendUnavailable(res);
        return;
      }
      forward(req, res, port);
    } catch (err) {
      next(err);
    }
  };
}

const NEXT_HMR_PATHS = new Set(["/_next/hmr", "/_next/webpack-hmr"]);
type UpgradeRequest = IncomingMessage & { paperclipWebSocketHandled?: boolean };

/**
 * `upgrade` listener for development: replays a hot-reload websocket upgrade
 * onto the child's port and pipes the two sockets together. Any other upgrade
 * is left to the listeners that own it. Register it with `prependListener`, so
 * the live-events listener, which closes paths it does not know, sees the
 * request already marked as handled.
 */
export function createNextHmrUpgradeHandler(options: {
  child: Pick<NextChild, "state" | "port">;
  logger: Pick<NextChildLogger, "warn">;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return;
    }
    if (!NEXT_HMR_PATHS.has(pathname)) return;

    (req as UpgradeRequest).paperclipWebSocketHandled = true;
    const port = options.child.state() === "ready" ? options.child.port() : null;
    if (port === null) {
      socket.destroy();
      return;
    }

    const upstream = net.connect({ host: "127.0.0.1", port });
    const closeBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", closeBoth);
    socket.once("close", closeBoth);
    upstream.on("error", (err) => {
      options.logger.warn({ err }, "UI child hot-reload socket failed");
      closeBoth();
    });
    upstream.once("close", closeBoth);
    upstream.once("connect", () => {
      const requestHead = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        requestHead.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${requestHead.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  };
}

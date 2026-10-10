import express, { type RequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";

const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".css", ".svg", ".json"]);

const PRECOMPRESSED_ENCODINGS = [
  { encoding: "br", suffix: ".br" },
  { encoding: "gzip", suffix: ".gz" },
] as const;

export interface PrecompressedStaticOptions {
  /** `Cache-Control` max-age passed to the file sender, in ms or as a string such as "1y". */
  maxAge?: string | number;
  /** Adds `immutable` to `Cache-Control`. */
  immutable?: boolean;
}

function listPrecompressedFiles(root: string): ReadonlySet<string> {
  const found = new Set<string>();
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const suffix = PRECOMPRESSED_ENCODINGS.find((candidate) => entry.name.endsWith(candidate.suffix))?.suffix;
    if (!suffix) continue;
    const original = entry.name.slice(0, -suffix.length);
    if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(original).toLowerCase())) continue;
    const relativeDirectory = path.relative(root, entry.parentPath).split(path.sep).join("/");
    found.add(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
  }
  return found;
}

/**
 * Serves `<file>.br` or `<file>.gz` instead of `<file>` when the client accepts
 * that encoding and the build wrote the sibling. Everything else falls through
 * to the next handler, so mount it before `express.static` on the same root.
 *
 * The list of siblings is read once, when this function runs, so the request
 * handler does no file system work of its own: it checks that list, points the
 * request at the sibling, and lets `express.static` send it with the usual
 * `ETag`, `304` and cache headers. Restart the server after a rebuild to pick up
 * new siblings; until then new files are sent uncompressed.
 *
 * It leaves range requests, other methods, other extensions, missing siblings
 * and clients that accept neither encoding to the next handler. It sets
 * `Vary: Accept-Encoding` on every request it considers, so caches keep the
 * encodings apart.
 *
 * @param root - Directory that holds the files and their precompressed siblings.
 * @param options - Cache headers for the compressed response.
 * @returns An Express request handler.
 * @example
 * app.use("/assets", precompressedStatic(assetsDir, { maxAge: "1y", immutable: true }), express.static(assetsDir));
 */
export function precompressedStatic(root: string, options: PrecompressedStaticOptions = {}): RequestHandler {
  const siblings = listPrecompressedFiles(root);
  const sendSibling = express.static(root, {
    maxAge: options.maxAge,
    immutable: options.immutable,
    dotfiles: "deny",
    index: false,
    redirect: false,
  });

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let requested: string;
    try {
      requested = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const extension = path.extname(requested).toLowerCase();
    if (!COMPRESSIBLE_EXTENSIONS.has(extension)) return next();

    res.vary("Accept-Encoding");
    if (req.headers.range) return next();

    const relativePath = path.posix.normalize(requested.startsWith("/") ? requested.slice(1) : requested);
    if (relativePath.startsWith("..") || path.posix.isAbsolute(relativePath)) return next();

    const choice = PRECOMPRESSED_ENCODINGS.find(
      (candidate) => req.acceptsEncodings(candidate.encoding) && siblings.has(`${relativePath}${candidate.suffix}`),
    );
    if (!choice) return next();

    const originalUrl = req.url;
    req.url = `/${relativePath.split("/").map(encodeURIComponent).join("/")}${choice.suffix}`;
    res.type(extension);
    res.setHeader("Content-Encoding", choice.encoding);
    sendSibling(req, res, (error) => {
      req.url = originalUrl;
      if (res.headersSent) return;
      res.removeHeader("Content-Encoding");
      res.removeHeader("Content-Type");
      next(error);
    });
  };
}

import path from "node:path";
import { stat } from "node:fs/promises";
import type { RequestHandler } from "express";

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

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves `<file>.br` or `<file>.gz` instead of `<file>` when the client accepts
 * that encoding and the build wrote the sibling. Everything else falls through
 * to the next handler, so mount it before `express.static` on the same root.
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
  const absoluteRoot = path.resolve(root);

  return async (req, res, next) => {
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

    const relativePath = path.posix.normalize(`.${requested.startsWith("/") ? requested : `/${requested}`}`);
    const absolutePath = path.resolve(absoluteRoot, relativePath);
    if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) return next();

    let choice: (typeof PRECOMPRESSED_ENCODINGS)[number] | undefined;
    for (const candidate of PRECOMPRESSED_ENCODINGS) {
      if (req.acceptsEncodings(candidate.encoding) && (await isFile(`${absolutePath}${candidate.suffix}`))) {
        choice = candidate;
        break;
      }
    }
    if (!choice) return next();

    res.type(extension);
    res.setHeader("Content-Encoding", choice.encoding);
    res.sendFile(`${relativePath}${choice.suffix}`, {
      root: absoluteRoot,
      dotfiles: "deny",
      maxAge: options.maxAge,
      immutable: options.immutable,
    }, (error) => {
      if (!error || res.headersSent) return;
      res.removeHeader("Content-Encoding");
      res.removeHeader("Content-Type");
      next();
    });
  };
}

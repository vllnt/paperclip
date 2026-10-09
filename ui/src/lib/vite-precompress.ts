import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Files smaller than this are not worth a sibling; the headers cost as much. */
export const PRECOMPRESS_MIN_BYTES = 1024;

const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".css", ".svg", ".json"]);
const CONCURRENCY = 4;

function listCompressibleFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && COMPRESSIBLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.statSync(file).size >= PRECOMPRESS_MIN_BYTES);
}

async function writeIfSmaller(target: string, original: Buffer, compressed: Buffer): Promise<boolean> {
  if (compressed.length >= original.length) return false;
  await fs.promises.writeFile(target, compressed);
  return true;
}

async function precompressFile(file: string): Promise<boolean> {
  const original = await fs.promises.readFile(file);
  const [brotli, gzipped] = await Promise.all([
    brotliAsync(original, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: original.length,
      },
    }),
    gzipAsync(original, { level: constants.Z_BEST_COMPRESSION }),
  ]);
  const wroteBrotli = await writeIfSmaller(`${file}.br`, original, brotli);
  const wroteGzip = await writeIfSmaller(`${file}.gz`, original, gzipped);
  return wroteBrotli || wroteGzip;
}

/**
 * Writes a `.br` and a `.gz` sibling next to every script, stylesheet, SVG and
 * JSON file of at least `PRECOMPRESS_MIN_BYTES`, when the sibling is smaller.
 * The server picks the sibling that the client accepts, so the app does not
 * depend on a proxy to compress its own assets.
 *
 * @param directory - Directory to walk, usually `<outDir>/assets`.
 * @returns How many source files received at least one sibling.
 */
export async function precompressDirectory(directory: string): Promise<number> {
  const files = listCompressibleFiles(directory);
  let written = 0;
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= files.length) return;
      if (await precompressFile(files[index])) written += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return written;
}

/**
 * Vite plugin that runs `precompressDirectory` on the built assets directory.
 *
 * @returns A build-only plugin.
 */
export function precompressAssetsPlugin(): Plugin {
  let assetsDirectory = "";

  return {
    name: "paperclip-precompress-assets",
    apply: "build",
    configResolved(config) {
      assetsDirectory = path.resolve(config.root, config.build.outDir, config.build.assetsDir);
    },
    async closeBundle() {
      if (!fs.existsSync(assetsDirectory)) return;
      await precompressDirectory(assetsDirectory);
    },
  };
}

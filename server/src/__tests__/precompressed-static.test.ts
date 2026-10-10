import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { precompressedStatic } from "../middleware/precompressed-static.js";

type RawResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

const SCRIPT = `${"export const value = 'precompressed asset body';\n".repeat(200)}`;
const STYLE = `${".card { color: rebeccapurple; }\n".repeat(200)}`;

let root: string;
const openServers: Array<ReturnType<typeof createServer>> = [];

function buildApp(): express.Express {
  const app = express();
  app.use(
    "/assets",
    precompressedStatic(root, { maxAge: "1y", immutable: true }),
    express.static(root, { maxAge: "1y", immutable: true }),
  );
  return app;
}

async function requestRaw(
  urlPath: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<RawResponse> {
  const server = createServer(buildApp());
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-precompressed-"));
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "app.js"), SCRIPT);
  fs.writeFileSync(path.join(root, "app.js.br"), brotliCompressSync(SCRIPT));
  fs.writeFileSync(path.join(root, "app.js.gz"), gzipSync(SCRIPT));
  fs.writeFileSync(path.join(root, "gzip-only.css"), STYLE);
  fs.writeFileSync(path.join(root, "gzip-only.css.gz"), gzipSync(STYLE));
  fs.writeFileSync(path.join(root, "plain.js"), SCRIPT);
  fs.writeFileSync(path.join(root, "nested", "chunk.js"), SCRIPT);
  fs.writeFileSync(path.join(root, "nested", "chunk.js.br"), brotliCompressSync(SCRIPT));
  fs.writeFileSync(path.join(root, "font.woff2"), "not compressible");
  fs.writeFileSync(path.join(root, "font.woff2.br"), "must never be served");
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("precompressedStatic", () => {
  it("serves the brotli sibling when the client accepts brotli", async () => {
    const response = await requestRaw("/assets/app.js", { "accept-encoding": "gzip, deflate, br" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(response.body).toString()).toBe(SCRIPT);
    expect(response.body.length).toBeLessThan(Buffer.byteLength(SCRIPT));
  });

  it("serves the gzip sibling when brotli is not accepted", async () => {
    const response = await requestRaw("/assets/app.js", { "accept-encoding": "gzip" });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).toString()).toBe(SCRIPT);
  });

  it("serves gzip when it is the only sibling and brotli is accepted", async () => {
    const response = await requestRaw("/assets/gzip-only.css", { "accept-encoding": "br, gzip" });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).toString()).toBe(STYLE);
  });

  it("serves a nested file and respects a brotli-only sibling", async () => {
    const response = await requestRaw("/assets/nested/chunk.js", { "accept-encoding": "br" });

    expect(response.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(response.body).toString()).toBe(SCRIPT);
  });

  it("sends the same content type and caching headers as the plain file", async () => {
    const plain = await requestRaw("/assets/app.js", { "accept-encoding": "identity" });
    const compressed = await requestRaw("/assets/app.js", { "accept-encoding": "br" });

    expect(compressed.headers["content-type"]).toBe(plain.headers["content-type"]);
    expect(compressed.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(compressed.headers["cache-control"]).toBe(plain.headers["cache-control"]);
    expect(compressed.headers.etag).toBeTruthy();
  });

  it("tells caches the response depends on the accepted encoding", async () => {
    const compressed = await requestRaw("/assets/app.js", { "accept-encoding": "br" });
    const plain = await requestRaw("/assets/app.js", { "accept-encoding": "identity" });

    expect(String(compressed.headers.vary)).toContain("Accept-Encoding");
    expect(String(plain.headers.vary)).toContain("Accept-Encoding");
  });

  it("serves the plain file when the client accepts no supported encoding", async () => {
    const withoutHeader = await requestRaw("/assets/app.js");
    const identityOnly = await requestRaw("/assets/app.js", { "accept-encoding": "identity" });
    const brotliRefused = await requestRaw("/assets/app.js", { "accept-encoding": "br;q=0, gzip;q=0" });

    for (const response of [withoutHeader, identityOnly, brotliRefused]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.body.toString()).toBe(SCRIPT);
    }
  });

  it("serves the plain file when no sibling exists", async () => {
    const response = await requestRaw("/assets/plain.js", { "accept-encoding": "br, gzip" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.toString()).toBe(SCRIPT);
  });

  it("never serves a compressed file for an extension it does not handle", async () => {
    const response = await requestRaw("/assets/font.woff2", { "accept-encoding": "br" });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.toString()).toBe("not compressible");
  });

  it("serves the plain file for range requests", async () => {
    const response = await requestRaw("/assets/app.js", { "accept-encoding": "br", range: "bytes=0-9" });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.toString()).toBe(SCRIPT.slice(0, 10));
  });

  it("answers HEAD with the compressed headers and no body", async () => {
    const response = await requestRaw("/assets/app.js", { "accept-encoding": "br" }, "HEAD");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.body.length).toBe(0);
  });

  it("answers a matching If-None-Match with 304", async () => {
    const first = await requestRaw("/assets/app.js", { "accept-encoding": "br" });
    const etag = String(first.headers.etag);

    const second = await requestRaw("/assets/app.js", { "accept-encoding": "br", "if-none-match": etag });

    expect(second.statusCode).toBe(304);
    expect(second.body.length).toBe(0);
  });

  it("does not leave the root through a traversal path", async () => {
    const outside = path.join(path.dirname(root), "outside-secret.js");
    fs.writeFileSync(outside, "secret");
    fs.writeFileSync(`${outside}.br`, brotliCompressSync("secret"));
    try {
      for (const attempt of ["/assets/..%2foutside-secret.js", "/assets/%2e%2e/outside-secret.js", "/assets/../outside-secret.js"]) {
        const response = await requestRaw(attempt, { "accept-encoding": "br" });
        expect(response.headers["content-encoding"]).toBeUndefined();
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body.toString()).not.toBe("secret");
        expect(response.body.toString()).not.toBe(brotliCompressSync("secret").toString());
      }
    } finally {
      fs.rmSync(outside, { force: true });
      fs.rmSync(`${outside}.br`, { force: true });
    }
  });

  it("survives a client that aborts in the middle of a compressed transfer", async () => {
    fs.writeFileSync(path.join(root, "big.js"), SCRIPT);
    fs.writeFileSync(path.join(root, "big.js.br"), randomBytes(16 * 1024 * 1024));
    const server = createServer(buildApp());
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const unhandled: unknown[] = [];
    const record = (error: unknown) => unhandled.push(error);
    process.on("uncaughtException", record);
    try {
      await new Promise<void>((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/assets/big.js", headers: { "accept-encoding": "br" } }, (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
          res.on("error", () => undefined);
        });
        req.on("error", () => resolve());
        req.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      process.off("uncaughtException", record);
    }

    expect(unhandled).toEqual([]);
    const after = await requestRaw("/assets/app.js", { "accept-encoding": "br" });
    expect(after.statusCode).toBe(200);
  });

  it("falls through for a malformed percent escape", async () => {
    const response = await requestRaw("/assets/%E0%A4%A.js", { "accept-encoding": "br" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });
});

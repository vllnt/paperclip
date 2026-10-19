import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRECOMPRESS_MIN_BYTES, precompressDirectory } from "./vite-precompress";

const SCRIPT = "export const answer = 42; // repeated text compresses well\n".repeat(100);

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-precompress-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("precompressDirectory", () => {
  it("writes brotli and gzip siblings that decompress to the original", async () => {
    fs.writeFileSync(path.join(directory, "index-abc.js"), SCRIPT);

    const written = await precompressDirectory(directory);

    expect(written).toBe(1);
    const brotli = fs.readFileSync(path.join(directory, "index-abc.js.br"));
    const gzipped = fs.readFileSync(path.join(directory, "index-abc.js.gz"));
    expect(brotliDecompressSync(brotli).toString()).toBe(SCRIPT);
    expect(gunzipSync(gzipped).toString()).toBe(SCRIPT);
    expect(brotli.length).toBeLessThan(Buffer.byteLength(SCRIPT));
    expect(gzipped.length).toBeLessThan(Buffer.byteLength(SCRIPT));
  });

  it("handles scripts, stylesheets, SVG and JSON, including nested folders", async () => {
    fs.mkdirSync(path.join(directory, "nested"));
    for (const name of ["a.js", "b.css", "c.svg", "d.json", "nested/e.mjs"]) {
      fs.writeFileSync(path.join(directory, name), SCRIPT);
    }

    expect(await precompressDirectory(directory)).toBe(5);
    for (const name of ["a.js", "b.css", "c.svg", "d.json", "nested/e.mjs"]) {
      expect(fs.existsSync(path.join(directory, `${name}.br`))).toBe(true);
      expect(fs.existsSync(path.join(directory, `${name}.gz`))).toBe(true);
    }
  });

  it("skips small files and file types that are already compressed", async () => {
    fs.writeFileSync(path.join(directory, "tiny.js"), "x".repeat(PRECOMPRESS_MIN_BYTES - 1));
    fs.writeFileSync(path.join(directory, "font.woff2"), SCRIPT);
    fs.writeFileSync(path.join(directory, "logo.png"), SCRIPT);

    expect(await precompressDirectory(directory)).toBe(0);
    expect(fs.readdirSync(directory).sort()).toEqual(["font.woff2", "logo.png", "tiny.js"]);
  });

  it("does not write a sibling that is not smaller than the original", async () => {
    const noise = Buffer.alloc(PRECOMPRESS_MIN_BYTES * 4);
    let state = 0x9e3779b9;
    for (let index = 0; index < noise.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      noise[index] = state >>> 24;
    }
    fs.writeFileSync(path.join(directory, "random.json"), noise);

    await precompressDirectory(directory);

    expect(fs.existsSync(path.join(directory, "random.json.br"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "random.json.gz"))).toBe(false);
  });

  it("leaves existing siblings alone on a second run and does not compress them again", async () => {
    fs.writeFileSync(path.join(directory, "app.js"), SCRIPT);
    await precompressDirectory(directory);

    expect(await precompressDirectory(directory)).toBe(1);
    expect(fs.readdirSync(directory).sort()).toEqual(["app.js", "app.js.br", "app.js.gz"]);
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "run-image-build-vitest.sh",
);

// The script ends in `exec pnpm exec vitest run <paths>`. A stub pnpm that
// prints one argument per line proves exactly what vitest would receive and
// lets a test pick the exit code vitest would return.
function withSandbox(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "image-build-vitest-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "pnpm"),
      '#!/bin/sh\nfor a in "$@"; do printf "ARG:%s\\n" "$a"; done\nexit "${STUB_PNPM_EXIT:-0}"\n',
    );
    chmodSync(path.join(bin, "pnpm"), 0o755);
    const touch = (...files) => {
      for (const file of files) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), "");
      }
    };
    const invoke = (manifestContent, env = {}) => {
      const manifest = path.join(dir, "manifest.txt");
      if (manifestContent !== null) writeFileSync(manifest, manifestContent);
      const result = spawnSync("sh", [script, manifest], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      const args = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("ARG:"))
        .map((line) => line.slice("ARG:".length));
      return { ...result, args };
    };
    return run({ dir, touch, invoke });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("passes every listed path to vitest", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts", "b/two.test.ts");
    const result = invoke("a/one.test.ts\nb/two.test.ts\n");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args, ["exec", "vitest", "run", "a/one.test.ts", "b/two.test.ts"]);
  });
});

test("keeps a last line that has no trailing newline", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts", "b/two.test.ts");
    const result = invoke("a/one.test.ts\nb/two.test.ts");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args.slice(3), ["a/one.test.ts", "b/two.test.ts"]);
  });
});

test("fails before vitest when a listed path is missing", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts");
    const result = invoke("a/one.test.ts\nb/gone.test.ts\n");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing b\/gone\.test\.ts/);
    assert.deepEqual(result.args, []);
  });
});

test("fails when the last line is a missing path without a trailing newline", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts");
    const result = invoke("a/one.test.ts\nb/gone.test.ts");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing b\/gone\.test\.ts/);
    assert.deepEqual(result.args, []);
  });
});

test("fails on an empty manifest, a newline-only manifest and an absent manifest", () => {
  withSandbox(({ invoke }) => {
    for (const content of ["", "\n\n"]) {
      const result = invoke(content);
      assert.equal(result.status, 1, JSON.stringify(content));
      assert.match(result.stderr, /no test files listed/);
      assert.deepEqual(result.args, []);
    }
    const absent = spawnSync("sh", [script, "nope.txt"], { encoding: "utf8" });
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /not found/);
  });
});

test("ignores blank lines, comment lines and CRLF line endings", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts", "b/two.test.ts");
    const result = invoke("# gate list\r\na/one.test.ts\r\n\r\n# note\r\nb/two.test.ts\r\n");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args.slice(3), ["a/one.test.ts", "b/two.test.ts"]);
  });
});

test("fails when the manifest holds only comments and blank lines", () => {
  withSandbox(({ invoke }) => {
    const result = invoke("# nothing yet\n\n");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no test files listed/);
  });
});

test("passes a path that contains a space as one argument", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/with space.test.ts", "b/two.test.ts");
    const result = invoke("a/with space.test.ts\nb/two.test.ts\n");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.args.slice(3), ["a/with space.test.ts", "b/two.test.ts"]);
  });
});

test("does not expand a glob entry", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts");
    const result = invoke("a/*.test.ts\n");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing a\/\*\.test\.ts/);
  });
});

test("returns the exit code of a failing vitest run", () => {
  withSandbox(({ touch, invoke }) => {
    touch("a/one.test.ts");
    const result = invoke("a/one.test.ts\n", { STUB_PNPM_EXIT: "7" });
    assert.equal(result.status, 7);
  });
});

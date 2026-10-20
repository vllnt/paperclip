// node --test tests/perf/backend/prod-readonly.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const script = new URL("./prod-readonly.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "prod-readonly-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** A report with one route whose 200 samples are `samples` and which also saw `failures` non-200 answers. */
function report(path, labelName, routes) {
  const out = { label: labelName, commit: "abc", n: 30, routes: {} };
  for (const [name, { samples, failures = 0 }] of Object.entries(routes)) {
    out.routes[name] = {
      path: `/api/${name}`,
      statuses: { 200: samples.length, ...(failures ? { 500: failures } : {}) },
      errors: 0,
      wireBytes: 100,
      samples: { serverMs: samples, totalMs: samples },
    };
  }
  writeFileSync(path, JSON.stringify(out));
  return path;
}

const around = (center) => Array.from({ length: 30 }, (_, i) => center + (i % 10) - 5);

describe("compare", () => {
  const beforeFile = report(join(dir, "before.json"), "before", { same: { samples: around(100) }, slow: { samples: around(100) }, failing: { samples: around(100) } });
  const afterFile = report(join(dir, "after.json"), "after", { same: { samples: around(100) }, slow: { samples: around(150) }, failing: { samples: around(100).slice(0, 20), failures: 10 } });

  it("labels a clear slowdown and an unchanged route, as a trend without A/A data", async () => {
    const { code, stdout } = await cli(["compare", beforeFile, afterFile]);
    assert.equal(code, 0);
    assert.match(stdout, /trend only/);
    assert.match(stdout, /^slow\s+p50 .* slower$/m);
    assert.match(stdout, /^same\s+p50 .* no clear change$/m);
  });

  it("reads a change only beyond the A/A noise when an A/A pair is given", async () => {
    const aa1 = report(join(dir, "aa1.json"), "aa1", { same: { samples: around(100) }, slow: { samples: around(100) }, failing: { samples: around(100) } });
    const aa2 = report(join(dir, "aa2.json"), "aa2", { same: { samples: around(100) }, slow: { samples: around(160) }, failing: { samples: around(100) } });
    const { stdout } = await cli(["compare", beforeFile, afterFile, "--aa", `${aa1},${aa2}`]);
    assert.match(stdout, /^slow\s+p50 .* within A\/A noise$/m);
  });

  it("flags a route that fails more often", async () => {
    const { stdout } = await cli(["compare", beforeFile, afterFile]);
    assert.match(stdout, /^failing\s+non-200\s+0\/30\s+10\/30 .*MORE FAILURES$/m);
  });
});

describe("run", () => {
  let server;
  let base;
  const seen = [];
  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      const body = Buffer.from(JSON.stringify({ status: "ok", commit: "abc123", pad: "x".repeat(2000) }));
      const gzip = /gzip/.test(String(req.headers["accept-encoding"]));
      if (req.headers["if-none-match"] === "\"v1\"") { res.writeHead(304).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json", ETag: "\"v1\"", ...(gzip ? { "Content-Encoding": "gzip" } : {}) });
      res.end(gzip ? gzipSync(body) : body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it("sends only GET, keeps route templates in the report and never writes the key", async () => {
    const out = join(dir, "run.json");
    const { code, stdout } = await cli(
      ["run", "--company-id", "company-secret-id", "--issue", "ISSUE-1", "--n", "2", "--gap-ms", "0", "--only", "dashboard,issue-by-id", "--out", out],
      { PAPERCLIP_API_URL: base, PAPERCLIP_API_KEY: "test-key-value" },
    );
    assert.equal(code, 0);
    const text = readFileSync(out, "utf8");
    const data = JSON.parse(text);
    assert.ok(seen.length > 0 && seen.every((r) => r.method === "GET" && r.auth === "Bearer test-key-value"));
    assert.ok(seen.some((r) => r.url === "/api/companies/company-secret-id/dashboard"));
    assert.equal(data.routes.dashboard.path, "/api/companies/{c}/dashboard");
    assert.equal(data.routes["issue-by-id"].path, "/api/issues/{i}");
    assert.equal(data.acceptEncoding, "gzip");
    assert.equal(data.routes.dashboard.contentEncoding, "gzip");
    assert.equal(data.routes.dashboard.conditionalStatus, 304);
    assert.equal(data.routes.dashboard.samples.serverMs.length, 2);
    for (const secret of ["test-key-value", "company-secret-id", "ISSUE-1"]) {
      assert.ok(!text.includes(secret) && !stdout.includes(secret), `${secret} leaked`);
    }
  });

  it("rejects a bad --n before it sends anything", async () => {
    const count = seen.length;
    const { code, stderr } = await cli(["run", "--company-id", "c", "--n", "abc"], { PAPERCLIP_API_URL: base, PAPERCLIP_API_KEY: "k" });
    assert.notEqual(code, 0);
    assert.match(stderr, /--n must be an integer of at least 1/);
    assert.equal(seen.length, count);
  });
});

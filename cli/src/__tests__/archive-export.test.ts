import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerArchiveCommands } from "../commands/client/archive.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerArchiveCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function line(kind: string, data: Record<string, unknown>, runId?: string) {
  return JSON.stringify({ kind, v: 1, companyId: COMPANY_ID, ...(runId ? { runId } : {}), data });
}

function ndjson(lines: string[]): Response {
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

describe("archive export command", () => {
  let dir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-archive-export-cli-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("follows next cursors and writes one header and one final end", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjson([
        line("export.header", { page: 1 }),
        line("run", { id: "run-1" }, "run-1"),
        line("run.end", { cursor: "c1" }, "run-1"),
        line("export.end", { runs: 1, next: "c1" }),
      ]))
      .mockResolvedValueOnce(ndjson([
        line("export.header", { page: 2 }),
        line("run", { id: "run-2" }, "run-2"),
        line("run.end", { cursor: "c2" }, "run-2"),
        line("export.end", { runs: 1, next: null, resumeCursor: "c2" }),
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const out = path.join(dir, "export.ndjson");

    await run(["archive", "export", "-C", COMPANY_ID, "--include", "run,events", "--limit", "1", "-o", out]);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `http://localhost:3100/api/companies/${COMPANY_ID}/archive/export?include=run%2Cevents&limit=1`,
      `http://localhost:3100/api/companies/${COMPANY_ID}/archive/export?cursor=c1&include=run%2Cevents&limit=1`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ accept: "application/x-ndjson" });
    const kinds = readFileSync(out, "utf8").trim().split("\n").map((entry) => JSON.parse(entry).kind);
    expect(kinds).toEqual(["export.header", "run", "run.end", "run", "run.end", "export.end"]);
  });

  it("resumes after the last complete run and drops a torn tail", async () => {
    const out = path.join(dir, "resume.ndjson");
    writeFileSync(out, [
      line("export.header", { include: ["run", "events"], since: null, requestedUntil: "2026-09-30T00:00:00.000Z" }),
      line("run", { id: "run-1" }, "run-1"),
      line("run.end", { cursor: "c1" }, "run-1"),
      line("run", { id: "run-2" }, "run-2"),
      "{\"kind\":\"run_event\",\"v\":1,\"data\":{\"seq\":",
    ].join("\n"));
    const fetchMock = vi.fn().mockResolvedValueOnce(ndjson([
      line("export.header", {}),
      line("run", { id: "run-2" }, "run-2"),
      line("run.end", { cursor: "c2" }, "run-2"),
      line("export.end", { runs: 1, next: null }),
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await run(["archive", "export", "-C", COMPANY_ID, "-o", out, "--resume"]);

    // Resume keeps the original --include and --until from the file header.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/archive/export?cursor=c1&until=2026-09-30T00%3A00%3A00.000Z&include=run%2Cevents`,
    );
    const records = readFileSync(out, "utf8").trim().split("\n").map((entry) => JSON.parse(entry));
    expect(records.map((record) => [record.kind, record.runId ?? null])).toEqual([
      ["export.header", null],
      ["run", "run-1"],
      ["run.end", "run-1"],
      ["run", "run-2"],
      ["run.end", "run-2"],
      ["export.end", null],
    ]);
  });

  it("refuses to resume a file exported with other options", async () => {
    const out = path.join(dir, "other.ndjson");
    writeFileSync(out, `${line("export.header", { include: ["run"], since: null })}\n${line("run.end", { cursor: "c1" }, "run-1")}\n`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(run(["archive", "export", "-C", COMPANY_ID, "-o", out, "--resume", "--include", "run,transcript"]))
      .rejects.toThrow("exit");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("other --include/--since/--until");
  });

  it("refuses to resume with a different --until", async () => {
    const out = path.join(dir, "until.ndjson");
    writeFileSync(out, `${line("export.header", { include: ["run"], since: null, requestedUntil: "2026-09-30T00:00:00.000Z" })}\n${line("run.end", { cursor: "c1" }, "run-1")}\n`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { errors } = captureFailure();

    await expect(run(["archive", "export", "-C", COMPANY_ID, "-o", out, "--resume", "--until", "2026-10-05T00:00:00Z"]))
      .rejects.toThrow("exit");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--until");
  });

  function captureFailure() {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    return { errors, exit };
  }

  it("reports a reset connection with the resume hint and keeps complete runs", async () => {
    const out = path.join(dir, "reset.ndjson");
    const encoder = new TextEncoder();
    let pulls = 0;
    // First read delivers one complete run, the next read fails like a reset.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode(`${[
            line("export.header", { include: ["run"], since: null }),
            line("run", { id: "run-1" }, "run-1"),
            line("run.end", { cursor: "c1" }, "run-1"),
          ].join("\n")}\n`));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new TypeError("terminated"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(body, { status: 200 })));
    const { errors, exit } = captureFailure();

    await expect(run(["archive", "export", "-C", COMPANY_ID, "-o", out])).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("--resume");
    expect(readFileSync(out, "utf8")).toContain("\"run.end\"");
  });

  it("reports an unwritable output path instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ndjson([
      line("export.header", {}),
      line("export.end", { runs: 0, next: null }),
    ])));
    const { errors, exit } = captureFailure();

    await expect(run(["archive", "export", "-C", COMPANY_ID, "-o", path.join(dir, "missing", "x.ndjson")]))
      .rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("ENOENT");
  });

  it("leaves an existing file untouched when the request fails, and resumes an empty file from scratch", async () => {
    const kept = path.join(dir, "kept.ndjson");
    writeFileSync(kept, "previous export\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    captureFailure();
    await expect(run(["archive", "export", "-C", COMPANY_ID, "-o", kept])).rejects.toThrow("exit");
    expect(readFileSync(kept, "utf8")).toBe("previous export\n");

    vi.restoreAllMocks();
    const empty = path.join(dir, "empty.ndjson");
    writeFileSync(empty, "");
    const fetchMock = vi.fn().mockResolvedValueOnce(ndjson([
      line("export.header", {}),
      line("export.end", { runs: 0, next: null }),
    ]));
    vi.stubGlobal("fetch", fetchMock);
    await run(["archive", "export", "-C", COMPANY_ID, "-o", empty, "--resume"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/archive/export`);
    expect(readFileSync(empty, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("fails when the stream ends without export.end and keeps the written runs", async () => {
    const out = path.join(dir, "cut.ndjson");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ndjson([
      line("export.header", {}),
      line("run", { id: "run-1" }, "run-1"),
      line("run.end", { cursor: "c1" }, "run-1"),
    ])));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(run(["archive", "export", "-C", COMPANY_ID, "-o", out])).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("--resume");
    expect(readFileSync(out, "utf8")).toContain("\"run.end\"");
  });
});

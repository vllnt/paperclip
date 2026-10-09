import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStorageCommands } from "../commands/client/storage.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const DESTINATION_ID = "33333333-3333-4333-8333-333333333333";
const ACCESS = "44444444-4444-4444-8444-444444444444";
const SECRET = "55555555-5555-4555-8555-555555555555";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerStorageCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token", "--json"], { from: "user" });
}

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("storage destinations commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  it("wraps every destination endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ status: "passed" })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["storage", "destinations", "list", "-C", COMPANY_ID]);
    await run([
      "storage", "destinations", "create", "-C", COMPANY_ID, "--id", DESTINATION_ID, "--label", "Archive",
      "--endpoint", "https://s3.eu-west-1.amazonaws.com", "--region", "eu-west-1", "--bucket", "acme-archive",
      "--prefix", "paperclip", "--encryption", "kms", "--kms-key-id", "alias/archive",
      "--access-key-secret", ACCESS, "--secret-key-secret", SECRET,
    ]);
    await run(["storage", "destinations", "probe", DESTINATION_ID, "-C", COMPANY_ID]);
    await run([
      "storage", "destinations", "rotate-credentials", DESTINATION_ID, "-C", COMPANY_ID,
      "--access-key-secret", ACCESS, "--secret-key-secret", SECRET, "--expected-credential-revision", "2",
    ]);
    await run(["storage", "destinations", "retire", DESTINATION_ID, "-C", COMPANY_ID, "--expected-revision", "3"]);

    const base = `http://localhost:3100/api/companies/${COMPANY_ID}/storage/destinations`;
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", base],
      ["POST", base],
      ["POST", `${base}/${DESTINATION_ID}/probe`],
      ["PATCH", `${base}/${DESTINATION_ID}/credentials`],
      ["POST", `${base}/${DESTINATION_ID}/retire`],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      id: DESTINATION_ID,
      label: "Archive",
      location: {
        endpoint: "https://s3.eu-west-1.amazonaws.com/",
        region: "eu-west-1",
        bucket: "acme-archive",
        prefix: "paperclip",
        forcePathStyle: false,
        encryption: { mode: "kms", kmsKeyId: "alias/archive" },
      },
      credentials: { accessKeySecretId: ACCESS, secretKeySecretId: SECRET },
    });
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toMatchObject({ expectedCredentialRevision: 2 });
    expect(JSON.parse(fetchMock.mock.calls[4]![1].body)).toEqual({ expectedRevision: 3 });
  });

  it("exits non-zero when a probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "failed", errorCode: "access_denied" })));
    await run(["storage", "destinations", "probe", DESTINATION_ID, "-C", COMPANY_ID]);
    expect(process.exitCode).toBe(1);
  });
});

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentResourceCapacity } from "@paperclipai/shared";
import { registerCapacityCommands } from "../commands/client/capacity.js";
import { registerWorkspaceCommands } from "../commands/client/workspace.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ENV_ID = "88888888-8888-4888-8888-888888888888";
const GIB = 1024 ** 3;

const ENVIRONMENT: EnvironmentResourceCapacity = {
  environmentId: ENV_ID,
  environmentName: "worker-a",
  driver: "ssh",
  sampling: "sampled",
  level: "critical",
  metricLevels: { "disk:workspaces": "critical", memory: "ok", load: "ok" },
  sampledAt: "2026-10-09T11:58:00.000Z",
  lastSuccessAt: "2026-10-09T11:58:00.000Z",
  readingStatus: "ok",
  cpuCount: 8,
  load1: 1,
  load5: 2,
  load15: 3,
  loadPerCore: 0.25,
  memTotalBytes: 16 * GIB,
  memAvailableBytes: 8 * GIB,
  disks: [{ labels: ["workspaces"], totalBytes: 100 * GIB, freeBytes: 3 * GIB, freePercent: 3 }],
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCapacityCommands(program);
  registerWorkspaceCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], {
    from: "user",
  });
}

describe("resource capacity commands", () => {
  let lines: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the company, instance and environment capacity routes", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/api/instance/resource-capacity")
              ? { generatedAt: "", hosts: [], environments: [ENVIRONMENT] }
              : url.includes("/api/environments/")
                ? { generatedAt: "", environment: ENVIRONMENT }
                : { generatedAt: "", companyId: COMPANY_ID, environments: [ENVIRONMENT] },
          ),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["capacity", "--company-id", COMPANY_ID]);
    await run(["capacity", "--instance"]);
    await run(["environment", "capacity", ENV_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/resource-capacity`],
      ["GET", "http://localhost:3100/api/instance/resource-capacity"],
      ["GET", `http://localhost:3100/api/environments/${ENV_ID}/resource-capacity`],
    ]);
    expect(lines.filter((line) => line.includes("worker-a"))).toHaveLength(3);
    expect(lines.find((line) => line.includes("worker-a"))).toContain("CRITICAL");
    expect(lines.find((line) => line.includes("worker-a"))).toContain(
      "disk workspaces 3.0 GiB free (3%) · memory 8.0 GiB of 16.0 GiB available · load 0.25/core",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.ts";
import {
  probePluginEnvironmentDriver,
  probePluginSandboxProviderDriver,
  validatePluginEnvironmentDriverConfig,
  validatePluginSandboxProviderConfig,
} from "../services/plugin-environment-driver.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import type { Db } from "@paperclipai/db";

const mockList = vi.fn();
const mockGetByKey = vi.fn();

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    list: mockList,
    getByKey: mockGetByKey,
  }),
}));

const PLUGIN_ID = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "11111111-1111-1111-1111-111111111111";

function seedProviderPlugin() {
  const plugin = {
    id: PLUGIN_ID,
    pluginKey: "acme.secure-sandbox-provider",
    status: "ready",
    manifestJson: {
      environmentDrivers: [
        {
          driverKey: "secure-plugin",
          kind: "sandbox_provider",
          displayName: "Secure Sandbox",
          configSchema: {
            type: "object",
            properties: {
              template: { type: "string" },
              apiKey: { type: "string", format: "secret-ref" },
              tokens: { type: "array", items: { type: "string", format: "secret-ref" } },
              timeoutMs: { type: "number" },
            },
          },
        },
      ],
    },
  };
  mockList.mockResolvedValue([plugin]);
  mockGetByKey.mockResolvedValue(plugin);
}

function createWorkerManager() {
  return {
    isRunning: vi.fn(() => true),
    call: vi.fn(async (_pluginId: string, _method: string, params: { config: Record<string, unknown> }) => ({
      ok: true,
      normalizedConfig: { ...params.config },
    })),
  } as unknown as PluginWorkerManager & { call: ReturnType<typeof vi.fn> };
}

describe("validatePluginSandboxProviderConfig secret-ref bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedProviderPlugin();
  });

  it("canonicalizes secret_ref binding objects to bare secret ids before the plugin validates", async () => {
    const workerManager = createWorkerManager();

    const result = await validatePluginSandboxProviderConfig({
      db: {} as Db,
      workerManager,
      provider: "secure-plugin",
      config: {
        template: "base",
        apiKey: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
        timeoutMs: 1234,
      },
    });

    expect(workerManager.call).toHaveBeenCalledWith(PLUGIN_ID, "environmentValidateConfig", {
      driverKey: "secure-plugin",
      config: {
        template: "base",
        apiKey: SECRET_ID,
        timeoutMs: 1234,
      },
    });
    expect(result.normalizedConfig.apiKey).toBe(SECRET_ID);
  });

  it("rejects pinned secret binding versions before calling the plugin", async () => {
    const workerManager = createWorkerManager();

    await expect(validatePluginSandboxProviderConfig({
      db: {} as Db,
      workerManager,
      provider: "secure-plugin",
      config: {
        apiKey: { type: "secret_ref", secretId: SECRET_ID, version: 3 },
      },
    })).rejects.toThrow(/pins version 3/);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("passes raw strings and bare secret ids through untouched", async () => {
    const workerManager = createWorkerManager();

    await validatePluginSandboxProviderConfig({
      db: {} as Db,
      workerManager,
      provider: "secure-plugin",
      config: {
        template: "base",
        apiKey: "raw-provider-key",
      },
    });

    expect(workerManager.call).toHaveBeenCalledWith(PLUGIN_ID, "environmentValidateConfig", {
      driverKey: "secure-plugin",
      config: {
        template: "base",
        apiKey: "raw-provider-key",
      },
    });
  });
});

describe("provider-controlled output is not returned to the caller", () => {
  // The server never sees a resolved secret: the plugin resolves it. So text a
  // provider returns can carry one, and must not reach the API response.
  const RESOLVED = "resolved-provider-token-9f3a";
  const pluginConfig = {
    pluginKey: "acme.secure-sandbox-provider",
    driverKey: "secure-plugin",
    driverConfig: { template: "base" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seedProviderPlugin();
  });

  function workerManagerReturning(result: unknown) {
    return {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => result),
    } as unknown as PluginWorkerManager & { call: ReturnType<typeof vi.fn> };
  }

  const echoingValidationFailure = {
    ok: false,
    errors: [`apiKey ${RESOLVED} was rejected`, "second error"],
    warnings: [`check ${RESOLVED}`],
  };

  async function expectSafeValidationRejection(attempt: Promise<unknown>) {
    const error = await attempt.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    const rejection = error as HttpError;
    expect(rejection.status).toBe(422);
    expect(rejection.message).toMatch(/rejected its config/);
    expect(JSON.stringify({ message: rejection.message, details: rejection.details })).not.toContain(RESOLVED);
  }

  it("withholds provider validation errors and warnings for a sandbox provider", async () => {
    await expectSafeValidationRejection(
      validatePluginSandboxProviderConfig({
        db: {} as Db,
        workerManager: workerManagerReturning(echoingValidationFailure),
        provider: "secure-plugin",
        config: { template: "base" },
      }),
    );
  });

  it("withholds provider validation errors and warnings for a plugin environment driver", async () => {
    await expectSafeValidationRejection(
      validatePluginEnvironmentDriverConfig({
        db: {} as Db,
        workerManager: workerManagerReturning(echoingValidationFailure),
        config: pluginConfig,
      }),
    );
  });

  const echoingProbe = {
    ok: true,
    summary: `connected with ${RESOLVED}`,
    diagnostics: [
      { severity: "error", message: `token ${RESOLVED}`, code: RESOLVED, details: { token: RESOLVED } },
      { severity: "not-a-severity", message: RESOLVED },
    ],
    metadata: { region: "us-east", apiKey: RESOLVED, tokens: [RESOLVED, RESOLVED] },
  };

  function expectSafeProbeDetails(result: Awaited<ReturnType<typeof probePluginSandboxProviderDriver>>) {
    expect(JSON.stringify(result)).not.toContain(RESOLVED);
    expect(result.ok).toBe(true);
    const details = result.details as { diagnostics: unknown[]; metadata: unknown };
    expect(details.metadata).toEqual({ region: "us-east" });
    expect(details.diagnostics).toEqual([
      { severity: "error", message: expect.any(String) },
      { severity: "info", message: expect.any(String) },
    ]);
  }

  it("redacts probe summary, diagnostics and metadata for a sandbox provider", async () => {
    const result = await probePluginSandboxProviderDriver({
      db: {} as Db,
      workerManager: workerManagerReturning(echoingProbe),
      companyId: "company-1",
      environmentId: "environment-1",
      provider: "secure-plugin",
      config: { provider: "secure-plugin", template: "base" },
    });
    expectSafeProbeDetails(result);
    expect(result.summary).toBe('Sandbox provider "secure-plugin" probe passed.');
  });

  it("redacts probe summary, diagnostics and metadata for a plugin environment driver", async () => {
    const result = await probePluginEnvironmentDriver({
      db: {} as Db,
      workerManager: workerManagerReturning(echoingProbe),
      companyId: "company-1",
      environmentId: "environment-1",
      config: pluginConfig,
    });
    expectSafeProbeDetails(result);
    expect(result.summary).toMatch(/probe passed\./);
  });
});

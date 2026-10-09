import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.ts";
import { normalizeEnvironmentConfigForPersistence } from "../services/environment-config.ts";
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

  function lazyList(length: number): { list: unknown[]; reads: { count: number } } {
    const reads = { count: 0 };
    const isIndex = (property: string | symbol): property is string =>
      typeof property === "string" && /^\d+$/.test(property);
    const list = new Proxy<unknown[]>([], {
      get(target, property, receiver) {
        if (property === "length") return length;
        if (isIndex(property)) {
          reads.count += 1;
          return null;
        }
        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        return isIndex(property) ? Number(property) < length : Reflect.has(target, property);
      },
    });
    return { list, reads };
  }

  function readDiagnostics(result: Awaited<ReturnType<typeof probePluginSandboxProviderDriver>>): unknown[] {
    const diagnostics = result.details?.diagnostics;
    return Array.isArray(diagnostics) ? diagnostics : [];
  }

  async function probeSandboxWith(diagnostics: unknown) {
    return await probePluginSandboxProviderDriver({
      db: {} as Db,
      workerManager: workerManagerReturning({ ok: true, diagnostics }),
      companyId: "company-1",
      environmentId: "environment-1",
      provider: "secure-plugin",
      config: { provider: "secure-plugin" },
    });
  }

  async function probeGenericWith(diagnostics: unknown) {
    return await probePluginEnvironmentDriver({
      db: {} as Db,
      workerManager: workerManagerReturning({ ok: true, diagnostics }),
      companyId: "company-1",
      environmentId: "environment-1",
      config: pluginConfig,
    });
  }

  it.each([
    ["sandbox provider", probeSandboxWith],
    ["plugin environment driver", probeGenericWith],
  ])("keeps 50 diagnostics and one marker for a million, and reads only the first 50, for a %s", async (_name, probe) => {
    const { list, reads } = lazyList(1_000_000);

    const diagnostics = readDiagnostics(await probe(list));

    expect(diagnostics).toHaveLength(51);
    expect(diagnostics[0]).toEqual({ severity: "info", message: expect.any(String) });
    expect(diagnostics[50]).toEqual({
      severity: "warning",
      message: expect.any(String),
      code: "diagnostics_truncated",
      omitted: 999_950,
    });
    expect(reads.count).toBeLessThanOrEqual(50);
  });

  it("adds a marker only when more than 50 diagnostics arrive", async () => {
    expect(readDiagnostics(await probeSandboxWith(new Array(50).fill(null)))).toHaveLength(50);

    const diagnostics = readDiagnostics(await probeSandboxWith(new Array(51).fill(null)));
    expect(diagnostics).toHaveLength(51);
    expect(diagnostics[50]).toMatchObject({ code: "diagnostics_truncated", omitted: 1 });
  });

  function deeplyNested(depth: number): unknown {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) value = { child: value };
    return value;
  }

  it("withholds probe metadata that is nested too deeply to check, without throwing", async () => {
    const result = await probePluginSandboxProviderDriver({
      db: {} as Db,
      workerManager: workerManagerReturning({ ok: true, metadata: { deep: deeplyNested(10_000) } }),
      companyId: "company-1",
      environmentId: "environment-1",
      provider: "secure-plugin",
      config: { provider: "secure-plugin" },
    });
    expect(result.ok).toBe(true);
    expect((result.details as { metadata: unknown }).metadata).toEqual({ withheld: expect.any(String) });

    const generic = await probePluginEnvironmentDriver({
      db: {} as Db,
      workerManager: workerManagerReturning({ ok: true, metadata: { deep: deeplyNested(10_000) } }),
      companyId: "company-1",
      environmentId: "environment-1",
      config: pluginConfig,
    });
    expect((generic.details as { metadata: unknown }).metadata).toEqual({ withheld: expect.any(String) });
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

describe("a provider's normalizedConfig keeps the caller's secret references", () => {
  // `driver: "plugin"` stores the provider's normalizedConfig as the environment
  // config, and the API returns it. A declared secret-ref field holds the caller's
  // secret id, so the provider may normalize other fields but not those values.
  const RESOLVED = "resolved-provider-token-9f3a";
  const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const callerDriverConfig = { template: "Base", apiKey: SECRET_ID, tokens: [ID_A, ID_B] };
  const pluginConfig = {
    pluginKey: "acme.secure-sandbox-provider",
    driverKey: "secure-plugin",
    driverConfig: callerDriverConfig,
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

  function validate(result: unknown, config = pluginConfig) {
    return validatePluginEnvironmentDriverConfig({ db: {} as Db, workerManager: workerManagerReturning(result), config });
  }

  async function expectRejectedWithoutEcho(attempt: Promise<unknown>) {
    const error = await attempt.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect(JSON.stringify({ message: (error as HttpError).message, details: (error as HttpError).details })).not.toContain(
      RESOLVED,
    );
  }

  it("keeps a normalization of non-secret fields and the same secret references in any order", async () => {
    const normalizedConfig = { template: "base", apiKey: SECRET_ID, tokens: [ID_B, ID_A], timeoutMs: 30_000 };
    const result = await validate({ ok: true, normalizedConfig });
    expect(result.driverConfig).toEqual(normalizedConfig);
  });

  it("falls back to the caller's config when the provider returns no normalizedConfig", async () => {
    const result = await validate({ ok: true });
    expect(result.driverConfig).toEqual(callerDriverConfig);
  });

  it("rejects a resolved value in place of a secret reference", async () => {
    await expectRejectedWithoutEcho(
      validate({ ok: true, normalizedConfig: { ...callerDriverConfig, apiKey: RESOLVED } }),
    );
  });

  it("rejects a resolved value added to a declared secret array", async () => {
    await expectRejectedWithoutEcho(
      validate({ ok: true, normalizedConfig: { ...callerDriverConfig, tokens: [ID_A, ID_B, RESOLVED] } }),
    );
  });

  it("rejects a resolved value in a declared field that the caller left empty", async () => {
    await expectRejectedWithoutEcho(
      validate(
        { ok: true, normalizedConfig: { template: "Base", apiKey: RESOLVED } },
        { ...pluginConfig, driverConfig: { template: "Base" } },
      ),
    );
  });

  it("rejects a normalizedConfig nested too deeply to check, without throwing a RangeError", async () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < 10_000; level += 1) deep = { child: deep };
    await expectRejectedWithoutEcho(validate({ ok: true, normalizedConfig: { ...callerDriverConfig, deep } }));
  });

  it("does not persist or return a resolved value through the environment persistence entry", async () => {
    const persist = (result: unknown) =>
      normalizeEnvironmentConfigForPersistence({
        db: {} as Db,
        companyId: "company-1",
        environmentName: "Plugin environment",
        driver: "plugin",
        secretProvider: "local_encrypted",
        config: pluginConfig,
        pluginWorkerManager: workerManagerReturning(result),
      });

    await expectRejectedWithoutEcho(
      persist({ ok: true, normalizedConfig: { ...callerDriverConfig, apiKey: RESOLVED } }),
    );
    await expect(persist({ ok: true, normalizedConfig: callerDriverConfig })).resolves.toEqual({
      ...pluginConfig,
      driverConfig: callerDriverConfig,
    });
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { createCompanySecretKeyResolver } from "../services/duplicate-detection-factory.js";
import {
  JUDGE_API_KEY_SECRET_NAME,
  createJudgeClient,
  type JudgeConfig,
  type JudgeTransport,
} from "../services/judge-client.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const config: JudgeConfig = { timeoutMs: 2_000, dailyCallCap: 100, zeroDataRetention: false };

describeEmbeddedPostgres("duplicate detection gateway keys come from company secrets", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-duplicate-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("paperclip-duplicate-secrets-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
    if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${name} ${companyId}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function giveGatewayKey(companyId: string, value: string, name = JUDGE_API_KEY_SECRET_NAME) {
    return secretService(db).create(companyId, { name, provider: "local_encrypted", value });
  }

  function recordingTransports() {
    const used = new Map<string, JudgeTransport>();
    const transportFor = vi.fn((apiKey: string) => {
      const transport: JudgeTransport = vi.fn(async () => ({
        answers: { same_outcome: { type: "boolean" as const, probability: 0.5 } },
        modelId: "typesafe-ai/jev-1.2",
        confidence: {},
      }));
      used.set(apiKey, transport);
      return transport;
    });
    return { used, transportFor };
  }

  const question = {
    same_outcome: { type: "predicate" as const, instructions: "Same result?" },
  };

  function ask(client: ReturnType<typeof createJudgeClient>, companyId: string) {
    return client.ask({
      companyId,
      rubricVersion: "v1",
      state: { new_issue: { title: "A" }, existing_issue: { title: "B" } },
      questions: question,
    });
  }

  it("resolves the secret of the asking company and nobody else's", async () => {
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    await giveGatewayKey(a, "gateway-key-for-A");
    await giveGatewayKey(b, "gateway-key-for-B");
    const resolve = createCompanySecretKeyResolver(db);

    expect(await resolve(a)).toBe("gateway-key-for-A");
    expect(await resolve(b)).toBe("gateway-key-for-B");
  });

  it("treats a company without the secret as having no key, whatever other companies hold", async () => {
    const withKey = await seedCompany("With");
    const without = await seedCompany("Without");
    await giveGatewayKey(withKey, "gateway-key-for-With");

    expect(await createCompanySecretKeyResolver(db)(without)).toBeUndefined();
  });

  it("ignores the process environment: a server-wide key does not stand in for a company secret", async () => {
    process.env.AI_GATEWAY_API_KEY = "process-wide-key-must-not-be-used";
    const company = await seedCompany("Env only");
    const { used, transportFor } = recordingTransports();
    const client = createJudgeClient({
      config,
      usage: { reserve: async () => true },
      resolveApiKey: createCompanySecretKeyResolver(db),
      transportFor,
    });

    expect(await ask(client, company)).toMatchObject({ ok: false, reason: "no_key" });
    expect(transportFor).not.toHaveBeenCalled();
    expect(used.size).toBe(0);
  });

  it("uses each company's own key end to end and skips the company without one", async () => {
    const a = await seedCompany("A");
    const b = await seedCompany("B");
    const c = await seedCompany("C");
    await giveGatewayKey(a, "gateway-key-for-A");
    await giveGatewayKey(b, "gateway-key-for-B");
    const { used, transportFor } = recordingTransports();
    const client = createJudgeClient({
      config,
      usage: { reserve: async () => true },
      resolveApiKey: createCompanySecretKeyResolver(db),
      transportFor,
    });

    expect((await ask(client, a)).ok).toBe(true);
    expect((await ask(client, b)).ok).toBe(true);
    expect(await ask(client, c)).toMatchObject({ ok: false, reason: "no_key" });

    expect([...used.keys()].sort()).toEqual(["gateway-key-for-A", "gateway-key-for-B"]);
    expect(used.get("gateway-key-for-A")).toHaveBeenCalledTimes(1);
    expect(used.get("gateway-key-for-B")).toHaveBeenCalledTimes(1);
  });

  it("stops serving a company once its secret is deleted", async () => {
    const company = await seedCompany("Revoked");
    const secret = await giveGatewayKey(company, "gateway-key-for-Revoked");
    const resolve = createCompanySecretKeyResolver(db);
    expect(await resolve(company)).toBe("gateway-key-for-Revoked");

    await db.update(companySecrets).set({ status: "deleted" }).where(eq(companySecrets.id, secret.id));

    expect(await resolve(company)).toBeUndefined();
  });

  it("does not accept a secret with a different name", async () => {
    const company = await seedCompany("Wrong name");
    await giveGatewayKey(company, "some-other-key", "SOME_OTHER_KEY");
    expect(await createCompanySecretKeyResolver(db)(company)).toBeUndefined();
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
  storageDestinations,
} from "@paperclipai/db";
import type { CreateStorageDestination, StorageS3Location } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { companyStorageRoutes } from "../routes/company-storage.js";
import { secretService } from "../services/secrets.js";
import { storageDestinationService, type StorageDestinationDeps } from "../services/storage-destinations.js";
import type { StorageProvider } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOARD = { actorType: "user" as const, actorId: "board-user-1" };

interface FakeBucketOptions {
  failPut?: string;
  failDelete?: boolean;
  serverSideEncryption?: string;
  /** Deny writes whose prefix differs from the destination's prefix. */
  scopedTo?: string;
}

/** In-memory S3 stand-in keyed by the full object key, prefix included. */
function fakeBucket(options: FakeBucketOptions = {}) {
  const objects = new Map<string, Buffer>();
  const seenCredentials: Array<{ accessKeyId: string; secretAccessKey: string }> = [];
  const factory: NonNullable<StorageDestinationDeps["providerFactory"]> = async ({ location, credentials }) => {
    seenCredentials.push(credentials);
    const full = (key: string) => [location.prefix, key].filter(Boolean).join("/");
    const fail = (name: string) => Object.assign(new Error(name), { name });
    const provider: StorageProvider = {
      id: "s3",
      async putObject(input) {
        if (options.failPut) throw fail(options.failPut);
        if (options.scopedTo !== undefined && location.prefix !== options.scopedTo) throw fail("AccessDenied");
        const body = Buffer.isBuffer(input.body) ? input.body : Buffer.alloc(0);
        objects.set(full(input.objectKey), body);
      },
      async headObject(input) {
        const body = objects.get(full(input.objectKey));
        return body
          ? { exists: true, contentLength: body.length, serverSideEncryption: options.serverSideEncryption }
          : { exists: false };
      },
      async getObject(input) {
        const body = objects.get(full(input.objectKey));
        if (!body) throw fail("NoSuchKey");
        return { stream: Readable.from([body]), contentLength: body.length };
      },
      async deleteObject(input) {
        if (options.failDelete) throw fail("AccessDenied");
        objects.delete(full(input.objectKey));
      },
    };
    return provider;
  };
  return { objects, seenCredentials, factory };
}

describeEmbeddedPostgres("company storage destinations", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousOrigins = process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS;
  const tmpDir = path.join(os.tmpdir(), `paperclip-storage-destinations-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("company-storage-destinations");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS;
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(storageDestinations);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousOrigins === undefined) delete process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS;
    else process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS = previousOrigins;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany(label: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Storage ${label}`,
      issuePrefix: `S${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    const secrets = secretService(db);
    const accessKey = await secrets.create(companyId, { name: `${label} access key`, provider: "local_encrypted", value: `AKIA-${label}` });
    const secretKey = await secrets.create(companyId, { name: `${label} secret key`, provider: "local_encrypted", value: `secret-${label}` });
    return { companyId, accessKeyId: accessKey.id, secretKeyId: secretKey.id };
  }

  function location(overrides: Partial<StorageS3Location> = {}): StorageS3Location {
    return {
      endpoint: "https://s3.example.com/",
      region: "us-east-1",
      bucket: "acme-archive",
      prefix: "paperclip",
      forcePathStyle: false,
      encryption: { mode: "s3_managed" },
      ...overrides,
    };
  }

  function createInput(company: Awaited<ReturnType<typeof seedCompany>>, overrides: Partial<CreateStorageDestination> = {}): CreateStorageDestination {
    return {
      id: randomUUID(),
      label: "Archive bucket",
      location: location(),
      credentials: { accessKeySecretId: company.accessKeyId, secretKeySecretId: company.secretKeyId },
      ...overrides,
    };
  }

  it("creates a destination with pinned secret references and secret bindings", async () => {
    const company = await seedCompany("create");
    const service = storageDestinationService(db);
    const input = createInput(company);
    const { destination, created } = await service.create(company.companyId, input, BOARD);
    expect(created).toBe(true);
    expect(destination).toMatchObject({
      id: input.id,
      companyId: company.companyId,
      provider: "s3",
      origin: "company",
      credentials: { accessKeySecretId: company.accessKeyId, accessKeyVersion: 1, secretKeyVersion: 1 },
      revision: 0,
      credentialRevision: 0,
      lastProbe: null,
      retiredAt: null,
    });
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, input.id));
    expect(bindings.map((binding) => [binding.targetType, binding.configPath, binding.versionSelector]).sort()).toEqual([
      ["storage_destination", "credentials.accessKeyId", "1"],
      ["storage_destination", "credentials.secretAccessKey", "1"],
    ]);
    expect(await db.select().from(activityLog)).toEqual([
      expect.objectContaining({ action: "storage.destination_created", entityId: input.id, details: expect.objectContaining({ bucket: "acme-archive", encryptionMode: "s3_managed" }) }),
    ]);
  });

  it("is idempotent on the client id and refuses a different payload under it", async () => {
    const company = await seedCompany("idempotent");
    const service = storageDestinationService(db);
    const input = createInput(company);
    await service.create(company.companyId, input, BOARD);
    const retry = await service.create(company.companyId, input, BOARD);
    expect(retry.created).toBe(false);
    await expect(service.create(company.companyId, { ...input, label: "Other" }, BOARD)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(storageDestinations)).toHaveLength(1);
  });

  it("refuses another company's secrets and another company's bucket", async () => {
    const owner = await seedCompany("owner");
    const other = await seedCompany("other");
    const service = storageDestinationService(db);
    await expect(service.create(other.companyId, {
      ...createInput(other),
      credentials: { accessKeySecretId: owner.accessKeyId, secretKeySecretId: other.secretKeyId },
    }, BOARD)).rejects.toMatchObject({ status: 404 });

    const first = await service.create(owner.companyId, createInput(owner), BOARD);
    // Same endpoint and bucket, other prefix, other host case: still the same physical bucket.
    const claim = service.create(other.companyId, createInput(other, {
      location: location({ endpoint: "https://S3.EXAMPLE.COM/", prefix: "theirs" }),
    }), BOARD);
    await expect(claim).rejects.toMatchObject({ status: 409 });
    await expect(claim).rejects.not.toThrow(owner.companyId);

    // The owner may use the bucket again under another prefix.
    await expect(service.create(owner.companyId, createInput(owner, { location: location({ prefix: "second" }) }), BOARD))
      .resolves.toMatchObject({ created: true });

    // Once every owner destination is retired, the bucket is free.
    for (const row of await service.list(owner.companyId)) {
      await service.retire(owner.companyId, row.id, { expectedRevision: row.revision }, BOARD);
    }
    expect(first.destination.id).toBeTruthy();
    await expect(service.create(other.companyId, createInput(other), BOARD)).resolves.toMatchObject({ created: true });
  });

  it("requires HTTPS and public addresses unless the operator allowlists the origin", async () => {
    const company = await seedCompany("network");
    const service = storageDestinationService(db);
    await expect(service.create(company.companyId, createInput(company, { location: location({ endpoint: "http://s3.example.com/" }) }), BOARD))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.create(company.companyId, createInput(company, { location: location({ endpoint: "https://127.0.0.5/" }) }), BOARD))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.create(company.companyId, createInput(company, { location: location({ endpoint: "https://169.254.169.254/" }) }), BOARD))
      .rejects.toMatchObject({ status: 422 });
    process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS = "http://127.0.0.1:9000";
    await expect(service.create(company.companyId, createInput(company, {
      location: location({ endpoint: "http://127.0.0.1:9000/", bucket: "local-minio", forcePathStyle: true }),
    }), BOARD)).resolves.toMatchObject({ created: true });
  });

  it("resolves the pinned keys through the binding check and stops when a secret is disabled", async () => {
    const company = await seedCompany("resolve");
    const bucket = fakeBucket();
    const service = storageDestinationService(db, { providerFactory: bucket.factory });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    await service.providerFor(company.companyId, destination.id);
    expect(bucket.seenCredentials).toEqual([{ accessKeyId: "AKIA-resolve", secretAccessKey: "secret-resolve" }]);
    const reads = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.consumerId, destination.id));
    expect(reads.map((event) => event.consumerType)).toEqual(["storage_destination", "storage_destination"]);

    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, company.secretKeyId));
    await expect(service.providerFor(company.companyId, destination.id)).rejects.toBeTruthy();
    expect(bucket.seenCredentials).toHaveLength(1);
  });

  it("probes write, read, checksum, encryption, public read and isolation, then deletes its object", async () => {
    const company = await seedCompany("probe");
    const bucket = fakeBucket({ serverSideEncryption: "AES256", scopedTo: "paperclip" });
    const anonymousUrls: string[] = [];
    const service = storageDestinationService(db, {
      providerFactory: bucket.factory,
      anonymousGet: async (url) => {
        anonymousUrls.push(url);
        return 403;
      },
    });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    const result = await service.probe(company.companyId, destination.id, BOARD);
    expect(result).toMatchObject({
      status: "passed",
      checks: { write: "passed", read: "passed", checksum: "passed", delete: "passed" },
      encryption: "verified",
      publicRead: "denied",
      isolation: "prefix_scoped",
      errorCode: null,
    });
    expect(anonymousUrls).toEqual([`https://acme-archive.s3.example.com/paperclip/paperclip-probe/${result.probeId}`]);
    expect(bucket.objects.size).toBe(0);
    const [row] = await db.select().from(storageDestinations).where(eq(storageDestinations.id, destination.id));
    expect(row?.lastProbeJson).toMatchObject({ probeId: result.probeId, status: "passed" });
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.action, "storage.destination_probed")));
    expect(audit).toEqual([expect.objectContaining({ details: expect.objectContaining({ status: "passed", publicRead: "denied" }) })]);
  });

  it("fails the probe on a public bucket, a refused write, a failed delete and a KMS mismatch", async () => {
    const company = await seedCompany("probe-fail");
    const cases: Array<{ bucket: FakeBucketOptions; anonymousStatus: number; locationOverride?: Partial<StorageS3Location>; code: string }> = [
      { bucket: { serverSideEncryption: "AES256" }, anonymousStatus: 200, code: "public_read" },
      { bucket: { failPut: "AccessDenied" }, anonymousStatus: 403, code: "access_denied" },
      { bucket: { failDelete: true, serverSideEncryption: "AES256" }, anonymousStatus: 403, code: "cleanup_failed" },
      { bucket: { serverSideEncryption: "AES256" }, anonymousStatus: 403, locationOverride: { encryption: { mode: "kms", kmsKeyId: "alias/archive" } }, code: "encryption_mismatch" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const bucket = fakeBucket(testCase.bucket);
      const service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => testCase.anonymousStatus });
      const { destination } = await service.create(company.companyId, createInput(company, {
        location: location({ prefix: `case-${index}`, ...testCase.locationOverride }),
      }), BOARD);
      const result = await service.probe(company.companyId, destination.id, BOARD);
      expect(result, testCase.code).toMatchObject({ status: "failed", errorCode: testCase.code });
      expect(result.error).not.toContain("AccessDenied");
      if (testCase.code !== "cleanup_failed") expect(bucket.objects.size, testCase.code).toBe(0);
    }
  });

  it("passes bucket default encryption as unverified when the provider reports none", async () => {
    const company = await seedCompany("bucket-default");
    const bucket = fakeBucket();
    const service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company, {
      location: location({ prefix: "", encryption: { mode: "bucket_default" } }),
    }), BOARD);
    const result = await service.probe(company.companyId, destination.id, BOARD);
    expect(result).toMatchObject({ status: "passed", encryption: "unverified", isolation: "not_applicable" });
  });

  it("rotates credentials with a revision check, clears the old probe and rebinds", async () => {
    const company = await seedCompany("rotate");
    const service = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "AES256" }).factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    await service.probe(company.companyId, destination.id, BOARD);
    const replacement = await secretService(db).create(company.companyId, { name: "new secret key", provider: "local_encrypted", value: "secret-new" });
    const credentials = { accessKeySecretId: company.accessKeyId, secretKeySecretId: replacement.id };
    await expect(service.rotateCredentials(company.companyId, destination.id, { credentials, expectedCredentialRevision: 5 }, BOARD))
      .rejects.toMatchObject({ status: 409 });
    const rotated = await service.rotateCredentials(company.companyId, destination.id, { credentials, expectedCredentialRevision: 0 }, BOARD);
    expect(rotated).toMatchObject({ credentialRevision: 1, revision: 1, lastProbe: null, credentials: { secretKeySecretId: replacement.id } });
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, destination.id));
    expect(bindings.map((binding) => binding.secretId).sort()).toEqual([company.accessKeyId, replacement.id].sort());
  });

  it("retires with a revision check and then refuses probes and clients", async () => {
    const company = await seedCompany("retire");
    const service = storageDestinationService(db, { providerFactory: fakeBucket().factory });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    await expect(service.retire(company.companyId, destination.id, { expectedRevision: 3 }, BOARD)).rejects.toMatchObject({ status: 409 });
    const retired = await service.retire(company.companyId, destination.id, { expectedRevision: 0 }, BOARD);
    expect(retired.retiredAt).not.toBeNull();
    await expect(service.retire(company.companyId, destination.id, { expectedRevision: 0 }, BOARD)).resolves.toMatchObject({ id: destination.id });
    await expect(service.probe(company.companyId, destination.id, BOARD)).rejects.toMatchObject({ status: 409 });
    await expect(service.providerFor(company.companyId, destination.id)).rejects.toMatchObject({ status: 409 });
  });

  describe("routes", () => {
    function app(actor: Express.Request["actor"]) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      server.use("/api", companyStorageRoutes(db));
      server.use(errorHandler);
      return server;
    }

    function board(companyId: string, role = "owner"): Express.Request["actor"] {
      return {
        type: "board",
        source: "session",
        userId: "board-user-1",
        userName: null,
        userEmail: null,
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }],
      } as Express.Request["actor"];
    }

    it("lets a board member create and list, and keeps other companies and agents out", async () => {
      const company = await seedCompany("route");
      const other = await seedCompany("route-other");
      const input = createInput(company);
      await request(app(board(company.companyId))).post(`/api/companies/${company.companyId}/storage/destinations`).send(input).expect(201);
      await request(app(board(company.companyId))).post(`/api/companies/${company.companyId}/storage/destinations`).send(input).expect(200);
      const list = await request(app(board(company.companyId))).get(`/api/companies/${company.companyId}/storage/destinations`).expect(200);
      expect(list.body.map((row: { id: string }) => row.id)).toEqual([input.id]);

      await request(app(board(other.companyId))).get(`/api/companies/${company.companyId}/storage/destinations`).expect(403);
      await request(app({ type: "agent", source: "agent_key", agentId: randomUUID(), companyId: company.companyId } as Express.Request["actor"]))
        .get(`/api/companies/${company.companyId}/storage/destinations`).expect(403);
      await request(app(board(company.companyId, "viewer"))).post(`/api/companies/${company.companyId}/storage/destinations`).send(createInput(company)).expect(403);
      await request(app(board(company.companyId))).post(`/api/companies/${company.companyId}/storage/destinations/not-a-uuid/retire`).send({ expectedRevision: 0 }).expect(400);
      await request(app(board(company.companyId))).post(`/api/companies/${company.companyId}/storage/destinations`).send({ ...input, extra: true }).expect(400);
    });

    it("refuses on cloud-managed instances", async () => {
      const company = await seedCompany("cloud");
      const previous = process.env.PAPERCLIP_MANAGED_CONFIG;
      process.env.PAPERCLIP_MANAGED_CONFIG = "{}";
      try {
        await request(app(board(company.companyId))).get(`/api/companies/${company.companyId}/storage/destinations`).expect(403);
      } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_MANAGED_CONFIG;
        else process.env.PAPERCLIP_MANAGED_CONFIG = previous;
      }
    });
  });
});

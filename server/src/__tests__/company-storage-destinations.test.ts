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
import {
  encryptionVerdict,
  storageDestinationService,
  storageObjectUrl,
  storagePhysicalKey,
  type StorageDestinationDeps,
} from "../services/storage-destinations.js";
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
  /** Stores the object, then throws: an upload whose outcome the client never learned. */
  failPutAfterStore?: string;
  failDelete?: boolean;
  serverSideEncryption?: string;
  serverSideEncryptionKeyId?: string;
  /** Deny writes whose prefix differs from the destination's prefix. */
  scopedTo?: string;
  /** The key may not read or write the bucket-root ownership marker. */
  markerDenied?: boolean;
  /** Runs inside every PUT, while a probe is in flight. */
  onPut?: () => Promise<void>;
  /** Runs before every GET. */
  onGet?: (key: string) => Promise<void>;
  /** GET streams this body (in 64 KiB chunks) instead of the stored object. */
  getBody?: Buffer;
  /** GET ignores the requested range, like a non-compliant server. */
  ignoreRange?: boolean;
}

const MARKER_KEY = ".paperclip/owner.json";

/** In-memory S3 stand-in keyed by the full object key, prefix included (one bucket). */
function fakeBucket(options: FakeBucketOptions = {}) {
  const objects = new Map<string, Buffer>();
  const seenCredentials: Array<{ accessKeyId: string; secretAccessKey: string }> = [];
  const pulled = { bytes: 0 };
  const factory: NonNullable<StorageDestinationDeps["providerFactory"]> = async ({ location, credentials }) => {
    seenCredentials.push(credentials);
    const full = (key: string) => [location.prefix, key].filter(Boolean).join("/");
    const fail = (name: string) => Object.assign(new Error(name), { name });
    const provider: StorageProvider = {
      id: "s3",
      async putObject(input) {
        const key = full(input.objectKey);
        const marker = key === MARKER_KEY;
        if (marker && options.markerDenied) throw fail("AccessDenied");
        await options.onPut?.();
        if (options.failPut) throw fail(options.failPut);
        if (options.scopedTo !== undefined && location.prefix !== options.scopedTo && !marker) throw fail("AccessDenied");
        if (input.ifNoneMatch === "*" && objects.has(key)) throw fail("PreconditionFailed");
        const body = Buffer.isBuffer(input.body) ? input.body : Buffer.alloc(0);
        objects.set(key, body);
        if (options.failPutAfterStore) throw fail(options.failPutAfterStore);
      },
      async headObject(input) {
        const body = objects.get(full(input.objectKey));
        return body
          ? { exists: true, contentLength: body.length, serverSideEncryption: options.serverSideEncryption, serverSideEncryptionKeyId: options.serverSideEncryptionKeyId }
          : { exists: false };
      },
      async getObject(input) {
        const key = full(input.objectKey);
        if (key === MARKER_KEY && options.markerDenied) throw fail("AccessDenied");
        await options.onGet?.(key);
        const stored = options.getBody && key !== MARKER_KEY ? options.getBody : objects.get(key);
        if (!stored) throw fail("NoSuchKey");
        const body = input.range && !options.ignoreRange ? stored.subarray(input.range.start, input.range.end + 1) : stored;
        const chunks = function* () {
          for (let offset = 0; offset < body.length; offset += 64 * 1024) {
            const chunk = body.subarray(offset, offset + 64 * 1024);
            pulled.bytes += chunk.length;
            yield chunk;
          }
        };
        return { stream: Readable.from(chunks()), contentLength: body.length };
      },
      async deleteObject(input) {
        if (options.failDelete) throw fail("AccessDenied");
        objects.delete(full(input.objectKey));
      },
    };
    return provider;
  };
  return { objects, seenCredentials, factory, pulled };
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

  it("refuses another company's secrets and secrets already used elsewhere", async () => {
    const owner = await seedCompany("owner");
    const other = await seedCompany("other");
    const service = storageDestinationService(db);
    await expect(service.create(other.companyId, {
      ...createInput(other),
      credentials: { accessKeySecretId: owner.accessKeyId, secretKeySecretId: other.secretKeyId },
    }, BOARD)).rejects.toMatchObject({ status: 404 });

    // A secret bound to anything else (here an instance setting) must not be sent to a bucket endpoint.
    await secretService(db).syncSecretRefsForTarget(owner.companyId, { targetType: "system", targetId: "integration" }, [
      { secretId: owner.accessKeyId, configPath: "env.OTHER_TOKEN" },
    ]);
    await expect(service.create(owner.companyId, createInput(owner), BOARD))
      .rejects.toMatchObject({ status: 422, details: { code: "secret_in_use" } });
  });

  it("reserves a bucket for the first company whose probe passes", async () => {
    const owner = await seedCompany("claim-owner");
    const other = await seedCompany("claim-other");
    const deps = { providerFactory: fakeBucket({ serverSideEncryption: "AES256" }).factory, anonymousGet: async () => 403 };
    const service = storageDestinationService(db, deps);

    // An unproven claim does not block anyone: no squatting with keys that do not work.
    const squat = await service.create(other.companyId, createInput(other, { location: location({ prefix: "theirs" }) }), BOARD);
    const { destination } = await service.create(owner.companyId, createInput(owner), BOARD);
    await expect(service.probe(owner.companyId, destination.id, BOARD)).resolves.toMatchObject({ status: "passed" });

    // Now the bucket is the owner's: same bucket under another host alias and prefix is refused.
    const claim = service.create(other.companyId, createInput(other, {
      location: location({ endpoint: "https://S3.EXAMPLE.COM./", prefix: "again" }),
    }), BOARD);
    await expect(claim).rejects.toMatchObject({ status: 409 });
    await expect(claim).rejects.not.toThrow(owner.companyId);
    // The earlier unproven claim cannot pass a probe any more.
    await expect(service.probe(other.companyId, squat.destination.id, BOARD))
      .rejects.toMatchObject({ status: 409, details: { code: "location_unavailable" } });
    const [squatRow] = await db.select().from(storageDestinations).where(eq(storageDestinations.id, squat.destination.id));
    expect(squatRow?.lastProbeJson).toMatchObject({ status: "failed", errorCode: "location_unavailable" });
    // The owner may use the bucket again under another prefix.
    await expect(service.create(owner.companyId, createInput(owner, { location: location({ prefix: "second" }) }), BOARD))
      .resolves.toMatchObject({ created: true });
  });

  it("keeps a bucket claimed after its owner retires every destination there", async () => {
    const owner = await seedCompany("retire-owner");
    const other = await seedCompany("retire-other");
    const service = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "AES256" }).factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(owner.companyId, createInput(owner), BOARD);
    await service.probe(owner.companyId, destination.id, BOARD);
    // Retiring deletes nothing, so the bucket and what the owner left in it stay the owner's.
    await service.retire(owner.companyId, destination.id, { expectedRevision: 0 }, BOARD);
    await expect(service.create(other.companyId, createInput(other), BOARD))
      .rejects.toMatchObject({ status: 409, details: { code: "location_unavailable" } });
  });

  it("proves bucket ownership with a marker, so a host alias cannot share a claimed bucket", async () => {
    const owner = await seedCompany("alias-owner");
    const other = await seedCompany("alias-other");
    const bucket = fakeBucket({ serverSideEncryption: "AES256" });
    const service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => 403 });
    const aliasA = location({ endpoint: "https://minio-a.example.com/", bucket: "shared", prefix: "a" });
    const aliasB = location({ endpoint: "https://minio-b.example.com/", bucket: "shared", prefix: "b" });

    const { destination } = await service.create(owner.companyId, createInput(owner, { location: aliasA }), BOARD);
    await expect(service.probe(owner.companyId, destination.id, BOARD)).resolves.toMatchObject({ status: "passed" });
    expect(JSON.parse(bucket.objects.get(MARKER_KEY)!.toString("utf8"))).toMatchObject({ destinationId: destination.id, nonce: expect.any(String) });

    // The other host name gives another database key, so only the marker can tell.
    const intruder = await service.create(other.companyId, createInput(other, { location: aliasB }), BOARD);
    await expect(service.probe(other.companyId, intruder.destination.id, BOARD))
      .rejects.toMatchObject({ status: 409, details: { code: "location_unavailable" } });
    await expect(service.providerFor(other.companyId, intruder.destination.id)).rejects.toMatchObject({ status: 409 });

    // The owner's own second destination through the alias is fine.
    const second = await service.create(owner.companyId, createInput(owner, { location: { ...aliasB, prefix: "a2" } }), BOARD);
    await expect(service.probe(owner.companyId, second.destination.id, BOARD)).resolves.toMatchObject({ status: "passed" });
  });

  it("never plants a marker in a bucket another company claimed, even when its marker is gone", async () => {
    const owner = await seedCompany("marker-gone-owner");
    const other = await seedCompany("marker-gone-other");
    const bucket = fakeBucket({ serverSideEncryption: "AES256" });
    const service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => 403 });
    const squat = await service.create(other.companyId, createInput(other, { location: location({ prefix: "theirs" }) }), BOARD);
    const { destination } = await service.create(owner.companyId, createInput(owner), BOARD);
    await service.probe(owner.companyId, destination.id, BOARD);
    bucket.objects.delete(MARKER_KEY);
    await expect(service.probe(other.companyId, squat.destination.id, BOARD)).rejects.toMatchObject({ status: 409 });
    expect(bucket.objects.has(MARKER_KEY)).toBe(false);
  });

  it("lets a lone alias of an unclaimed bucket pass, and refuses a key that cannot check the marker", async () => {
    const company = await seedCompany("alias-lone");
    const service = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "AES256" }).factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company, { location: location({ endpoint: "https://minio-b.example.com/", bucket: "shared" }) }), BOARD);
    await expect(service.probe(company.companyId, destination.id, BOARD)).resolves.toMatchObject({ status: "passed" });

    const denied = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "AES256", markerDenied: true }).factory, anonymousGet: async () => 403 });
    const scoped = await denied.create(company.companyId, createInput(company, { location: location({ bucket: "scoped-only" }) }), BOARD);
    await expect(denied.probe(company.companyId, scoped.destination.id, BOARD)).resolves.toMatchObject({ status: "failed", errorCode: "ownership_unverified" });
  });

  it("loses a marker race to a claim written between its read and its write", async () => {
    const company = await seedCompany("alias-race");
    const options: FakeBucketOptions = { serverSideEncryption: "AES256" };
    const bucket = fakeBucket(options);
    options.onGet = async (key) => {
      if (key !== MARKER_KEY) return;
      options.onGet = undefined;
      // Another installation or company claims the bucket right after our first read.
      bucket.objects.set(MARKER_KEY, Buffer.from(JSON.stringify({ format: "paperclip.storage-owner", v: 1, destinationId: randomUUID(), nonce: "theirs" })));
    };
    const service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    await expect(service.probe(company.companyId, destination.id, BOARD))
      .rejects.toMatchObject({ status: 409, details: { code: "location_unavailable" } });
  });

  it("requires the exact encryption the destination asked for", async () => {
    const s3 = { mode: "s3_managed" as const };
    const kms = { mode: "kms" as const, kmsKeyId: "1234abcd-12ab-34cd-56ef-1234567890ab" };
    const keyArn = "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
    expect(encryptionVerdict(s3, "AES256")).toBe("verified");
    expect(encryptionVerdict(s3, "NONE")).toBe("failed");
    expect(encryptionVerdict(s3, "aws:kms")).toBe("failed");
    expect(encryptionVerdict(kms, "aws:kms", keyArn)).toBe("verified");
    expect(encryptionVerdict(kms, "aws:kms")).toBe("verified");
    expect(encryptionVerdict(kms, "aws:kms-fake", keyArn)).toBe("failed");
    expect(encryptionVerdict(kms, "aws:kms", "arn:aws:kms:us-east-1:111122223333:key/other")).toBe("failed");
    expect(encryptionVerdict({ mode: "kms", kmsKeyId: keyArn }, "aws:kms", keyArn)).toBe("verified");
    expect(encryptionVerdict({ mode: "bucket_default" }, undefined)).toBe("unverified");
    expect(encryptionVerdict({ mode: "bucket_default" }, "AES256")).toBe("verified");
    expect(encryptionVerdict({ mode: "bucket_default" }, "NONE")).toBe("failed");

    const company = await seedCompany("kms-fake");
    const service = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "aws:kms-fake" }).factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company, { location: location({ encryption: kms }) }), BOARD);
    await expect(service.probe(company.companyId, destination.id, BOARD)).resolves.toMatchObject({ status: "failed", errorCode: "encryption_mismatch" });
  });

  it("counts only 401 and 403 as a private bucket: a redirect proves nothing", async () => {
    const company = await seedCompany("redirect");
    for (const [index, status] of [302, 301, 404, 500].entries()) {
      const service = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "AES256" }).factory, anonymousGet: async () => status });
      const { destination } = await service.create(company.companyId, createInput(company, { location: location({ bucket: `redirect-${index}` }) }), BOARD);
      await expect(service.probe(company.companyId, destination.id, BOARD), String(status))
        .resolves.toMatchObject({ status: "failed", publicRead: "unknown", errorCode: "public_read_unverified" });
    }
    const service = storageDestinationService(db, { providerFactory: fakeBucket({ serverSideEncryption: "AES256" }).factory, anonymousGet: async () => 401 });
    const { destination } = await service.create(company.companyId, createInput(company, { location: location({ bucket: "redirect-401" }) }), BOARD);
    await expect(service.probe(company.companyId, destination.id, BOARD)).resolves.toMatchObject({ status: "passed", publicRead: "denied" });
  });

  it("deletes the probe object after an upload whose outcome was unknown, and caps the read", async () => {
    const company = await seedCompany("probe-cleanup");
    const ambiguous = fakeBucket({ serverSideEncryption: "AES256", failPutAfterStore: "RequestTimeout" });
    const service = storageDestinationService(db, { providerFactory: ambiguous.factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    await expect(service.probe(company.companyId, destination.id, BOARD)).resolves.toMatchObject({ status: "failed" });
    expect([...ambiguous.objects.keys()].filter((key) => key.includes("paperclip-probe"))).toEqual([]);

    // HEAD says 32 bytes, GET streams 8 MiB and ignores the range.
    const flood = fakeBucket({ serverSideEncryption: "AES256", getBody: Buffer.alloc(8 * 1024 * 1024, 1), ignoreRange: true });
    const capped = storageDestinationService(db, { providerFactory: flood.factory, anonymousGet: async () => 403 });
    const big = await capped.create(company.companyId, createInput(company, { location: location({ bucket: "flood" }) }), BOARD);
    await expect(capped.probe(company.companyId, big.destination.id, BOARD)).resolves.toMatchObject({ status: "failed", errorCode: "read_mismatch" });
    expect(flood.pulled.bytes).toBeLessThan(1024 * 1024);
  });

  it("returns the original destination on a retried create after a referenced secret changed", async () => {
    const company = await seedCompany("idempotent-rotated");
    const service = storageDestinationService(db);
    const input = createInput(company);
    await service.create(company.companyId, input, BOARD);
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, company.secretKeyId));
    await expect(service.create(company.companyId, input, BOARD)).resolves.toMatchObject({ created: false, destination: { id: input.id } });
  });

  it("canonicalizes AWS host aliases and builds the probe URL the way the S3 client addresses the bucket", () => {
    const aws = (endpoint: string) => storagePhysicalKey({ endpoint, bucket: "Acme-Archive" });
    expect(aws("https://s3.amazonaws.com/")).toBe("s3.amazonaws.com/acme-archive");
    expect(aws("https://s3.us-east-1.amazonaws.com/")).toBe("s3.amazonaws.com/acme-archive");
    expect(aws("https://s3.dualstack.eu-west-1.amazonaws.com./")).toBe("s3.amazonaws.com/acme-archive");
    expect(aws("https://minio.example.com:9000/")).toBe("minio.example.com:9000/acme-archive");
    expect(storageObjectUrl(location({ bucket: "dotted.bucket" }), "k")).toBe("https://s3.example.com/dotted.bucket/paperclip/k");
    expect(storageObjectUrl(location(), "k")).toBe("https://acme-archive.s3.example.com/paperclip/k");
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
    // Allowlist entries are compared as origins, so a trailing slash still matches.
    process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS = "http://127.0.0.1:9000/, http://minio.internal:9000";
    // An allowlisted private host name must use path style, so no bucket subdomain of it is dialled.
    await expect(service.create(company.companyId, createInput(company, {
      location: location({ endpoint: "http://minio.internal:9000/", bucket: "local-minio", forcePathStyle: false, prefix: "vhost" }),
    }), BOARD)).rejects.toMatchObject({ status: 422 });
    await expect(service.create(company.companyId, createInput(company, {
      location: location({ endpoint: "http://127.0.0.1:9000/", bucket: "local-minio", forcePathStyle: true }),
    }), BOARD)).resolves.toMatchObject({ created: true });
  });

  it("hands out a client only after a current passing probe, with keys resolved through the binding check", async () => {
    const company = await seedCompany("resolve");
    const bucket = fakeBucket({ serverSideEncryption: "AES256" });
    const service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => 403 });
    const { destination } = await service.create(company.companyId, createInput(company), BOARD);
    await expect(service.providerFor(company.companyId, destination.id))
      .rejects.toMatchObject({ status: 409, details: { code: "storage_destination_unverified" } });

    await service.probe(company.companyId, destination.id, BOARD);
    await service.providerFor(company.companyId, destination.id);
    expect(bucket.seenCredentials.at(-1)).toEqual({ accessKeyId: "AKIA-resolve", secretAccessKey: "secret-resolve" });
    const reads = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.consumerId, destination.id));
    expect(new Set(reads.map((event) => event.consumerType))).toEqual(new Set(["storage_destination"]));
    // The probe reads the keys as the board user who asked for it; the archive client as the system.
    expect(reads.filter((event) => event.actorType === "user").map((event) => event.actorId)).toContain("board-user-1");

    const seen = bucket.seenCredentials.length;
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, company.secretKeyId));
    await expect(service.providerFor(company.companyId, destination.id)).rejects.toBeTruthy();
    expect(bucket.seenCredentials).toHaveLength(seen);
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
    // Only the ownership marker stays, at the bucket root.
    expect([...bucket.objects.keys()]).toEqual([MARKER_KEY]);
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
      // s3_managed asked for, nothing reported: a provider that ignores the header stores plaintext.
      { bucket: {}, anonymousStatus: 403, code: "encryption_unverified" },
      // The privacy check could not run (here: a dotted bucket host that does not resolve): fail closed.
      { bucket: { serverSideEncryption: "AES256" }, anonymousStatus: -1, locationOverride: { bucket: "dotted.archive" }, code: "public_read_unverified" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const bucket = fakeBucket(testCase.bucket);
      const service = storageDestinationService(db, {
        providerFactory: bucket.factory,
        anonymousGet: async () => {
          if (testCase.anonymousStatus < 0) throw new Error("getaddrinfo ENOTFOUND");
          return testCase.anonymousStatus;
        },
      });
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

  it("keeps the last passing probe while a new probe runs, then replaces it", async () => {
    const company = await seedCompany("reprobe");
    let service: ReturnType<typeof storageDestinationService>;
    let destinationId = "";
    let usableDuringProbe: boolean | null = null;
    const options: FakeBucketOptions = { serverSideEncryption: "AES256" };
    const bucket = fakeBucket(options);
    service = storageDestinationService(db, { providerFactory: bucket.factory, anonymousGet: async () => 403 });
    ({ destination: { id: destinationId } } = await service.create(company.companyId, createInput(company), BOARD));
    await service.probe(company.companyId, destinationId, BOARD);

    // Second probe: while it is in flight the earlier pass still applies; then it fails.
    options.onPut = async () => {
      options.onPut = undefined;
      usableDuringProbe = await service.providerFor(company.companyId, destinationId).then(() => true, () => false);
      const [row] = await db.select().from(storageDestinations).where(eq(storageDestinations.id, destinationId));
      expect(row?.lastProbeJson).toMatchObject({ status: "passed", pending: { probeId: expect.any(String) } });
      options.failPut = "AccessDenied";
    };
    const second = await service.probe(company.companyId, destinationId, BOARD);
    expect(usableDuringProbe).toBe(true);
    expect(second).toMatchObject({ status: "failed", errorCode: "access_denied" });
    const [row] = await db.select().from(storageDestinations).where(eq(storageDestinations.id, destinationId));
    expect(row?.lastProbeJson).toMatchObject({ status: "failed" });
    expect(row?.lastProbeJson).not.toHaveProperty("pending");
    await expect(service.providerFor(company.companyId, destinationId)).rejects.toMatchObject({ status: 409 });
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
      // Choosing where company keys go is an owner or admin action.
      await request(app(board(company.companyId, "member"))).post(`/api/companies/${company.companyId}/storage/destinations`).send(createInput(company)).expect(403);
      await request(app(board(company.companyId, "member"))).get(`/api/companies/${company.companyId}/storage/destinations`).expect(200);
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

describe("storagePhysicalKey", () => {
  it("canonicalizes legacy, FIPS, dualstack and China AWS hosts and stays linear on a hostile endpoint", () => {
    const key = (host: string) => storagePhysicalKey({ endpoint: `https://${host}/`, bucket: "b" });
    for (const host of [
      "s3-us-west-2.amazonaws.com",
      "s3-fips.us-gov-west-1.amazonaws.com",
      "s3.dualstack.us-east-1.amazonaws.com",
      "s3.cn-north-1.amazonaws.com.cn",
    ]) {
      expect(key(host)).toBe("s3.amazonaws.com/b");
    }
    expect(key("evil-s3.amazonaws.com")).toBe("evil-s3.amazonaws.com/b");

    // A near-miss of the AWS suffix after many dashes: the earlier pattern backtracked for seconds here.
    const hostile = `s3${"--".repeat(22)}.amazonaws.co`;
    const started = performance.now();
    expect(key(hostile)).toBe(`${hostile}/b`);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

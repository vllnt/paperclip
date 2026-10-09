import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { and, asc, eq, ne, isNull, sql } from "drizzle-orm";
import { storageDestinations, type Db } from "@paperclipai/db";
import type {
  CreateStorageDestination,
  StorageCredentialPins,
  StorageCredentialRefs,
  StorageDestinationView,
  StorageEncryption,
  StorageProbeResult,
  StorageS3Location,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { resolveApprovedRemoteHttpAddresses } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { secretService } from "./secrets.js";
import { companyS3RequestHandler, storageEndpointPolicy } from "../storage/company-s3-network.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageProvider } from "../storage/types.js";

type DestinationRow = typeof storageDestinations.$inferSelect;

export interface StorageDestinationActor {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export interface StorageDestinationDeps {
  /** Builds the client for a location and resolved keys. Tests inject an in-memory provider. */
  providerFactory?: (input: {
    location: StorageS3Location;
    credentials: { accessKeyId: string; secretAccessKey: string };
  }) => Promise<StorageProvider>;
  /** Unauthenticated GET of an object URL, for the public-read check. */
  anonymousGet?: (url: string, location: StorageS3Location, signal: AbortSignal) => Promise<number>;
  probeTimeoutMs?: number;
}

const PROBE_PREFIX = "paperclip-probe";
const ISOLATION_PROBE_PREFIX = "paperclip-isolation-probe";
const CLEANUP_TIMEOUT_MS = 10_000;

/** Fixed, provider-independent probe failures: no raw provider text reaches the API. */
const PROBE_ERRORS = {
  credentials_unavailable: "The access key secrets cannot be read. Check that both secrets exist and are active.",
  endpoint_rejected: "The endpoint is outside the network policy of this instance.",
  endpoint_unreachable: "The endpoint did not answer.",
  invalid_credentials: "The provider rejected the access key.",
  access_denied: "The access key is not allowed to write, read and delete objects under this prefix.",
  bucket_not_found: "The bucket does not exist or is in another region.",
  encryption_unsupported: "The provider rejected the requested encryption. Try bucket default encryption.",
  encryption_mismatch: "The provider stored the object with a different encryption than requested.",
  read_mismatch: "The object read back does not match what was written.",
  public_read: "Objects in this bucket can be read without credentials. Make the bucket private.",
  cleanup_failed: "The probe object could not be deleted. Check the delete permission.",
  timeout: "The probe did not finish within its time limit.",
  probe_failed: "The probe failed.",
} as const;
type ProbeErrorCode = keyof typeof PROBE_ERRORS;

class ProbeFailure extends Error {
  constructor(readonly code: ProbeErrorCode) {
    super(PROBE_ERRORS[code]);
  }
}

function probeErrorCode(error: unknown): ProbeErrorCode {
  if (error instanceof ProbeFailure) return error.code;
  // Our own errors: the endpoint policy, or the secret service refusing the keys.
  if (error instanceof HttpError) {
    const reason = (error.details as { code?: unknown } | undefined)?.code;
    if (reason === "remote_http_dns_failed") return "endpoint_unreachable";
    return /endpoint/i.test(error.message) ? "endpoint_rejected" : "credentials_unavailable";
  }
  const name = (error as { name?: string; code?: string } | null)?.name ?? "";
  const code = (error as { code?: string } | null)?.code ?? "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch") return "invalid_credentials";
  if (name === "AccessDenied" || name === "Forbidden") return "access_denied";
  if (name === "NoSuchBucket" || name === "PermanentRedirect") return "bucket_not_found";
  if (name === "NotImplemented" || name === "InvalidArgument" || name === "InvalidEncryptionAlgorithmError") return "encryption_unsupported";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) return "endpoint_unreachable";
  if (error instanceof Error && error.message.includes("network policy")) return "endpoint_rejected";
  return "probe_failed";
}

/** Normalized endpoint host and bucket: the unit a company may not share. */
export function storagePhysicalKey(location: Pick<StorageS3Location, "endpoint" | "bucket">): string {
  const url = new URL(location.endpoint);
  return `${url.host.toLowerCase()}/${location.bucket.toLowerCase()}`;
}

/** Object URL for an unauthenticated GET, in the location's addressing style. */
export function storageObjectUrl(location: StorageS3Location, objectKey: string): string {
  const url = new URL(location.endpoint);
  const fullKey = [location.prefix, objectKey].filter(Boolean).join("/");
  const path = fullKey.split("/").map(encodeURIComponent).join("/");
  if (location.forcePathStyle) return `${url.origin}/${location.bucket}/${path}`;
  return `${url.protocol}//${location.bucket}.${url.host}/${path}`;
}

/** Whether the provider reported the encryption the destination asked for. */
export function encryptionVerdict(
  encryption: StorageEncryption,
  reported: string | undefined,
): StorageProbeResult["encryption"] {
  if (!reported) return "unverified";
  if (encryption.mode === "kms" && !reported.startsWith("aws:kms")) return "failed";
  return "verified";
}

function view(row: DestinationRow): StorageDestinationView {
  return {
    id: row.id,
    companyId: row.companyId,
    label: row.label,
    provider: row.provider,
    origin: row.origin,
    location: row.locationJson,
    credentials: row.credentialsJson,
    revision: row.revision,
    credentialRevision: row.credentialRevision,
    lastProbe: row.lastProbeJson ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** JSON with sorted object keys: JSONB does not keep the key order it was given. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameCreatePayload(row: DestinationRow, input: CreateStorageDestination) {
  return row.label === input.label
    && canonicalJson(row.locationJson) === canonicalJson(input.location)
    && row.credentialsJson.accessKeySecretId === input.credentials.accessKeySecretId
    && row.credentialsJson.secretKeySecretId === input.credentials.secretKeySecretId;
}

async function defaultProviderFactory(input: {
  location: StorageS3Location;
  credentials: { accessKeyId: string; secretAccessKey: string };
}): Promise<StorageProvider> {
  const { location } = input;
  return createS3StorageProvider({
    bucket: location.bucket,
    region: location.region,
    endpoint: location.endpoint,
    prefix: location.prefix,
    forcePathStyle: location.forcePathStyle,
    credentials: input.credentials,
    requestHandler: await companyS3RequestHandler(location),
    serverSideEncryption: location.encryption,
  });
}

async function defaultAnonymousGet(url: string, location: StorageS3Location, signal: AbortSignal): Promise<number> {
  const { allowPrivateNetwork } = storageEndpointPolicy(location);
  const response = await guardedRemoteHttpFetch(url, { method: "GET", signal }, {
    allowPrivateNetwork,
    error: (message) => unprocessable(message),
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

/**
 * Company storage destinations: create, list, probe, rotate credentials and
 * retire, plus the authenticated client for consumers (the company archive).
 */
export function storageDestinationService(db: Db, deps: StorageDestinationDeps = {}) {
  const secrets = secretService(db);
  const providerFactory = deps.providerFactory ?? defaultProviderFactory;
  const anonymousGet = deps.anonymousGet ?? defaultAnonymousGet;
  const probeTimeoutMs = deps.probeTimeoutMs ?? 30_000;

  async function get(companyId: string, id: string): Promise<DestinationRow> {
    const [row] = await db
      .select()
      .from(storageDestinations)
      .where(and(eq(storageDestinations.companyId, companyId), eq(storageDestinations.id, id)));
    if (!row) throw notFound("Storage destination not found");
    return row;
  }

  async function assertEndpointAllowed(location: StorageS3Location) {
    const { endpoint, allowPrivateNetwork } = storageEndpointPolicy(location);
    // A host name is checked again at every connect; an IP literal can be rejected now.
    if (isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) !== 0) {
      await resolveApprovedRemoteHttpAddresses(endpoint, { allowPrivateNetwork }, () =>
        unprocessable("The storage endpoint is unavailable or outside the operator network policy"));
    }
  }

  /** Secrets must be this company's, company scoped; the current versions are pinned. */
  async function pinCredentials(companyId: string, refs: StorageCredentialRefs): Promise<StorageCredentialPins> {
    for (const secretId of [refs.accessKeySecretId, refs.secretKeySecretId]) {
      const secret = await secrets.getById(secretId);
      if (!secret || secret.companyId !== companyId || secret.scope !== "company") {
        throw notFound("Company secret not found");
      }
    }
    return {
      ...refs,
      accessKeyVersion: await secrets.resolveSecretVersion(companyId, refs.accessKeySecretId, "latest"),
      secretKeyVersion: await secrets.resolveSecretVersion(companyId, refs.secretKeySecretId, "latest"),
    };
  }

  async function bindCredentials(connection: Db, companyId: string, id: string, pins: StorageCredentialPins) {
    await secretService(connection).syncSecretRefsForTarget(companyId, { targetType: "storage_destination", targetId: id }, [
      { secretId: pins.accessKeySecretId, versionSelector: pins.accessKeyVersion, configPath: "credentials.accessKeyId" },
      { secretId: pins.secretKeySecretId, versionSelector: pins.secretKeyVersion, configPath: "credentials.secretAccessKey" },
    ], { replaceAll: true });
  }

  /**
   * Resolves the pinned keys through the binding check on every call (each
   * read is recorded in secret_access_events), so a revoked secret stops the
   * next operation. Nothing is cached.
   */
  async function resolveCredentials(row: DestinationRow) {
    const context = { consumerType: "storage_destination" as const, consumerId: row.id, actorType: "system" as const, actorId: null };
    const pins = row.credentialsJson;
    const [accessKeyId, secretAccessKey] = await Promise.all([
      secrets.resolveSecretValue(row.companyId, pins.accessKeySecretId, pins.accessKeyVersion, { ...context, configPath: "credentials.accessKeyId" }),
      secrets.resolveSecretValue(row.companyId, pins.secretKeySecretId, pins.secretKeyVersion, { ...context, configPath: "credentials.secretAccessKey" }),
    ]);
    return { accessKeyId, secretAccessKey };
  }

  async function audit(companyId: string, id: string, action: string, actor: StorageDestinationActor, details: Record<string, unknown>) {
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: `storage.destination_${action}`,
      entityType: "storage_destination",
      entityId: id,
      details,
    });
  }

  async function writeProbe(row: DestinationRow, result: StorageProbeResult) {
    await db
      .update(storageDestinations)
      .set({ lastProbeJson: result, updatedAt: new Date() })
      .where(and(eq(storageDestinations.companyId, row.companyId), eq(storageDestinations.id, row.id)));
  }

  /** Writes one byte outside the prefix: success means the key is not limited to the prefix. */
  async function checkIsolation(row: DestinationRow, credentials: { accessKeyId: string; secretAccessKey: string }, probeId: string) {
    const location = row.locationJson;
    const segments = location.prefix.split("/");
    const parent = segments.slice(0, -1).join("/");
    const outside = await providerFactory({ location: { ...location, prefix: parent }, credentials });
    const objectKey = `${ISOLATION_PROBE_PREFIX}/${probeId}`;
    try {
      await outside.putObject({ objectKey, body: Buffer.from("x"), contentType: "application/octet-stream", contentLength: 1 });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      return name === "AccessDenied" || name === "Forbidden" ? "prefix_scoped" as const : "unknown" as const;
    }
    await outside.deleteObject({ objectKey, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }).catch(() => undefined);
    return "bucket_wide" as const;
  }

  return {
    get,
    /** The authenticated client, for consumers such as the company archive. */
    async providerFor(companyId: string, id: string): Promise<StorageProvider> {
      const row = await get(companyId, id);
      if (row.retiredAt) throw conflict("Storage destination is retired");
      return providerFactory({ location: row.locationJson, credentials: await resolveCredentials(row) });
    },

    async list(companyId: string): Promise<StorageDestinationView[]> {
      const rows = await db
        .select()
        .from(storageDestinations)
        .where(eq(storageDestinations.companyId, companyId))
        .orderBy(asc(storageDestinations.createdAt), asc(storageDestinations.id));
      return rows.map(view);
    },

    /**
     * Idempotent on the client id: the same id and payload return the
     * existing destination; a different payload under that id is a conflict.
     */
    async create(companyId: string, input: CreateStorageDestination, actor: StorageDestinationActor) {
      await assertEndpointAllowed(input.location);
      const physicalKey = storagePhysicalKey(input.location);
      const pins = await pinCredentials(companyId, input.credentials);
      const outcome = await db.transaction(async (tx) => {
        // Serialize creates of one physical bucket so two companies cannot both claim it.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`storage_destination:${physicalKey}`}))`);
        const [existing] = await tx.select().from(storageDestinations).where(eq(storageDestinations.id, input.id));
        if (existing) {
          if (existing.companyId !== companyId || !sameCreatePayload(existing, input)) {
            throw conflict("This destination id is already used with different settings");
          }
          return { row: existing, created: false };
        }
        const [claimed] = await tx
          .select({ id: storageDestinations.id })
          .from(storageDestinations)
          .where(and(
            eq(storageDestinations.physicalKey, physicalKey),
            ne(storageDestinations.companyId, companyId),
            isNull(storageDestinations.retiredAt),
          ))
          .limit(1);
        // Say only that the location is unavailable, never which company uses it.
        if (claimed) throw conflict("This storage location is not available. Use a bucket of your own.");
        const [row] = await tx
          .insert(storageDestinations)
          .values({
            id: input.id,
            companyId,
            label: input.label,
            locationJson: input.location,
            physicalKey,
            credentialsJson: pins,
          })
          .returning();
        await bindCredentials(tx as unknown as Db, companyId, input.id, pins);
        return { row: row!, created: true };
      });
      if (outcome.created) {
        const location = input.location;
        await audit(companyId, input.id, "created", actor, {
          label: input.label,
          endpointHost: new URL(location.endpoint).host,
          bucket: location.bucket,
          prefix: location.prefix,
          encryptionMode: location.encryption.mode,
        });
      }
      return { destination: view(outcome.row), created: outcome.created };
    },

    async rotateCredentials(
      companyId: string,
      id: string,
      input: { credentials: StorageCredentialRefs; expectedCredentialRevision: number },
      actor: StorageDestinationActor,
    ) {
      const current = await get(companyId, id);
      if (current.retiredAt) throw conflict("Storage destination is retired");
      const pins = await pinCredentials(companyId, input.credentials);
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(storageDestinations)
          .set({
            credentialsJson: pins,
            credentialRevision: sql`${storageDestinations.credentialRevision} + 1`,
            revision: sql`${storageDestinations.revision} + 1`,
            // A probe of the old keys says nothing about the new ones.
            lastProbeJson: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(storageDestinations.companyId, companyId),
            eq(storageDestinations.id, id),
            eq(storageDestinations.credentialRevision, input.expectedCredentialRevision),
            isNull(storageDestinations.retiredAt),
          ))
          .returning();
        if (!updated) throw conflict("The destination changed; reload and try again");
        await bindCredentials(tx as unknown as Db, companyId, id, pins);
        return updated;
      });
      await audit(companyId, id, "credentials_rotated", actor, { credentialRevision: row.credentialRevision });
      return view(row);
    },

    /** Stops future use. Nothing is deleted, locally or in the bucket. */
    async retire(companyId: string, id: string, input: { expectedRevision: number }, actor: StorageDestinationActor) {
      const current = await get(companyId, id);
      if (current.retiredAt) return view(current);
      const [row] = await db
        .update(storageDestinations)
        .set({ retiredAt: new Date(), revision: sql`${storageDestinations.revision} + 1`, updatedAt: new Date() })
        .where(and(
          eq(storageDestinations.companyId, companyId),
          eq(storageDestinations.id, id),
          eq(storageDestinations.revision, input.expectedRevision),
          isNull(storageDestinations.retiredAt),
        ))
        .returning();
      if (!row) throw conflict("The destination changed; reload and try again");
      await audit(companyId, id, "retired", actor, { revision: row.revision });
      return view(row);
    },

    /**
     * PUT, HEAD (size and encryption), GET with SHA-256, an unauthenticated
     * GET that must be refused, an optional out-of-prefix write, and DELETE.
     * The intent is stored before any network call; cleanup has its own
     * deadline, and a failed probe never blocks retiring the destination.
     */
    async probe(companyId: string, id: string, actor: StorageDestinationActor): Promise<StorageProbeResult> {
      const row = await get(companyId, id);
      if (row.retiredAt) throw conflict("Storage destination is retired");
      const location = row.locationJson;
      const probeId = randomUUID();
      const result: StorageProbeResult = {
        probeId,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        credentialRevision: row.credentialRevision,
        checks: { write: "skipped", read: "skipped", checksum: "skipped", delete: "skipped" },
        encryption: "unverified",
        publicRead: "unknown",
        isolation: location.prefix ? "unknown" : "not_applicable",
        errorCode: null,
        error: null,
      };
      await writeProbe(row, result);

      const objectKey = `${PROBE_PREFIX}/${probeId}`;
      const signal = AbortSignal.timeout(probeTimeoutMs);
      let client: StorageProvider | null = null;
      let wrote = false;
      try {
        storageEndpointPolicy(location);
        const credentials = await resolveCredentials(row);
        client = await providerFactory({ location, credentials });
        const body = randomBytes(32);
        const expectedSha = createHash("sha256").update(body).digest("hex");
        try {
          await client.putObject({ objectKey, body, contentType: "application/octet-stream", contentLength: body.length });
        } catch (error) {
          result.checks.write = "failed";
          throw error;
        }
        wrote = true;
        result.checks.write = "passed";

        const head = await client.headObject({ objectKey, signal });
        if (!head.exists || head.contentLength !== body.length) {
          result.checks.read = "failed";
          throw new ProbeFailure("read_mismatch");
        }
        result.encryption = encryptionVerdict(location.encryption, head.serverSideEncryption);
        if (result.encryption === "failed") throw new ProbeFailure("encryption_mismatch");

        const object = await client.getObject({ objectKey, signal });
        const hash = createHash("sha256");
        for await (const chunk of object.stream) hash.update(chunk as Buffer);
        result.checks.read = "passed";
        result.checks.checksum = hash.digest("hex") === expectedSha ? "passed" : "failed";
        if (result.checks.checksum === "failed") throw new ProbeFailure("read_mismatch");

        const anonymousStatus = await anonymousGet(storageObjectUrl(location, objectKey), location, signal).catch(() => null);
        result.publicRead = anonymousStatus === null ? "unknown" : anonymousStatus >= 200 && anonymousStatus < 300 ? "allowed" : "denied";
        if (result.publicRead === "allowed") throw new ProbeFailure("public_read");

        if (location.prefix) result.isolation = await checkIsolation(row, credentials, probeId);
        result.status = "passed";
      } catch (error) {
        const code = signal.aborted ? "timeout" : probeErrorCode(error);
        result.status = "failed";
        result.errorCode = code;
        result.error = PROBE_ERRORS[code];
      } finally {
        if (wrote && client) {
          try {
            await client.deleteObject({ objectKey, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
            result.checks.delete = "passed";
          } catch {
            result.checks.delete = "failed";
            if (result.status === "passed") {
              result.status = "failed";
              result.errorCode = "cleanup_failed";
              result.error = PROBE_ERRORS.cleanup_failed;
            }
          }
        }
        result.finishedAt = new Date().toISOString();
        await writeProbe(row, result);
      }
      await audit(companyId, id, "probed", actor, {
        probeId,
        status: result.status,
        errorCode: result.errorCode,
        encryption: result.encryption,
        publicRead: result.publicRead,
        isolation: result.isolation,
      });
      return result;
    },
  };
}

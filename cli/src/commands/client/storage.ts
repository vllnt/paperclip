import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  STORAGE_ENCRYPTION_MODES,
  type CreateStorageDestination,
  type StorageDestinationView,
  type StorageEncryptionMode,
  type StorageProbeResult,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CreateOptions extends BaseClientOptions {
  companyId?: string;
  id?: string;
  label: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  pathStyle?: boolean;
  encryption?: string;
  kmsKeyId?: string;
  accessKeySecret: string;
  secretKeySecret: string;
}

interface RotateOptions extends BaseClientOptions {
  companyId?: string;
  accessKeySecret: string;
  secretKeySecret: string;
  expectedCredentialRevision: string;
}

interface RetireOptions extends BaseClientOptions {
  companyId?: string;
  expectedRevision: string;
}

function parseRevision(value: string, flag: string): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) throw new Error(`${flag} must be a non-negative integer`);
  return revision;
}

function parseEncryption(value: string | undefined): StorageEncryptionMode {
  const mode = value ?? "s3_managed";
  if (!(STORAGE_ENCRYPTION_MODES as readonly string[]).includes(mode)) {
    throw new Error(`--encryption must be one of ${STORAGE_ENCRYPTION_MODES.join(", ")}`);
  }
  return mode as StorageEncryptionMode;
}

/** `/companies/:id/storage/destinations[/:destinationId/<action>]` */
function destinationsPath(companyId: string | undefined, destinationId?: string, action?: string): string {
  const base = apiPath`/api/companies/${companyId}/storage/destinations`;
  if (!destinationId) return base;
  return `${base}${apiPath`/${destinationId}`}${action ? `/${action}` : ""}`;
}

export function registerStorageCommands(program: Command): void {
  const storage = program.command("storage").description("Company storage destinations (board only)");
  const destinations = storage.command("destinations").description("S3-compatible destinations with company secret references");

  addCommonClientOptions(
    destinations
      .command("list")
      .description("List the company's storage destinations")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions & { companyId?: string }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await ctx.api.get<StorageDestinationView[]>(destinationsPath(ctx.companyId));
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    destinations
      .command("create")
      .description("Create a destination; repeat with the same --id to retry safely")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--id <uuid>", "Client-generated destination id (default: a new one)")
      .requiredOption("--label <label>", "Display name")
      .requiredOption("--endpoint <url>", "S3 endpoint origin, for example https://s3.eu-west-1.amazonaws.com")
      .requiredOption("--region <region>", "Region, for example eu-west-1")
      .requiredOption("--bucket <bucket>", "Bucket name")
      .option("--prefix <prefix>", "Key prefix inside the bucket", "")
      .option("--path-style", "Use path-style addressing (MinIO and some S3-compatible services)")
      .option("--encryption <mode>", `Server-side encryption: ${STORAGE_ENCRYPTION_MODES.join(", ")}`, "s3_managed")
      .option("--kms-key-id <id>", "KMS key id, with --encryption kms")
      .requiredOption("--access-key-secret <secretId>", "Company secret holding the access key id")
      .requiredOption("--secret-key-secret <secretId>", "Company secret holding the secret access key")
      .action(async (opts: CreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const mode = parseEncryption(opts.encryption);
          const body: CreateStorageDestination = {
            id: opts.id ?? randomUUID(),
            label: opts.label,
            location: {
              endpoint: opts.endpoint.endsWith("/") ? opts.endpoint : `${opts.endpoint}/`,
              region: opts.region,
              bucket: opts.bucket,
              prefix: opts.prefix ?? "",
              forcePathStyle: Boolean(opts.pathStyle),
              encryption: mode === "kms" ? { mode, kmsKeyId: opts.kmsKeyId } : { mode },
            },
            credentials: { accessKeySecretId: opts.accessKeySecret, secretKeySecretId: opts.secretKeySecret },
          };
          const row = await ctx.api.post<StorageDestinationView>(destinationsPath(ctx.companyId), body);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    destinations
      .command("probe")
      .description("Write, read, checksum and delete a probe object; check encryption, public read and prefix isolation")
      .argument("<destinationId>", "Destination ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (destinationId: string, opts: BaseClientOptions & { companyId?: string }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<StorageProbeResult>(destinationsPath(ctx.companyId, destinationId, "probe"), {});
          printOutput(result, { json: ctx.json });
          if (result?.status === "failed") process.exitCode = 1;
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    destinations
      .command("rotate-credentials")
      .description("Point a destination at new company secrets")
      .argument("<destinationId>", "Destination ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--access-key-secret <secretId>", "Company secret holding the access key id")
      .requiredOption("--secret-key-secret <secretId>", "Company secret holding the secret access key")
      .requiredOption("--expected-credential-revision <n>", "Current credential revision (from list)")
      .action(async (destinationId: string, opts: RotateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.patch<StorageDestinationView>(destinationsPath(ctx.companyId, destinationId, "credentials"), {
            credentials: { accessKeySecretId: opts.accessKeySecret, secretKeySecretId: opts.secretKeySecret },
            expectedCredentialRevision: parseRevision(opts.expectedCredentialRevision, "--expected-credential-revision"),
          });
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    destinations
      .command("retire")
      .description("Stop using a destination; nothing is deleted")
      .argument("<destinationId>", "Destination ID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--expected-revision <n>", "Current revision (from list)")
      .action(async (destinationId: string, opts: RetireOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<StorageDestinationView>(destinationsPath(ctx.companyId, destinationId, "retire"), {
            expectedRevision: parseRevision(opts.expectedRevision, "--expected-revision"),
          });
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

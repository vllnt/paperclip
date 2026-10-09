import { z } from "zod";

/**
 * Company storage destinations (the S3-01 contract of the company S3 storage
 * plan). A destination is an immutable S3-compatible location plus explicit
 * company secret references; there is no ambient credential fallback.
 * Location validation adapted from the unmerged 2026-10-04 S3 storage work.
 */
const uuid = z.string().uuid();

export const STORAGE_ENCRYPTION_MODES = ["s3_managed", "kms", "bucket_default"] as const;
export type StorageEncryptionMode = (typeof STORAGE_ENCRYPTION_MODES)[number];

export const storageEncryptionSchema = z
  .object({
    mode: z.enum(STORAGE_ENCRYPTION_MODES),
    kmsKeyId: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .refine((value) => value.mode !== "kms" || Boolean(value.kmsKeyId), {
    message: "KMS encryption needs a key id",
    path: ["kmsKeyId"],
  })
  .refine((value) => value.mode === "kms" || value.kmsKeyId === undefined, {
    message: "A key id is only used with KMS encryption",
    path: ["kmsKeyId"],
  });
export type StorageEncryption = z.infer<typeof storageEncryptionSchema>;

export const storageS3LocationSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(512)
      .refine((value) => {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol)
          && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
      }, "Use an S3 endpoint origin, without a path, query or credentials"),
    region: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use a region such as us-east-1"),
    bucket: z
      .string()
      .trim()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Use a valid bucket name")
      .refine((value) => !value.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(value), "Use a valid bucket name"),
    prefix: z
      .string()
      .trim()
      .max(256)
      .regex(/^([a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*)?$/, "Use letters, digits, - and _ separated by /")
      .default(""),
    forcePathStyle: z.boolean().default(false),
    encryption: storageEncryptionSchema.default({ mode: "s3_managed" }),
  })
  .strict();
export type StorageS3Location = z.infer<typeof storageS3LocationSchema>;

export const storageCredentialRefsSchema = z
  .object({ accessKeySecretId: uuid, secretKeySecretId: uuid })
  .strict()
  .refine((value) => value.accessKeySecretId !== value.secretKeySecretId, {
    message: "Use two different secrets for the access key id and the secret key",
  });
export type StorageCredentialRefs = z.infer<typeof storageCredentialRefsSchema>;

/** Secret references with the versions pinned when they were set. */
export interface StorageCredentialPins extends StorageCredentialRefs {
  accessKeyVersion: number;
  secretKeyVersion: number;
}

export const createStorageDestinationSchema = z
  .object({
    /** Client-generated, so a retried create returns the same destination. */
    id: uuid,
    label: z.string().trim().min(1).max(80),
    location: storageS3LocationSchema,
    credentials: storageCredentialRefsSchema,
  })
  .strict();
export type CreateStorageDestination = z.infer<typeof createStorageDestinationSchema>;

export const rotateStorageCredentialsSchema = z
  .object({
    credentials: storageCredentialRefsSchema,
    expectedCredentialRevision: z.number().int().nonnegative(),
  })
  .strict();

export const retireStorageDestinationSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();

export const STORAGE_PROBE_CHECK_RESULTS = ["passed", "failed", "skipped"] as const;
export type StorageProbeCheckResult = (typeof STORAGE_PROBE_CHECK_RESULTS)[number];

export interface StorageProbeResult {
  probeId: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  credentialRevision: number;
  checks: {
    write: StorageProbeCheckResult;
    read: StorageProbeCheckResult;
    checksum: StorageProbeCheckResult;
    delete: StorageProbeCheckResult;
  };
  /** `verified`: the provider reported the requested encryption on the object. */
  encryption: "verified" | "unverified" | "failed";
  /** `allowed` fails the probe: the object was readable without credentials. */
  publicRead: "denied" | "allowed" | "unknown";
  /** Whether the key can write outside the destination prefix. */
  isolation: "prefix_scoped" | "bucket_wide" | "not_applicable" | "unknown";
  errorCode: string | null;
  error: string | null;
  /**
   * A newer probe that has started but not finished. The fields above keep
   * the previous result until the new one replaces them, so a destination
   * that passed stays usable while it is probed again.
   */
  pending?: { probeId: string; startedAt: string } | null;
}

export interface StorageDestinationView {
  id: string;
  companyId: string;
  label: string;
  provider: "s3";
  origin: "company";
  location: StorageS3Location;
  credentials: StorageCredentialPins;
  revision: number;
  credentialRevision: number;
  lastProbe: StorageProbeResult | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

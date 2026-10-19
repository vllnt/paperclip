import { z } from "zod";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
} from "../constants.js";
import { commaSeparatedEnumQuerySchema } from "./query.js";
import { envConfigSchema } from "./secret.js";

export const environmentDriverSchema = z.enum(ENVIRONMENT_DRIVERS);
export const environmentStatusSchema = z.enum(ENVIRONMENT_STATUSES);
export const environmentLeaseStatusSchema = z.enum(ENVIRONMENT_LEASE_STATUSES);
export const environmentLeaseCleanupStatusSchema = z.enum(ENVIRONMENT_LEASE_CLEANUP_STATUSES);

/** Lease statuses listed by `GET /api/companies/:companyId/environment-leases` when `status` is omitted. */
export const COMPANY_ENVIRONMENT_LEASES_DEFAULT_STATUSES = ["active", "pending_cleanup"] as const;

export const listEnvironmentLeasesQuerySchema = z.object({
  status: commaSeparatedEnumQuerySchema(ENVIRONMENT_LEASE_STATUSES).describe(
    "Comma-separated lease statuses: active, released, expired, failed, retained, pending_cleanup. " +
      "Omitted lists every status for an environment and active,pending_cleanup for a company.",
  ),
});
export type ListEnvironmentLeasesQuery = z.infer<typeof listEnvironmentLeasesQuerySchema>;

const environmentFields = {
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema,
  status: environmentStatusSchema.optional().default("active"),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  envVars: envConfigSchema.optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
};

export const createEnvironmentSchema = z.object(environmentFields).strict();
export type CreateEnvironment = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema.optional(),
  status: environmentStatusSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  envVars: envConfigSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();
export type UpdateEnvironment = z.infer<typeof updateEnvironmentSchema>;

export const probeEnvironmentConfigSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema,
  config: z.record(z.string(), z.unknown()).optional().default({}),
  envVars: envConfigSchema.optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();
export type ProbeEnvironmentConfig = z.infer<typeof probeEnvironmentConfigSchema>;

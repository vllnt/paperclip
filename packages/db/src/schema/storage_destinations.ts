import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { StorageCredentialPins, StorageProbeResult, StorageS3Location } from "@paperclipai/shared";
import { companies } from "./companies.js";

/**
 * Company storage destinations (S3-01 of the company S3 storage plan). The
 * location is immutable: a change is a new destination. Credentials are
 * company secret references, pinned to a version and mirrored by
 * `company_secret_bindings` rows with target type `storage_destination`.
 */
export const storageDestinations = pgTable("storage_destinations", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"s3">().notNull().default("s3"),
  origin: text("origin").$type<"company">().notNull().default("company"),
  label: text("label").notNull(),
  locationJson: jsonb("location_json").$type<StorageS3Location>().notNull(),
  /** Normalized endpoint host and bucket: one physical bucket serves one company per instance. */
  physicalKey: text("physical_key").notNull(),
  credentialsJson: jsonb("credentials_json").$type<StorageCredentialPins>().notNull(),
  revision: integer("revision").notNull().default(0),
  credentialRevision: integer("credential_revision").notNull().default(0),
  lastProbeJson: jsonb("last_probe_json").$type<StorageProbeResult>(),
  /** Random value in the bucket's ownership marker; set before the marker is first written. */
  ownerNonce: text("owner_nonce"),
  /** First passing probe. The claim on the bucket outlives retirement: retiring deletes nothing. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Composite target for company-owned references (archive settings, assets).
  unique("storage_destinations_company_id_uq").on(t.companyId, t.id),
  index("storage_destinations_company_created_idx").on(t.companyId, t.createdAt),
  index("storage_destinations_physical_key_idx").on(t.physicalKey),
  check("storage_destinations_provider_check", sql`${t.provider} in ('s3')`),
  check("storage_destinations_origin_check", sql`${t.origin} in ('company')`),
]);

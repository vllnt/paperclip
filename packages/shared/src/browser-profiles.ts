import { z } from "zod";

export const BROWSER_PROFILE_NAME_MAX = 80;
export const BROWSER_PROFILE_MAX_DOMAINS = 50;
export const BROWSER_PROFILE_MAX_AGENTS = 100;
export const BROWSER_FILL_VALUE_MAX = 2000;
export const BROWSER_WAIT_MAX_MS = 10_000;
export const BROWSER_SIGNIN_LEASE_MS = 15 * 60 * 1000;

/**
 * Host patterns an agent may navigate to: `app.example.com` matches that host
 * only, `*.example.com` matches every subdomain but not the apex.
 */
const hostPattern =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const browserAllowedDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(hostPattern, "Use a host such as app.example.com or *.example.com");

export const browserProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(BROWSER_PROFILE_NAME_MAX);

export const browserProfileStatusSchema = z.enum(["active", "suspended"]);
export type BrowserProfileStatus = z.infer<typeof browserProfileStatusSchema>;

export const createBrowserProfileSchema = z
  .object({
    name: browserProfileNameSchema,
    allowedDomains: z
      .array(browserAllowedDomainSchema)
      .max(BROWSER_PROFILE_MAX_DOMAINS)
      .default([]),
  })
  .strict();
export type CreateBrowserProfile = z.infer<typeof createBrowserProfileSchema>;

export const updateBrowserProfileSchema = z
  .object({
    name: browserProfileNameSchema.optional(),
    allowedDomains: z
      .array(browserAllowedDomainSchema)
      .max(BROWSER_PROFILE_MAX_DOMAINS)
      .optional(),
    allowedAgentIds: z
      .array(z.string().uuid())
      .max(BROWSER_PROFILE_MAX_AGENTS)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
export type UpdateBrowserProfile = z.infer<typeof updateBrowserProfileSchema>;

export const companyBrowserSettingsSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type CompanyBrowserSettings = z.infer<
  typeof companyBrowserSettingsSchema
>;

export interface BrowserProfile {
  id: string;
  companyId: string;
  name: string;
  status: BrowserProfileStatus;
  allowedDomains: string[];
  allowedAgentIds: string[];
  hasSavedSession: boolean;
  lastSavedAt: string | null;
  signIn: { active: boolean; userId: string | null; expiresAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface BrowserRuntimeStatus {
  available: boolean;
  reason: string | null;
}

export interface BrowserProfilesOverview {
  enabled: boolean;
  runtime: BrowserRuntimeStatus;
  profiles: BrowserProfile[];
}

export const browserSignInStartSchema = z
  .object({ startUrl: z.string().url().max(2048).optional() })
  .strict();

export const browserKeySchema = z.enum([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);
export type BrowserKey = z.infer<typeof browserKeySchema>;

const pixel = z.number().int().min(0).max(8192);

/** Input a signed-in board user relays to the live browser. */
export const browserSignInInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url().max(2048) }).strict(),
  z.object({ type: z.literal("click"), x: pixel, y: pixel }).strict(),
  z
    .object({ type: z.literal("type"), text: z.string().min(1).max(500) })
    .strict(),
  z.object({ type: z.literal("key"), key: browserKeySchema }).strict(),
  z
    .object({ type: z.literal("scroll"), deltaY: z.number().int().min(-2000).max(2000) })
    .strict(),
]);
export type BrowserSignInInput = z.infer<typeof browserSignInInputSchema>;

export interface BrowserSignInState {
  url: string;
  title: string;
  width: number;
  height: number;
  expiresAt: string;
}

const ref = z.string().regex(/^e[0-9]{1,6}$/);

/**
 * The only operations an agent can request. There is deliberately no script,
 * cookie, storage or state operation: the saved session never leaves the server.
 */
export const browserAgentActionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("navigate"), url: z.string().url().max(2048) })
    .strict(),
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("click"), ref }).strict(),
  z
    .object({
      action: z.literal("fill"),
      ref,
      value: z.string().max(BROWSER_FILL_VALUE_MAX),
    })
    .strict(),
  z.object({ action: z.literal("press"), key: browserKeySchema }).strict(),
  z
    .object({
      action: z.literal("scroll"),
      direction: z.enum(["up", "down"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      ms: z.number().int().min(0).max(BROWSER_WAIT_MAX_MS),
    })
    .strict(),
  z.object({ action: z.literal("close") }).strict(),
]);
export type BrowserAgentAction = z.infer<typeof browserAgentActionSchema>;

export interface BrowserAgentActionResult {
  ok: true;
  url: string;
  title: string;
  snapshot: string | null;
  note: string | null;
}

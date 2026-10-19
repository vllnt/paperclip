export const PLUGIN_ID = "vllnt.paperclip-convex";

/** Only capabilities that a tool in this version enforces. A grant for anything else is refused at config time, never silently ignored. */
export const CAPABILITIES = ["meta-read", "health-read", "logs-read", "data-read-pii", "lifecycle"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ENVIRONMENT_CLASSES = ["production", "staging", "preview", "dev", "custom"] as const;
export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** Presets expand to capabilities; they never widen the environments a grant lists. */
export const PRESETS = {
  observer: ["meta-read", "health-read"],
  janitor: ["meta-read", "health-read", "lifecycle"],
} as const satisfies Record<string, readonly Capability[]>;
export type Preset = keyof typeof PRESETS;

/** `owner/name` with no `.` or `..` segment: the value is placed in a GitHub API path, where those would change the endpoint. */
export const isRepositoryName = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.split("/").every(part => part !== "." && part !== "..");

export const MAX_PREVIEW_TTL_HOURS = 168;
export const MIN_EXPIRY_LEAD_MS = 30 * 60_000;
export const HOUR_MS = 3_600_000;

export interface SecretRef { type: "secret_ref"; secretId: string; version?: "latest" }

export interface ProjectMapping {
  convexProjectId: string;
  name: string;
  repository: string | null;
  paperclipProjectId: string | null;
  token: SecretRef | null;
  previewDeployKey: SecretRef | null;
  production: string[];
  staging: string[];
}

export interface Grant {
  agentId: string | null;
  role: string | null;
  environments: EnvironmentClass[];
  capabilities: Capability[];
}

export interface ConnectionConfig {
  teamId: string | null;
  teamToken: SecretRef | null;
  projects: ProjectMapping[];
  githubToken: SecretRef | null;
  grants: Grant[];
  guards: { activityHours: number; maxDeletesPerRun: number; callsPerMinute: number; dryRunOnly: boolean };
  reaper: { enabled: boolean; ttlHours: number; quota: number; alertPercent: number };
}

/** A Convex deployment as the plugin uses it. Unknown or malformed fields become null and classify as production. */
export interface ConvexDeployment {
  name: string;
  kind: string | null;
  deploymentType: string | null;
  projectId: string | null;
  reference: string | null;
  previewIdentifier: string | null;
  createTime: number | null;
  lastDeployTime: number | null;
  expiresAt: number | null;
  isDefault: boolean | null;
  creator: string | null;
  region: string | null;
  deploymentClass: string | null;
  deploymentUrl: string | null;
}

export type ConnectionState = "connected" | "disconnected" | "not-configured" | "not-connected";

export interface ReaperItem { name: string; previewIdentifier: string | null; reason: string }
export interface ReaperProjectReport {
  convexProjectId: string;
  name: string;
  previews: number;
  delete: ReaperItem[];
  setExpiry: Array<{ name: string; from: number | null; to: number }>;
  kept: number;
  deleted: string[];
  expirySet: string[];
  failed: Array<{ name: string; error: string }>;
  skipped: ReaperItem[];
  /** Previews not examined, and expiry changes not planned, because the time budget or the per-pass limit was reached. The next pass continues with the oldest. */
  deferred?: number;
  error?: string;
}
export interface ReaperReport {
  at: string;
  trigger: "schedule" | "manual" | "retry" | "api";
  dryRun: boolean;
  projects: ReaperProjectReport[];
  quota: { count: number; quota: number; percent: number; partial: boolean; alert: boolean; lowerBound?: boolean; issueId?: string | null } | null;
  errors: string[];
  /** Why the pass stopped before it finished (time budget, repeated outage, operator stop). The next hourly pass starts over, oldest previews first. */
  incomplete?: string;
}

export const PLUGIN_ID = "vllnt.paperclip-convex";
export const PAGE_PATH = "/convex";

export const CAPABILITIES = [
  "meta-read", "health-read", "logs-read", "data-read-pii", "env-read-names", "env-read-values", "env-write",
  "run-query", "run-write", "deploy", "lifecycle", "backup", "restore-import", "admin",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ENVIRONMENT_CLASSES = ["production", "staging", "preview", "dev", "custom"] as const;
export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** Presets expand to capabilities; they never widen the environments a grant lists. */
export const PRESETS = {
  observer: ["meta-read", "health-read"],
  triager: ["meta-read", "health-read", "logs-read", "env-read-names", "run-query"],
  janitor: ["meta-read", "health-read", "lifecycle"],
} as const satisfies Record<string, readonly Capability[]>;
export type Preset = keyof typeof PRESETS;

/** Writes that on production need a per-call board approval (slice 3) and so cannot be granted without it. */
export const PRODUCTION_WRITE_CAPABILITIES: readonly Capability[] = ["env-write", "run-write", "deploy", "restore-import", "admin"];

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
  approval: "per-call" | null;
}

export interface ConnectionConfig {
  teamId: string | null;
  teamToken: SecretRef | null;
  projects: ProjectMapping[];
  githubToken: SecretRef | null;
  grants: Grant[];
  guards: { activityHours: number; maxDeletesPerRun: number; callsPerMinute: number; dryRunOnly: boolean };
  reaper: {
    enabled: boolean; ttlHours: number; quota: number; alertPercent: number;
    /** Dev deployments older than `maxAgeDays` are deleted by the reaper once `enabled`; until then they are only planned. */
    dev: { enabled: boolean; maxAgeDays: number; protect: string[]; onlyPatterns: string[]; maxDeletes: number };
    /** Template such as `pr{pr}-run{run}-s{shard}-a{attempt}` that reads the pull request from a CI preview name. */
    ciPreviewTemplate: string | null;
    supersededMinAgeMinutes: number;
  };
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
export interface ReaperDevReport {
  listed: number;
  delete: ReaperItem[];
  deleted: string[];
  kept: number;
  failed: Array<{ name: string; error: string }>;
  skipped: ReaperItem[];
  /** True when deletions were attempted; false for a plan only (dry run, dev policy off, or an agent started the pass). */
  executed: boolean;
  error?: string;
}
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
  /** How many previews the CI template matched; shown so a template that never matches is visible. Absent without a template. */
  ciMatched?: number;
  dev?: ReaperDevReport;
  error?: string;
}
export interface ReaperReport {
  at: string;
  trigger: "schedule" | "manual" | "retry" | "api";
  dryRun: boolean;
  projects: ReaperProjectReport[];
  quota: { count: number; quota: number; percent: number; partial: boolean; alert: boolean; issueId?: string | null } | null;
  errors: string[];
}

import type { RoutineTrigger } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Typed client for event sources (design-event-wake §3.1, §3.7).
 *
 * These types mirror the server contract being built in parallel (A1,
 * `feat/event-sources-server`). They live in the UI package until the server
 * PR lands the shared types; at that point they should be swapped for the
 * `@paperclipai/shared` exports without changing call sites.
 */

export const EVENT_SIGNING_MODES = ["hmac_sha256", "bearer"] as const;
export type EventSigningMode = (typeof EVENT_SIGNING_MODES)[number];

export const EVENT_NORMALIZERS = ["generic_v1", "gatus"] as const;
export type EventNormalizer = (typeof EVENT_NORMALIZERS)[number];

export const EVENT_SEVERITIES = ["info", "warning", "critical"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const EVENT_STATES = ["problem", "recovery", "info"] as const;
export type EventState = (typeof EVENT_STATES)[number];

export const EVENT_ON_RECOVERY_MODES = ["comment_and_wake", "comment_only", "ignore"] as const;
export type EventOnRecovery = (typeof EVENT_ON_RECOVERY_MODES)[number];

export const EVENT_DELIVERY_STATUSES = [
  "processing",
  "dispatched",
  "grouped_silent",
  "invalid",
  "unrouted",
  "storm_folded",
  "recovery_without_issue",
  "failed",
] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

export interface EventSource {
  id: string;
  companyId: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  publicId: string;
  /** Absolute ingest URL: `POST …/api/event-sources/public/{publicId}/events`. */
  ingestUrl: string;
  signingMode: EventSigningMode;
  replayWindowSec: number;
  normalizer: EventNormalizer;
  normalizerConfig: Record<string, unknown> | null;
  pinnedLabels: Record<string, string>;
  rateLimitPerMinute: number;
  maxNewIssuesPerHour: number;
  retentionDays: number;
  lastDeliveryAt: string | null;
  lastResult: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned once, on create and on rotate. Never returned by any other call. */
export interface EventSourceSecretMaterial {
  ingestUrl: string;
  secret: string;
  signingMode: EventSigningMode;
}

export interface EventSourceWithSecret {
  eventSource: EventSource;
  secretMaterial: EventSourceSecretMaterial;
}

export interface CreateEventSourceInput {
  name: string;
  signingMode?: EventSigningMode;
  replayWindowSec?: number;
  normalizer?: EventNormalizer;
  normalizerConfig?: Record<string, unknown> | null;
  pinnedLabels?: Record<string, string>;
  rateLimitPerMinute?: number;
  maxNewIssuesPerHour?: number;
  retentionDays?: number;
}

export type UpdateEventSourceInput = Partial<Omit<CreateEventSourceInput, "signingMode">> & {
  enabled?: boolean;
};

export interface NormalizedEvent {
  schema?: string;
  eventId?: string;
  source: string;
  type: string;
  severity: EventSeverity;
  state: EventState;
  dedupeKey: string;
  title: string;
  summary?: string;
  labels: Record<string, string>;
  occurredAt?: string;
  url?: string;
}

export const EVENT_TEST_ACTIONS = [
  "new_issue",
  "comment",
  "silent",
  "recovery_comment",
  "recovery_without_issue",
  "storm_folded",
  "append_target_unavailable",
] as const;
export type EventTestAction = (typeof EVENT_TEST_ACTIONS)[number];

export interface EventTestMatch {
  triggerId: string;
  routineId: string;
  routineTitle: string;
  assigneeAgentId: string | null;
  assigneeAgentName?: string | null;
  fallback: boolean;
  groupKey: string;
  action: EventTestAction;
  /** The open group issue a comment would land on, when there is one. */
  issueId?: string | null;
  issueIdentifier?: string | null;
}

/** Result of the dry run. Nothing is written when it is requested. */
export interface EventTestResult {
  /** `null` when the payload failed normalization. */
  event: NormalizedEvent | null;
  errors: string[];
  matches: EventTestMatch[];
  fallbackMatches: EventTestMatch[];
  outcome: "dispatched" | "unrouted" | "invalid";
}

export interface EventDelivery {
  id: string;
  sourceId: string;
  status: EventDeliveryStatus;
  receivedAt: string;
  httpStatus: number | null;
  latencyMs: number | null;
  attempts: number;
  /** Redacted, capped normalized event; `null` for invalid deliveries. */
  event: NormalizedEvent | null;
  matchedTriggerIds: string[];
  routineRunIds: string[];
  issueIds: string[];
  routineOutcomes: Record<string, { status: string; runId?: string; issueId?: string; failureClass?: string; error?: string }>;
  error: string | null;
}

export interface EventDeliveryPage {
  items: EventDelivery[];
  nextCursor: string | null;
}

export interface EventGroup {
  id: string;
  routineId: string;
  fingerprint: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCommentAt: string | null;
  repeatCount: number;
  lastSeverity: EventSeverity | null;
  lastState: EventState | null;
}

export interface EventMatch {
  sources?: string[];
  types?: string[];
  minSeverity?: EventSeverity;
  /** A single string is an exact/glob value; an array means any-of. */
  labels?: Record<string, string | string[]>;
}

export interface EventGrouping {
  groupKey: string;
  repeatCommentCooldownSec: number;
  rewakeOnSeverityIncrease: boolean;
  onRecovery: EventOnRecovery;
  issueMode: "group" | { appendToIssueId: string };
}

export type EventRoutineTrigger = RoutineTrigger & {
  kind: "event";
  eventSourceId: string | null;
  eventMatch: EventMatch | null;
  eventGrouping: EventGrouping | null;
  fallback: boolean;
};

export function isEventTrigger(trigger: RoutineTrigger): trigger is EventRoutineTrigger {
  return trigger.kind === "event";
}

export interface EventSourceDeliveryFilters {
  status?: EventDeliveryStatus | "all";
  limit?: number;
  cursor?: string | null;
}

export const eventSourcesApi = {
  list: (companyId: string) =>
    api.get<EventSource[]>(`/companies/${companyId}/event-sources`),
  create: (companyId: string, data: CreateEventSourceInput) =>
    api.post<EventSourceWithSecret>(`/companies/${companyId}/event-sources`, data),
  get: (id: string) => api.get<EventSource>(`/event-sources/${id}`),
  update: (id: string, data: UpdateEventSourceInput) =>
    api.patch<EventSource>(`/event-sources/${id}`, data),
  archive: (id: string) => api.delete<void>(`/event-sources/${id}`),
  rotateSecret: (id: string) =>
    api.post<EventSourceWithSecret>(`/event-sources/${id}/rotate-secret`, {}),
  test: (id: string, payload: Record<string, unknown>) =>
    api.post<EventTestResult>(`/event-sources/${id}/test`, { payload }),
  deliveries: (id: string, filters: EventSourceDeliveryFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.status && filters.status !== "all") params.set("status", filters.status);
    if (filters.limit) params.set("limit", String(filters.limit));
    if (filters.cursor) params.set("cursor", filters.cursor);
    const query = params.toString();
    return api.get<EventDeliveryPage>(`/event-sources/${id}/deliveries${query ? `?${query}` : ""}`);
  },
  routineEventGroups: (routineId: string, filters: { open?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (filters.open) params.set("open", "true");
    const query = params.toString();
    return api.get<EventGroup[]>(`/routines/${routineId}/event-groups${query ? `?${query}` : ""}`);
  },
};

import type { RoutineTrigger } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Typed client for event sources (design-event-wake §3.1, §3.7).
 *
 * These JSON response types mirror PR144 (`packages/shared/src/event-sources.ts`
 * and `server/src/services/event-sources/service.ts`), with dates as strings. They live in the UI package until the server
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
  "rejected_aggregate",
] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

export interface EventSource {
  id: string;
  companyId: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  publicId: string;
  /** Absolute ingress URL: `POST …/api/event-sources/public/{publicId}/events`. */
  ingressUrl: string;
  secretId: string | null;
  signingMode: EventSigningMode;
  replayWindowSec: number;
  normalizer: EventNormalizer;
  normalizerConfig: Record<string, unknown> | null;
  pinnedLabels: Record<string, string>;
  rateLimitPerMinute: number;
  maxNewIssuesPerHour: number;
  retentionDays: number;
  lastRotatedAt: string | null;
  lastDeliveryAt: string | null;
  lastResult: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned once, on create and on rotate. Never returned by any other call. */
export interface EventSourceSecretMaterial {
  ingressUrl: string;
  secret: string;
}

export interface EventSourceWithSecret {
  source: EventSource;
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
  eventId: string | null;
  source: string;
  type: string;
  severity: EventSeverity;
  state: EventState;
  dedupeKey: string;
  title: string;
  summary: string;
  labels: Record<string, string>;
  occurredAt: string;
  url: string | null;
}

export const EVENT_TEST_ACTIONS = [
  "new_issue",
  "comment",
  "comment_and_wake",
  "silent",
  "recovery_comment",
  "recovery_ignored",
  "recovery_without_issue",
  "storm_folded",
] as const;
export type EventTestAction = (typeof EVENT_TEST_ACTIONS)[number];

export interface EventTestMatch {
  triggerIds: string[];
  routineId: string;
  routineTitle: string;
  assigneeAgentId: string | null;
  groupKey: string;
  action: EventTestAction;
  /** The open group issue a comment would land on, when there is one. */
  issueId: string | null;
}

/** Result of the dry run. Nothing is written when it is requested. */
export interface EventTestResult {
  /** `null` when the payload failed normalization. */
  event: NormalizedEvent | null;
  validationErrors: string[];
  matched: EventTestMatch[];
  fallback: EventTestMatch[];
  wouldBe: EventDeliveryStatus | null;
}

export interface EventRoutineOutcome {
  status: "issue_created" | "grouped" | "grouped_silent" | "recovered" | "recovery_without_issue"
    | "recovery_ignored" | "storm_folded" | "failed_permanent" | "failed_transient";
  runId?: string | null;
  issueId?: string | null;
  failureClass?: "permanent" | "transient";
  error?: string | null;
  note?: string | null;
}

export type EventRejectOutcome = "unauthorized" | "not_found" | "auth_failure_rate_limited" | "rate_limited" | "duplicate";

export interface EventDelivery {
  id: string;
  companyId: string;
  sourceId: string;
  status: EventDeliveryStatus;
  receivedAt: string;
  claimedAt: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  attempts: number;
  /** Redacted, capped normalized event; `null` for invalid or aggregate deliveries. */
  event: Record<string, unknown> | null;
  matchedTriggerIds: string[];
  routineRunIds: string[];
  issueIds: string[];
  routineOutcomes: Record<string, EventRoutineOutcome>;
  error: string | null;
  rejectCounts: Partial<Record<EventRejectOutcome, number>> | null;
  firstIp: string | null;
  lastIp: string | null;
}

export interface EventDeliveryPage {
  items: EventDelivery[];
  nextCursor: string | null;
}

export interface EventGroup {
  id: string;
  companyId: string;
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
  lastSeverity: EventSeverity;
  lastState: EventState;
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
  list: (companyId: string, { includeArchived = false }: { includeArchived?: boolean } = {}) =>
    api.get<EventSource[]>(`/companies/${companyId}/event-sources${includeArchived ? "?includeArchived=true" : ""}`),
  create: (companyId: string, data: CreateEventSourceInput) =>
    api.post<EventSourceWithSecret>(`/companies/${companyId}/event-sources`, data),
  get: (id: string) => api.get<EventSource>(`/event-sources/${id}`),
  update: (id: string, data: UpdateEventSourceInput) =>
    api.patch<EventSource>(`/event-sources/${id}`, data),
  archive: (id: string) => api.delete<EventSource>(`/event-sources/${id}`),
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
    if (filters.open !== undefined) params.set("open", String(filters.open));
    const query = params.toString();
    return api.get<EventGroup[]>(`/routines/${routineId}/event-groups${query ? `?${query}` : ""}`);
  },
};

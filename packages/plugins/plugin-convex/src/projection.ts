/**
 * Allowlist projections of Convex responses. Fields not named here are dropped, so a field Convex adds later (or one that
 * carries key material) can never reach an agent by accident.
 */
const list = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const id = (value: unknown): string | null => (typeof value === "number" || typeof value === "string" ? String(value) : null);
const items = (raw: unknown, key = "items"): Record<string, unknown>[] =>
  list(raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined);

/** Deploy key metadata only: never the key itself. */
export function projectDeployKeys(raw: unknown) {
  return items(raw).slice(0, 100).map(key => ({
    id: id(key.id), name: text(key.name), createdAt: num(key.creationTime), lastUsedAt: num(key.lastUsedTime), expiresAt: num(key.expiresAt), creator: id(key.creator),
    allowedActions: (Array.isArray(key.allowedActions) ? key.allowedActions : []).filter((action): action is string => typeof action === "string").slice(0, 50),
  }));
}

export function projectCustomDomains(raw: unknown) {
  return items(raw, "domains").slice(0, 100).map(domain => ({
    domain: text(domain.domain), destination: text(domain.requestDestination), createdAt: num(domain.creationTime), verifiedAt: num(domain.verificationTime),
  }));
}

export function projectClasses(raw: unknown) {
  return items(raw).map(item => ({ type: text(item.type), available: item.available === true }));
}
export function projectRegions(raw: unknown) {
  return items(raw).map(item => ({ name: text(item.name), displayName: text(item.displayName), available: item.available === true }));
}

const MAX_METADATA_CHARS = 1000;

/**
 * Deployment audit events. The client IP, user agent and free-form metadata are personal data or may hold secrets, so they
 * are removed unless the caller holds `data-read-pii` for the deployment's environment.
 */
export function projectAuditEvents(raw: unknown, includePii: boolean) {
  const out = items(raw).slice(0, 100).map(event => {
    const actor = event.actor && typeof event.actor === "object" ? event.actor as Record<string, unknown> : {};
    const metadata = includePii ? JSON.stringify(event.metadata ?? null).slice(0, MAX_METADATA_CHARS) : undefined;
    return {
      action: text(event.action), createdAt: num(event.createTime),
      actor: { kind: text(actor.kind), memberId: id(actor.member_id) },
      ...(includePii ? { clientIp: text(event.clientIp), clientUserAgent: text(event.clientUserAgent), metadata } : {}),
    };
  });
  const more = raw && typeof raw === "object" ? (raw as { pagination?: { hasMore?: boolean } }).pagination?.hasMore === true : false;
  return { events: out, hasMore: more };
}

const isFailure = (raw: unknown): raw is { error: string } => !!raw && typeof raw === "object" && "error" in raw && Object.keys(raw).length === 1;
const record = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {});

/** Deployment API answers are projected too; a per-call failure `{error}` passes through unchanged. */
export function projectDeploymentInfo(raw: unknown) {
  if (isFailure(raw)) return raw;
  const info = record(raw);
  return {
    kind: text(info.kind), teamId: id(info.teamId), projectId: id(info.projectId), id: id(info.id), deploymentType: text(info.deploymentType),
    reference: text(info.reference), projectName: text(info.projectName), projectSlug: text(info.projectSlug),
  };
}

export function projectUsage(raw: unknown) {
  if (isFailure(raw)) return raw;
  const usage = record(raw);
  const metrics: Record<string, { unit: string | null; currentDay: number | null; currentMonth: number | null }> = {};
  for (const [name, value] of Object.entries(record(usage.metrics)).slice(0, 40)) {
    if (!/^[A-Za-z]{1,60}$/.test(name)) continue;
    const metric = record(value);
    const window = record(metric.usage);
    metrics[name] = { unit: text(metric.unit), currentDay: num(window.current_day), currentMonth: num(window.current_month) };
  }
  return { seedStatus: text(usage.seedStatus), metrics };
}

export function projectUsageLimits(raw: unknown) {
  if (isFailure(raw)) return raw;
  return {
    usageLimits: items(raw, "usageLimits").slice(0, 100).map(limit => ({
      id: text(limit.id), metric: text(limit.metric), window: text(limit.window), limitType: text(limit.limitType), limit: num(limit.limit), enabled: limit.enabled === true,
    })),
  };
}

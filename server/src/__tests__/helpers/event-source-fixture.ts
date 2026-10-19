import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  heartbeatRuns,
  issues,
  projects,
  type createDb,
} from "@paperclipai/db";
import type { CreateEventSource, EventGrouping, EventMatch } from "@paperclipai/shared";
import { issueService } from "../../services/issues.ts";
import { eventSourceService, type IngestResult } from "../../services/event-sources/service.ts";
import { routineService } from "../../services/routines.ts";

type TestDb = ReturnType<typeof createDb>;

export interface WakeupRecord {
  agentId: string;
  opts: {
    source?: string;
    triggerDetail?: string;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    contextSnapshot?: Record<string, unknown>;
  };
}

/** A generic_v1 wire body. Every field has a sensible default so a test names only what it varies. */
export function wireEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema: "paperclip.event.v1",
    source: "gatus",
    type: "uptime.down",
    severity: "critical",
    state: "problem",
    dedupeKey: "api-health",
    title: "API health check failing",
    summary: "HTTP 503 from /health",
    labels: { service: "api" },
    ...overrides,
  };
}

export async function seedEventFixture(
  db: TestDb,
  opts: {
    now?: () => number;
    /** Runs before every wake; throw to simulate an adapter failure. The default wake still happens afterwards. */
    beforeWakeup?: (agentId: string, opts: WakeupRecord["opts"]) => void | Promise<void>;
  } = {},
) {
  const companyId = randomUUID();
  const defaultResponsibleUserId = randomUUID();
  const issuePrefix = `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const wakeups: WakeupRecord[] = [];
  const clock = { ms: opts.now ? opts.now() : Date.now() };
  const now = opts.now ?? (() => clock.ms);

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix,
    defaultResponsibleUserId,
    requireBoardApprovalForNewAgents: false,
  });
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, companyId, name: "Alerts", status: "in_progress" });

  const heartbeat = {
    wakeup: async (agentId: string, wakeupOpts: WakeupRecord["opts"]) => {
      await opts.beforeWakeup?.(agentId, wakeupOpts);
      wakeups.push({ agentId, opts: wakeupOpts });
      const issueId =
        (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
        (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
        null;
      if (!issueId) return null;
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: wakeupOpts.source ?? "assignment",
        triggerDetail: wakeupOpts.triggerDetail ?? null,
        status: "queued",
        responsibleUserId: defaultResponsibleUserId,
        contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
      });
      await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
      return { id: runId };
    },
  };

  const routinesSvc = routineService(db, { heartbeat });
  const sources = eventSourceService(db, { heartbeat, now });
  const issueSvc = issueService(db);

  async function createAgent(name = "Responder", status: "active" | "terminated" = "active") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function createRoutine(input: {
    assigneeAgentId: string;
    title?: string;
    description?: string;
    status?: "active" | "paused";
    concurrencyPolicy?: "coalesce_if_active" | "always_enqueue" | "skip_if_active";
    variables?: unknown[];
  }) {
    return routinesSvc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: input.title ?? "Respond to alerts",
        description: input.description ?? "Investigate the alert and fix or escalate.",
        assigneeAgentId: input.assigneeAgentId,
        priority: "medium",
        status: input.status ?? "active",
        concurrencyPolicy: input.concurrencyPolicy ?? "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        ...(input.variables ? { variables: input.variables } : {}),
      } as never,
      {},
    );
  }

  async function createSource(input: Partial<CreateEventSource> = {}) {
    const created = await sources.create(
      companyId,
      { name: input.name ?? "Gatus", signingMode: "hmac_sha256", ...input } as CreateEventSource,
      { userId: "board-user" },
    );
    return { source: created.source, secret: created.secretMaterial.secret };
  }

  async function subscribe(
    routineId: string,
    eventSourceId: string,
    trigger: { match?: EventMatch | null; grouping?: Partial<EventGrouping>; fallback?: boolean; label?: string } = {},
  ) {
    const created = await routinesSvc.createTrigger(
      routineId,
      {
        kind: "event",
        label: trigger.label ?? null,
        eventSourceId,
        eventMatch: trigger.match ?? null,
        eventGrouping: trigger.grouping ? ({ ...trigger.grouping } as EventGrouping) : undefined,
        fallback: trigger.fallback ?? false,
      } as never,
      {},
    );
    return created.trigger;
  }

  /** Builds a signed ingest request for a source. */
  function request(
    source: { publicId: string },
    secret: string,
    body: unknown,
    overrides: {
      timestamp?: string;
      signature?: string;
      signaturePrefix?: string;
      ip?: string | null;
      secretOverride?: string;
      bearer?: string | null;
      raw?: Buffer;
    } = {},
  ) {
    const rawBody = overrides.raw ?? Buffer.from(JSON.stringify(body));
    const timestamp = overrides.timestamp ?? String(Math.floor(now() / 1000));
    const signature =
      overrides.signature ??
      `${overrides.signaturePrefix ?? ""}${createHmac("sha256", overrides.secretOverride ?? secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest("hex")}`;
    return {
      publicId: source.publicId,
      ip: overrides.ip === undefined ? "203.0.113.7" : overrides.ip,
      authorizationHeader: overrides.bearer === null ? undefined : overrides.bearer ?? `Bearer ${secret}`,
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody,
      body,
    };
  }

  /** Signs and ingests one event. */
  async function send(
    source: { publicId: string },
    secret: string,
    body: unknown,
    overrides: Parameters<typeof request>[3] = {},
  ): Promise<IngestResult> {
    return sources.ingest(request(source, secret, body, overrides));
  }

  async function issuesFor(routineId: string) {
    return db.select().from(issues).where(eq(issues.originId, routineId));
  }

  return {
    companyId,
    projectId,
    wakeups,
    clock,
    db,
    heartbeat,
    routinesSvc,
    sources,
    issueSvc,
    createAgent,
    createRoutine,
    createSource,
    subscribe,
    request,
    send,
    issuesFor,
    advance: (ms: number) => {
      clock.ms += ms;
    },
  };
}

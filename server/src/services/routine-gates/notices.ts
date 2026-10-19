import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { issues, routineRuns, type Db, type routines } from "@paperclipai/db";
import type { RoutineGateResult } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import type { issueService } from "../issues.js";
import { ROUTINE_GATE_ACTOR_ID } from "./outcome.js";

type RoutineRow = typeof routines.$inferSelect;

/** Issue origin of the "Gate failing" notice; one open issue per routine. */
export const ROUTINE_GATE_FAILURE_ORIGIN_KIND = "routine_gate_failure";

const CONSECUTIVE_SCRIPT_FAULTS = 5;
const CONSECUTIVE_SILENT_SKIPS_WITH_STDERR = 3;
const TRANSPORT_FAULT_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 50;
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

const SCRIPT_FAULT_CLASSES = new Set(["script_fault", "timeout", "overflow"]);

interface GateRunSample {
  triggeredAt: Date;
  result: RoutineGateResult;
}

/** Why the gate looks broken, or null while it looks healthy. History is newest first. */
export function describeGateFailure(history: GateRunSample[], now: Date): string | null {
  const faults = history.slice(0, CONSECUTIVE_SCRIPT_FAULTS);
  if (faults.length === CONSECUTIVE_SCRIPT_FAULTS && faults.every((sample) => SCRIPT_FAULT_CLASSES.has(sample.result.class))) {
    return `The gate script failed ${CONSECUTIVE_SCRIPT_FAULTS} times in a row (latest: ${faults[0]!.result.class}).`;
  }

  const streak: GateRunSample[] = [];
  for (const sample of history) {
    if (sample.result.class !== "transport") break;
    streak.push(sample);
  }
  const oldest = streak.at(-1);
  if (oldest && now.getTime() - oldest.triggeredAt.getTime() > TRANSPORT_FAULT_WINDOW_MS) {
    return `The gate could not run on its worker for more than an hour (latest: ${streak[0]!.result.detail ?? "transport fault"}).`;
  }

  const silent = history.slice(0, CONSECUTIVE_SILENT_SKIPS_WITH_STDERR);
  if (
    silent.length === CONSECUTIVE_SILENT_SKIPS_WITH_STDERR &&
    silent.every((sample) => sample.result.class === "skip" && sample.result.stderrTail.trim().length > 0)
  ) {
    return `The gate skipped ${CONSECUTIVE_SILENT_SKIPS_WITH_STDERR} times in a row and wrote to stderr each time; it may be crashing with exit code 1.`;
  }
  return null;
}

export interface GateNoticeDeps {
  db: Db;
  issueSvc: ReturnType<typeof issueService>;
  /** The board user to notify when the routine has no responsible user. */
  resolveBoardUserId(companyId: string): Promise<string | null>;
}

/**
 * Opens one "Gate failing" issue when a routine's gate keeps failing. It goes to the routine's
 * responsible user, or to the board when that is unset, and never to the routine's agent: waking
 * the agent would cost tokens, and the agent cannot change PR-only gate code.
 */
export async function raiseGateFailureNotice(deps: GateNoticeDeps, routine: RoutineRow): Promise<string | null> {
  const { db } = deps;
  const rows = await db
    .select({ triggeredAt: routineRuns.triggeredAt, gateResult: routineRuns.gateResult })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.routineId, routine.id),
        isNotNull(routineRuns.gateResult),
        ne(routineRuns.status, "gating"),
      ),
    )
    .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.id))
    .limit(HISTORY_LIMIT);
  const history = rows.map((row) => ({ triggeredAt: row.triggeredAt, result: row.gateResult as RoutineGateResult }));
  const reason = describeGateFailure(history, new Date());
  if (!reason) return null;

  const open = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, routine.companyId),
        eq(issues.originKind, ROUTINE_GATE_FAILURE_ORIGIN_KIND),
        eq(issues.originId, routine.id),
        inArray(issues.status, OPEN_STATUSES),
      ),
    )
    .limit(1)
    .then((found) => found[0] ?? null);
  if (open) return null;

  const userId = routine.responsibleUserId ?? (await deps.resolveBoardUserId(routine.companyId));
  const latest = history[0]!.result;
  const created = await deps.issueSvc.create(routine.companyId, {
    title: `Gate failing: ${routine.title}`,
    description: [
      reason,
      "",
      `Routine: ${routine.title}`,
      `Latest result: ${latest.class}${latest.exitCode === null ? "" : ` (exit ${latest.exitCode})`}${latest.detail ? `, ${latest.detail}` : ""}`,
      latest.stderrTail.trim() ? `\nstderr (tail):\n\n\`\`\`text\n${JSON.stringify(latest.stderrTail).replace(/`/g, "\\u0060")}\n\`\`\`` : "",
      "",
      "The routine keeps running while its gate fails (a script fault wakes the agent; a transport fault skips a schedule). Fix the gate script by pull request and re-pin it on the routine.",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeUserId: userId,
    responsibleUserId: userId,
    trustExplicitResponsibleUserId: true,
    originKind: ROUTINE_GATE_FAILURE_ORIGIN_KIND,
    originId: routine.id,
  });
  try {
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "system",
      actorId: ROUTINE_GATE_ACTOR_ID,
      action: "routine.gate_failed",
      entityType: "routine",
      entityId: routine.id,
      details: { routineId: routine.id, issueId: created.id, reason },
    });
  } catch (err) {
    logger.warn({ err, routineId: routine.id }, "failed to log routine gate failure");
  }
  return created.id;
}

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export const EVENT_PRUNE_BATCH_SIZE = 5_000;
/** Keep closed-issue groups this long so a late recovery can still find its issue. */
export const EVENT_GROUP_CLOSED_RETENTION_DAYS = 30;
/** Webhook test receipts only guard a replay window of at most one day. */
export const WEBHOOK_TEST_RECEIPT_RETENTION_DAYS = 7;
const MAX_BATCHES_PER_TABLE = 40;

export interface EventPruneResult {
  deliveries: number;
  groups: number;
  webhookTestReceipts: number;
}

function affectedRows(result: unknown): number {
  const rows = result as { count?: number; rowCount?: number } | unknown[];
  if (Array.isArray(rows)) return rows.length;
  return rows.count ?? rows.rowCount ?? 0;
}

async function deleteInBatches(db: Db, build: (limit: number) => ReturnType<typeof sql>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
    const deleted = affectedRows(await db.execute(build(EVENT_PRUNE_BATCH_SIZE)));
    total += deleted;
    if (deleted < EVENT_PRUNE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Deletes, in batches of at most 5000: delivery rows older than their source's
 * `retentionDays`, event groups whose issue has been closed for more than 30
 * days (or that sit on a standing append-mode issue and have been idle that
 * long), and webhook test receipts past their replay window. Idempotent and
 * safe to run from every server instance.
 */
export async function pruneEventData(db: Db, nowDate: Date = new Date()): Promise<EventPruneResult> {
  // Raw `sql` parameters are not serialized by the driver, so the instant goes in as text.
  const now = sql`${nowDate.toISOString()}::timestamptz`;
  const deliveries = await deleteInBatches(db, (limit) => sql`
    delete from event_deliveries
    where id in (
      select d.id
      from event_deliveries d
      join event_sources s on s.id = d.source_id
      where d.received_at < ${now} - make_interval(days => s.retention_days)
      limit ${limit}
    )
    returning id
  `);

  const groups = await deleteInBatches(db, (limit) => sql`
    delete from routine_event_groups
    where id in (
      select g.id
      from routine_event_groups g
      join issues i on i.id = g.issue_id
      where (i.status = 'done' and i.completed_at < ${now} - make_interval(days => ${EVENT_GROUP_CLOSED_RETENTION_DAYS}))
         or (i.status = 'cancelled' and i.cancelled_at < ${now} - make_interval(days => ${EVENT_GROUP_CLOSED_RETENTION_DAYS}))
         or (
           -- A group on a standing (append-mode) issue never closes with it, so it ages out by idleness.
           g.last_seen_at < ${now} - make_interval(days => ${EVENT_GROUP_CLOSED_RETENTION_DAYS})
           and (i.origin_kind is distinct from 'routine_execution' or i.origin_id is distinct from g.routine_id::text)
         )
      limit ${limit}
    )
    returning id
  `);

  const webhookTestReceipts = await deleteInBatches(db, (limit) => sql`
    delete from routine_webhook_test_receipts
    where id in (
      select id
      from routine_webhook_test_receipts
      where received_at < ${now} - make_interval(days => ${WEBHOOK_TEST_RECEIPT_RETENTION_DAYS})
      limit ${limit}
    )
    returning id
  `);

  return { deliveries, groups, webhookTestReceipts };
}

import type { Db } from "@paperclipai/db";
import type { EventRoutineOutcome } from "@paperclipai/shared";

/**
 * A parked event run reached its final outcome after the delivery was already answered `gating`.
 * `event` is the full normalized event the run was parked with.
 */
export interface GatedEventSettlement {
  companyId: string;
  routineId: string;
  runId: string;
  deliveryId: string | null;
  event: unknown;
  outcome: EventRoutineOutcome;
}

export type GatedEventSettler = (settlement: GatedEventSettlement) => Promise<void>;

// The event source service owns the delivery log and the fallback rules, and it depends on the
// routine service; this registry lets the gate worker reach it without a cyclic import.
const settlers = new WeakMap<object, GatedEventSettler>();

export function registerGatedEventSettler(db: Db, settler: GatedEventSettler): void {
  settlers.set(db, settler);
}

export async function settleGatedEvent(db: Db, settlement: GatedEventSettlement): Promise<void> {
  const settler = settlers.get(db);
  if (settler) await settler(settlement);
}

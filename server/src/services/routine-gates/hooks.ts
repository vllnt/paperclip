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

/** The new-issue budget of the source that received a delivery, for a dispatch that commits later. */
export interface GatedEventStormSlot {
  consumeStormSlot: () => Promise<boolean>;
  releaseStormSlot: () => Promise<void>;
}

export interface GatedEventHooks {
  settle(settlement: GatedEventSettlement): Promise<void>;
  /** Slot hooks for the source behind a delivery; null when the delivery is gone. */
  stormSlotForDelivery(deliveryId: string): Promise<GatedEventStormSlot | null>;
}

// The event source service owns the delivery log, the storm budget and the fallback rules, and it
// depends on the routine service; this registry lets the gate worker reach it without a cyclic import.
const registry = new WeakMap<object, GatedEventHooks>();

export function registerGatedEventHooks(db: Db, hooks: GatedEventHooks): void {
  registry.set(db, hooks);
}

export async function settleGatedEvent(db: Db, settlement: GatedEventSettlement): Promise<void> {
  const hooks = registry.get(db);
  if (hooks) await hooks.settle(settlement);
}

export async function gatedEventStormSlot(db: Db, deliveryId: string | null): Promise<GatedEventStormSlot | null> {
  const hooks = registry.get(db);
  if (!hooks || !deliveryId) return null;
  return hooks.stormSlotForDelivery(deliveryId);
}

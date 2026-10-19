import {
  readAdapterSteeringAcknowledgement,
  type AdapterRuntimeEvent,
  type AdapterSteeringHandle,
  type AdapterSteerResult,
} from "@paperclipai/adapter-utils";

/**
 * Live steering for legacy adapter runs (a spawned CLI that keeps stdin open).
 *
 * An adapter registers a handle while its process can take a message mid-run.
 * A steer is two-phase: writing the message makes it "pending", and only the
 * adapter's steering acknowledgement (the provider started the message) runs
 * the settle step that removes the comment from the queue. A run that ends
 * first drops its pending steers, so their comments stay queued.
 */
type RunSteering = {
  handle: AdapterSteeringHandle | null;
  pending: Map<string, () => Promise<void>>;
};

const runSteering = new Map<string, RunSteering>();

export function setAdapterSteeringHandle(runId: string, handle: AdapterSteeringHandle | null) {
  if (handle) {
    runSteering.set(runId, { handle, pending: new Map() });
    return;
  }
  // The adapter unregisters only after every started message was acknowledged,
  // so anything still pending will never start in this process.
  runSteering.delete(runId);
}

export function clearAdapterSteering(runId: string) {
  runSteering.delete(runId);
}

export function adapterSteeringAvailable(runId: string | null | undefined): boolean {
  return Boolean(runId && runSteering.get(runId)?.handle);
}

export function pendingAdapterSteeringCommentIds(runId: string | null | undefined): ReadonlySet<string> {
  const steering = runId ? runSteering.get(runId) : undefined;
  return new Set(steering?.pending.keys() ?? []);
}

/** Writes the message to the run's live input; `settle` runs once it starts. */
export function steerAdapterRun(
  runId: string,
  input: { text: string; correlationId: string; settle: () => Promise<void> },
): AdapterSteerResult {
  const steering = runSteering.get(runId);
  if (!steering?.handle) {
    return { status: "unavailable", reason: "The run is no longer taking messages" };
  }
  const result = steering.handle.steer({ text: input.text, correlationId: input.correlationId });
  if (result.status === "pending" && !steering.pending.has(input.correlationId)) {
    steering.pending.set(input.correlationId, input.settle);
  }
  return result;
}

/** Runs the settle step for an acknowledged steer. Returns false when none was pending. */
export async function acknowledgeAdapterSteering(runId: string, event: AdapterRuntimeEvent): Promise<boolean> {
  const correlationId = readAdapterSteeringAcknowledgement(event);
  const steering = runSteering.get(runId);
  const settle = correlationId ? steering?.pending.get(correlationId) : undefined;
  if (!correlationId || !steering || !settle) return false;
  steering.pending.delete(correlationId);
  await settle();
  return true;
}

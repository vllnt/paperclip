import type { AdapterRuntimeEvent } from "./types.js";

export const ADAPTER_STEERING_ACKNOWLEDGEMENT_KIND = "steering_acknowledgement";

/**
 * The run event an adapter emits through `onEvent` once the provider has put a
 * steered message into the model's context. It is the only steering receipt.
 */
export function adapterSteeringAcknowledgementEvent(input: {
  runId: string;
  correlationId: string;
}): AdapterRuntimeEvent {
  return {
    eventType: "item.completed",
    stream: "system",
    message: "Steering acknowledged for the active turn.",
    payload: {
      kind: ADAPTER_STEERING_ACKNOWLEDGEMENT_KIND,
      status: "acknowledged",
      itemId: `${input.runId}:steer:${input.correlationId}`,
      correlationId: input.correlationId,
    },
  };
}

/** Returns the acknowledged correlation id, or null for any other event. */
export function readAdapterSteeringAcknowledgement(event: AdapterRuntimeEvent): string | null {
  if (event.eventType !== "item.completed") return null;
  const payload = event.payload ?? {};
  if (payload.kind !== ADAPTER_STEERING_ACKNOWLEDGEMENT_KIND) return null;
  return typeof payload.correlationId === "string" && payload.correlationId.length > 0
    ? payload.correlationId
    : null;
}

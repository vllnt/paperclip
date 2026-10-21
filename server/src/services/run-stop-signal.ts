/**
 * Adapters whose CLI ends its turn on SIGINT and still writes its final result
 * event, which carries the run's usage and cost. SIGTERM ends these CLIs with
 * no result event, so the usage of a stopped run is lost.
 */
const ADAPTERS_THAT_REPORT_USAGE_ON_INTERRUPT: ReadonlySet<string> = new Set(["claude_local"]);

/**
 * Picks the signal that asks a run's local provider process to stop.
 *
 * Codex handles Ctrl-C by cancelling its tool sessions, while SIGTERM can leave
 * commands in their separate process groups alive. A run that owns an adapter
 * control stops through that control, so it gets no signal choice.
 *
 * A caller that stops the run of its own request, for example an agent that
 * hands its issue to the next reviewer, asks to flush the final usage. That
 * ask only changes the signal for adapters that report usage on interrupt.
 *
 * @param input.adapterType - Adapter type of the agent that owns the run.
 * @param input.ownsAdapterControl - True when the run registered an adapter control.
 * @param input.flushFinalUsage - True when the caller wants the run's final usage recorded.
 * @returns The signal to send first, or `undefined` for the default termination signal.
 * @example
 * resolveRunStopSignal({ adapterType: "claude_local", ownsAdapterControl: false, flushFinalUsage: true });
 */
export function resolveRunStopSignal(input: {
  adapterType: string | null | undefined;
  ownsAdapterControl: boolean;
  flushFinalUsage: boolean;
}): NodeJS.Signals | undefined {
  if (input.ownsAdapterControl) return undefined;
  if (input.adapterType === "codex_local") return "SIGINT";
  if (
    input.flushFinalUsage &&
    input.adapterType !== null &&
    input.adapterType !== undefined &&
    ADAPTERS_THAT_REPORT_USAGE_ON_INTERRUPT.has(input.adapterType)
  ) {
    return "SIGINT";
  }
  return undefined;
}

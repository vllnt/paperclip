import { describe, expect, it } from "vitest";
import { resolveRunStopSignal } from "./run-stop-signal.js";

describe("resolveRunStopSignal", () => {
  it.each([
    { adapterType: "codex_local", ownsAdapterControl: false, flushFinalUsage: false, expected: "SIGINT" },
    { adapterType: "codex_local", ownsAdapterControl: false, flushFinalUsage: true, expected: "SIGINT" },
    { adapterType: "codex_local", ownsAdapterControl: true, flushFinalUsage: false, expected: undefined },
    { adapterType: "claude_local", ownsAdapterControl: false, flushFinalUsage: false, expected: undefined },
    { adapterType: "claude_local", ownsAdapterControl: false, flushFinalUsage: true, expected: "SIGINT" },
    { adapterType: "claude_local", ownsAdapterControl: true, flushFinalUsage: true, expected: undefined },
    { adapterType: "cursor_local", ownsAdapterControl: false, flushFinalUsage: true, expected: undefined },
    { adapterType: null, ownsAdapterControl: false, flushFinalUsage: true, expected: undefined },
    { adapterType: undefined, ownsAdapterControl: false, flushFinalUsage: true, expected: undefined },
  ])(
    "returns $expected for $adapterType (control: $ownsAdapterControl, flush usage: $flushFinalUsage)",
    ({ expected, ...input }) => {
      expect(resolveRunStopSignal(input)).toBe(expected);
    },
  );
});

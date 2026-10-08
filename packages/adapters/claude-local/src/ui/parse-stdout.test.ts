import { describe, expect, it } from "vitest";
import { parseClaudeStdoutLine } from "./parse-stdout.js";

describe("parseClaudeStdoutLine", () => {
  it("keeps live-input lifecycle receipts out of the transcript", () => {
    const line = JSON.stringify({ type: "command_lifecycle", command_uuid: "11111111-0000-5000-8000-000000000001", state: "started" });
    expect(parseClaudeStdoutLine(line, "2026-10-07T20:00:00.000Z")).toEqual([]);
  });
});

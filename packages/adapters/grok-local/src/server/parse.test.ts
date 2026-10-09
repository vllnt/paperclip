import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyGrokFailure, isGrokUnknownSessionError, parseGrokJsonl } from "./parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("parseGrokJsonl", () => {
  it("collects streamed thought/text content and final session metadata", () => {
    const parsed = parseGrokJsonl([
      JSON.stringify({ type: "thought", data: "Plan" }),
      JSON.stringify({ type: "thought", data: " first." }),
      JSON.stringify({ type: "text", data: "hel" }),
      JSON.stringify({ type: "text", data: "lo" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
    ].join("\n"));

    expect(parsed).toEqual({
      sessionId: "sess-1",
      summary: "hello",
      thought: "Plan first.",
      errorMessage: null,
      stopReason: "EndTurn",
      requestId: "req-1",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
    });
  });

  it("extracts token usage and cost from the end event", () => {
    const parsed = parseGrokJsonl([
      JSON.stringify({ type: "text", data: "hi" }),
      JSON.stringify({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "sess-1",
        requestId: "req-1",
        usage: { input_tokens: 21560, output_tokens: 960, cache_read_input_tokens: 25216 },
        total_cost_usd: 0.0564448,
      }),
    ].join("\n"));

    expect(parsed.inputTokens).toBe(21560);
    expect(parsed.outputTokens).toBe(960);
    expect(parsed.cachedInputTokens).toBe(25216);
    expect(parsed.costUsd).toBe(0.0564448);
  });

  it("reads structured error payloads", () => {
    const parsed = parseGrokJsonl([
      JSON.stringify({ type: "error", error: { message: "Authentication required" } }),
    ].join("\n"));

    expect(parsed.errorMessage).toBe("Authentication required");
  });

  it("separates reasoning turns that grok streaming-json glues together", () => {
    // PAPA-349: at turn boundaries grok drops the newline between turns; the
    // aggregated thought should still read as two paragraphs.
    const parsed = parseGrokJsonl([
      JSON.stringify({ type: "thought", data: "The user uses `" }),
      JSON.stringify({ type: "thought", data: "ls" }),
      JSON.stringify({ type: "thought", data: "`" }),
      JSON.stringify({ type: "thought", data: "The" }),
      JSON.stringify({ type: "thought", data: " `" }),
      JSON.stringify({ type: "thought", data: "ls" }),
      JSON.stringify({ type: "thought", data: "`" }),
      JSON.stringify({ type: "thought", data: " returned" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1" }),
    ].join("\n"));

    expect(parsed.thought).toBe("The user uses `ls`\nThe `ls` returned");
  });

  it("preserves assistant `text` chunks verbatim (no boundary heuristic)", () => {
    // PAPA-349 review feedback: the turn-boundary helper is scoped to the
    // reasoning stream only. Final assistant text is stored unmodified so
    // user-visible responses cannot be reshaped by the heuristic.
    const parsed = parseGrokJsonl([
      JSON.stringify({ type: "text", data: "Done." }),
      JSON.stringify({ type: "text", data: "Next" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1" }),
    ].join("\n"));

    expect(parsed.summary).toBe("Done.Next");
  });
});

describe("isGrokUnknownSessionError", () => {
  it("detects stale resume failures", () => {
    expect(isGrokUnknownSessionError("", "session not found")).toBe(true);
    expect(isGrokUnknownSessionError("", "everything fine")).toBe(false);
  });
});

describe("classifyGrokFailure", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");
  const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), "utf8");
  const classify = (errorMessage: string | null, stderr = "") => classifyGrokFailure({ errorMessage, stderr }, now);

  it("classifies the real signed-out error from the CLI as an authentication failure", () => {
    const parsed = parseGrokJsonl(fixture("error-not-signed-in.jsonl"));
    expect(classify(parsed.errorMessage)).toMatchObject({ errorCode: "grok_auth_required", errorFamily: null });
  });

  it("classifies the CLI's model cooldown error as a provider quota, not an authentication failure", () => {
    const parsed = parseGrokJsonl(fixture("error-model-cooldown.jsonl"));
    expect(classify(parsed.errorMessage)).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: null,
    });
  });

  it("classifies an xAI team out of credits as a provider quota with no reset time", () => {
    expect(classify(
      "Your team 1a2b3c has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
    )).toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota", retryNotBefore: null });
  });

  it("reads the reset time from the message when it names one", () => {
    expect(classify("429: usage limit reached, try again in 20 minutes")).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-10-09T12:20:00.000Z",
    });
  });

  it("classifies overload and capacity errors as transient upstream failures", () => {
    for (const message of [
      "The model is overloaded. Please try again later.",
      "503 Service Unavailable",
      "xAI is at capacity right now",
      "429 Too Many Requests",
    ]) {
      expect(classify(message), message).toEqual({
        errorCode: "grok_transient_upstream",
        errorFamily: "transient_upstream",
        retryNotBefore: null,
      });
    }
  });

  it("reads the stderr line when the stream carried no error event", () => {
    expect(classify(null, "Error: Not signed in. To authenticate without a browser, run:")).toMatchObject({
      errorCode: "grok_auth_required",
    });
  });

  it("leaves task and unknown failures unclassified", () => {
    for (const message of ["Grok exited with code 2", "Tool call failed: ls returned 1", null]) {
      expect(classify(message), String(message)).toEqual({ errorCode: null, errorFamily: null, retryNotBefore: null });
    }
  });

  it("does not take a quota or capacity word inside tool output for a provider failure", () => {
    expect(classify("Tests failed: expected 429 but got 200 in rate-limit.test.ts")).toMatchObject({ errorCode: null });
  });

  it("classifies a 100k-character message in linear time", () => {
    const started = performance.now();
    classify(`${"a ".repeat(50_000)}`);
    classify(`not signed ${"in ".repeat(40_000)}`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

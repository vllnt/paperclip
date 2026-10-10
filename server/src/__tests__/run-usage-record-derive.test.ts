import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runUsageRecords } from "@paperclipai/db";
import { RUN_USAGE_RECORD_SCHEMA_VERSION } from "@paperclipai/shared";
import {
  deriveRunUsageRecord,
  type DeriveRunUsageRecordInput,
  type RunUsageDeriveRun,
} from "../services/run-usage-record-derive.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const ROUTINE_ID = "66666666-6666-4666-8666-666666666666";

function makeRun(overrides: Partial<RunUsageDeriveRun> = {}): RunUsageDeriveRun {
  return {
    id: RUN_ID,
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    invocationSource: "assignment",
    status: "succeeded",
    errorCode: null,
    signal: null,
    stderrExcerpt: null,
    runtimeMode: "legacy",
    driverKind: null,
    retryOfRunId: null,
    scheduledRetryReason: null,
    livenessState: "advanced",
    lastUsefulActionAt: new Date("2026-10-01T10:00:30.000Z"),
    usageJson: null,
    contextSnapshot: null,
    sessionIdBefore: null,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    startedAt: new Date("2026-10-01T10:00:05.000Z"),
    finishedAt: new Date("2026-10-01T10:01:05.000Z"),
    ...overrides,
  };
}

function makeInput(overrides: Partial<DeriveRunUsageRecordInput> = {}): DeriveRunUsageRecordInput {
  return {
    run: makeRun(),
    adapterType: "claude_local",
    issue: null,
    contextProjectId: null,
    wakeReason: null,
    retryDepth: 0,
    source: "derived",
    ...overrides,
  };
}

const CLAUDE_USAGE = {
  inputTokens: 1200,
  cachedInputTokens: 30000,
  outputTokens: 800,
  rawInputTokens: 1200,
  rawCachedInputTokens: 30000,
  rawOutputTokens: 800,
  usageSource: "per_run",
  sessionReused: true,
  provider: "anthropic",
  biller: "anthropic",
  model: "claude-sonnet-5-5",
  costUsd: 0.5,
  cacheAdjustedCostUsd: 0.0123456,
  costStatus: "reported",
  billingType: "metered_api",
};

const OPENAI_USAGE = {
  inputTokens: 1000,
  cachedInputTokens: 800,
  outputTokens: 50,
  rawInputTokens: 1000,
  rawCachedInputTokens: 800,
  rawOutputTokens: 50,
  usageSource: "per_run",
  provider: "openai",
  biller: "openai",
  model: "gpt-6-astra",
  billingType: "subscription_included",
};

describe("deriveRunUsageRecord", () => {
  it.each(["queued", "running", "scheduled_retry"])("returns null for the non-terminal status %s", (status) => {
    expect(deriveRunUsageRecord(makeInput({ run: makeRun({ status }) }))).toBeNull();
  });

  it("maps a measured Claude run: keys, dimensions, tokens, cost, timings", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ usageJson: CLAUDE_USAGE, sessionIdBefore: "abc" }),
      issue: { id: ISSUE_ID, projectId: PROJECT_ID, originKind: "manual", originId: null },
      wakeReason: "issue_assigned",
    }));

    expect(record).toMatchObject({
      runId: RUN_ID,
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      routineId: null,
      adapterType: "claude_local",
      runtimeMode: "legacy",
      driverKind: null,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-5-5",
      invocationSource: "assignment",
      wakeReason: "issue_assigned",
      isRetry: false,
      retryDepth: 0,
      sessionReused: true,
      status: "succeeded",
      errorCode: null,
      causeFamily: null,
      livenessState: "advanced",
      providerWorkStarted: true,
      usefulAction: true,
      inputTokens: 1200,
      cacheReadTokens: 30000,
      cacheWriteTokens: null,
      outputTokens: 800,
      reasoningTokens: null,
      usageBasis: "per_run",
      usageQuality: "measured",
      costMicros: 12346,
      apiEquivalentMicros: null,
      costStatus: "reported",
      queueWaitMs: 5000,
      durationMs: 60000,
      day: "2026-10-01",
      schemaVersion: RUN_USAGE_RECORD_SCHEMA_VERSION,
      source: "derived",
    });
    expect(record?.finishedAt).toEqual(new Date("2026-10-01T10:01:05.000Z"));
    expect(record?.runCreatedAt).toEqual(new Date("2026-10-01T10:00:00.000Z"));
  });

  it("uses created_at when finished_at is null and leaves the duration empty", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ finishedAt: null, createdAt: new Date("2026-10-02T23:59:59.000Z") }),
    }));

    expect(record?.finishedAt).toEqual(new Date("2026-10-02T23:59:59.000Z"));
    expect(record?.day).toBe("2026-10-02");
    expect(record?.durationMs).toBeNull();
  });

  it("records a run without usage as missing, with no tokens and no cost", () => {
    const record = deriveRunUsageRecord(makeInput({ run: makeRun({ usageJson: null }) }));

    expect(record).toMatchObject({
      usageQuality: "missing",
      inputTokens: null,
      cacheReadTokens: null,
      outputTokens: null,
      costMicros: null,
      costStatus: null,
      provider: null,
      model: null,
    });
  });

  it("records a cost-only usage as missing tokens but keeps the cost", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ usageJson: { costUsd: 0.25, provider: "x", billingType: "metered_api", costStatus: "reported" } }),
    }));

    expect(record).toMatchObject({ usageQuality: "missing", inputTokens: null, costMicros: 250000 });
  });

  it("prices a subscription-included run at zero", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ usageJson: { ...CLAUDE_USAGE, billingType: "subscription_included" } }),
    }));

    expect(record?.costMicros).toBe(0);
  });

  it("falls back to the plain cost when no cache-adjusted cost exists", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ usageJson: { ...CLAUDE_USAGE, cacheAdjustedCostUsd: undefined, costUsd: 1.25 } }),
    }));

    expect(record?.costMicros).toBe(1250000);
  });

  it("marks a session-baseline subtraction as derived", () => {
    const record = deriveRunUsageRecord(makeInput({
      adapterType: "gemini_local",
      run: makeRun({ usageJson: { ...CLAUDE_USAGE, usageSource: "session_delta" } }),
    }));

    expect(record).toMatchObject({ usageQuality: "derived", usageBasis: "session_delta" });
  });

  describe("Codex", () => {
    it("treats codex_local usage as measured per-run counts, even when a resume reuses the session id", () => {
      const resumed = deriveRunUsageRecord(makeInput({
        adapterType: "codex_local",
        run: makeRun({
          sessionIdBefore: "session-1",
          usageJson: { ...OPENAI_USAGE, inputTokens: 440670, cachedInputTokens: 400000, rawInputTokens: 440670 },
        }),
      }));

      expect(resumed).toMatchObject({
        usageQuality: "measured",
        usageBasis: "per_run",
        sessionReused: true,
        inputTokens: 40670,
        cacheReadTokens: 400000,
      });
    });

    it("keeps the app-server runner path declared, because only the CLI path was verified", () => {
      const viaRunner = deriveRunUsageRecord(makeInput({
        adapterType: "paperclip_runner",
        run: makeRun({ driverKind: "codex_app_server", usageJson: OPENAI_USAGE }),
      }));

      expect(viaRunner?.usageQuality).toBe("declared");
      expect(viaRunner?.driverKind).toBe("codex_app_server");
    });

    it("keeps Anthropic counts as reported when a codex_local run streams from an Anthropic model", () => {
      const record = deriveRunUsageRecord(makeInput({
        adapterType: "codex_local",
        run: makeRun({ usageJson: CLAUDE_USAGE }),
      }));

      expect(record).toMatchObject({ inputTokens: 1200, cacheReadTokens: 30000, usageQuality: "measured" });
    });
  });

  describe("token classes by provider", () => {
    it.each(["openai", "xai"])("stores %s input without its cached part, so the classes do not overlap", (provider) => {
      const record = deriveRunUsageRecord(makeInput({
        adapterType: "codex_local",
        run: makeRun({ usageJson: { ...OPENAI_USAGE, provider } }),
      }));

      expect(record).toMatchObject({
        provider,
        inputTokens: 200,
        cacheReadTokens: 800,
        outputTokens: 50,
        usageQuality: "measured",
      });
    });

    it("classes a grok model that is recorded under the openai label the OpenAI way", () => {
      const record = deriveRunUsageRecord(makeInput({
        adapterType: "codex_local",
        run: makeRun({ usageJson: { ...OPENAI_USAGE, provider: "openai", model: "grok-4.7" } }),
      }));

      expect(record).toMatchObject({
        provider: "openai",
        model: "grok-4.7",
        inputTokens: 200,
        cacheReadTokens: 800,
        outputTokens: 50,
        usageQuality: "measured",
      });
    });

    it("takes the vendor from the recorded provider label and never from the model id", () => {
      const record = deriveRunUsageRecord(makeInput({
        adapterType: "codex_local",
        run: makeRun({ usageJson: { ...OPENAI_USAGE, provider: "mystery", model: "grok-4.7" } }),
      }));

      expect(record).toMatchObject({ provider: "mystery", model: "grok-4.7", inputTokens: 1000, cacheReadTokens: 800 });
    });

    it("keeps the counts of a provider that has no rule as reported", () => {
      const other = deriveRunUsageRecord(makeInput({ run: makeRun({ usageJson: { ...OPENAI_USAGE, provider: "mystery" } }) }));
      const none = deriveRunUsageRecord(makeInput({ run: makeRun({ usageJson: { ...OPENAI_USAGE, provider: undefined } }) }));

      expect(other).toMatchObject({ inputTokens: 1000, cacheReadTokens: 800 });
      expect(none).toMatchObject({ inputTokens: 1000, cacheReadTokens: 800 });
    });

    it("keeps the reported counts and marks the run declared when the cached part is larger than the input", () => {
      const record = deriveRunUsageRecord(makeInput({
        adapterType: "codex_local",
        run: makeRun({ usageJson: { ...OPENAI_USAGE, inputTokens: 100, cachedInputTokens: 800 } }),
      }));

      expect(record).toMatchObject({ inputTokens: 100, cacheReadTokens: 800, usageQuality: "declared" });
    });

    it("subtracts nothing when only one of the two counts is present", () => {
      const record = deriveRunUsageRecord(makeInput({
        run: makeRun({ usageJson: { provider: "openai", inputTokens: 1000, outputTokens: 5 } }),
      }));

      expect(record).toMatchObject({ inputTokens: 1000, cacheReadTokens: null });
    });
  });

  it("ignores negative, fractional and non-finite token values", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ usageJson: { inputTokens: -5, cachedInputTokens: 10.9, outputTokens: Number.NaN } }),
    }));

    expect(record).toMatchObject({ inputTokens: 0, cacheReadTokens: 10, outputTokens: null });
  });

  it("classifies a failure and carries the code", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ status: "failed", errorCode: "process_lost", signal: null }),
    }));

    expect(record).toMatchObject({ status: "failed", errorCode: "process_lost", causeFamily: "interrupted_crash" });
  });

  it.each(["workspace_busy", "ai_connection_busy"])(
    "says provider work did not start for the deferral %s",
    (errorCode) => {
      const record = deriveRunUsageRecord(makeInput({ run: makeRun({ status: "cancelled", errorCode }) }));

      expect(record?.providerWorkStarted).toBe(false);
    },
  );

  it("says provider work did not start for a run that never started", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ status: "cancelled", errorCode: "cancelled", startedAt: null }),
    }));

    expect(record).toMatchObject({ providerWorkStarted: false, queueWaitMs: null, durationMs: null });
  });

  it("derives the routine from a routine-execution issue with an id-shaped origin", () => {
    const routine = deriveRunUsageRecord(makeInput({
      issue: { id: ISSUE_ID, projectId: null, originKind: "routine_execution", originId: ROUTINE_ID },
    }));
    const badOrigin = deriveRunUsageRecord(makeInput({
      issue: { id: ISSUE_ID, projectId: null, originKind: "routine_execution", originId: "not-a-uuid" },
    }));
    const manual = deriveRunUsageRecord(makeInput({
      issue: { id: ISSUE_ID, projectId: null, originKind: "manual", originId: ROUTINE_ID },
    }));

    expect(routine?.routineId).toBe(ROUTINE_ID);
    expect(badOrigin?.routineId).toBeNull();
    expect(manual?.routineId).toBeNull();
  });

  it("prefers the issue project and falls back to the context project", () => {
    const fromIssue = deriveRunUsageRecord(makeInput({
      issue: { id: ISSUE_ID, projectId: PROJECT_ID, originKind: "manual", originId: null },
      contextProjectId: "99999999-9999-4999-8999-999999999999",
    }));
    const fromContext = deriveRunUsageRecord(makeInput({ contextProjectId: PROJECT_ID }));

    expect(fromIssue?.projectId).toBe(PROJECT_ID);
    expect(fromContext?.projectId).toBe(PROJECT_ID);
    expect(fromContext?.issueId).toBeNull();
  });

  it("records the retry link, depth and reason", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({ retryOfRunId: "77777777-7777-4777-8777-777777777777", scheduledRetryReason: "transient_failure" }),
      retryDepth: 2,
    }));

    expect(record).toMatchObject({ isRetry: true, retryDepth: 2, retryReason: "transient_failure" });
  });

  it("keeps identifier columns to a short safe alphabet and maps the rest to other", () => {
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({
        errorCode: "Has Spaces And Caps",
        status: "failed",
        usageJson: { ...CLAUDE_USAGE, model: "anthropic/claude-3.5-sonnet:beta", provider: "x".repeat(81) },
      }),
      wakeReason: "has space",
    }));

    expect(record).toMatchObject({
      errorCode: "other",
      model: "anthropic/claude-3.5-sonnet:beta",
      provider: "other",
      wakeReason: "other",
    });
  });

  it("never copies prompt, context, stderr or log text into the record", () => {
    const canary = "CANARY-PROMPT-SECRET-7731";
    const record = deriveRunUsageRecord(makeInput({
      run: makeRun({
        status: "failed",
        errorCode: "adapter_failed",
        stderrExcerpt: `ENOSPC ${canary}`,
        contextSnapshot: { prompt: canary, issueId: ISSUE_ID, wakeReason: canary },
        usageJson: { ...CLAUDE_USAGE, summary: canary, error: canary },
      }),
    }));

    expect(record?.causeFamily).toBe("disk_or_workspace");
    expect(JSON.stringify(record)).not.toContain(canary);
  });

  it("only produces columns the table has, and every required column", () => {
    const record = deriveRunUsageRecord(makeInput({ run: makeRun({ usageJson: CLAUDE_USAGE }) }));
    const columns = getTableColumns(runUsageRecords);
    const required = Object.entries(columns)
      .filter(([, column]) => column.notNull && !column.hasDefault)
      .map(([name]) => name);

    expect(record).not.toBeNull();
    const keys = Object.keys(record ?? {});
    expect(keys.filter((key) => !(key in columns))).toEqual([]);
    expect(required.filter((name) => !keys.includes(name))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_CAUSES,
  classifyRunFailure,
  isRunFailureCause,
  type RunFailureCause,
} from "./run-failure-cause.js";

const NON_TERMINAL_OR_OK = ["queued", "scheduled_retry", "running", "succeeded"] as const;

describe("classifyRunFailure", () => {
  it("returns null for runs that are not failures", () => {
    for (const status of NON_TERMINAL_OR_OK) {
      expect(classifyRunFailure({ status, errorCode: "process_lost" })).toBeNull();
    }
  });

  const exactCodes: ReadonlyArray<readonly [string, RunFailureCause]> = [
    ["server_shutdown_interrupted", "interrupted_graceful"],
    ["process_lost", "interrupted_crash"],
    ["acpx_handshake_transport_lost", "interrupted_crash"],
    ["native_restart_recovery_blocked", "interrupted_crash"],
    ["workspace_restore_failed", "disk_or_workspace"],
    ["workspace_git_scan_failed", "disk_or_workspace"],
    ["restore_failed", "disk_or_workspace"],
    ["restore_permission_denied", "disk_or_workspace"],
    ["restore_unsafe_archive", "disk_or_workspace"],
    ["workspace_sync_out_failed", "disk_or_workspace"],
    ["workspace_busy", "workspace_lock"],
    ["workspace_busy_retry", "workspace_lock"],
    ["restore_lock_timeout", "workspace_lock"],
    ["provider_quota", "provider_quota"],
    ["claude_transient_upstream", "provider_transient"],
    ["codex_transient_upstream", "provider_transient"],
    ["transient_upstream", "provider_transient"],
    ["github_rate_limited", "external_service_quota"],
    ["timeout", "timeout"],
    ["acpx_handshake_timeout", "timeout"],
    ["hermes_gateway_timeout", "timeout"],
    ["openclaw_gateway_wait_timeout", "timeout"],
    ["codex_output_inactivity_monitor", "timeout"],
    ["acpx_auth_required", "auth_or_config"],
    ["github_auth_required", "auth_or_config"],
    ["github_token_unavailable", "auth_or_config"],
    ["signing_secret_unconfigured", "auth_or_config"],
    ["claude_cli_version_incompatible", "auth_or_config"],
    ["ai_connection_unavailable", "auth_or_config"],
    ["adapter_engine_unavailable", "auth_or_config"],
    ["budget_blocked", "budget_or_cap"],
    ["ai_connection_busy_retry", "budget_or_cap"],
    ["issue_terminal_status", "control_plane_cancel"],
    ["issue_paused", "control_plane_cancel"],
    ["issue_reassigned", "control_plane_cancel"],
    ["lock_released_on_reassignment", "control_plane_cancel"],
    ["queued_comment_discarded", "control_plane_cancel"],
    ["operator_interrupted", "operator_cancel"],
    ["cancelled", "operator_cancel"],
    ["hermes_gateway_cancelled", "operator_cancel"],
    ["adapter_failed", "adapter_failure"],
    ["acpx_protocol_error", "adapter_failure"],
    ["openclaw_gateway_agent_error", "adapter_failure"],
    ["tool_execution_failed", "adapter_failure"],
  ];

  it.each(exactCodes)("maps %s to %s", (errorCode, cause) => {
    expect(classifyRunFailure({ status: "failed", errorCode })).toBe(cause);
  });

  it("treats every issue_* control-plane code as a control-plane cancel", () => {
    for (const errorCode of ["issue_blocked", "issue_not_found", "issue_execution_lock_changed", "issue_waiting_for_response"]) {
      expect(classifyRunFailure({ status: "cancelled", errorCode })).toBe("control_plane_cancel");
    }
  });

  it("sends codes it does not know to unknown instead of guessing", () => {
    expect(classifyRunFailure({ status: "failed", errorCode: "elicitation_required" })).toBe("unknown");
    expect(classifyRunFailure({ status: "failed", errorCode: "some_future_code" })).toBe("unknown");
    expect(classifyRunFailure({ status: "failed", errorCode: null })).toBe("unknown");
  });

  it("maps a timed_out status with no code to timeout", () => {
    expect(classifyRunFailure({ status: "timed_out" })).toBe("timeout");
  });

  it("maps a cancelled status with no code to unknown, because who cancelled is not recorded", () => {
    expect(classifyRunFailure({ status: "cancelled" })).toBe("unknown");
  });

  it("uses the exit signal only when there is no error code", () => {
    expect(classifyRunFailure({ status: "failed", signal: "SIGKILL" })).toBe("interrupted_crash");
    expect(classifyRunFailure({ status: "failed", signal: "SIGTERM" })).toBe("interrupted_graceful");
    expect(classifyRunFailure({ status: "failed", errorCode: "adapter_failed", signal: "SIGKILL" })).toBe("adapter_failure");
  });

  describe("stderr refinement of generic codes", () => {
    it("recognises a full disk", () => {
      expect(classifyRunFailure({ status: "failed", errorCode: "adapter_failed", stderrExcerpt: "write: No space left on device" })).toBe("disk_or_workspace");
      expect(classifyRunFailure({ status: "failed", stderrExcerpt: "ENOSPC: no space left" })).toBe("disk_or_workspace");
    });

    it("recognises an external service quota before a provider quota", () => {
      expect(classifyRunFailure({ status: "failed", errorCode: "adapter_failed", stderrExcerpt: "DeploymentQuotaReached: limit hit; rate limit" })).toBe("external_service_quota");
    });

    it("recognises provider quota and transient upstream errors", () => {
      expect(classifyRunFailure({ status: "failed", errorCode: "adapter_failed", stderrExcerpt: "You're out of extra usage" })).toBe("provider_quota");
      expect(classifyRunFailure({ status: "failed", stderrExcerpt: "API Error: 529 overloaded" })).toBe("provider_transient");
    });

    it("never overrides a specific code", () => {
      expect(classifyRunFailure({ status: "failed", errorCode: "process_lost", stderrExcerpt: "No space left on device" })).toBe("interrupted_crash");
    });

    it("scans only a bounded prefix of the excerpt", () => {
      const tail = `${"x".repeat(5000)} No space left on device`;
      expect(classifyRunFailure({ status: "failed", errorCode: "adapter_failed", stderrExcerpt: tail })).toBe("adapter_failure");
    });
  });

  it("only ever returns a member of the closed set", () => {
    const samples = ["adapter_failed", "x", "", "issue_x", "provider_quota", "restore_lock_timeout"];
    for (const errorCode of samples) {
      for (const status of ["failed", "cancelled", "interrupted", "timed_out"]) {
        const cause = classifyRunFailure({ status, errorCode });
        expect(cause !== null && RUN_FAILURE_CAUSES.includes(cause)).toBe(true);
      }
    }
  });
});

describe("isRunFailureCause", () => {
  it("accepts members and rejects everything else", () => {
    expect(isRunFailureCause("timeout")).toBe(true);
    expect(isRunFailureCause("nope")).toBe(false);
    expect(isRunFailureCause(null)).toBe(false);
  });
});

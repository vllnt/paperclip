/**
 * Closed set of reasons a run did not succeed. The free-text `heartbeat_runs.error_code` has
 * about 150 literals and no enum; analytics group by this set instead. Add a value only with
 * a classifier rule and a test, and bump {@link RUN_FAILURE_CAUSE_RULES_VERSION}.
 */
export const RUN_FAILURE_CAUSES = [
  "interrupted_graceful",
  "interrupted_crash",
  "disk_or_workspace",
  "workspace_lock",
  "provider_quota",
  "provider_transient",
  "external_service_quota",
  "timeout",
  "auth_or_config",
  "budget_or_cap",
  "control_plane_cancel",
  "operator_cancel",
  "adapter_failure",
  "unknown",
] as const;

export type RunFailureCause = (typeof RUN_FAILURE_CAUSES)[number];

/** Bump when a rule changes, so records derived under older rules can be re-derived. */
export const RUN_FAILURE_CAUSE_RULES_VERSION = 1;

const STDERR_SCAN_CHARS = 4000;

const NON_FAILURE_STATUSES: ReadonlySet<string> = new Set(["queued", "scheduled_retry", "running", "succeeded"]);

const CAUSE_BY_CODE: ReadonlyMap<string, RunFailureCause> = new Map<string, RunFailureCause>([
  ["server_shutdown_interrupted", "interrupted_graceful"],
  ["process_lost", "interrupted_crash"],
  ["acpx_handshake_transport_lost", "interrupted_crash"],
  ["native_restart_recovery_blocked", "interrupted_crash"],
  ["execution_reconciliation_required", "interrupted_crash"],
  ["legacy_execution_requires_reconciliation", "interrupted_crash"],
  ["workspace_restore_failed", "disk_or_workspace"],
  ["workspace_git_scan_failed", "disk_or_workspace"],
  ["restore_failed", "disk_or_workspace"],
  ["restore_permission_denied", "disk_or_workspace"],
  ["restore_unsafe_archive", "disk_or_workspace"],
  ["workspace_sync_out_failed", "disk_or_workspace"],
  ["workspace_sync_out_unrecoverable", "disk_or_workspace"],
  ["workspace_base_ref_unresolved", "disk_or_workspace"],
  ["workspace_busy", "workspace_lock"],
  ["workspace_busy_retry", "workspace_lock"],
  ["restore_lock_timeout", "workspace_lock"],
  ["provider_quota", "provider_quota"],
  ["claude_transient_upstream", "provider_transient"],
  ["codex_transient_upstream", "provider_transient"],
  ["transient_upstream", "provider_transient"],
  ["transient_failure", "provider_transient"],
  ["github_rate_limited", "external_service_quota"],
  ["timeout", "timeout"],
  ["acpx_handshake_timeout", "timeout"],
  ["hermes_gateway_timeout", "timeout"],
  ["openclaw_gateway_wait_timeout", "timeout"],
  ["codex_output_inactivity_monitor", "timeout"],
  ["acpx_auth_required", "auth_or_config"],
  ["github_auth_required", "auth_or_config"],
  ["github_forbidden", "auth_or_config"],
  ["github_invalid_identity", "auth_or_config"],
  ["github_token_unavailable", "auth_or_config"],
  ["signing_secret_unconfigured", "auth_or_config"],
  ["user_secret_definition_missing", "auth_or_config"],
  ["claude_cli_version_incompatible", "auth_or_config"],
  ["connection_unavailable", "auth_or_config"],
  ["ai_connection_unavailable", "auth_or_config"],
  ["ai_connection_incompatible", "auth_or_config"],
  ["ai_connection_changed", "auth_or_config"],
  ["adapter_engine_unavailable", "auth_or_config"],
  ["agent_not_invokable", "auth_or_config"],
  ["agent_chat_disabled", "auth_or_config"],
  ["binding_missing", "auth_or_config"],
  ["responsible_user_missing", "auth_or_config"],
  ["provider_tool_definition_invalid", "auth_or_config"],
  ["paperclip_runner_coordinator_required", "auth_or_config"],
  ["plugin_resolver_failed", "auth_or_config"],
  ["heartbeat_wake_on_demand_disabled", "auth_or_config"],
  ["hermes_gateway_api_key_missing", "auth_or_config"],
  ["hermes_gateway_api_base_url_missing", "auth_or_config"],
  ["hermes_gateway_api_base_url_invalid", "auth_or_config"],
  ["hermes_gateway_plain_http_remote_denied", "auth_or_config"],
  ["openclaw_gateway_url_missing", "auth_or_config"],
  ["openclaw_gateway_url_invalid", "auth_or_config"],
  ["openclaw_gateway_url_protocol", "auth_or_config"],
  ["budget_blocked", "budget_or_cap"],
  ["ai_connection_busy", "budget_or_cap"],
  ["ai_connection_busy_retry", "budget_or_cap"],
  ["ai_connection_wait", "budget_or_cap"],
  ["lock_released_on_reassignment", "control_plane_cancel"],
  ["queued_comment_discarded", "control_plane_cancel"],
  ["queued_run_claim_rejected", "control_plane_cancel"],
  ["legacy_disposition_repair_suppressed", "control_plane_cancel"],
  ["approval_request_superseded", "control_plane_cancel"],
  ["chat_completion_outbox_owns_retry", "control_plane_cancel"],
  ["external_chat_continuation", "control_plane_cancel"],
  ["operator_interrupted", "operator_cancel"],
  ["cancelled", "operator_cancel"],
  ["hermes_gateway_cancelled", "operator_cancel"],
  ["slack_session_stopped", "operator_cancel"],
  ["action_declined", "operator_cancel"],
  ["adapter_failed", "adapter_failure"],
  ["acpx_protocol_error", "adapter_failure"],
  ["acpx_runtime_error", "adapter_failure"],
  ["acpx_local_retired", "adapter_failure"],
  ["hermes_gateway_protocol_error", "adapter_failure"],
  ["hermes_gateway_run_failed", "adapter_failure"],
  ["openclaw_gateway_agent_error", "adapter_failure"],
  ["openclaw_gateway_wait_error", "adapter_failure"],
  ["openclaw_gateway_wait_status_unexpected", "adapter_failure"],
  ["paperclip_runner_provider_failed", "adapter_failure"],
  ["tool_execution_failed", "adapter_failure"],
  ["tool_not_found", "adapter_failure"],
  ["github_fetch_failed", "adapter_failure"],
  ["github_invalid_response", "adapter_failure"],
  ["github_unexpected_response", "adapter_failure"],
]);

/** Codes that say a run failed without saying why, so stderr may refine them. */
const GENERIC_CODES: ReadonlySet<string> = new Set(["", "adapter_failed", "unknown", "unsupported", "tool_execution_failed"]);

const STDERR_RULES: ReadonlyArray<readonly [RegExp, RunFailureCause]> = [
  [/no space left on device|\bENOSPC\b/i, "disk_or_workspace"],
  [/DeploymentQuotaReached/, "external_service_quota"],
  [/out of extra usage|usage limit|insufficient_quota|quota (?:exceeded|exhausted)|rate[ _-]?limit/i, "provider_quota"],
  [/\boverloaded\b|API Error: 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up/i, "provider_transient"],
];

/** Input to {@link classifyRunFailure}: row fields only, never prompts or logs. */
export interface RunFailureInput {
  status: string;
  errorCode?: string | null;
  signal?: string | null;
  stderrExcerpt?: string | null;
}

/**
 * Narrows an unknown value to a member of {@link RUN_FAILURE_CAUSES}.
 *
 * @param value - Any value, usually a database column.
 * @returns True when the value is a known cause.
 */
export function isRunFailureCause(value: unknown): value is RunFailureCause {
  return typeof value === "string" && RUN_FAILURE_CAUSES.some((cause) => cause === value);
}

function causeFromCode(code: string): RunFailureCause | null {
  const exact = CAUSE_BY_CODE.get(code);
  if (exact) return exact;
  if (code.startsWith("issue_")) return "control_plane_cancel";
  return null;
}

function causeFromStderr(stderrExcerpt: string | null | undefined): RunFailureCause | null {
  if (!stderrExcerpt) return null;
  const head = stderrExcerpt.slice(0, STDERR_SCAN_CHARS);
  for (const [pattern, cause] of STDERR_RULES) {
    if (pattern.test(head)) return cause;
  }
  return null;
}

function causeFromSignal(signal: string | null | undefined): RunFailureCause | null {
  if (signal === "SIGKILL") return "interrupted_crash";
  if (signal === "SIGTERM" || signal === "SIGINT") return "interrupted_graceful";
  return null;
}

/**
 * Classifies why a terminal run did not succeed. Pure and total: an unmapped code returns
 * `unknown`, so the taxonomy grows from the "unmapped codes" view rather than from guesses.
 * The stderr excerpt is scanned only for a fixed set of patterns over a bounded prefix; the
 * matched text is discarded and never returned.
 *
 * @param input - Status, error code, exit signal and stderr excerpt of the run row.
 * @returns A cause, or null when the status is not a failure.
 * @example
 * classifyRunFailure({ status: "failed", errorCode: "restore_lock_timeout" }); // "workspace_lock"
 */
export function classifyRunFailure(input: RunFailureInput): RunFailureCause | null {
  if (NON_FAILURE_STATUSES.has(input.status)) return null;
  const code = input.errorCode?.trim() ?? "";
  const byCode = code === "" ? null : causeFromCode(code);
  if (byCode && !GENERIC_CODES.has(code)) return byCode;
  const byStderr = causeFromStderr(input.stderrExcerpt);
  if (byStderr) return byStderr;
  if (byCode) return byCode;
  if (code === "") {
    const bySignal = causeFromSignal(input.signal);
    if (bySignal) return bySignal;
    if (input.status === "timed_out") return "timeout";
  }
  return "unknown";
}

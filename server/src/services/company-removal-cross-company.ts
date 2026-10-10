import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

/** The `details.code` of the 409 that a company delete returns when it would reach another company's rows. */
export const COMPANY_DELETE_CROSS_COMPANY_REFERENCES = "company_delete_cross_company_references";

/**
 * A foreign key from a row that may belong to another company to a row that a company
 * delete removes. The key is `ON DELETE CASCADE` or `ON DELETE SET NULL`, so deleting
 * the parent would delete or change the child row.
 */
export interface CrossCompanyReference {
  /** The table that holds the referencing rows. */
  child: string;
  /** The column of that table that holds the reference. */
  column: string;
  /** The table that the reference points at. A company delete removes rows of this table. */
  parent: string;
  /**
   * For a child table without a `company_id` column: the reference to the parent row
   * that decides which company a row belongs to. A row belongs to the company of that row.
   */
  owner?: { column: string; table: string };
}

/** A cascade or set-null key that the cross-company check leaves out, with the reason. */
export interface CrossCompanyExclusion {
  child: string;
  column: string;
  parent: string;
  reason: string;
}

/**
 * Every cascade or set-null foreign key into a table that a company delete removes
 * rows from, except the keys that cannot reach another company's rows by their shape:
 * a key that includes `company_id` in a composite pair with the parent's `company_id`,
 * a `company_id` key to `companies`, and the keys in `CROSS_COMPANY_EXCLUSIONS`.
 *
 * `company-removal-coverage.test.ts` reads the live foreign keys and fails when this
 * list misses one, or holds one that no longer exists. The list is sorted by parent,
 * then child, then column.
 */
export const CROSS_COMPANY_REFERENCES: readonly CrossCompanyReference[] = [
  { child: "decision_effect_executions", column: "activity_log_id", parent: "activity_log", owner: { column: "decision_id", table: "decisions" } },
  { child: "agent_session_goal_actions", column: "session_id", parent: "agent_task_sessions" },
  { child: "agent_config_revisions", column: "agent_id", parent: "agents" },
  { child: "agent_config_revisions", column: "created_by_agent_id", parent: "agents" },
  { child: "agent_memberships", column: "agent_id", parent: "agents" },
  { child: "case_events", column: "actor_agent_id", parent: "agents" },
  { child: "cases", column: "created_by_agent_id", parent: "agents" },
  { child: "chat_task_handoffs", column: "agent_id", parent: "agents" },
  { child: "company_onboarding_seeds", column: "agent_id", parent: "agents" },
  { child: "company_secret_proposals", column: "proposed_by_agent_id", parent: "agents" },
  { child: "company_secret_proposals", column: "target_id", parent: "agents" },
  { child: "company_secret_provider_configs", column: "created_by_agent_id", parent: "agents" },
  { child: "company_secret_versions", column: "created_by_agent_id", parent: "agents", owner: { column: "secret_id", table: "company_secrets" } },
  { child: "company_secrets", column: "created_by_agent_id", parent: "agents" },
  { child: "company_skill_comments", column: "author_agent_id", parent: "agents" },
  { child: "company_skill_stars", column: "agent_id", parent: "agents" },
  { child: "company_skill_test_run_templates", column: "created_by_agent_id", parent: "agents" },
  { child: "company_skill_test_run_templates", column: "updated_by_agent_id", parent: "agents" },
  { child: "company_skill_versions", column: "author_agent_id", parent: "agents" },
  { child: "connection_grant_delegations", column: "agent_id", parent: "agents" },
  { child: "connection_grants", column: "created_by_agent_id", parent: "agents" },
  { child: "connection_grants", column: "revoked_by_agent_id", parent: "agents" },
  { child: "connection_grants", column: "subject_agent_id", parent: "agents" },
  { child: "connection_token_issuances", column: "agent_id", parent: "agents" },
  { child: "document_annotation_comments", column: "author_agent_id", parent: "agents" },
  { child: "document_annotation_threads", column: "created_by_agent_id", parent: "agents" },
  { child: "document_annotation_threads", column: "resolved_by_agent_id", parent: "agents" },
  { child: "document_revisions", column: "created_by_agent_id", parent: "agents" },
  { child: "documents", column: "created_by_agent_id", parent: "agents" },
  { child: "documents", column: "locked_by_agent_id", parent: "agents" },
  { child: "documents", column: "updated_by_agent_id", parent: "agents" },
  { child: "execution_workspace_runtime_leases", column: "owner_agent_id", parent: "agents" },
  { child: "heartbeat_run_watchdog_decisions", column: "created_by_agent_id", parent: "agents" },
  { child: "issue_approvals", column: "linked_by_agent_id", parent: "agents" },
  { child: "issue_comments", column: "deleted_by_agent_id", parent: "agents" },
  { child: "issue_comments", column: "derived_author_agent_id", parent: "agents" },
  { child: "issue_inbox_archives", column: "archived_by_agent_id", parent: "agents" },
  { child: "issue_plan_decompositions", column: "owner_agent_id", parent: "agents" },
  { child: "issue_recovery_actions", column: "owner_agent_id", parent: "agents" },
  { child: "issue_recovery_actions", column: "previous_owner_agent_id", parent: "agents" },
  { child: "issue_recovery_actions", column: "return_owner_agent_id", parent: "agents" },
  { child: "issue_relations", column: "created_by_agent_id", parent: "agents" },
  { child: "issue_thread_interactions", column: "addressee_agent_id", parent: "agents" },
  { child: "issue_tree_hold_members", column: "assignee_agent_id", parent: "agents" },
  { child: "issue_tree_holds", column: "created_by_agent_id", parent: "agents" },
  { child: "issue_tree_holds", column: "released_by_agent_id", parent: "agents" },
  { child: "issue_watchdogs", column: "created_by_agent_id", parent: "agents" },
  { child: "issue_watchdogs", column: "updated_by_agent_id", parent: "agents" },
  { child: "pipeline_case_events", column: "actor_agent_id", parent: "agents" },
  { child: "pipeline_cases", column: "created_by_agent_id", parent: "agents" },
  { child: "pipeline_cases", column: "lease_agent_id", parent: "agents" },
  { child: "pipelines", column: "created_by_agent_id", parent: "agents" },
  { child: "routine_revisions", column: "created_by_agent_id", parent: "agents" },
  { child: "routine_triggers", column: "created_by_agent_id", parent: "agents" },
  { child: "routine_triggers", column: "updated_by_agent_id", parent: "agents" },
  { child: "routines", column: "created_by_agent_id", parent: "agents" },
  { child: "routines", column: "updated_by_agent_id", parent: "agents" },
  { child: "status_cards", column: "agent_id", parent: "agents" },
  { child: "status_cards", column: "archived_by_agent_id", parent: "agents" },
  { child: "status_cards", column: "created_by_agent_id", parent: "agents" },
  { child: "status_cards", column: "query_compiled_by_agent_id", parent: "agents" },
  { child: "summary_slots", column: "last_generated_by_agent_id", parent: "agents" },
  { child: "tool_action_requests", column: "decided_by_agent_id", parent: "agents" },
  { child: "tool_action_requests", column: "requested_by_agent_id", parent: "agents" },
  { child: "tool_action_requests", column: "resolved_by_agent_id", parent: "agents" },
  { child: "tool_applications", column: "owner_agent_id", parent: "agents" },
  { child: "tool_call_events", column: "agent_id", parent: "agents" },
  { child: "tool_catalog_entries", column: "reviewed_by_agent_id", parent: "agents" },
  { child: "tool_connection_installs", column: "created_by_agent_id", parent: "agents" },
  { child: "tool_connections", column: "created_by_agent_id", parent: "agents" },
  { child: "tool_gateway_sessions", column: "agent_id", parent: "agents" },
  { child: "tool_invocations", column: "agent_id", parent: "agents" },
  { child: "tool_mcp_gateway_tokens", column: "expiry_override_by_agent_id", parent: "agents" },
  { child: "tool_mcp_gateways", column: "agent_id", parent: "agents" },
  { child: "tool_oauth_states", column: "subject_agent_id", parent: "agents" },
  { child: "tool_policies", column: "created_by_agent_id", parent: "agents" },
  { child: "tool_profile_bindings", column: "created_by_agent_id", parent: "agents" },
  { child: "tool_stdio_command_templates", column: "created_by_agent_id", parent: "agents" },
  { child: "user_secret_definitions", column: "created_by_agent_id", parent: "agents" },
  { child: "user_secret_definitions", column: "updated_by_agent_id", parent: "agents" },
  { child: "workspace_runtime_services", column: "owner_agent_id", parent: "agents" },
  { child: "issue_approvals", column: "approval_id", parent: "approvals" },
  { child: "tool_action_requests", column: "approval_id", parent: "approvals" },
  { child: "case_attachments", column: "asset_id", parent: "assets" },
  { child: "company_logos", column: "asset_id", parent: "assets" },
  { child: "issue_attachments", column: "asset_id", parent: "assets" },
  { child: "runner_api_response_reservations", column: "asset_id", parent: "assets" },
  { child: "chat_deliveries", column: "conversation_id", parent: "chat_conversations" },
  { child: "chat_actions", column: "delivery_id", parent: "chat_deliveries" },
  { child: "chat_message_links", column: "delivery_id", parent: "chat_deliveries" },
  { child: "chat_message_links", column: "publication_id", parent: "chat_publications" },
  { child: "company_skills", column: "forked_from_company_id", parent: "companies" },
  { child: "company_secret_bindings", column: "secret_id", parent: "company_secrets" },
  { child: "company_secret_proposals", column: "created_secret_id", parent: "company_secrets" },
  { child: "company_secret_proposals", column: "secret_id", parent: "company_secrets" },
  { child: "routine_triggers", column: "secret_id", parent: "company_secrets" },
  { child: "secret_access_events", column: "secret_id", parent: "company_secrets" },
  { child: "company_skill_comments", column: "company_skill_id", parent: "company_skills" },
  { child: "company_skill_source_entries", column: "skill_id", parent: "company_skills" },
  { child: "company_skill_stars", column: "company_skill_id", parent: "company_skills" },
  { child: "company_skill_test_inputs", column: "skill_id", parent: "company_skills" },
  { child: "company_skill_test_runs", column: "skill_id", parent: "company_skills" },
  { child: "company_skill_versions", column: "company_skill_id", parent: "company_skills" },
  { child: "decisions", column: "bundle_id", parent: "decision_bundles" },
  { child: "decision_target_issues", column: "decision_id", parent: "decisions" },
  { child: "case_documents", column: "document_id", parent: "documents" },
  { child: "document_annotation_anchor_snapshots", column: "document_id", parent: "documents" },
  { child: "document_annotation_comments", column: "document_id", parent: "documents" },
  { child: "document_annotation_threads", column: "document_id", parent: "documents" },
  { child: "document_memberships", column: "document_id", parent: "documents" },
  { child: "document_revisions", column: "document_id", parent: "documents" },
  { child: "issue_documents", column: "document_id", parent: "documents" },
  { child: "pipeline_case_documents", column: "document_id", parent: "documents" },
  { child: "pipeline_documents", column: "document_id", parent: "documents" },
  { child: "routine_documents", column: "document_id", parent: "documents" },
  { child: "status_cards", column: "document_id", parent: "documents" },
  { child: "summary_slots", column: "document_id", parent: "documents" },
  { child: "company_onboarding_seeds", column: "goal_id", parent: "goals" },
  { child: "project_goals", column: "goal_id", parent: "goals" },
  { child: "routines", column: "goal_id", parent: "goals" },
  { child: "agent_instruction_working_copies", column: "run_id", parent: "heartbeat_runs" },
  { child: "chat_completion_deliveries", column: "target_run_id", parent: "heartbeat_runs" },
  { child: "chat_github_reviews", column: "run_id", parent: "heartbeat_runs" },
  { child: "company_secret_proposals", column: "origin_run_id", parent: "heartbeat_runs" },
  { child: "connection_token_issuances", column: "run_id", parent: "heartbeat_runs" },
  { child: "document_annotation_comments", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "document_revisions", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "environment_leases", column: "heartbeat_run_id", parent: "heartbeat_runs" },
  { child: "execution_workspace_runtime_leases", column: "owner_run_id", parent: "heartbeat_runs" },
  { child: "heartbeat_run_watchdog_decisions", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "heartbeat_run_watchdog_decisions", column: "run_id", parent: "heartbeat_runs" },
  { child: "issue_attachments", column: "originating_run_id", parent: "heartbeat_runs" },
  { child: "issue_comments", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_comments", column: "deleted_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_comments", column: "derived_created_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_execution_decisions", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_inbox_archives", column: "archived_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_plan_decompositions", column: "owner_run_id", parent: "heartbeat_runs" },
  { child: "issue_question_response_deliveries", column: "source_run_id", parent: "heartbeat_runs" },
  { child: "issue_question_response_deliveries", column: "target_run_id", parent: "heartbeat_runs" },
  { child: "issue_thread_interactions", column: "resolved_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_thread_interactions", column: "source_run_id", parent: "heartbeat_runs" },
  { child: "issue_tree_hold_members", column: "active_run_id", parent: "heartbeat_runs" },
  { child: "issue_tree_holds", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_tree_holds", column: "released_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_watchdogs", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_watchdogs", column: "updated_by_run_id", parent: "heartbeat_runs" },
  { child: "issue_work_products", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "issues", column: "checkout_run_id", parent: "heartbeat_runs" },
  { child: "issues", column: "execution_run_id", parent: "heartbeat_runs" },
  { child: "provider_trace_records", column: "run_id", parent: "heartbeat_runs" },
  { child: "routine_revisions", column: "created_by_run_id", parent: "heartbeat_runs" },
  { child: "runner_api_response_reservations", column: "run_id", parent: "heartbeat_runs" },
  { child: "secret_access_events", column: "heartbeat_run_id", parent: "heartbeat_runs" },
  { child: "status_card_updates", column: "run_id", parent: "heartbeat_runs", owner: { column: "card_id", table: "status_cards" } },
  { child: "tool_call_events", column: "run_id", parent: "heartbeat_runs" },
  { child: "tool_gateway_sessions", column: "run_id", parent: "heartbeat_runs" },
  { child: "tool_invocations", column: "run_id", parent: "heartbeat_runs" },
  { child: "workspace_operations", column: "heartbeat_run_id", parent: "heartbeat_runs" },
  { child: "workspace_runtime_services", column: "started_by_run_id", parent: "heartbeat_runs" },
  { child: "chat_completion_deliveries", column: "response_comment_id", parent: "issue_comments" },
  { child: "chat_message_links", column: "comment_id", parent: "issue_comments" },
  { child: "chat_publications", column: "comment_id", parent: "issue_comments" },
  { child: "document_annotation_comments", column: "issue_comment_id", parent: "issue_comments" },
  { child: "issue_attachments", column: "issue_comment_id", parent: "issue_comments" },
  { child: "issue_duplicate_pairs", column: "comment_id", parent: "issue_comments" },
  { child: "issue_thread_interactions", column: "source_comment_id", parent: "issue_comments" },
  { child: "case_issue_links", column: "issue_id", parent: "issues" },
  { child: "chat_task_handoffs", column: "conversation_id", parent: "issues" },
  { child: "chat_task_handoffs", column: "task_id", parent: "issues" },
  { child: "company_onboarding_seeds", column: "issue_id", parent: "issues" },
  { child: "company_secret_proposals", column: "origin_issue_id", parent: "issues" },
  { child: "connection_token_issuances", column: "issue_id", parent: "issues" },
  { child: "cost_events", column: "issue_id", parent: "issues" },
  { child: "decision_target_issues", column: "issue_id", parent: "issues" },
  { child: "decision_training_examples", column: "issue_id", parent: "issues" },
  { child: "document_annotation_comments", column: "issue_id", parent: "issues" },
  { child: "document_annotation_threads", column: "issue_id", parent: "issues" },
  { child: "environment_leases", column: "issue_id", parent: "issues" },
  { child: "execution_workspace_runtime_leases", column: "owner_issue_id", parent: "issues" },
  { child: "execution_workspaces", column: "source_issue_id", parent: "issues" },
  { child: "external_object_mentions", column: "source_issue_id", parent: "issues" },
  { child: "feedback_exports", column: "issue_id", parent: "issues" },
  { child: "feedback_votes", column: "issue_id", parent: "issues" },
  { child: "finance_events", column: "issue_id", parent: "issues" },
  { child: "heartbeat_run_watchdog_decisions", column: "evaluation_issue_id", parent: "issues" },
  { child: "issue_approvals", column: "issue_id", parent: "issues" },
  { child: "issue_attachments", column: "issue_id", parent: "issues" },
  { child: "issue_comments", column: "issue_id", parent: "issues" },
  { child: "issue_create_idempotency_keys", column: "issue_id", parent: "issues" },
  { child: "issue_documents", column: "issue_id", parent: "issues" },
  { child: "issue_duplicate_pairs", column: "candidate_issue_id", parent: "issues" },
  { child: "issue_duplicate_pairs", column: "issue_id", parent: "issues" },
  { child: "issue_execution_decisions", column: "issue_id", parent: "issues" },
  { child: "issue_inbox_archives", column: "issue_id", parent: "issues" },
  { child: "issue_labels", column: "issue_id", parent: "issues" },
  { child: "issue_plan_decompositions", column: "source_issue_id", parent: "issues" },
  { child: "issue_question_response_deliveries", column: "issue_id", parent: "issues" },
  { child: "issue_read_states", column: "issue_id", parent: "issues" },
  { child: "issue_recovery_actions", column: "recovery_issue_id", parent: "issues" },
  { child: "issue_recovery_actions", column: "source_issue_id", parent: "issues" },
  { child: "issue_reference_mentions", column: "source_issue_id", parent: "issues" },
  { child: "issue_reference_mentions", column: "target_issue_id", parent: "issues" },
  { child: "issue_relations", column: "issue_id", parent: "issues" },
  { child: "issue_relations", column: "related_issue_id", parent: "issues" },
  { child: "issue_thread_interactions", column: "issue_id", parent: "issues" },
  { child: "issue_tree_hold_members", column: "issue_id", parent: "issues" },
  { child: "issue_tree_hold_members", column: "parent_issue_id", parent: "issues" },
  { child: "issue_tree_holds", column: "root_issue_id", parent: "issues" },
  { child: "issue_watchdogs", column: "issue_id", parent: "issues" },
  { child: "issue_watchdogs", column: "watchdog_issue_id", parent: "issues" },
  { child: "issue_work_products", column: "issue_id", parent: "issues" },
  { child: "pipeline_automation_executions", column: "execution_issue_id", parent: "issues" },
  { child: "pipeline_case_issue_links", column: "issue_id", parent: "issues" },
  { child: "routine_runs", column: "linked_issue_id", parent: "issues" },
  { child: "routines", column: "parent_issue_id", parent: "issues" },
  { child: "secret_access_events", column: "issue_id", parent: "issues" },
  { child: "status_card_updates", column: "generation_issue_id", parent: "issues", owner: { column: "card_id", table: "status_cards" } },
  { child: "status_cards", column: "generating_issue_id", parent: "issues" },
  { child: "summary_slots", column: "generating_issue_id", parent: "issues" },
  { child: "tool_action_deliveries", column: "issue_id", parent: "issues" },
  { child: "tool_action_requests", column: "issue_id", parent: "issues" },
  { child: "tool_call_events", column: "issue_id", parent: "issues" },
  { child: "tool_gateway_sessions", column: "issue_id", parent: "issues" },
  { child: "tool_invocations", column: "issue_id", parent: "issues" },
  { child: "tool_mcp_gateways", column: "approval_issue_id", parent: "issues" },
  { child: "tool_mcp_gateways", column: "issue_id", parent: "issues" },
  { child: "tool_runtime_slots", column: "issue_id", parent: "issues" },
  { child: "workspace_operations", column: "issue_id", parent: "issues" },
  { child: "workspace_runtime_services", column: "issue_id", parent: "issues" },
  { child: "cases", column: "project_id", parent: "projects" },
  { child: "connection_token_issuances", column: "project_id", parent: "projects" },
  { child: "execution_workspaces", column: "project_id", parent: "projects" },
  { child: "feedback_exports", column: "project_id", parent: "projects" },
  { child: "issue_work_products", column: "project_id", parent: "projects" },
  { child: "pipelines", column: "project_id", parent: "projects" },
  { child: "project_goals", column: "project_id", parent: "projects" },
  { child: "project_memberships", column: "project_id", parent: "projects" },
  { child: "project_workspaces", column: "project_id", parent: "projects" },
  { child: "routines", column: "project_id", parent: "projects" },
  { child: "tool_gateway_sessions", column: "project_id", parent: "projects" },
  { child: "tool_mcp_gateways", column: "project_id", parent: "projects" },
  { child: "workspace_runtime_services", column: "project_id", parent: "projects" },
  { child: "routine_runs", column: "routine_revision_id", parent: "routine_revisions" },
  { child: "routine_runs", column: "trigger_id", parent: "routine_triggers" },
  { child: "routine_webhook_test_receipts", column: "trigger_id", parent: "routine_triggers" },
  { child: "document_annotation_comments", column: "routine_id", parent: "routines" },
  { child: "document_annotation_threads", column: "routine_id", parent: "routines" },
  { child: "pipeline_automation_executions", column: "routine_id", parent: "routines" },
  { child: "routine_documents", column: "routine_id", parent: "routines" },
  { child: "routine_revisions", column: "routine_id", parent: "routines" },
  { child: "routine_runs", column: "routine_id", parent: "routines" },
  { child: "routine_triggers", column: "routine_id", parent: "routines" },
  { child: "tool_access_audit_events", column: "gateway_id", parent: "tool_mcp_gateways" },
  { child: "tool_call_events", column: "gateway_id", parent: "tool_mcp_gateways" },
  { child: "tool_gateway_sessions", column: "gateway_id", parent: "tool_mcp_gateways" },
  { child: "tool_invocations", column: "gateway_id", parent: "tool_mcp_gateways" },
  { child: "tool_mcp_gateway_tokens", column: "gateway_id", parent: "tool_mcp_gateways" },
  { child: "issue_work_products", column: "runtime_service_id", parent: "workspace_runtime_services" },
];

/** The cascade and set-null keys that `CROSS_COMPANY_REFERENCES` leaves out on purpose. */
export const CROSS_COMPANY_EXCLUSIONS: readonly CrossCompanyExclusion[] = [
  { child: "cli_auth_challenges", column: "requested_company_id", parent: "companies", reason: "A login challenge has no company of its own. The only company it names is the one it requested." },
  { child: "company_secret_versions", column: "secret_id", parent: "company_secrets", reason: "This is the owner reference. A row belongs to the company of its secret, which is the deleted row." },
  { child: "decision_effect_executions", column: "decision_id", parent: "decisions", reason: "This is the owner reference. A row belongs to the company of its decision, which is the deleted row." },
  { child: "environment_custom_image_setup_sessions", column: "started_by_agent_id", parent: "agents", reason: "Setup sessions belong to an instance-level environment, not to a company. Only an audit pointer is cleared." },
  { child: "environment_custom_image_templates", column: "created_by_agent_id", parent: "agents", reason: "Templates belong to an instance-level environment, not to a company. Only an audit pointer is cleared." },
];

function parentRowsOfCompany(reference: CrossCompanyReference, companyId: string): SQL {
  return reference.parent === "companies"
    ? sql`parent."id" = ${companyId}`
    : sql`parent."company_id" = ${companyId}`;
}

function childBelongsToOtherCompany(reference: CrossCompanyReference, companyId: string): SQL {
  if (reference.owner) {
    return sql`EXISTS (
      SELECT 1 FROM ${sql.identifier(reference.owner.table)} AS owner
      WHERE owner."id" = child.${sql.identifier(reference.owner.column)}
        AND owner."company_id" IS DISTINCT FROM ${companyId}
    )`;
  }
  return sql`child."company_id" IS DISTINCT FROM ${companyId}`;
}

function rowsOfOtherCompanies(reference: CrossCompanyReference, companyId: string): SQL {
  return sql`
    SELECT ${reference.child}::text AS child_table, child.ctid::text AS row_id
    FROM ${sql.identifier(reference.child)} AS child
    WHERE child.${sql.identifier(reference.column)} IN (
      SELECT parent."id" FROM ${sql.identifier(reference.parent)} AS parent
      WHERE ${parentRowsOfCompany(reference, companyId)}
    )
    AND ${childBelongsToOtherCompany(reference, companyId)}
  `;
}

function readCount(row: unknown): { table: string; count: number } | null {
  if (typeof row !== "object" || row === null) return null;
  const table: unknown = Reflect.get(row, "child_table");
  const total: unknown = Reflect.get(row, "total");
  if (typeof table !== "string" || typeof total !== "number" || total <= 0) return null;
  return { table, count: total };
}

/**
 * Refuses to delete a company when that would delete or change another company's rows.
 *
 * A row of company B can reference a row of company A through a cascade or set-null key
 * (for example an attachment of B that points at an asset of A). Deleting A would then
 * delete that row of B, or clear its reference, and the change cannot be undone. Run this
 * inside the deletion transaction, before any delete. It reads only.
 *
 * A row that references this company through two columns counts once.
 *
 * @param db - The transaction that will delete the company.
 * @param companyId - The company about to be deleted.
 * @throws A 409 with `details.code` `company_delete_cross_company_references` and the tables with their row counts. It names no ids, companies or content.
 */
export async function assertNoCrossCompanyReferences(db: Pick<Db, "execute">, companyId: string): Promise<void> {
  const found = sql.join(
    CROSS_COMPANY_REFERENCES.map((reference) => rowsOfOtherCompanies(reference, companyId)),
    sql` UNION ALL `,
  );
  const rows = await db.execute(
    sql`SELECT child_table, count(DISTINCT row_id)::int AS total FROM (${found}) AS found GROUP BY child_table ORDER BY child_table`,
  );
  const references = Array.from(rows).flatMap((row) => {
    const entry = readCount(row);
    return entry ? [entry] : [];
  });
  if (references.length === 0) return;
  throw conflict(
    "Company delete is blocked because rows of other companies depend on this company's data. Nothing was deleted.",
    { code: COMPANY_DELETE_CROSS_COMPANY_REFERENCES, references },
  );
}

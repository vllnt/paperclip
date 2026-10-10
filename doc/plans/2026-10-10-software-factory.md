# Software factory plan

## Verified overlap table

The table below was checked against `origin/main` at commit `d9804ac4fbd8c277933d112be0b688715ba23594`. It is the reuse contract for this plan.

| Slice | Existing primitive reused | Dependency or owner track | Flag | Web surface | REST API surface | CLI surface | Migration |
|---|---|---|---|---|---|---|---|
| Workflow name and graph canvas | `pipelines`, `pipeline_stages`, `pipeline_transitions`, pipeline services, and pipeline cases. A case is one run of a pipeline. | No new PR dependency for the existing pipeline/case implementation. The Workroom/sidebar work lands first. | `enablePipelines`; `enableCases` for case views. | Add a **Workflows** entry and a project workflow view. Render the existing stage graph as an n8n-style canvas. Show open case counts and case state on each node. | Keep `/api/companies/:companyId/pipelines`, `/api/pipelines/:pipelineId/cases`, and `/api/cases/:caseId` as the contract. Add graph and case-summary responses only where the existing response does not provide the view. | Extend `paperclipai pipelines` for graph and case summaries. Keep the command name stable. | None. The canvas is a view over existing rows. |
| Project workflow navigation and routine links | `pipelines.projectId`, `routines.projectId`, `pipeline_automation_executions.routineId`, and existing project routes. | No new PR dependency for the existing routine and project APIs. | `enablePipelines`. | On a project, list workflows and routines. From a workflow stage, open the linked routine and its revision. | Reuse project, pipeline, and routine endpoints. Add only a project-scoped workflow listing if existing list filters cannot provide it. | Add project filters to `paperclipai pipelines` and use existing routine commands for routine details. | None. Project links already exist. |
| Parallel cases and joins | Several open rows in `pipeline_cases` are parallel runs. Parent cases, child counts, `pipeline_case_blockers`, child issues, and blockers provide fan-out and join. | No new PR dependency for cases. Depend on the issue-plan decomposition track when its view is enabled. | `enableCases`; `enableIssuePlanDecompositions` for the decomposition history view. | Show concurrent cases in the workflow run view. Show parent, children, blockers, and join readiness. | Reuse case, child, blocker, and case-event endpoints. Add a read model only if the current aggregation cannot return the canvas state in one company-scoped request. | Add case tree, blocker, and join columns to the existing pipeline commands. | None for the first version. Store a per-workflow concurrency policy in the existing pipeline configuration. Assign a migration just in time only if measurement proves JSON configuration insufficient. |
| Watchdog, holds, and release gates | Flow watchdog, holds with lift conditions, approvals, and merge-on-green. | Flow-watchdog owner track; holds PR #102. Consume both after they land. | `enablePipelines` and `enableCases` as applicable. Do not add a factory health flag. | Display watchdog status and active holds on the workflow and case pages after their owner APIs land; show unavailable until then. A hold pauses the line and shows its lift condition. | Consume the watchdog and hold endpoints when their owner tracks land. Reuse approval and merge endpoints. Do not create a second stop or health API. | Add read-only health and hold output to workflow commands; use existing hold commands for changes. | None. |
| Runtime teams and project links | `agents.reportsTo`, team-catalog packages, team-level goals, and built-in agents. | Teams Catalog and built-in-agent tracks. No runtime-team PR until the gap test passes. | `enableBuiltInAgents` for shipped agents; no new team flag until a gap is proven. | Import a catalog team and show its agents, projects, routines, workflows, and goals. If runtime teams are approved, add shared team views across projects. | Reuse catalog import and agent/goal/project APIs. Add company-scoped team membership and project-link endpoints only after the gap test passes. | Extend existing team commands for import/list/show. Add membership/link commands only with runtime team tables. | None for catalog teams. If runtime teams are approved, assign the next migration number just in time for the smallest company-scoped team, membership, and project-link tables. |
| Default factory bundle | Teams Catalog, Skills Catalog, built-in-agent setup, and lean-skill validation. | Teams Catalog, Skills Catalog, and lean-skill PRs #51, #78, and #89. The built-in coordinator is the same role used by the Workroom plan. | `enableBuiltInAgents`; skill catalog controls. | Offer a catalog import that creates the default team, agents, projects, routines, and skills. Link the coordinator to the Workroom surface owned by the other plan. | Reuse catalog install/import endpoints and company skill APIs. Add no second bundle registry. | Add a deterministic bundle import and dry-run command that calls the same API contract. | None. A bundle is catalog content. |
| Retrospective and improvement loop | Skill revision proposals, company evals, routine revisions, agent/document revisions, and activity history. | Skill-proposal PR #107 and company-evals PR #92. | Existing skill/eval controls. No new retro flag. | Add a retrospective view to a workflow or project. Show evidence, proposed change, owner, and follow-up result. | Reuse proposal, eval, revision, and activity endpoints. Add an aggregation only if the existing APIs cannot correlate a run window to a proposal. | Add an export or report command that reads the same proposal/eval data. | None. |
| KPI and DORA read views | Flow metrics, run statistics, `run_usage_records`, run log, issues, work products, recovery actions, and linked merge/deploy evidence. | Flow-metrics PR #106, run-stats PR #28, usage/failure observability PR #73, and token-estimate PR #62 are in-flight or merged dependencies. The metrics API must land its definitions and source coverage before these views claim support. | `enablePipelines` for workflow views; existing observability access for traces and usage. Do not use first-party Telemetry for company KPIs. | Give company, project, workflow, case, agent, and team views the same metric cards and source/coverage labels. Add DORA cards only when their event source is available. | After the metrics API lands, extend it with dimensions and time windows. Return source, freshness, coverage, and “unavailable” when a DORA event cannot be proven. Do not add a KPI ledger. | Add `paperclipai metrics`/DORA output only when the metrics API exists; JSON and table output must match web values. | None for read models. If goal metric fields are approved, assign the next migration number just in time. |
| Trace and run inspection | `heartbeat_run_events`, `run_usage_records`, `provider_trace_records`, and operator-gated OpenTelemetry traces. | Usage/failure observability PR #73, token-estimate PR #62, and the full-observability plan. The OTel endpoint remains a no-op when unset. | Existing observability gate; no new telemetry flag. | A run detail panel links the workflow case, routine, agent, usage facts, run events, provider trace metadata, and OTel trace when available. | Reuse run, run-event, usage, provider-trace, and observability endpoints. Join by run ID and preserve company authorization. | Extend run and observability commands with workflow/case filters and trace references. | None. |
| Revision impact history | Agent config and instruction revisions, document revisions, routine revisions, company skill versions, and `activity_log`. | No new PR dependency; use the existing revision and activity-log owners. Skill version CLI work is PR #35. | Existing feature controls. | Mark revisions on KPI charts and workflow timelines. Allow a before/after comparison with the source revision and run window. | Reuse revision and activity endpoints. Add a read-only impact aggregation if needed; do not add a second history table. | Add history and impact export using the same read model. | None. |
| Web/API/CLI parity and rollout | Existing company-scoped auth, activity logging, feature catalog, and CLI API client. | No new PR dependency; use the normal API/UI/CLI parity checks and the owners above. | The existing flags above. | Every enabled action has an accessible web route and clear failure state. | Every web action has a company-scoped, permission-checked REST contract. Mutations log activity. | Every supported web action has a matching CLI command or a documented read-only omission. | Migrations are additive, numbered from the current head at implementation time, and tested before rollout. |

## Verified anchors and boundaries

- `packages/db/src/schema/pipelines.ts` already defines company-scoped pipelines with optional project links, stages, transitions, and stage configuration.
- `packages/db/src/schema/pipeline_cases.ts` already defines cases, parent cases, child counters, leases, terminal state, issue links, blockers, and routine-backed automation executions.
- `packages/db/src/schema/routines.ts` already defines `projectId`, routine revisions, routine runs, concurrency policy, and the revision used for a run.
- `packages/db/src/schema/heartbeat_run_events.ts` is the durable instance run log. It is not the Telemetry path.
- `packages/db/src/schema/run_usage_records.ts` is the bounded, asynchronous usage fact table. It contains project and routine dimensions and survives deletion of an agent or run.
- `packages/db/src/schema/provider_trace_records.ts` stores trace metadata for a run. Exact provider bytes remain in the restricted sidecar.
- `server/src/instrumentation.ts` and `doc/observability.md` define the operator-gated OTel path. No endpoint means no exported traces.
- The flow watchdog and holds are in-flight owner tracks. This plan consumes their landed status and action APIs; it does not claim those controls already exist.
- `packages/db/src/schema/agent_config_revisions.ts`, `agent_instruction_revisions.ts`, `document_revisions.ts`, `routines.ts`, and `company_skills.ts` already preserve configuration and content history. `activity_log.ts` records mutating actions.
- `packages/db/src/schema/agents.ts` provides the management tree through `reportsTo`. `goals.level` already accepts `team`, but `goals` has no metric fields today.
- `packages/teams-catalog` already ships importable teams with agents, projects, tasks, and skills. The catalog is the default-bundle boundary.
- The feature catalog already contains `enablePipelines`, `enableCases`, `enableIssuePlanDecompositions`, `enableBuiltInAgents`, and `enableAgentChat`. It has no factory-specific health or holds flag. The workflow plan does not create a parallel flag set.
- The current migration head is `0298`. Future numbers must be assigned just in time after the implementation branch is based on the actual head.
- The sidebar must retain the Cmd+K launcher. The Workroom row lands first. Add a Workflows row after it. Do not add New task or Search rows.

## Operating model

A workflow is a pipeline definition. A case is one execution of that definition. The canvas shows the pipeline graph and overlays case state; it does not execute work. A workflow may have several open cases at once. Child issues and case blockers express fan-out and join. A stage can run a linked routine through the existing `onEnter` automation contract. The linked routine run keeps `routineRevisionId`; the case references the execution and run.

The first implementation should use the existing pipeline JSON configuration for concurrency policy. The configuration must define the maximum active cases, the admission behavior when the limit is reached, and whether a retry consumes a slot. The service must enforce the policy atomically and expose the reason for a deferred case. Add normalized scheduling tables only when profiling or correctness tests show that the existing pipeline configuration cannot meet the contract.

The canvas must be a progressive-disclosure view. The top layer shows stage names, active counts, holds, and outcomes. The case layer shows child work, blockers, routine runs, and approvals. The run layer shows events, usage facts, provider trace metadata, and an optional OTel trace. Raw event text remains secondary.

Health and stop-the-line behavior stay with their owners. The workflow view consumes watchdog results and holds with lift conditions. It does not invent a second health score or pause mechanism. A release gate uses existing approvals and merge-on-green behavior.

Metrics are read models. Every card names its source, time window, freshness, and coverage. A DORA card is hidden or marked unavailable when its event source cannot be proven. A metric must never read first-party Telemetry. The implementation should start with flow throughput, scrap/failure, cycle time, queue wait, usage/cost, and recovery views, then add DORA views over the same metrics API when the merge/deploy source is complete.

A change marker is a revision event joined to the runs and metrics after that event. The first version can compare fixed windows before and after a revision. It must show the revision identifier, actor, affected object, and sample size. It must not claim causality from correlation.

The default factory bundle is catalog content. It imports a small team, skills, routines, projects, and the built-in coordinator. The coordinator is one built-in agent shared with the Workroom plan. Workroom owns the chat surface; this plan owns the factory bundle and workflow surfaces. Retrospectives create skill revision proposals or company evals and attach evidence. They do not silently mutate a live skill, agent, or workflow.

All web, REST, and CLI paths use the same company boundary and actor checks. Mutations use the existing activity-log path. API names remain stable unless the choice below is changed deliberately.

## Consequential choices

### Rename pipelines in the API

**Recommendation: keep the API and database names `pipelines` and `pipeline_cases`, and use “Workflows” as the product label.**

The existing routes, CLI commands, feature flags, schemas, and tests already use pipeline names. A hard rename would break clients and add a migration without changing execution behavior. If a future compatibility alias is needed, add an additive `workflows` route and CLI alias, document the deprecation window, and keep the pipeline contract as the source of truth. Do not rename tables in this plan.

### Add runtime team tables

**Recommendation: defer runtime team tables until a gap test proves that the org tree and catalog are insufficient.**

The management tree, team-level goals, and catalog packages already express the default teams. Test the required cases first: one team shared by multiple projects, membership changes without changing reporting lines, team-scoped workflow ownership, and team-scoped KPI filtering. If catalog imports plus project links can express these cases, add no tables. If they cannot, add only company-scoped teams, memberships, and project links. Do not add a second agent hierarchy or a team chat system. Assign the next migration number just in time.

### Add metric fields to goals

**Recommendation: keep goals as they are while the metrics API proves the need; add fields only for a demonstrated write/read gap.**

The current goal table already supports company, parent, owner, level, and status. Build KPI and DORA cards from existing metric sources first. If a goal must persist a target that cannot be represented by the metrics read model, add explicit fields for metric key, unit, baseline, target, and target date in one additive migration. Validate units and ownership, preserve historical values, and publish the source and freshness with every goal metric. Do not create a separate goal KPI ledger.

## Delivery and acceptance order

1. Land the navigation and Workroom dependency, then expose Workflows behind `enablePipelines`.
2. Validate the canvas against real pipeline stages, transitions, cases, child issues, blockers, and routine revisions.
3. Add project views and concurrency policy using existing rows and atomic admission.
4. Integrate watchdog results, holds, approvals, and merge gates.
5. Import the catalog factory bundle and verify the shared built-in coordinator.
6. Add trace/run inspection and metrics read models with explicit source and coverage.
7. Add revision markers, retrospectives, and eval evidence.
8. Run the runtime-team and goal-metric gap tests before any schema migration.
9. Release web, API, and CLI surfaces together behind the existing flags.

Acceptance requires that a workflow case can be started twice in parallel, that fan-out and join state is inspectable, that a routine revision is pinned to each run, that a hold stops admission and displays its lift condition, and that every KPI links back to durable instance data. The implementation must pass company-boundary, permission, activity-log, retry, lease, and failure-path tests. No step may send company KPI data through first-party Telemetry.

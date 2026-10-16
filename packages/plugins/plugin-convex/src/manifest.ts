import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./contracts.js";

const secretRef = {
  type: "object", format: "secret-ref",
  properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } },
  required: ["type", "secretId"], additionalProperties: false,
};
const names = { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100 };
const tool = (name: string, displayName: string, description: string) => ({ name, displayName, description, parametersSchema: { type: "object" } });

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID, apiVersion: 1, version: "0.1.0", displayName: "Convex",
  description: "Manage Convex deployments with per-environment, per-agent access: inventory, health, preview lifecycle and a quota reaper.",
  author: "VLLNT", categories: ["connector"],
  capabilities: ["agents.read", "issues.create", "jobs.schedule", "plugin.state.read", "plugin.state.write", "secrets.read-ref", "http.outbound",
    "activity.log.write", "agent.tools.register", "ui.page.register", "instance.settings.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  jobs: [{ jobKey: "convex-reaper", displayName: "Reap Convex previews and check the quota", schedule: "17 * * * *" }],
  instanceConfigSchema: {
    type: "object", additionalProperties: false,
    properties: {
      teamId: { type: "string", pattern: "^[0-9]+$" },
      teamToken: secretRef,
      projects: {
        type: "array", maxItems: 50, items: {
          type: "object", additionalProperties: false, required: ["convexProjectId"],
          properties: {
            convexProjectId: { type: "string", pattern: "^[0-9]+$" },
            name: { type: "string", maxLength: 100 },
            paperclipProjectId: { type: "string" },
            repository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
            token: secretRef,
            previewDeployKey: secretRef,
            environments: { type: "object", additionalProperties: false, properties: { production: names, staging: names } },
          },
        },
      },
      github: { type: "object", additionalProperties: false, properties: { token: secretRef } },
      grants: {
        type: "array", maxItems: 200, items: {
          type: "object", additionalProperties: false, required: ["environments"],
          properties: {
            agentId: { type: "string" }, role: { type: "string" },
            preset: { enum: ["observer", "triager", "janitor"] },
            capabilities: { type: "array", items: { enum: ["meta-read", "health-read", "logs-read", "data-read-pii", "env-read-names", "env-read-values", "env-write", "run-query", "run-write", "deploy", "lifecycle", "backup", "restore-import", "admin"] } },
            environments: { type: "array", minItems: 1, items: { enum: ["production", "staging", "preview", "dev", "custom"] } },
            approval: { enum: ["per-call"] },
          },
        },
      },
      guards: {
        type: "object", additionalProperties: false, properties: {
          activityHours: { type: "integer", minimum: 1, maximum: 168 }, maxDeletesPerRun: { type: "integer", minimum: 1, maximum: 100 },
          callsPerMinute: { type: "integer", minimum: 1, maximum: 600 }, dryRunOnly: { type: "boolean" },
        },
      },
      reaper: {
        type: "object", additionalProperties: false, properties: {
          enabled: { type: "boolean" }, ttlHours: { type: "integer", minimum: 3, maximum: 168 },
          quota: { type: "integer", minimum: 1 }, alertPercent: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  tools: [
    tool("convex_list_projects", "List Convex projects", "List the Convex projects mapped to this company."),
    tool("convex_list_deployments", "List Convex deployments", "List deployments with their environment class."),
    tool("convex_get_deployment", "Get a Convex deployment", "Read one deployment."),
    tool("convex_quota", "Convex deployment quota", "Count the team's deployments against the quota."),
    tool("convex_deployment_health", "Convex deployment health", "Last deploy, expiry, usage and usage limits."),
    tool("convex_get_usage", "Convex deployment usage", "Current usage per metric."),
    tool("convex_list_usage_limits", "Convex usage limits", "List configured usage limits."),
    tool("convex_list_custom_domains", "List Convex custom domains", "List the custom domains of a deployment."),
    tool("convex_list_deploy_keys", "List Convex deploy keys", "List deploy key metadata; values are never returned."),
    tool("convex_list_classes_regions", "List Convex deployment classes and regions", "List classes and regions available to the team."),
    tool("convex_list_audit_events", "List Convex deployment audit events", "Recent audit events; personal data needs data-read-pii."),
    tool("convex_set_preview_expiry", "Set Convex preview expiry", "Set a preview's expiry, at most 7 days out."),
    tool("convex_delete_preview", "Delete a Convex preview", "Delete a preview deployment behind server-side guards."),
    tool("convex_reap_previews", "Reap Convex previews", "Delete finished previews and shorten expiry of the rest."),
  ],
  ui: { slots: [
    { type: "settingsPage", id: "convex-settings", displayName: "Convex", exportName: "ConvexPage" },
    { type: "page", id: "convex", routePath: "convex", displayName: "Convex", exportName: "ConvexPage" },
  ] },
};
export default manifest;

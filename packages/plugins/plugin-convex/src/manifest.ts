import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CAPABILITIES, ENVIRONMENT_CLASSES, PLUGIN_ID, PRESETS } from "./contracts.js";
import { TOOL_DECLARATIONS } from "./tool-declarations.js";

const secretRef = {
  type: "object", format: "secret-ref",
  properties: { type: { const: "secret_ref" }, secretId: { type: "string" }, version: { const: "latest" } },
  required: ["type", "secretId"], additionalProperties: false,
};
const names = { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 100 };
// owner/name without a "." or ".." segment: the value goes into a GitHub API path (contracts.isRepositoryName is the same rule).
const repositoryPattern = "^(?!\\.{1,2}/)(?!.*/\\.{1,2}$)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID, apiVersion: 1, version: "0.1.0", displayName: "Convex",
  description: "Manage Convex deployments with per-environment, per-agent access: inventory, health, preview lifecycle and a quota reaper.",
  author: "VLLNT", categories: ["connector"],
  capabilities: ["agents.read", "issues.create", "jobs.schedule", "plugin.state.read", "plugin.state.write", "secrets.read-ref", "http.outbound",
    "activity.log.write", "agent.tools.register", "ui.page.register"],
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
            name: { type: "string", minLength: 1, maxLength: 100 },
            paperclipProjectId: { type: "string", minLength: 1 },
            repository: { type: "string", pattern: repositoryPattern },
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
          // A grant names one agent or one role, and grants something: the same rules parseConfig applies.
          oneOf: [{ required: ["agentId"], not: { required: ["role"] } }, { required: ["role"], not: { required: ["agentId"] } }],
          anyOf: [{ required: ["preset"] }, { required: ["capabilities"] }],
          properties: {
            agentId: { type: "string", minLength: 1 }, role: { type: "string", minLength: 1 },
            preset: { enum: Object.keys(PRESETS) },
            capabilities: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...CAPABILITIES] } },
            environments: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...ENVIRONMENT_CLASSES] } },
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
          quota: { type: "integer", minimum: 1, maximum: 100000 }, alertPercent: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  tools: TOOL_DECLARATIONS.map(({ name, displayName, description, parametersSchema }) => ({ name, displayName, description, parametersSchema })),
  ui: { slots: [{ type: "page", id: "convex", routePath: "convex", displayName: "Convex", exportName: "ConvexPage" }] },
};
export default manifest;

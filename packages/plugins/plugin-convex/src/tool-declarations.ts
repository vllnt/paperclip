import type { Capability } from "./contracts.js";

/**
 * The one description of each agent tool. The manifest publishes these and `agent-tools.ts` registers handlers against them: the host builds the
 * tool list an agent sees from the manifest only, so a schema or description kept anywhere else would never reach the agent.
 */
export interface ToolDeclaration {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  /** The grant an agent needs, on the deployment's environment class, to call the tool. */
  capability: Capability;
}

const NAME = {
  type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
  description: "Convex deployment name, for example happy-otter-123. Take it from the name field of convex_list_deployments.",
};
const DRY_RUN_DEFAULT_TRUE = { type: "boolean", default: true, description: "Defaults to true: every guard runs and the result says what would happen, but nothing changes. Pass false to apply the change." };
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const byName = schema({ name: NAME }, ["name"]);

export const TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: "convex_list_projects", displayName: "List Convex projects", capability: "meta-read", parametersSchema: schema(),
    description: "List the Convex projects mapped to this company: convexProjectId, name and GitHub repository. Takes no input. Use it first to learn which projects exist.",
  },
  {
    name: "convex_list_deployments", displayName: "List Convex deployments", capability: "meta-read",
    parametersSchema: schema({
      convexProjectId: { type: "string", pattern: "^[0-9]+$", description: "Only this project (an id from convex_list_projects)." },
      deploymentType: { enum: ["preview", "dev", "prod", "custom"], description: "Only this Convex deployment type." },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Rows per page." },
      cursor: { type: "string", maxLength: 128, description: "The nextCursor of the previous page; leave out for the first page." },
    }),
    description: "List deployments of the company's Convex projects, ordered by name, 50 per page. Each row is short: name, environment (production, staging, preview, dev or custom), " +
      "deploymentType, previewIdentifier, lastDeployTime and expiresAt (milliseconds since epoch). Only environments you hold a meta-read grant for are shown. " +
      "The result has total, truncated and nextCursor: pass nextCursor as cursor to read the next page. Use convex_get_deployment for the detail of one row.",
  },
  {
    name: "convex_get_deployment", displayName: "Get a Convex deployment", capability: "meta-read", parametersSchema: byName,
    description: "Read one deployment: environment class and the reason for it, type, reference, preview identifier, create, last deploy and expiry times, region, class, creator and project. " +
      "Refused with a pointer to convex_list_deployments when the name is not one of this company's deployments.",
  },
  {
    name: "convex_quota", displayName: "Convex deployment quota", capability: "meta-read", parametersSchema: schema(),
    description: "Count the team's deployments against the configured quota: count, quota, percent, alert and partial (true when only the mapped projects could be counted). " +
      "Takes no input. The answer is shared for a minute, so repeated calls are cheap. When the team has more deployments than could be counted, lowerBound is true and count is a minimum.",
  },
  {
    name: "convex_deployment_health", displayName: "Convex deployment health", capability: "health-read", parametersSchema: byName,
    description: "Health from the documented Convex APIs: last deploy, expiry, whether it expired, current usage and usage limits. " +
      "Failure rate, cache hit rate, scheduler lag, function metrics and insights have no documented API and are listed under unavailable. A part Convex could not answer carries its own error.",
  },
  {
    name: "convex_get_usage", displayName: "Convex deployment usage", capability: "health-read", parametersSchema: byName,
    description: "Current-day and current-month usage per metric for one deployment (Convex marks this endpoint beta).",
  },
  {
    name: "convex_list_usage_limits", displayName: "Convex usage limits", capability: "health-read", parametersSchema: byName,
    description: "List the usage limits configured on one deployment.",
  },
  {
    name: "convex_list_custom_domains", displayName: "List Convex custom domains", capability: "meta-read", parametersSchema: byName,
    description: "List the custom domains of one deployment.",
  },
  {
    name: "convex_list_deploy_keys", displayName: "List Convex deploy keys", capability: "meta-read", parametersSchema: byName,
    description: "List deploy key metadata of one deployment: name, creation time, last use and allowed actions. Key values are never returned.",
  },
  {
    name: "convex_list_classes_regions", displayName: "List Convex deployment classes and regions", capability: "meta-read", parametersSchema: schema(),
    description: "List the deployment classes and regions available to the team. Takes no input. Needs a team token and team id in the company config.",
  },
  {
    name: "convex_list_audit_events", displayName: "List Convex deployment audit events", capability: "logs-read",
    parametersSchema: schema({
      name: NAME,
      from: { type: "number", description: "Only events at or after this time, in milliseconds since epoch. Defaults to the last 24 hours." },
    }, ["name"]),
    description: "List recent audit events of one deployment (action, time, actor kind), from the last 24 hours unless from is given. " +
      "Client IP, user agent and metadata are included only if you also hold data-read-pii for the environment.",
  },
  {
    name: "convex_set_preview_expiry", displayName: "Set Convex preview expiry", capability: "lifecycle",
    parametersSchema: schema({
      name: NAME,
      hours: { type: "number", minimum: 0.5, maximum: 168, description: "Hours from now until the preview expires." },
      dryRun: { type: "boolean", default: false, description: "Run every guard and report what would happen without changing anything." },
    }, ["name", "hours"]),
    description: "Set when a preview deployment expires, 0.5 to 168 hours (7 days) from now. Previews only. " +
      "Convex deletes a preview when its expiry passes, so an expiry sooner than the preview's current one, the reaper's deadline or the activity window counts as a deletion: it follows the deletion guards and the per-run deletion limit. " +
      "A preview that carries the do-not-delete markers can only have its expiry moved later. " +
      "The result includes countsAsDeletion and earliestFreeExpiresAt, the earliest expiry that does not count as a deletion. Use dryRun first.",
  },
  {
    name: "convex_delete_preview", displayName: "Delete a Convex preview", capability: "lifecycle",
    parametersSchema: schema({ name: NAME, dryRun: DRY_RUN_DEFAULT_TRUE }, ["name"]),
    description: "Irreversibly delete a preview deployment and all its data. It is a dry run unless you pass dryRun: false, so call it once to see the evidence, then again with dryRun: false. " +
      "Refused for production, staging, dev and custom deployments, for previews marked do-not-delete, for previews of open pull requests or recently active branches, " +
      "for previews with no evidence that the work is finished (a closed or merged pull request, or a gone and idle branch), and past the per-run deletion limit. " +
      "When the company is set to dry-run-only, the result says so in note and nothing is deleted.",
  },
  {
    name: "convex_reap_previews", displayName: "Reap Convex previews", capability: "lifecycle",
    parametersSchema: schema({ dryRun: DRY_RUN_DEFAULT_TRUE }),
    description: "Run the reaper for this company: delete previews whose pull request is closed (or whose branch is gone and idle) and shorten the expiry of the rest. " +
      "It is a dry run unless you pass dryRun: false, and a real run is refused unless the company enabled the reaper. " +
      "The result gives counts per project and the first 25 entries of each list, with truncated when there are more; the full report is on the Convex page. " +
      "incomplete says why a pass stopped early. A pass that is already running is joined, not repeated.",
  },
];

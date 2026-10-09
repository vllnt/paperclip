import type { ConvexDeployment } from "./contracts.js";

/** Words that mark a deployment as production-like. A name, reference or preview identifier with one of these as a whole word is never deleted. */
const MARKERS = new Set(["prod", "prd", "production", "preprod", "preproduction", "staging", "stage", "stg", "main", "master", "release", "releases"]);
/** Words of a value: split on punctuation, on a capital after a lowercase letter, and between letters and digits (`releaseCandidate`, `staging2`). */
const words = (value: string | null): string[] => (value
  ? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([A-Za-z])([0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  : []);

/**
 * The hard delete guard. It runs inside every delete and expiry path, after and independent of grants and company config: no setting can
 * loosen it. Only cloud preview and dev deployments pass. Production, custom, default and local deployments never do, and neither does
 * anything whose name, reference or preview identifier (branch) says production, staging, main or release.
 */
export function hardDeleteBlock(deployment: ConvexDeployment): string | null {
  if (deployment.kind !== "cloud") return "Only cloud deployments can be deleted.";
  if (deployment.deploymentType !== "preview" && deployment.deploymentType !== "dev") return `Only preview and dev deployments can be deleted; this one is ${deployment.deploymentType ?? "of an unknown type"}.`;
  if (deployment.isDefault !== false) return "A default deployment is never deleted.";
  for (const value of [deployment.name, deployment.reference, deployment.previewIdentifier]) {
    const marker = words(value).find(word => MARKERS.has(word));
    if (marker) return `It references production, staging, main or release ("${marker}"), so it is never deleted.`;
  }
  return null;
}

import type { ConvexDeployment } from "./contracts.js";

/** Words that mark a deployment as production-like. A name, reference or preview identifier with one of these as a whole word is never deleted. */
const MARKERS = new Set(["prod", "prd", "production", "preprod", "preproduction", "staging", "stage", "stg", "main", "master", "release", "releases"]);
/**
 * Words of a value, split on punctuation, on a capital after a lowercase letter, and between letters and digits (`releaseCandidate`, `staging2`). An all-capitals
 * run next to lowercase is read both ways (`PRODdb` as `PROD db`, `HTMLParser` as `HTML Parser`), and a word counts if either reading finds it.
 */
const split = (value: string, acronymBeforeLower: boolean): string[] => {
  let text = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  text = acronymBeforeLower ? text.replace(/([A-Z]{2,})([a-z])/g, "$1 $2") : text.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return text.replace(/([A-Za-z])([0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
};
const words = (value: string): string[] => [...split(value, false), ...split(value, true)];

/**
 * The hard delete guard. It runs inside every delete and expiry path, after and independent of grants and company config: no setting can
 * loosen it. Only cloud preview and dev deployments pass. Production, custom, default and local deployments never do, and neither does
 * anything whose name, reference or preview identifier (branch) says production, staging, main or release.
 */
export function hardDeleteBlock(deployment: ConvexDeployment): string | null {
  if (deployment.kind !== "cloud") return "Only cloud deployments can be deleted.";
  if (deployment.deploymentType !== "preview" && deployment.deploymentType !== "dev") return `Only preview and dev deployments can be deleted; this one is ${deployment.deploymentType ?? "of an unknown type"}.`;
  if (deployment.isDefault !== false) return "A default deployment is never deleted.";
  for (const original of [deployment.name, deployment.reference, deployment.previewIdentifier]) {
    if (!original) continue;
    const value = original.normalize("NFKC"); // full-width letters become ordinary ones
    // Look-alike letters (Cyrillic o for Latin o) can hide a production word, so a name outside plain ASCII is never deleted.
    if (!/^[\x20-\x7e]*$/.test(value)) return "Its name contains characters outside a-z, 0-9 and punctuation, so it is never deleted.";
    const marker = words(value).find(word => MARKERS.has(word));
    if (marker) return `It references production, staging, main or release ("${marker}"), so it is never deleted.`;
  }
  return null;
}

import type { ConvexDeployment, EnvironmentClass, ProjectMapping } from "./contracts.js";

export interface Classification { environment: EnvironmentClass; reason: string }

const matches = (list: readonly string[], deployment: ConvexDeployment): boolean =>
  list.some(entry => entry === deployment.name || entry === deployment.reference || entry === deployment.previewIdentifier);

/**
 * Environment class of a deployment, computed from the re-fetched Convex record and the company's overrides.
 * Fail closed: anything the rules do not recognise is production.
 */
export function classifyDeployment(deployment: ConvexDeployment, project: ProjectMapping): Classification {
  if (deployment.kind !== "cloud") return { environment: "production", reason: "not a cloud deployment" };
  if (matches(project.production, deployment)) return { environment: "production", reason: "listed as production by the company" };
  const type = deployment.deploymentType;
  if (type === "prod") return { environment: "production", reason: "Convex production deployment" };
  if (deployment.isDefault === null) return { environment: "production", reason: "default flag unknown" };
  if (deployment.isDefault && type !== "dev") return { environment: "production", reason: "default deployment" };
  if (matches(project.staging, deployment)) return { environment: "staging", reason: "listed as staging by the company" };
  if (type === "preview") return { environment: "preview", reason: "Convex preview deployment" };
  if (type === "dev") return { environment: "dev", reason: "Convex dev deployment" };
  if (type === "custom") return { environment: "custom", reason: "Convex custom deployment" };
  return { environment: "production", reason: "unknown deployment type" };
}

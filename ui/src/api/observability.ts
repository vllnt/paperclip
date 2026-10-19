import type {
  ObservabilityFailuresQuery,
  ObservabilityFailuresResponse,
  ObservabilityHealth,
  ObservabilityUsageQuery,
  ObservabilityUsageResponse,
} from "@paperclipai/shared";
import { api } from "./client";

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * Client for the run usage reports under `/companies/:companyId/observability`. The server
 * validates every filter, so this client only drops the ones that are not set.
 */
export const observabilityApi = {
  health: (companyId: string) =>
    api.get<ObservabilityHealth>(`/companies/${companyId}/observability/health`),
  usage: (companyId: string, query: Partial<ObservabilityUsageQuery> = {}) =>
    api.get<ObservabilityUsageResponse>(`/companies/${companyId}/observability/usage${queryString(query)}`),
  failures: (companyId: string, query: Partial<ObservabilityFailuresQuery> = {}) =>
    api.get<ObservabilityFailuresResponse>(`/companies/${companyId}/observability/failures${queryString(query)}`),
};

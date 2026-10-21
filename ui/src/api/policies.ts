import type {
  CompanyPolicy,
  CompanyPolicyRevision,
  CreateCompanyPolicy,
  ListCompanyPoliciesQuery,
  UpdateCompanyPolicy,
} from "@paperclipai/shared";
import { api } from "./client";

function listQuery(filters: ListCompanyPoliciesQuery): string {
  const params = new URLSearchParams();
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.status) params.set("status", filters.status);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const policiesApi = {
  list: (companyId: string, filters: ListCompanyPoliciesQuery = {}) =>
    api.get<CompanyPolicy[]>(`/companies/${companyId}/policies${listQuery(filters)}`),
  get: (companyId: string, key: string) =>
    api.get<CompanyPolicy>(`/companies/${companyId}/policies/${encodeURIComponent(key)}`),
  revisions: (companyId: string, key: string) =>
    api.get<CompanyPolicyRevision[]>(`/companies/${companyId}/policies/${encodeURIComponent(key)}/revisions`),
  create: (companyId: string, data: CreateCompanyPolicy) =>
    api.post<CompanyPolicy>(`/companies/${companyId}/policies`, data),
  update: (companyId: string, key: string, data: UpdateCompanyPolicy) =>
    api.patch<CompanyPolicy>(`/companies/${companyId}/policies/${encodeURIComponent(key)}`, data),
  remove: (companyId: string, key: string) =>
    api.delete<CompanyPolicy>(`/companies/${companyId}/policies/${encodeURIComponent(key)}`),
};

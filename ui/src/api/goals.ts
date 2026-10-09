import type { CompanyFocus, Goal, GoalProgress } from "@paperclipai/shared";
import { api } from "./client";

export const goalsApi = {
  list: (companyId: string) => api.get<Goal[]>(`/companies/${companyId}/goals`),
  get: (id: string) => api.get<Goal>(`/goals/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
  focus: (companyId: string) => api.get<CompanyFocus>(`/companies/${companyId}/goals/focus`),
  progress: (companyId: string) => api.get<Record<string, GoalProgress>>(`/companies/${companyId}/goals/progress`),
};

import type {
  ActivityEvent,
  ListRoutinesQuery,
  Routine,
  RoutineDetail,
  RoutineListItem,
  RoutineRevision,
  RoutineRun,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
} from "@paperclipai/shared";
import { activityApi } from "./activity";
import { api } from "./client";

export interface RoutineTriggerResponse {
  trigger: RoutineTrigger;
  secretMaterial: RoutineTriggerSecretMaterial | null;
}

export interface RotateRoutineTriggerResponse {
  trigger: RoutineTrigger;
  secretMaterial: RoutineTriggerSecretMaterial;
}

export interface RestoreRoutineRevisionSecretMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

export interface RestoreRoutineRevisionResponse {
  routine: Routine;
  revision: RoutineRevision;
  restoredFromRevisionId: string;
  restoredFromRevisionNumber: number;
  secretMaterials: RestoreRoutineRevisionSecretMaterial[];
}

/** Filters of the company routine list; each one maps to a `GET .../routines` query parameter. */
export type RoutineListFilters = { [K in keyof ListRoutinesQuery]?: ListRoutinesQuery[K] | null };

export const routinesApi = {
  list: (companyId: string, filters: RoutineListFilters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (typeof value === "string" && value) params.set(key, value);
    }
    const query = params.toString();
    return api.get<RoutineListItem[]>(`/companies/${companyId}/routines${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Routine>(`/companies/${companyId}/routines`, data),
  get: (id: string) => api.get<RoutineDetail>(`/routines/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<Routine>(`/routines/${id}`, data),
  listRevisions: (id: string) => api.get<RoutineRevision[]>(`/routines/${id}/revisions`),
  restoreRevision: (
    id: string,
    revisionId: string,
    body: { changeSummary?: string | null } = {},
  ) =>
    api.post<RestoreRoutineRevisionResponse>(
      `/routines/${id}/revisions/${revisionId}/restore`,
      body,
    ),
  listRuns: (id: string, limit: number = 50) => api.get<RoutineRunSummary[]>(`/routines/${id}/runs?limit=${limit}`),
  createTrigger: (id: string, data: Record<string, unknown>) =>
    api.post<RoutineTriggerResponse>(`/routines/${id}/triggers`, data),
  updateTrigger: (id: string, data: Record<string, unknown>) =>
    api.patch<RoutineTrigger>(`/routine-triggers/${id}`, data),
  deleteTrigger: (id: string) => api.delete<void>(`/routine-triggers/${id}`),
  rotateTriggerSecret: (id: string) =>
    api.post<RotateRoutineTriggerResponse>(`/routine-triggers/${id}/rotate-secret`, {}),
  run: (id: string, data?: Record<string, unknown>) =>
    api.post<RoutineRun>(`/routines/${id}/run`, data ?? {}),
  activity: async (
    companyId: string,
    routineId: string,
    related?: { triggerIds?: string[]; runIds?: string[] },
  ) => {
    const requests = [
      activityApi.list(companyId, { entityType: "routine", entityId: routineId }),
      ...(related?.triggerIds ?? []).map((triggerId) =>
        activityApi.list(companyId, { entityType: "routine_trigger", entityId: triggerId })),
      ...(related?.runIds ?? []).map((runId) =>
        activityApi.list(companyId, { entityType: "routine_run", entityId: runId })),
    ];
    const events = (await Promise.all(requests)).flat();
    const deduped = new Map(events.map((event) => [event.id, event]));
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  },
};

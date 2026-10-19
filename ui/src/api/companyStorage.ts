import type {
  CreateStorageDestination,
  StorageCredentialRefs,
  StorageDestinationView,
  StorageProbeResult,
} from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/storage/destinations`;

export const companyStorageApi = {
  list: (companyId: string) => api.get<StorageDestinationView[]>(base(companyId)),
  create: (companyId: string, input: CreateStorageDestination) =>
    api.post<StorageDestinationView>(base(companyId), input),
  probe: (companyId: string, destinationId: string) =>
    api.post<StorageProbeResult>(`${base(companyId)}/${encodeURIComponent(destinationId)}/probe`, {}),
  rotateCredentials: (
    companyId: string,
    destinationId: string,
    input: { credentials: StorageCredentialRefs; expectedCredentialRevision: number },
  ) => api.patch<StorageDestinationView>(`${base(companyId)}/${encodeURIComponent(destinationId)}/credentials`, input),
  retire: (companyId: string, destinationId: string, expectedRevision: number) =>
    api.post<StorageDestinationView>(`${base(companyId)}/${encodeURIComponent(destinationId)}/retire`, { expectedRevision }),
};

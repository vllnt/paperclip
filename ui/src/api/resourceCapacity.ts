import type { CompanyResourceCapacity, InstanceResourceCapacity } from "@paperclipai/shared";
import { api } from "./client";

export const resourceCapacityApi = {
  /** Every server host and environment. Instance admins only (403 otherwise). */
  instance: () => api.get<InstanceResourceCapacity>("/instance/resource-capacity"),
  /** The environments the company's agents run on. */
  company: (companyId: string) =>
    api.get<CompanyResourceCapacity>(`/companies/${companyId}/resource-capacity`),
};

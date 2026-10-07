import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { AllowedOwner } from "../src/contracts.js";

const registryKey = { scopeKind: "instance" as const, namespace: "connection", stateKey: "app-companies" };

/** Seed the state that company-app.connect and allowed-owners.set leave behind. */
export async function seedConnection(h: TestHarness, companyId: string, appId: string, owners: AllowedOwner[] = [{ id: 1, login: "org" }]): Promise<void> {
  const registry = await h.ctx.state.get(registryKey) as Record<string, string> | null;
  await h.ctx.state.set(registryKey, { ...registry, [appId]: companyId });
  await h.ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: "connection", stateKey: "allowed-owners" }, owners);
}

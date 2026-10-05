import { PLUGIN_ID, type Credentials } from "../contracts.js";

export async function hostApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) {
    // Do not echo provider/server responses from secret writes.
    throw new Error(res.status === 401 ? "Sign in to Paperclip again, then retry."
      : res.status === 403 ? "An instance administrator must complete GitHub setup."
      : `Paperclip could not save this change (${res.status}). Retry without leaving this page.`);
  }
  return res.status === 204 ? undefined as T : res.json();
}
export interface SavedApp { appId: string; appSlug: string; appName: string; privateKey: { type: "secret_ref"; secretId: string; version: "latest" } }
export async function saveCredentials(companyId: string, credentials: Credentials): Promise<SavedApp> {
  const secret = await hostApi<{ id: string }>(`/companies/${encodeURIComponent(companyId)}/secrets`, "POST", {
    name: `GitHub App ${credentials.id} private key`, provider: "local_encrypted", value: credentials.privateKey,
    description: "Private key used only by the GitHub Projects plugin."
  });
  return { appId: credentials.id, appSlug: credentials.slug, appName: credentials.name,
    privateKey: { type: "secret_ref", secretId: secret.id, version: "latest" } };
}
export async function saveConfiguration(companyId: string, config: SavedApp | Record<string, never>) {
  await hostApi(`/plugins/${PLUGIN_ID}/config`, "POST", { companyId, configJson: config });
}
export async function ensureCanConfigure(companyId: string) {
  const health = await hostApi<{ deploymentMode: string }>("/health");
  if (health.deploymentMode !== "local_trusted") {
    const access = await hostApi<{ isInstanceAdmin: boolean }>("/cli-auth/me");
    if (!access.isInstanceAdmin) throw new Error("An instance administrator must complete GitHub setup.");
  }
  await hostApi(`/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`);
}

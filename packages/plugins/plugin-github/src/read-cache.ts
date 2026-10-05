import { createHash } from "node:crypto";
import type { GitHubClient } from "./github.js";

export type AppAuth = { id: string; pem: string };
export type CacheInfo = { fetchedAt: string; expiresAt: string };
type Entry = { companyId: string; expires: number; result: Promise<{ data: unknown; cache: CacheInfo }> };

/** Worker-local read cache. Never persists credentials or serves expired/error results. */
export class GitHubReadCache {
  private entries = new Map<string, Entry>();
  constructor(private ttl = 30_000, private capacity = 64) {}
  invalidate(companyId?: string | null) {
    if (!companyId) { this.entries.clear(); return; }
    for (const [key, entry] of this.entries) if (entry.companyId === companyId) this.entries.delete(key);
  }
  async read<T>(companyId: string, identity: unknown, resource: unknown, load: () => Promise<T>, refresh = false): Promise<{ data: T; cache: CacheInfo }> {
    const key = createHash("sha256").update(JSON.stringify([companyId, identity, resource])).digest("hex");
    const previous = this.entries.get(key);
    if (!refresh && previous && previous.expires > Date.now()) {
      this.entries.delete(key); this.entries.set(key, previous);
      return structuredClone(await previous.result) as { data: T; cache: CacheInfo };
    }
    const entry: Entry = { companyId, expires: Infinity, result: Promise.resolve().then(async () => {
      const data = await load(), now = Date.now();
      entry.expires = now + this.ttl;
      // Large diffs remain readable without retaining large responses in memory.
      if (Buffer.byteLength(JSON.stringify(data) ?? "") > 1_048_576 && this.entries.get(key) === entry) this.entries.delete(key);
      return { data, cache: { fetchedAt: new Date(now).toISOString(), expiresAt: new Date(entry.expires).toISOString() } };
    }) };
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    try { return structuredClone(await entry.result) as { data: T; cache: CacheInfo }; }
    catch (error) { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; }
  }
  async catalog(companyId: string, auth: AppAuth, github: GitHubClient, refresh = false) {
    return (await this.read(companyId, auth, "catalog", () => github.catalog(auth.id, auth.pem), refresh)).data;
  }
}

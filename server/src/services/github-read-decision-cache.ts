/**
 * Keeps the answer of the GitHub credential route for an ordinary read (a git fetch, a gh pr view, a local git
 * command) of one run for a short time, so the commands of one run do not repeat the database reads, the secret-store
 * read and the plugin call for each command.
 *
 * What it guarantees:
 * - It lives in this process's memory only. Nothing is written to disk or to the database.
 * - An entry belongs to one company, one agent and one run, and to one classified operation. It is never served
 *   to another run, agent or company.
 * - An entry ends at its time limit, and never after the credential's own expiry when that is known.
 * - It holds a bounded number of entries; the oldest one goes first.
 * - Whoever uses it must check, on every hit, what can change within the limit (the run, its identity, the policy,
 *   the trust gate). See `github-operation-credentials.ts`.
 *
 * The same module lets concurrent identical requests share one resolution, so a caller that gave up and asked again
 * joins the work that is still running instead of starting it a second time.
 */

const DEFAULT_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;
const DEFAULT_MAX_ENTRIES = 2_000;

/** `PAPERCLIP_GITHUB_READ_CACHE_SECONDS`: 0 turns the cache off, the default is 30, the most is 300. */
export function readDecisionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_GITHUB_READ_CACHE_SECONDS?.trim();
  if (!raw) return DEFAULT_TTL_SECONDS * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_TTL_SECONDS * 1000;
  return Math.min(Math.floor(seconds), MAX_TTL_SECONDS) * 1000;
}

export type ReadDecision<T> = { value: T; expiresAt: number };

export type ReadDecisionCache<T> = ReturnType<typeof createReadDecisionCache<T>>;

export function createReadDecisionCache<T>(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? readDecisionTtlMs();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, ReadDecision<T>>();
  const inflight = new Map<string, Promise<unknown>>();

  function purgeExpired() {
    const at = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= at) entries.delete(key);
  }

  return {
    enabled: ttlMs > 0,
    get size() { return entries.size; },
    /** The key of one run's entry for one classified operation. */
    key(run: { companyId: string; agentId: string; runId: string }, shape: string) {
      return JSON.stringify([run.companyId, run.agentId, run.runId, shape]);
    },
    get(key: string): ReadDecision<T> | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
      return entry;
    },
    /** `credentialExpiresAt` (epoch milliseconds) ends the entry early; the entry never outlives it. */
    put(key: string, value: T, credentialExpiresAt?: number) {
      if (ttlMs <= 0) return;
      const expiresAt = Math.min(now() + ttlMs, credentialExpiresAt ?? Number.POSITIVE_INFINITY);
      if (expiresAt <= now()) return;
      if (entries.size >= maxEntries) {
        purgeExpired();
        while (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
      }
      entries.delete(key);
      entries.set(key, { value, expiresAt });
    },
    drop(key: string) { entries.delete(key); },
    clear() { entries.clear(); inflight.clear(); },
    /** Runs `create` once for concurrent callers of the same key; the others wait for the same result. */
    shared<R>(key: string, create: () => Promise<R>): Promise<R> {
      const running = inflight.get(key);
      if (running) return running as Promise<R>;
      const started = create().finally(() => { if (inflight.get(key) === started) inflight.delete(key); });
      inflight.set(key, started);
      return started;
    },
  };
}

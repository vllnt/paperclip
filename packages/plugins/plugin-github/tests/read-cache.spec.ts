import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReadCache } from "../src/read-cache.js";
afterEach(() => vi.useRealTimers());
describe("bounded GitHub read cache", () => {
  it("deduplicates in-flight requests, clones results, and expires after 30 seconds", async () => {
    vi.useFakeTimers(); const cache = new GitHubReadCache(), load = vi.fn(async () => ({ rows: [1] }));
    const [a, b] = await Promise.all([cache.read("c1", "pem", "page", load), cache.read("c1", "pem", "page", load)]);
    a.data.rows.push(2); expect(b.data.rows).toEqual([1]); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001); await cache.read("c1", "pem", "page", load); expect(load).toHaveBeenCalledTimes(2);
  });
  it("isolates companies and credential rotations without keeping secrets in cache keys", async () => {
    const cache = new GitHubReadCache(), load = vi.fn().mockResolvedValue({ rows: [] });
    for (const [company, secret] of [["c1", "key-one"], ["c2", "key-one"], ["c1", "key-two"]]) await cache.read(company, secret, "catalog", load);
    expect(load).toHaveBeenCalledTimes(3);
    expect([...((cache as any).entries as Map<string, unknown>).keys()].every(k => /^[a-f0-9]{64}$/.test(k))).toBe(true);
  });
  it("does not cache rejections or let invalidated in-flight results repopulate the cache", async () => {
    const cache = new GitHubReadCache(), load = vi.fn().mockRejectedValueOnce(new Error("Denied")).mockResolvedValue("fresh");
    await expect(cache.read("c1", "key", "page", load)).rejects.toThrow("Denied");
    await cache.read("c1", "key", "page", load); expect(load).toHaveBeenCalledTimes(2);
    let finish!: (v: string) => void;
    const old = cache.read("c1", "key", "page", () => new Promise<string>(r => { finish = r; }), true);
    await Promise.resolve(); cache.invalidate("c1");
    await cache.read("c1", "key", "page", load); finish("old"); await old;
    expect((await cache.read("c1", "key", "page", load)).data).toBe("fresh");
  });
  it("evicts old entries and does not retain oversized diffs", async () => {
    const cache = new GitHubReadCache(30_000, 2), load = vi.fn().mockResolvedValue("ok");
    for (const page of [1, 2, 3, 1]) await cache.read("c1", "key", page, load);
    expect(load).toHaveBeenCalledTimes(4);
    const big = vi.fn().mockResolvedValue("x".repeat(1_048_577));
    await cache.read("c1", "key", "diff", big); await cache.read("c1", "key", "diff", big); expect(big).toHaveBeenCalledTimes(2);
  });
});

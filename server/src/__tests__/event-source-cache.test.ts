import { describe, expect, it, vi } from "vitest";
import { EVENT_SOURCE_CACHE_TTL_MS, createEventSourceCache } from "../services/event-sources/source-cache.js";

interface Source {
  id: string;
  version: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options: { ttlMs?: number } = {}) {
  let clock = 1_000_000;
  const database = new Map<string, Source>();
  const load = vi.fn(async (publicId: string): Promise<Source | null> => database.get(publicId) ?? null);
  const loadAll = vi.fn(async () => [...database.entries()].map(([publicId, value]) => ({ publicId, value })));
  const cache = createEventSourceCache<Source>({ load, loadAll, ttlMs: options.ttlMs ?? 1000, now: () => clock });
  return {
    cache,
    load,
    loadAll,
    database,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createEventSourceCache", () => {
  describe("positive cache", () => {
    it("loads a source once and serves it from memory within the TTL", async () => {
      const { cache, load, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });

      const first = await cache.get("a");
      advance(999);
      const second = await cache.get("a");

      expect(first).toEqual({ id: "a", version: 1 });
      expect(second).toBe(first);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("reloads once the TTL has elapsed and returns the fresh value", async () => {
      const { cache, load, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      database.set("a", { id: "a", version: 2 });
      advance(999);
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      advance(1);
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("caches different ids independently", async () => {
      const { cache, load, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });

      await cache.get("a");
      await cache.get("b");
      await cache.get("a");
      await cache.get("b");

      expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    });

    it("defaults the TTL to thirty seconds", async () => {
      expect(EVENT_SOURCE_CACHE_TTL_MS).toBe(30_000);
      let clock = 0;
      const load = vi.fn(async () => ({ id: "a", version: 1 }));
      const cache = createEventSourceCache<Source>({ load, loadAll: async () => [], now: () => clock });
      await cache.get("a");
      clock = 29_999;
      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(1);
      clock = 30_000;
      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("starts the TTL when the load finishes, not when it started", async () => {
      let clock = 0;
      const load = vi.fn(async () => {
        clock += 400;
        return { id: "a", version: 1 };
      });
      const cache = createEventSourceCache<Source>({ load, loadAll: async () => [], ttlMs: 1000, now: () => clock });

      await cache.get("a"); // finishes at t = 400, valid until t = 1400
      clock = 1399;
      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(1);
      clock = 1400;
      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed load and retries on the next call", async () => {
      const { cache, load, database } = setup();
      load.mockRejectedValueOnce(new Error("db down"));

      await expect(cache.get("a")).rejects.toThrow("db down");
      database.set("a", { id: "a", version: 1 });
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidate(publicId)", () => {
    it("forces the next get to reload that source", async () => {
      const { cache, load, database } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      database.set("a", { id: "a", version: 2 });
      cache.invalidate("a");

      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("leaves other cached sources alone", async () => {
      const { cache, load, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });
      await cache.get("a");
      await cache.get("b");

      cache.invalidate("a");
      await cache.get("b");

      expect(load).toHaveBeenCalledTimes(2);
    });

    it("does not let a load that was in flight before the invalidation repopulate stale data", async () => {
      const { cache, load } = setup();
      const staleLoad = deferred<Source | null>();
      load.mockImplementationOnce(() => staleLoad.promise);

      const pending = cache.get("a");
      cache.invalidate("a"); // the source was rotated while the old read was still running
      staleLoad.resolve({ id: "a", version: 1 });

      // The caller that started the read still gets what it read ...
      expect(await pending).toEqual({ id: "a", version: 1 });
      // ... but nothing was cached, so the next caller reads again and sees the new data.
      load.mockImplementationOnce(async () => ({ id: "a", version: 2 }));
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("does not negative-cache a null read that was in flight across an invalidation", async () => {
      const { cache, load, database } = setup();
      const staleLoad = deferred<Source | null>();
      load.mockImplementationOnce(() => staleLoad.promise);

      const pending = cache.get("a");
      database.set("a", { id: "a", version: 1 }); // the source is created while the lookup runs
      cache.invalidate("a");
      staleLoad.resolve(null);

      expect(await pending).toBeNull();
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("discards in-flight loads of every source, because the generation is global", async () => {
      const { cache, load } = setup();
      const slow = deferred<Source | null>();
      load.mockImplementationOnce(() => slow.promise);

      const pending = cache.get("a");
      cache.invalidate("some-other-source");
      slow.resolve({ id: "a", version: 1 });
      await pending;

      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("caches a load that started after the invalidation", async () => {
      const { cache, load, database } = setup();
      database.set("a", { id: "a", version: 1 });
      cache.invalidate("a");
      await cache.get("a");
      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidate() with no id", () => {
    it("clears every cached source", async () => {
      const { cache, load, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });
      await cache.get("a");
      await cache.get("b");

      cache.invalidate();
      await cache.get("a");
      await cache.get("b");

      expect(load).toHaveBeenCalledTimes(4);
    });

    it("clears negative entries too", async () => {
      const { cache, load, database } = setup();
      expect(await cache.get("ghost")).toBeNull();
      database.set("ghost", { id: "ghost", version: 1 });
      cache.invalidate();
      expect(await cache.get("ghost")).toEqual({ id: "ghost", version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("discards loads that were in flight", async () => {
      const { cache, load } = setup();
      const slow = deferred<Source | null>();
      load.mockImplementationOnce(() => slow.promise);
      const pending = cache.get("a");
      cache.invalidate();
      slow.resolve({ id: "a", version: 1 });
      await pending;

      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe("negative cache", () => {
    it("remembers an unknown id for the TTL so probing costs one lookup", async () => {
      const { cache, load, advance } = setup();

      expect(await cache.get("ghost")).toBeNull();
      expect(await cache.get("ghost")).toBeNull();
      advance(999);
      expect(await cache.get("ghost")).toBeNull();

      expect(load).toHaveBeenCalledTimes(1);
    });

    it("looks the id up again after the TTL", async () => {
      const { cache, load, database, advance } = setup();
      await cache.get("ghost");
      database.set("ghost", { id: "ghost", version: 1 });

      advance(1000);

      expect(await cache.get("ghost")).toEqual({ id: "ghost", version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("is cleared for one id by invalidate(publicId)", async () => {
      const { cache, load, database } = setup();
      await cache.get("ghost");
      database.set("ghost", { id: "ghost", version: 1 });

      cache.invalidate("ghost");

      expect(await cache.get("ghost")).toEqual({ id: "ghost", version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("turns a cached source into a negative entry when it disappears after the TTL", async () => {
      const { cache, load, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      database.delete("a");
      advance(1000);
      expect(await cache.get("a")).toBeNull();
      expect(await cache.get("a")).toBeNull();

      expect(load).toHaveBeenCalledTimes(2);
    });

    it("drops the negative entry once the id loads successfully", async () => {
      const { cache, load, database, advance } = setup();
      await cache.get("a");
      database.set("a", { id: "a", version: 1 });
      advance(1000);
      await cache.get("a");
      database.delete("a");
      advance(500);

      // Served from the positive entry, not from a stale negative one.
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("stays bounded: past 10,000 unknown ids the negative cache is flushed instead of growing", async () => {
      const { cache, load } = setup();
      for (let i = 0; i < 10_000; i += 1) await cache.get(`ghost-${i}`);
      expect(load).toHaveBeenCalledTimes(10_000);

      // Entries below the cap are still negative-cached.
      await cache.get("ghost-0");
      expect(load).toHaveBeenCalledTimes(10_000);

      // One more distinct id flushes the cache before it is stored ...
      await cache.get("ghost-10000");
      expect(load).toHaveBeenCalledTimes(10_001);

      // ... so older ids have to be looked up again, while the newest one is remembered.
      await cache.get("ghost-0");
      expect(load).toHaveBeenCalledTimes(10_002);
      await cache.get("ghost-10000");
      expect(load).toHaveBeenCalledTimes(10_002);
    });
  });

  describe("preload", () => {
    it("fills the cache from loadAll and reports how many sources it loaded", async () => {
      const { cache, load, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });

      expect(await cache.preload()).toBe(2);
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(await cache.get("b")).toEqual({ id: "b", version: 1 });

      expect(loadAll).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    });

    it("returns zero for an empty database", async () => {
      const { cache } = setup();
      expect(await cache.preload()).toBe(0);
    });

    it("gives preloaded entries the normal TTL", async () => {
      const { cache, load, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.preload();

      advance(999);
      await cache.get("a");
      expect(load).not.toHaveBeenCalled();

      advance(1);
      await cache.get("a");
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("overwrites an existing entry", async () => {
      const { cache, database } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");
      database.set("a", { id: "a", version: 2 });

      await cache.preload();

      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
    });

    it("is discarded when an invalidation happens while loadAll is running", async () => {
      const { cache, load, loadAll, database } = setup();
      const slow = deferred<Array<{ publicId: string; value: Source }>>();
      loadAll.mockImplementationOnce(() => slow.promise);

      const pending = cache.preload();
      cache.invalidate("a");
      slow.resolve([{ publicId: "a", value: { id: "a", version: 1 } }]);

      expect(await pending).toBe(0);
      database.set("a", { id: "a", version: 2 });
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});

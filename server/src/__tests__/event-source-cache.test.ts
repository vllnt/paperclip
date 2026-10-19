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
  const loadAll = vi.fn(async (_previous: ReadonlyMap<string, Source>) =>
    [...database.entries()].map(([publicId, value]) => ({ publicId, value })),
  );
  const cache = createEventSourceCache<Source>({ loadAll, ttlMs: options.ttlMs ?? 1000, now: () => clock });
  return {
    cache,
    loadAll,
    database,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createEventSourceCache", () => {
  it("defaults the TTL to thirty seconds", () => {
    expect(EVENT_SOURCE_CACHE_TTL_MS).toBe(30_000);
  });

  describe("serving from the map", () => {
    it("loads every source once and serves them from memory within the TTL", async () => {
      const { cache, loadAll, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });

      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      advance(999);
      expect(await cache.get("b")).toEqual({ id: "b", version: 1 });
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(loadAll).toHaveBeenCalledTimes(1);
    });

    it("reloads once the TTL has elapsed and returns the fresh value", async () => {
      const { cache, loadAll, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      database.set("a", { id: "a", version: 2 });
      advance(999);
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      advance(1);
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(loadAll).toHaveBeenCalledTimes(2);
    });

    it("hands the previous map to loadAll so resolved secrets can be reused", async () => {
      const { cache, loadAll, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");
      advance(1000);
      await cache.get("a");

      expect(loadAll.mock.calls[0]![0].size).toBe(0);
      expect(loadAll.mock.calls[1]![0].get("a")).toEqual({ id: "a", version: 1 });
    });

    it("shares one load between concurrent requests", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      const gate = deferred<void>();
      loadAll.mockImplementationOnce(async () => {
        await gate.promise;
        return [{ publicId: "a", value: { id: "a", version: 1 } }];
      });

      const pending = Promise.all(Array.from({ length: 50 }, () => cache.get("a")));
      gate.resolve();
      await pending;

      expect(loadAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("unknown ids", () => {
    it("answers an id the map does not hold without any further lookup", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      for (let index = 0; index < 10_000; index += 1) {
        expect(await cache.get(`unknown-${index}`)).toBeNull();
      }

      expect(loadAll).toHaveBeenCalledTimes(1);
    });

    it("costs at most one reload per TTL, however many ids are probed", async () => {
      const { cache, loadAll, advance } = setup();
      await cache.get("x");
      advance(1000);

      await Promise.all(Array.from({ length: 500 }, (_, index) => cache.get(`unknown-${index}`)));

      expect(loadAll).toHaveBeenCalledTimes(2);
    });

    it("finds a source that appeared in the database after the next reload", async () => {
      const { cache, database, advance } = setup();
      expect(await cache.get("late")).toBeNull();

      database.set("late", { id: "late", version: 1 });
      advance(1000);

      expect(await cache.get("late")).toEqual({ id: "late", version: 1 });
    });
  });

  describe("invalidate(publicId)", () => {
    it("forces the next get to reload, and serves the new value", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      database.set("a", { id: "a", version: 2 });
      cache.invalidate("a");

      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(loadAll).toHaveBeenCalledTimes(2);
    });

    it("makes a source created after the last load visible at once", async () => {
      const { cache, database } = setup();
      expect(await cache.get("new")).toBeNull();

      database.set("new", { id: "new", version: 1 });
      cache.invalidate("new");

      expect(await cache.get("new")).toEqual({ id: "new", version: 1 });
    });

    it("stops serving a source that was removed from the database", async () => {
      const { cache, database } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      database.delete("a");
      cache.invalidate("a");

      expect(await cache.get("a")).toBeNull();
    });

    it("does not let a load that was in flight before the invalidation publish stale data", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      const gate = deferred<void>();
      loadAll.mockImplementationOnce(async () => {
        const snapshot = [...database.entries()].map(([publicId, value]) => ({ publicId, value }));
        await gate.promise;
        return snapshot;
      });

      const pending = cache.get("a");
      database.set("a", { id: "a", version: 2 });
      cache.invalidate("a");
      gate.resolve();

      expect(await pending).toEqual({ id: "a", version: 2 });
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
    });

    it("discards in-flight loads of every source, because the generation is global", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });
      const gate = deferred<void>();
      loadAll.mockImplementationOnce(async () => {
        const snapshot = [...database.entries()].map(([publicId, value]) => ({ publicId, value }));
        await gate.promise;
        return snapshot;
      });

      const pending = cache.get("b");
      database.set("b", { id: "b", version: 2 });
      cache.invalidate("a");
      gate.resolve();

      expect(await pending).toEqual({ id: "b", version: 2 });
    });
  });

  describe("invalidate() with no id", () => {
    it("clears every cached source and reloads them", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });
      await cache.get("a");

      database.set("a", { id: "a", version: 2 });
      database.set("b", { id: "b", version: 2 });
      cache.invalidate();

      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(await cache.get("b")).toEqual({ id: "b", version: 2 });
      expect(loadAll).toHaveBeenCalledTimes(2);
    });
  });

  describe("load failures", () => {
    it("throws when the first load fails, and tries again on the next call", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      loadAll.mockRejectedValueOnce(new Error("db down"));

      await expect(cache.get("a")).rejects.toThrow("db down");
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
    });

    it("does not serve a mutated map when the reload fails", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      cache.invalidate("a");
      loadAll.mockRejectedValueOnce(new Error("db down"));

      await expect(cache.get("a")).rejects.toThrow("db down");
    });

    it("keeps serving the previous map for a short time after a failed backstop reload", async () => {
      const { cache, loadAll, database, advance } = setup({ ttlMs: 30_000 });
      database.set("a", { id: "a", version: 1 });
      await cache.get("a");

      advance(30_000);
      loadAll.mockRejectedValueOnce(new Error("db down"));
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });

      advance(1000);
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(loadAll).toHaveBeenCalledTimes(2);

      advance(5000);
      database.set("a", { id: "a", version: 2 });
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
      expect(loadAll).toHaveBeenCalledTimes(3);
    });
  });

  describe("preload", () => {
    it("fills the map and reports how many sources it loaded", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      database.set("b", { id: "b", version: 1 });

      expect(await cache.preload()).toBe(2);
      expect(await cache.get("a")).toEqual({ id: "a", version: 1 });
      expect(await cache.get("b")).toEqual({ id: "b", version: 1 });
      expect(loadAll).toHaveBeenCalledTimes(1);
    });

    it("returns zero for an empty database", async () => {
      const { cache } = setup();
      expect(await cache.preload()).toBe(0);
    });

    it("gives preloaded entries the normal TTL", async () => {
      const { cache, loadAll, database, advance } = setup();
      database.set("a", { id: "a", version: 1 });
      await cache.preload();

      advance(999);
      await cache.get("a");
      expect(loadAll).toHaveBeenCalledTimes(1);

      advance(1);
      await cache.get("a");
      expect(loadAll).toHaveBeenCalledTimes(2);
    });

    it("is discarded when an invalidation happens while loadAll is running", async () => {
      const { cache, loadAll, database } = setup();
      database.set("a", { id: "a", version: 1 });
      const gate = deferred<void>();
      loadAll.mockImplementationOnce(async () => {
        const snapshot = [...database.entries()].map(([publicId, value]) => ({ publicId, value }));
        await gate.promise;
        return snapshot;
      });

      const preloading = cache.preload();
      database.set("a", { id: "a", version: 2 });
      cache.invalidate("a");
      gate.resolve();

      expect(await preloading).toBe(0);
      expect(await cache.get("a")).toEqual({ id: "a", version: 2 });
    });
  });
});

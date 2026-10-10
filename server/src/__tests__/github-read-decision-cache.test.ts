import { describe, expect, it, vi } from "vitest";
import { createReadDecisionCache, readDecisionTtlMs } from "../services/github-read-decision-cache.js";

// The short per-run cache of the GitHub credential route. These tests need no database: they pin what it keeps, for how
// long, for whom, and that it never keeps more than a bounded number of entries or a failed resolution.

const run = { companyId: "company-1", agentId: "agent-1", runId: "run-1" };

function cache<T = string>(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let at = 1_000_000;
  const made = createReadDecisionCache<T>({ ...options, now: () => at });
  return { made, advance: (ms: number) => { at += ms; }, now: () => at };
}

describe("the time limit", () => {
  it.each([
    ["is 30 seconds when nothing is set", undefined, 30_000],
    ["is 30 seconds for an empty value", "", 30_000],
    ["can be set to 5 seconds", "5", 5_000],
    ["can be set to 0, which turns the cache off", "0", 0],
    ["is at most 300 seconds", "9999", 300_000],
    ["is 30 seconds for a negative value", "-5", 30_000],
    ["is 30 seconds for a value that is not a number", "soon", 30_000],
    ["cuts a fraction down to whole seconds", "2.9", 2_000],
  ])("%s", (_name, value, expected) => {
    expect(readDecisionTtlMs(value === undefined ? {} : { PAPERCLIP_GITHUB_READ_CACHE_SECONDS: value })).toBe(expected);
  });
});

describe("what an entry belongs to", () => {
  it("gives a different key to another run, agent or company, and to another operation", () => {
    const { made } = cache();
    const keys = new Set([
      made.key(run, "read"),
      made.key({ ...run, runId: "run-2" }, "read"),
      made.key({ ...run, agentId: "agent-2" }, "read"),
      made.key({ ...run, companyId: "company-2" }, "read"),
      made.key(run, "other-read"),
    ]);

    expect(keys.size).toBe(5);
  });

  it("cannot be made to collide by a value that looks like the separator", () => {
    const { made } = cache();

    expect(made.key({ companyId: "a", agentId: "b", runId: "c" }, "d")).not.toBe(made.key({ companyId: "a", agentId: "b", runId: "c\",\"d" }, ""));
    expect(made.key({ companyId: "a\",\"b", agentId: "c", runId: "d" }, "e")).not.toBe(made.key({ companyId: "a", agentId: "b\",\"c", runId: "d" }, "e"));
  });

  it("serves an entry only to the key it was stored under", () => {
    const { made } = cache();
    made.put(made.key(run, "read"), "first run");

    expect(made.get(made.key(run, "read"))?.value).toBe("first run");
    expect(made.get(made.key({ ...run, runId: "run-2" }, "read"))).toBeUndefined();
    expect(made.get(made.key({ ...run, companyId: "company-2" }, "read"))).toBeUndefined();
  });
});

describe("how long an entry lives", () => {
  it("serves it until its time limit and not after", () => {
    const { made, advance } = cache({ ttlMs: 30_000 });
    const key = made.key(run, "read");
    made.put(key, "answer");

    advance(29_999);
    expect(made.get(key)?.value).toBe("answer");
    advance(1);
    expect(made.get(key)).toBeUndefined();
    expect(made.size).toBe(0);
  });

  it("ends at the credential's own expiry when that comes first, and never later", () => {
    const { made, advance, now } = cache({ ttlMs: 30_000 });
    const key = made.key(run, "read");
    made.put(key, "answer", now() + 5_000);

    advance(4_999);
    expect(made.get(key)?.value).toBe("answer");
    advance(1);
    expect(made.get(key)).toBeUndefined();
  });

  it("keeps the time limit when the credential expires later than that", () => {
    const { made, advance, now } = cache({ ttlMs: 30_000 });
    const key = made.key(run, "read");
    made.put(key, "answer", now() + 3_600_000);

    advance(30_000);
    expect(made.get(key)).toBeUndefined();
  });

  it("does not keep an answer whose credential has already expired", () => {
    const { made, now } = cache();
    const key = made.key(run, "read");

    made.put(key, "answer", now());
    made.put(made.key(run, "other"), "answer", now() - 1);

    expect(made.size).toBe(0);
  });

  it("starts the time limit again when an entry is stored again", () => {
    const { made, advance } = cache({ ttlMs: 30_000 });
    const key = made.key(run, "read");
    made.put(key, "old");
    advance(20_000);
    made.put(key, "new");
    advance(20_000);

    expect(made.get(key)?.value).toBe("new");
  });

  it("keeps nothing when the cache is off", () => {
    const { made } = cache({ ttlMs: 0 });
    made.put(made.key(run, "read"), "answer");

    expect(made.enabled).toBe(false);
    expect(made.size).toBe(0);
    expect(made.get(made.key(run, "read"))).toBeUndefined();
  });

  it("forgets one entry, or all of them", () => {
    const { made } = cache();
    made.put(made.key(run, "a"), "1");
    made.put(made.key(run, "b"), "2");

    made.drop(made.key(run, "a"));
    expect(made.size).toBe(1);
    made.clear();
    expect(made.size).toBe(0);
  });
});

describe("how many entries it keeps", () => {
  it("never holds more than its limit, and drops the oldest first", () => {
    const { made } = cache({ maxEntries: 3 });
    for (const name of ["a", "b", "c", "d", "e"]) made.put(made.key(run, name), name);

    expect(made.size).toBe(3);
    expect(made.get(made.key(run, "a"))).toBeUndefined();
    expect(made.get(made.key(run, "b"))).toBeUndefined();
    expect(["c", "d", "e"].map(name => made.get(made.key(run, name))?.value)).toEqual(["c", "d", "e"]);
  });

  it("drops entries that have expired before it drops one that has not", () => {
    const { made, advance } = cache({ ttlMs: 10_000, maxEntries: 2 });
    made.put(made.key(run, "old"), "old");
    advance(6_000);
    made.put(made.key(run, "fresh"), "fresh");
    advance(5_000); // `old` has expired, `fresh` has not
    made.put(made.key(run, "new"), "new");

    expect(made.get(made.key(run, "fresh"))?.value).toBe("fresh");
    expect(made.get(made.key(run, "new"))?.value).toBe("new");
    expect(made.size).toBe(2);
  });
});

describe("concurrent identical requests", () => {
  it("share one resolution and all receive its answer", async () => {
    const { made } = cache();
    let release: (value: string) => void = () => {};
    const create = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const key = made.key(run, "read");

    const waiting = [made.shared(key, create), made.shared(key, create), made.shared(key, create)];
    release("one answer");

    expect(await Promise.all(waiting)).toEqual(["one answer", "one answer", "one answer"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("start a new resolution once the first has finished: nothing is kept by sharing", async () => {
    const { made } = cache();
    const create = vi.fn(async () => "answer");
    const key = made.key(run, "read");

    await made.shared(key, create);
    await made.shared(key, create);

    expect(create).toHaveBeenCalledTimes(2);
    expect(made.size).toBe(0);
  });

  it("do not share across runs, agents or companies", async () => {
    const { made } = cache();
    const create = vi.fn(async () => "answer");

    await Promise.all([
      made.shared(made.key(run, "read"), create),
      made.shared(made.key({ ...run, runId: "run-2" }, "read"), create),
      made.shared(made.key({ ...run, companyId: "company-2" }, "read"), create),
    ]);

    expect(create).toHaveBeenCalledTimes(3);
  });

  it("give every waiter the failure, and keep no failure", async () => {
    const { made } = cache();
    const key = made.key(run, "read");
    let fail: (error: Error) => void = () => {};
    const first = vi.fn(() => new Promise<string>((_resolve, reject) => { fail = reject; }));

    const waiting = [made.shared(key, first), made.shared(key, first)];
    const outcomes = Promise.allSettled(waiting);
    fail(new Error("vault is down"));

    expect((await outcomes).map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(first).toHaveBeenCalledTimes(1);
    // The next request resolves again; the failure was not stored.
    expect(await made.shared(key, async () => "answer")).toBe("answer");
  });
});

import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "../services/event-sources/sliding-window-limiter.js";

/** A limiter on a manually advanced clock. `at` moves the clock to an absolute time in ms. */
function limiterAt(options: { windowMs?: number; maxKeys?: number } = {}) {
  let current = 1_000_000_000_000;
  const start = current;
  const limiter = createSlidingWindowLimiter({ ...options, now: () => current });
  return {
    limiter,
    start,
    at(offsetMs: number) {
      current = start + offsetMs;
    },
  };
}

describe("createSlidingWindowLimiter", () => {
  it("allows requests up to the limit and reports the remaining budget", () => {
    const { limiter } = limiterAt();
    expect(limiter.consume("k", 3)).toEqual({ allowed: true, limit: 3, remaining: 2, retryAfterSeconds: 0 });
    expect(limiter.consume("k", 3)).toEqual({ allowed: true, limit: 3, remaining: 1, retryAfterSeconds: 0 });
    expect(limiter.consume("k", 3)).toEqual({ allowed: true, limit: 3, remaining: 0, retryAfterSeconds: 0 });
  });

  it("blocks the request after the limit with a retry hint", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i += 1) limiter.consume("k", 3);
    expect(limiter.consume("k", 3)).toEqual({ allowed: false, limit: 3, remaining: 0, retryAfterSeconds: 60 });
  });

  it("does not count blocked requests against the window", () => {
    const { limiter, at } = limiterAt();
    limiter.consume("k", 1);
    for (let i = 0; i < 50; i += 1) expect(limiter.consume("k", 1).allowed).toBe(false);
    at(60_000);
    expect(limiter.consume("k", 1).allowed).toBe(true);
  });

  it("counts down the retry hint as the window moves toward the oldest hit expiring", () => {
    const { limiter, at } = limiterAt();
    limiter.consume("k", 2);
    limiter.consume("k", 2);
    at(10_000);
    expect(limiter.consume("k", 2).retryAfterSeconds).toBe(50);
    at(40_000);
    expect(limiter.consume("k", 2).retryAfterSeconds).toBe(20);
    at(59_999);
    expect(limiter.consume("k", 2).retryAfterSeconds).toBe(1);
  });

  it("allows again exactly when the oldest second bucket leaves the 60 second window", () => {
    const { limiter, at } = limiterAt();
    limiter.consume("k", 1);
    at(59_999);
    expect(limiter.consume("k", 1).allowed).toBe(false);
    at(60_000);
    expect(limiter.consume("k", 1)).toEqual({ allowed: true, limit: 1, remaining: 0, retryAfterSeconds: 0 });
  });

  it("slides: requests expire one second bucket at a time instead of resetting all at once", () => {
    const { limiter, at } = limiterAt();
    limiter.consume("k", 3); // t = 0
    at(30_000);
    limiter.consume("k", 3); // t = 30s
    limiter.consume("k", 3); // t = 30s
    expect(limiter.consume("k", 3).allowed).toBe(false);

    at(59_000);
    expect(limiter.consume("k", 3).allowed).toBe(false);

    // The t = 0 hit has expired; the two t = 30s hits have not.
    at(60_000);
    expect(limiter.consume("k", 3)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("k", 3)).toMatchObject({ allowed: false, retryAfterSeconds: 30 });

    // Both t = 30s hits expire together.
    at(90_000);
    expect(limiter.consume("k", 3)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("groups hits in the same second into one bucket", () => {
    const { limiter, at } = limiterAt();
    limiter.consume("k", 3);
    at(400);
    limiter.consume("k", 3);
    at(900);
    limiter.consume("k", 3);
    at(59_000);
    expect(limiter.consume("k", 3).allowed).toBe(false);
    // All three hits shared one bucket, so they leave the window together.
    at(60_000);
    expect(limiter.consume("k", 3)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("keeps keys independent of each other", () => {
    const { limiter } = limiterAt();
    expect(limiter.consume("a", 1).allowed).toBe(true);
    expect(limiter.consume("a", 1).allowed).toBe(false);
    expect(limiter.consume("b", 1).allowed).toBe(true);
    expect(limiter.consume("b", 1).allowed).toBe(false);
    expect(limiter.consume("c", 5)).toMatchObject({ allowed: true, remaining: 4 });
  });

  it("applies the limit given on each call so a changed limit takes effect immediately", () => {
    const { limiter } = limiterAt();
    limiter.consume("k", 5);
    limiter.consume("k", 5);
    expect(limiter.consume("k", 2)).toMatchObject({ allowed: false, limit: 2 });
    expect(limiter.consume("k", 10)).toMatchObject({ allowed: true, remaining: 7 });
  });

  it("blocks every request when the limit is zero", () => {
    const { limiter } = limiterAt();
    expect(limiter.consume("k", 0)).toEqual({ allowed: false, limit: 0, remaining: 0, retryAfterSeconds: 60 });
  });

  it("handles a large limit with many hits in the same second", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 1000; i += 1) expect(limiter.consume("k", 1000).allowed).toBe(true);
    expect(limiter.consume("k", 1000)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("honours a custom window length", () => {
    const { limiter, at } = limiterAt({ windowMs: 10_000 });
    limiter.consume("k", 1);
    at(9_999);
    expect(limiter.consume("k", 1)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    at(10_000);
    expect(limiter.consume("k", 1).allowed).toBe(true);
  });

  it("treats a window shorter than one second as a single bucket", () => {
    const { limiter, at } = limiterAt({ windowMs: 500 });
    limiter.consume("k", 1);
    at(999);
    expect(limiter.consume("k", 1).allowed).toBe(false);
    at(1_000);
    expect(limiter.consume("k", 1).allowed).toBe(true);
  });

  describe("bounded key space", () => {
    it("never throws and still admits a new key when more distinct keys than maxKeys arrive", () => {
      const { limiter } = limiterAt({ maxKeys: 10 });
      for (let i = 0; i < 200; i += 1) {
        expect(limiter.consume(`ip-${i}`, 1)).toMatchObject({ allowed: true, remaining: 0 });
      }
      expect(limiter.consume("brand-new", 1).allowed).toBe(true);
    });

    it("evicts the oldest live key when every tracked key is still live", () => {
      const { limiter } = limiterAt({ maxKeys: 2 });
      limiter.consume("a", 1);
      limiter.consume("b", 1);
      expect(limiter.consume("a", 1).allowed).toBe(false);

      // "c" does not fit: the oldest-inserted key "a" is dropped to make room.
      expect(limiter.consume("c", 1).allowed).toBe(true);
      expect(limiter.consume("b", 1).allowed).toBe(false);
      expect(limiter.consume("c", 1).allowed).toBe(false);
      // "a" lost its history, so it starts a fresh window.
      expect(limiter.consume("a", 1).allowed).toBe(true);
    });

    it("reclaims expired keys before evicting any live key", () => {
      const { limiter, at } = limiterAt({ maxKeys: 3 });
      limiter.consume("live", 2); // t = 0
      at(1_000);
      limiter.consume("stale-1", 1);
      limiter.consume("stale-2", 1);
      at(50_000);
      limiter.consume("live", 2); // "live" now has a hit at t = 0 and one at t = 50s

      at(61_000); // stale-1 and stale-2 (hit at t = 1s) have left the window; live's t = 50s hit has not
      expect(limiter.consume("fresh", 1).allowed).toBe(true);

      // "live" kept its t = 50s hit (its t = 0 hit expired): 1 of 2 used, so this call takes the last slot.
      // Had "live" been evicted it would have started over and reported one more request remaining.
      expect(limiter.consume("live", 2)).toMatchObject({ allowed: true, remaining: 0 });
    });
  });
});

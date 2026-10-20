import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  databaseRetryBudgetUsage,
  isTransientDatabaseError,
  isTransientDbConnectionError,
  resetDatabaseRetryBudget,
  retryIdempotentDatabaseOperation,
} from "../database-retry.js";
import { retryOnTransientDbConnectionError } from "../middleware/auth.js";
import { logger } from "../middleware/logger.js";

/** The shape drizzle produces: a wrapper whose `cause` is the driver error. */
function transient(code = "CONNECTION_CLOSED"): Error {
  return new Error("Failed query", { cause: Object.assign(new Error(`write ${code}`), { code }) });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function capture<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

async function drive<T>(promise: Promise<T>): Promise<Outcome<T>> {
  const outcome = capture(promise);
  await vi.runAllTimersAsync();
  return outcome;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An operation that fails each attempt after `durations[i]` ms, and records each attempt's start. */
function failing(durations: number[] = [], error: () => Error = () => transient()) {
  const starts: number[] = [];
  const errors: Error[] = [];
  const run = async (): Promise<never> => {
    const index = starts.length;
    starts.push(performance.now());
    const duration = durations[index] ?? 0;
    if (duration > 0) await delay(duration);
    const failure = error();
    errors.push(failure);
    throw failure;
  };
  return { run, starts, errors };
}

/** Deterministic `Math.random` (mulberry32). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDatabaseRetryBudget();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetDatabaseRetryBudget();
});

describe("retry policy", () => {
  it("retries a lasting failure five times after doubling sleeps, then throws the last error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const op = failing();
    const outcome = await drive(retryIdempotentDatabaseOperation(op.run));
    expect(outcome).toEqual({ ok: false, error: op.errors[5] });
    expect(op.starts).toHaveLength(6);
    const gaps = op.starts.slice(1).map((start, index) => start - op.starts[index]);
    expect(gaps).toEqual([50, 100, 200, 400, 800]);
  });

  it.each([
    ["the lowest", 0, 0.8],
    ["the highest", 0.999_999, 1.2],
  ])("keeps every sleep within the jitter bounds at %s random draw", async (_label, draw, factor) => {
    vi.spyOn(Math, "random").mockReturnValue(draw);
    const op = failing();
    await drive(retryIdempotentDatabaseOperation(op.run));
    const gaps = op.starts.slice(1).map((start, index) => start - op.starts[index]);
    [50, 100, 200, 400, 800].forEach((nominal, index) => {
      expect(Math.abs(gaps[index] - nominal * factor)).toBeLessThanOrEqual(1);
    });
    expect(op.starts[5] - op.starts[0]).toBeLessThanOrEqual(1_860);
  });

  it("costs a hung database at most three slow attempts", async () => {
    const op = failing([30_000, 30_000, 30_000, 30_000, 30_000, 30_000], () => transient("CONNECT_TIMEOUT"));
    const outcome = await drive(retryIdempotentDatabaseOperation(op.run));
    expect(outcome).toEqual({ ok: false, error: op.errors[2] });
    expect(op.starts).toHaveLength(3);
  });

  it("retries after a slow first or second attempt, and after an attempt of exactly 2,000 ms", async () => {
    const op = failing([2_500, 2_500, 2_000, 2_000, 2_000, 2_000]);
    await drive(retryIdempotentDatabaseOperation(op.run));
    expect(op.starts).toHaveLength(6);
  });

  it("stops after a third attempt slower than 2,000 ms", async () => {
    const op = failing([0, 0, 2_001]);
    const outcome = await drive(retryIdempotentDatabaseOperation(op.run));
    expect(outcome).toEqual({ ok: false, error: op.errors[2] });
    expect(op.starts).toHaveLength(3);
  });

  it("returns the first success", async () => {
    let calls = 0;
    const outcome = await drive(retryIdempotentDatabaseOperation(async () => {
      calls += 1;
      if (calls < 5) throw transient();
      return "ok";
    }));
    expect(outcome).toEqual({ ok: true, value: "ok" });
    expect(calls).toBe(5);
  });

  it("throws a non-transient error at once, as the same value", async () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });
    const op = failing([], () => error);
    const outcome = await drive(retryIdempotentDatabaseOperation(op.run));
    expect(outcome).toEqual({ ok: false, error });
    expect(op.starts).toHaveLength(1);
  });

  it("retries the wide set only with the wide predicate", async () => {
    const shutdown = () => Object.assign(new Error("terminating connection"), { code: "57P01" });
    const narrow = failing([], shutdown);
    await drive(retryIdempotentDatabaseOperation(narrow.run));
    expect(narrow.starts).toHaveLength(1);
    const wide = failing([], shutdown);
    await drive(retryIdempotentDatabaseOperation(wide.run, { isTransient: isTransientDatabaseError }));
    expect(wide.starts).toHaveLength(6);
  });
});

describe("retry abort", () => {
  it("rejects with the abort reason within 10 ms of an abort during a sleep, and starts no further attempt", async () => {
    const controller = new AbortController();
    const op = failing();
    const outcome = capture(retryIdempotentDatabaseOperation(op.run, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(20);
    expect(op.starts).toHaveLength(1);
    const reason = new Error("request closed");
    const abortedAt = performance.now();
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(10);
    expect(performance.now() - abortedAt).toBeLessThanOrEqual(10);
    await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toEqual({ ok: false, error: reason });
    await vi.runAllTimersAsync();
    expect(op.starts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("runs nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("gone");
    controller.abort(reason);
    const op = failing();
    const outcome = await drive(retryIdempotentDatabaseOperation(op.run, { signal: controller.signal }));
    expect(outcome).toEqual({ ok: false, error: reason });
    expect(op.starts).toHaveLength(0);
    expect(databaseRetryBudgetUsage()).toEqual({ calls: 0, retries: 0 });
  });

  it("does not retry after an abort during an attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("gone");
    const op = failing([100]);
    const outcome = capture(retryIdempotentDatabaseOperation(op.run, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(50);
    controller.abort(reason);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({ ok: false, error: reason });
    expect(op.starts).toHaveLength(1);
  });

  it("leaves no listener or timer behind after a retried success", async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await drive(retryIdempotentDatabaseOperation(async () => {
      calls += 1;
      if (calls < 3) throw transient();
      return "ok";
    }, { signal: controller.signal }));
    expect(outcome).toEqual({ ok: true, value: "ok" });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("retry budget", () => {
  it("gives a single failing call on an idle process all five retries", async () => {
    const op = failing();
    await drive(retryIdempotentDatabaseOperation(op.run));
    expect(op.starts).toHaveLength(6);
    expect(databaseRetryBudgetUsage()).toEqual({ calls: 1, retries: 5 });
  });

  it("counts neither a retry that the slow-attempt cap forbids nor the sixth failure", async () => {
    const slow = failing([0, 0, 3_000]);
    await drive(retryIdempotentDatabaseOperation(slow.run));
    expect(slow.starts).toHaveLength(3);
    expect(databaseRetryBudgetUsage()).toEqual({ calls: 1, retries: 2 });

    resetDatabaseRetryBudget();
    const lasting = failing();
    await drive(retryIdempotentDatabaseOperation(lasting.run));
    expect(databaseRetryBudgetUsage()).toEqual({ calls: 1, retries: 5 });
  });

  it("holds the retries of every 10 s window to its calls plus 100 in a total outage", async () => {
    const callStarts: number[] = [];
    const retryTimes: number[] = [];
    const pending: Promise<Outcome<never>>[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      setTimeout(() => {
        callStarts.push(performance.now());
        const op = failing();
        pending.push(capture(retryIdempotentDatabaseOperation(op.run).finally(() => {
          retryTimes.push(...op.starts.slice(0, -1));
        })));
      }, index * 10);
    }
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(callStarts).toHaveLength(2_000);
    const second = (time: number) => Math.floor(time / 1_000);
    const last = second(Math.max(...retryTimes, ...callStarts));
    for (let start = second(callStarts[0]) - 9; start <= last; start += 1) {
      const inWindow = (time: number) => second(time) >= start && second(time) < start + 10;
      const calls = callStarts.filter(inWindow).length;
      const retries = retryTimes.filter(inWindow).length;
      expect(retries, `window starting at second ${start}`).toBeLessThanOrEqual(calls + 100);
    }
    expect(retryTimes.length).toBeLessThan(2_000 * 5);
  });

  it("throws the last error at once when a retry is refused, and warns at most once in 10 s", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const budgetWarnings = () =>
      warn.mock.calls.filter((call) => call[1] === "database retry budget refused retries").length;

    async function burst(size: number) {
      const ops = Array.from({ length: size }, () => failing());
      const settled: number[] = [];
      const outcomes = ops.map((op, index) =>
        capture(retryIdempotentDatabaseOperation(op.run).finally(() => {
          settled[index] = performance.now();
        })));
      await vi.runAllTimersAsync();
      await Promise.all(outcomes);
      return ops.map((op, index) => ({ op, settledAt: settled[index], outcome: outcomes[index] }));
    }

    const first = await burst(40);
    const refused = first.filter(({ op }) => op.starts.length < 6);
    expect(refused.length).toBeGreaterThan(0);
    for (const { op, settledAt, outcome } of refused) {
      expect(settledAt).toBe(op.starts.at(-1));
      await expect(outcome).resolves.toEqual({ ok: false, error: op.errors.at(-1) });
    }
    expect(budgetWarnings()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    const second = await burst(40);
    expect(second.some(({ op }) => op.starts.length < 6)).toBe(true);
    expect(budgetWarnings()).toBe(1);

    await vi.advanceTimersByTimeAsync(6_000);
    const third = await burst(200);
    expect(third.some(({ op }) => op.starts.length < 6)).toBe(true);
    expect(budgetWarnings()).toBe(2);
  });

  it("is one budget for the dashboard, the cloud-tenant lookup and the wake delivery", async () => {
    const lookups = Array.from({ length: 40 }, () => failing());
    const outcomes = lookups.map((op) => capture(retryOnTransientDbConnectionError(op.run)));
    await vi.runAllTimersAsync();
    await Promise.all(outcomes);
    expect(databaseRetryBudgetUsage()).toEqual({ calls: 40, retries: 140 });

    const wake = failing([], () => Object.assign(new Error("serialization failure"), { code: "40001" }));
    await drive(retryIdempotentDatabaseOperation(wake.run, { isTransient: isTransientDatabaseError }));
    expect(wake.starts).toHaveLength(2);
  });
});

/** The policy on `main` before this change: 3 attempts, 50 and 100 ms sleeps, no budget. */
async function previousPolicy<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 2 || !isTransientDbConnectionError(error)) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

/**
 * A database-free model of a total outage in a running process: calls arrive
 * at `rate` per second for 10 s of steady traffic, then through the outage and
 * 3 s after it. Every attempt inside the outage fails at once, every attempt
 * outside it succeeds. Returns the share of calls started during the outage
 * that run out of retries.
 */
async function outageShare(
  policy: (run: () => Promise<string>) => Promise<string>,
  rate: number,
  outageMs: number,
): Promise<number> {
  const warmupMs = 10_000;
  resetDatabaseRetryBudget();
  vi.spyOn(Math, "random").mockImplementation(seededRandom(rate * 10_000 + outageMs));
  const outageStart = performance.now() + warmupMs;
  const outageEnd = outageStart + outageMs;
  const inOutage = (time: number) => time >= outageStart && time < outageEnd;
  const run = () => inOutage(performance.now()) ? Promise.reject(transient()) : Promise.resolve("ok");
  const results: Promise<boolean>[] = [];
  const total = Math.ceil(((warmupMs + outageMs + 3_000) * rate) / 1_000);
  for (let index = 0; index < total; index += 1) {
    setTimeout(() => {
      if (!inOutage(performance.now())) {
        void policy(run).catch(() => undefined);
        return;
      }
      results.push(policy(run).then(() => false, () => true));
    }, (index * 1_000) / rate);
  }
  await vi.runAllTimersAsync();
  const failed = await Promise.all(results);
  vi.mocked(Math.random).mockRestore();
  return failed.filter(Boolean).length / failed.length;
}

describe("retry budget model against the previous policy", () => {
  const rates = [20, 77, 150];
  const outages = [300, 1_000, 3_000];
  const cases = rates.flatMap((rate) => outages.map((outage) => [rate, outage] as const));

  it.each(cases)("%i calls a second, %i ms outage", async (rate, outage) => {
    const before = await outageShare(previousPolicy, rate, outage);
    const after = await outageShare(retryIdempotentDatabaseOperation, rate, outage);
    if (outage < 3_000) {
      expect(after).toBeLessThanOrEqual(before);
    } else {
      expect(after).toBeLessThanOrEqual(before + 0.05);
    }
  });
});

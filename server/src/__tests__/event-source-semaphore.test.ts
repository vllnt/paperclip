import { describe, expect, it } from "vitest";
import { createSemaphore } from "../services/event-sources/semaphore.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("event dispatch semaphore", () => {
  it("never runs more tasks than its limit and starts waiters in order", async () => {
    const semaphore = createSemaphore(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let peak = 0;
    const tasks = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        peak = Math.max(peak, semaphore.active);
        await gate.promise;
        return index;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(semaphore.active).toBe(2);
    expect(semaphore.waiting).toBe(2);

    gates[0]!.resolve();
    await tasks[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all([tasks[1], tasks[2]]);
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3]!.resolve();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(semaphore.active).toBe(0);
    expect(semaphore.waiting).toBe(0);
  });

  it("frees its slot when a task throws", async () => {
    const semaphore = createSemaphore(1);
    await expect(semaphore.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(semaphore.active).toBe(0);
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });

  it("treats a limit below one as one", async () => {
    const semaphore = createSemaphore(0);
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });
});

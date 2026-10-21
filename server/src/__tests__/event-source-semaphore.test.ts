import { describe, expect, it } from "vitest";
import { SEMAPHORE_FIRST_IN_A_ROW, createSemaphore } from "../services/event-sources/semaphore.ts";

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

  it("starts a task run with first ahead of the waiting tasks, keeping the limit", async () => {
    const semaphore = createSemaphore(1);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: string[] = [];
    const run = (name: string, gate: ReturnType<typeof deferred>, first = false) =>
      semaphore.run(async () => {
        started.push(name);
        await gate.promise;
      }, { first });
    const tasks = [run("busy", gates[0]!), run("queued", gates[1]!), run("first-a", gates[2]!, true), run("first-b", gates[3]!, true)];
    await Promise.resolve();
    expect(semaphore.waiting).toBe(3);

    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(semaphore.active).toBeLessThanOrEqual(1);
    }
    await Promise.all(tasks);
    expect(started).toEqual(["busy", "first-a", "first-b", "queued"]);
    expect(semaphore.active).toBe(0);
  });

  it("lets one other waiting task start after a run of first tasks, so first tasks cannot starve it", async () => {
    const semaphore = createSemaphore(1);
    const busy = deferred();
    const started: string[] = [];
    const run = (name: string, first = false) =>
      semaphore.run(async () => {
        started.push(name);
        if (name === "busy") await busy.promise;
      }, { first });
    const tasks = [run("busy"), run("other-1"), run("other-2")];
    for (let index = 1; index <= SEMAPHORE_FIRST_IN_A_ROW + 2; index += 1) tasks.push(run(`first-${index}`, true));

    busy.resolve();
    await Promise.all(tasks);

    const firsts = Array.from({ length: SEMAPHORE_FIRST_IN_A_ROW }, (_, index) => `first-${index + 1}`);
    expect(started).toEqual([
      "busy",
      ...firsts,
      "other-1",
      `first-${SEMAPHORE_FIRST_IN_A_ROW + 1}`,
      `first-${SEMAPHORE_FIRST_IN_A_ROW + 2}`,
      "other-2",
    ]);
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

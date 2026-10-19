/**
 * Bounds how many event dispatches run at once. A dispatch holds one pooled
 * connection for its routine-lock transaction while the issue service takes a
 * second one through the root pool, so an unbounded burst of deliveries could
 * park every connection in a transaction that is waiting for another.
 */
export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

export function createSemaphore(limit: number): Semaphore {
  const capacity = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= capacity) {
        // The releasing task hands its slot straight to the next waiter, so `active` stays at capacity.
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

/**
 * Bounds how many event dispatches run at once. A dispatch holds one pooled
 * connection for its routine-lock transaction while the issue service takes a
 * second one through the root pool, so an unbounded burst of deliveries could
 * park every connection in a transaction that is waiting for another.
 */
/**
 * How many waiting `first` tasks start in a row while other tasks wait; then one other task starts, so
 * a stream of `first` tasks cannot hold the others back for good.
 */
export const SEMAPHORE_FIRST_IN_A_ROW = 3;

export interface Semaphore {
  /**
   * Runs `task` once a slot is free. A task run with `first` waits ahead of the waiting tasks run
   * without it, up to `SEMAPHORE_FIRST_IN_A_ROW` in a row; tasks of each kind start in the order they came.
   */
  run<T>(task: () => Promise<T>, options?: { first?: boolean }): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

export function createSemaphore(limit: number): Semaphore {
  const capacity = Math.max(1, Math.floor(limit));
  let active = 0;
  const firstQueue: Array<() => void> = [];
  const queue: Array<() => void> = [];
  let firstInARow = 0;

  const release = () => {
    const takeFirst = firstQueue.length > 0 && (queue.length === 0 || firstInARow < SEMAPHORE_FIRST_IN_A_ROW);
    firstInARow = takeFirst ? firstInARow + 1 : 0;
    const next = takeFirst ? firstQueue.shift() : queue.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    async run<T>(task: () => Promise<T>, options: { first?: boolean } = {}): Promise<T> {
      if (active >= capacity) {
        // The releasing task hands its slot straight to the next waiter, so `active` stays at capacity.
        await new Promise<void>((resolve) => (options.first ? firstQueue : queue).push(resolve));
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
      return firstQueue.length + queue.length;
    },
  };
}

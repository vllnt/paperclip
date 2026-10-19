/** Maps `items` with at most `limit` calls in flight and returns the results in input order. `fn` is not started for an item once `stop()` is true; its slot is `undefined`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, stop: () => boolean, fn: (item: T) => Promise<R>): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

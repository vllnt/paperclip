/** Safety net for `id IN (...)` lookups whose id list comes from per-issue state
 * (queued wakes, run contexts) that grows with the length of the issue. */
export const COMMENT_LOOKUP_BATCH = 500;

export async function selectInCommentBatches<T>(
  ids: readonly string[],
  select: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length <= COMMENT_LOOKUP_BATCH) return ids.length ? select([...ids]) : [];
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += COMMENT_LOOKUP_BATCH) {
    rows.push(...await select(ids.slice(offset, offset + COMMENT_LOOKUP_BATCH)));
  }
  return rows;
}

/**
 * Runs `work` over `items` with at most `limit` in flight, preserving result
 * order. Independent units (mailboxes, rooms, files) seed in parallel; each
 * unit stays sequential so its own history keeps a causal order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

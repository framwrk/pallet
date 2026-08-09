/**
 * Bounded parallelism for the fan-out work the services do: stat'ing a
 * directory's entries, resolving symlink targets. The cap matters more for
 * SFTP than for disk — a server's channel budget is finite (§3.3).
 */

/** `items.map(fn)` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

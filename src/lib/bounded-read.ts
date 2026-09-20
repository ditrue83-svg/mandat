// Keep each reader's own transaction and locks. Two reads can overlap without
// queuing a whole page of transactions against the small application pool.
export async function mapInReadPairs<Item, Result>(
  items: readonly Item[],
  reader: (item: Item, index: number) => Result | PromiseLike<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let offset = 0; offset < items.length; offset += 2) {
    const batch = await Promise.allSettled(
      items
        .slice(offset, offset + 2)
        .map(async (item, index) => reader(item, offset + index)),
    );
    // Wait for both readers to release their resources even if one fails.
    // A failed batch never starts more reads or returns a partial page.
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

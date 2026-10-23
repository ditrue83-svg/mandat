import { getDb } from "./index";

type Transaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

// pg-pool emits this exact error when its checkout waiter expires, before
// Drizzle obtains a client. Never retry a callback, SQL failure or commit.
export async function withWorkerDatabaseTransaction<T>(
  body: (tx: Transaction) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let entered = false;
    try {
      return await getDb().transaction(async (tx) => {
        entered = true;
        signal?.throwIfAborted();
        return body(tx);
      });
    } catch (error) {
      if (
        entered ||
        attempt !== 0 ||
        !(error instanceof Error) ||
        error.message !== "timeout exceeded when trying to connect"
      )
        throw error;
      signal?.throwIfAborted();
      // One new checkout only. No transaction body/provider stage has run.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

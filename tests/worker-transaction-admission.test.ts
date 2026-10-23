import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  queries: [] as string[],
  failCommit: false,
}));
vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  const { EventEmitter } = await import("node:events");
  class FixtureClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(callback: (error?: Error) => void) {
      queueMicrotask(() => callback());
    }
    query(query: string | { text: string }) {
      const text = typeof query === "string" ? query : query.text;
      fixture.queries.push(text);
      if (fixture.failCommit && text === "commit")
        return Promise.reject(new Error("commit outcome unavailable"));
      return Promise.resolve({ rows: [] });
    }
    end(callback?: () => void) {
      this._ending = true;
      queueMicrotask(() => {
        this.emit("end");
        callback?.();
      });
    }
  }
  return {
    ...actual,
    Pool: class FixturePool extends actual.Pool {
      constructor(options: import("pg").PoolConfig) {
        super({
          ...options,
          Client: FixtureClient as unknown as NonNullable<
            import("pg").PoolConfig["Client"]
          >,
        });
      }
    },
  };
});

import { closeDb, getDb } from "../src/db";
import { withWorkerDatabaseTransaction } from "../src/db/worker-transaction";

beforeEach(() => {
  vi.stubEnv("DATABASE_PROVIDER", "local");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:unused@127.0.0.1/fixture");
  vi.stubEnv("DATABASE_POOL_MAX", "1");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fixture.queries.length = 0;
  fixture.failCommit = false;
});
afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("does not retry authentication or other connection errors before entry", async () => {
  const pool = getDb().$client;
  const error = new Error("synthetic authentication failure");
  const connect = vi.spyOn(pool, "connect").mockRejectedValueOnce(error as never);
  const body = vi.fn(async () => true);
  await expect(withWorkerDatabaseTransaction(body)).rejects.toBe(error);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(body).not.toHaveBeenCalled();
  expect(fixture.queries).toEqual([]);
});

it("reproduces the real pool checkout timeout before a transaction can start", async () => {
  const pool = getDb().$client;
  const held = await pool.connect();
  const body = vi.fn(async () => true);
  try {
    const outcome = getDb().transaction(body).catch((error) => error);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await outcome).toMatchObject({
      message: "timeout exceeded when trying to connect",
    });
    expect(body).not.toHaveBeenCalled();
    expect(fixture.queries).toEqual([]);
    expect(pool.waitingCount).toBe(0);
  } finally {
    held.release();
  }
});

it("enters the guard once after a temporary checkout failure and calls the provider once", async () => {
  const pool = getDb().$client;
  const held = await pool.connect();
  const guard = vi.fn(async () => "current-inputs");
  const provider = vi.fn(async () => "one-response");
  try {
    const outcome = withWorkerDatabaseTransaction(guard).then(provider);
    await vi.advanceTimersByTimeAsync(8000);
    expect(guard).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(fixture.queries).toEqual([]);
    held.release();
    await vi.advanceTimersByTimeAsync(250);
    expect(await outcome).toBe("one-response");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(fixture.queries).toEqual(["begin", "commit"]);
    expect(pool.waitingCount).toBe(0);
  } catch (error) {
    // Release only if the guard never acquired the fixture connection.
    if (!guard.mock.calls.length) held.release();
    throw error;
  }
});

it("stops after two unsuccessful checkouts without running SQL or the callback", async () => {
  const pool = getDb().$client;
  const held = await pool.connect();
  const body = vi.fn(async () => true);
  try {
    const outcome = withWorkerDatabaseTransaction(body).catch((error) => error);
    await vi.advanceTimersByTimeAsync(16_250);
    expect(await outcome).toMatchObject({
      message: "timeout exceeded when trying to connect",
    });
    expect(body).not.toHaveBeenCalled();
    expect(fixture.queries).toEqual([]);
    expect(pool.waitingCount).toBe(0);
  } finally {
    held.release();
  }
});

it("never retries a started callback, even if it throws the pool's exact message", async () => {
  const error = new Error("timeout exceeded when trying to connect");
  const body = vi.fn(async () => {
    throw error;
  });
  await expect(withWorkerDatabaseTransaction(body)).rejects.toBe(error);
  expect(body).toHaveBeenCalledTimes(1);
  expect(fixture.queries).toEqual(["begin", "rollback"]);
});

it("does not replay work after an uncertain commit", async () => {
  fixture.failCommit = true;
  const body = vi.fn(async () => "saved-result");
  await expect(withWorkerDatabaseTransaction(body)).rejects.toThrow();
  expect(body).toHaveBeenCalledTimes(1);
  expect(fixture.queries).toEqual(["begin", "commit", "rollback"]);
});

it("honors cancellation during checkout backoff without entering a second transaction", async () => {
  const pool = getDb().$client;
  const held = await pool.connect();
  const controller = new AbortController();
  const body = vi.fn(async () => true);
  try {
    const outcome = withWorkerDatabaseTransaction(body, controller.signal).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(8000);
    controller.abort();
    held.release();
    await vi.advanceTimersByTimeAsync(250);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(body).not.toHaveBeenCalled();
    expect(fixture.queries).toEqual([]);
  } catch (error) {
    if (!controller.signal.aborted) held.release();
    throw error;
  }
});

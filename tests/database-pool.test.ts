import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  queryCalls: [] as string[],
  nextQueryError: null as Error | null,
}));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  const { EventEmitter } = await import("node:events");
  // Exercise the installed pg pool's acquisition/removal/error behavior with
  // an in-memory client transport. No socket or real credential is used.
  class FixtureClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(callback: (error?: Error) => void) {
      queueMicrotask(() => callback());
    }
    query(
      text: string,
      _values: unknown,
      callback: (error: Error | null, result?: unknown) => void,
    ) {
      fixture.queryCalls.push(text);
      const error = fixture.nextQueryError;
      fixture.nextQueryError = null;
      queueMicrotask(() => callback(error, { rows: [{ value: 1 }] }));
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
    Pool: class extends actual.Pool {
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

beforeEach(() => {
  vi.stubEnv("DATABASE_PROVIDER", "local");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:unused@127.0.0.1/fixture");
  fixture.queryCalls.length = 0;
  fixture.nextQueryError = null;
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("PostgreSQL connection loss", () => {
  it("removes a disconnected idle client and reconnects for the next query", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = getDb().$client;
    const client = await pool.connect();
    client.release();
    expect(pool.idleCount).toBe(1);
    const error = Object.assign(new Error("read EADDRNOTAVAIL"), {
      code: "EADDRNOTAVAIL",
      connectionSecrets: "must-not-be-logged",
    });

    expect(() => client.emit("error", error)).not.toThrow();
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(log.mock.calls).toEqual([["database_idle_connection_error"]]);

    const replacement = await pool.connect();
    expect(replacement).not.toBe(client);
    replacement.release();
    await expect(pool.query("SELECT 1")).resolves.toMatchObject({
      rows: [{ value: 1 }],
    });
    expect(fixture.queryCalls).toEqual(["SELECT 1"]);
  });

  it("keeps active query failures observable and never retries them automatically", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = getDb().$client;
    const error = new Error("connection lost during query");
    fixture.nextQueryError = error;

    await expect(pool.query("INSERT fixture")).rejects.toBe(error);
    expect(fixture.queryCalls).toEqual(["INSERT fixture"]);
    expect(pool.totalCount).toBe(0);
    expect(log).not.toHaveBeenCalled();
    await expect(pool.query("SELECT 1")).resolves.toMatchObject({
      rows: [{ value: 1 }],
    });
    expect(fixture.queryCalls).toEqual(["INSERT fixture", "SELECT 1"]);
  });

  it("registers one handler per cached pool and creates a fresh pool after closing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = getDb();
    expect(getDb()).toBe(original);
    expect(original.$client.listenerCount("error")).toBe(1);
    const client = await original.$client.connect();
    client.release();
    const privateError = new Error("must-not-be-logged");
    Object.defineProperty(privateError, "connection", {
      get() {
        throw new Error("error details must never be inspected");
      },
    });
    expect(() => client.emit("error", privateError)).not.toThrow();
    expect(log.mock.calls).toEqual([["database_idle_connection_error"]]);

    await closeDb();
    const replacement = getDb();
    expect(replacement).not.toBe(original);
    expect(replacement.$client.listenerCount("error")).toBe(1);
  });
});

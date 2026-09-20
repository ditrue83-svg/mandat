import { expect, it, vi } from "vitest";
import { mapInReadPairs } from "../src/lib/bounded-read";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

it("overlaps only two reads and preserves input order despite reversed completions", async () => {
  const values = ["first", "second", "third", "fourth", "fifth"];
  const reads = values.map(() => deferred<string>());
  const thirdStarted = deferred<void>();
  const fifthStarted = deferred<void>();
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const result = mapInReadPairs(values, async (value, index) => {
    started.push(index);
    peak = Math.max(peak, ++active);
    if (index === 2) thirdStarted.resolve();
    if (index === 4) fifthStarted.resolve();
    try {
      return `${value}:${await reads[index].promise}`;
    } finally {
      active--;
    }
  });
  expect(started).toEqual([0, 1]);
  reads[1].resolve("B");
  await reads[1].promise;
  expect(started).toEqual([0, 1]);
  reads[0].resolve("A");
  await thirdStarted.promise;
  expect(started).toEqual([0, 1, 2, 3]);
  reads[3].resolve("D");
  await reads[3].promise;
  expect(started).toEqual([0, 1, 2, 3]);
  reads[2].resolve("C");
  await fifthStarted.promise;
  reads[4].resolve("E");
  expect(await result).toEqual([
    "first:A",
    "second:B",
    "third:C",
    "fourth:D",
    "fifth:E",
  ]);
  expect(peak).toBe(2);
  expect(active).toBe(0);
});

it("waits for the other read to finish before rejecting and never starts another pair", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const failure = new Error("Source changed during reading");
  const started: number[] = [];
  let settled = false;
  const result = mapInReadPairs(
    [first, second, deferred<string>()],
    (read, i) => {
      started.push(i);
      return read.promise;
    },
  );
  const outcome = result.then(
    () => {
      settled = true;
      return { error: null };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  first.reject(failure);
  await first.promise.catch(() => undefined);
  expect(settled).toBe(false);
  expect(started).toEqual([0, 1]);
  second.resolve("finished");
  expect(await outcome).toEqual({ error: failure });
  expect(started).toEqual([0, 1]);
});

it("also settles the whole pair when a reader throws synchronously", async () => {
  const second = deferred<string>();
  const failure = new Error("Invalid first source");
  const started: number[] = [];
  const result = mapInReadPairs([0, 1, 2], (index) => {
    started.push(index);
    if (index === 0) throw failure;
    return second.promise;
  });
  const outcome = result.catch((error: unknown) => error);
  expect(started).toEqual([0, 1]);
  second.reject(new Error("Invalid second source"));
  expect(await outcome).toBe(failure);
  expect(started).toEqual([0, 1]);
});

it("does not open any reads for an empty inventory", async () => {
  const reader = vi.fn(async () => "unused");
  expect(await mapInReadPairs([], reader)).toEqual([]);
  expect(reader).not.toHaveBeenCalled();
});

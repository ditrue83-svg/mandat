import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import {
  aiBudgetPaused,
  budgetAwareConsumer,
} from "../src/worker/ai-budget-pause";
const pg = new PGlite();
const db = drizzle(pg, { schema });
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(async () => {
  context.db = db;
  await db.delete(schema.settings);
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "10");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});
const now = new Date("2026-10-23T10:00:00Z");

it("keeps current legacy blocks paused without modifying their history", async () => {
  await db
    .insert(schema.settings)
    .values({ key: "ai_budget_blocked", value: "2026-10" });
  expect(await aiBudgetPaused(now)).toBe(true);
  expect(await db.select().from(schema.settings)).toHaveLength(1);
  expect(await aiBudgetPaused(new Date("2026-10-31T23:00:00Z"))).toBe(false);
  expect(await db.select().from(schema.settings)).toHaveLength(1);
});

it("only reopens a recorded block for a higher configured cap or the new Zurich month", async () => {
  await db.insert(schema.settings).values([
    { key: "ai_budget_blocked", value: "2026-10" },
    {
      key: "ai_budget_blocked_limit",
      value: { month: "2026-10", budgetChf: 10 },
    },
  ]);
  expect(await aiBudgetPaused(now)).toBe(true);
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "9");
  expect(await aiBudgetPaused(now)).toBe(true);
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "20");
  expect(await aiBudgetPaused(now)).toBe(false);
  expect(await db.select().from(schema.settings)).toHaveLength(2);
});

it("fails closed on malformed matching cap evidence and invalid configuration", async () => {
  await db.insert(schema.settings).values([
    { key: "ai_budget_blocked", value: "2026-10" },
    {
      key: "ai_budget_blocked_limit",
      value: { month: "2026-09", budgetChf: 0 },
    },
  ]);
  expect(await aiBudgetPaused(now)).toBe(true);
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "0");
  expect(await aiBudgetPaused(now)).toBe(true);
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "invalid");
  await expect(aiBudgetPaused(now)).rejects.toThrow("budget");
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "10");
  await expect(aiBudgetPaused(new Date(NaN))).rejects.toThrow("clock");
});

it("does not fetch or consume durable work while paused, including after restart", async () => {
  let paused = true;
  const start = vi.fn(async () => undefined),
    stop = vi.fn(async () => undefined);
  const control = budgetAwareConsumer({
    paused: async () => paused,
    start,
    stop,
  });
  await Promise.all([control(), control(), control()]);
  expect(start).not.toHaveBeenCalled();
  paused = false;
  await Promise.all([control(), control()]);
  expect(start).toHaveBeenCalledTimes(1);
  paused = true;
  await Promise.all([control(), control()]);
  expect(stop).toHaveBeenCalledTimes(1);
  const restarted = budgetAwareConsumer({
    paused: async () => paused,
    start,
    stop,
  });
  await restarted();
  expect(start).toHaveBeenCalledTimes(1);
});

it("waits for the current consumer to drain before starting a replacement", async () => {
  let paused = false,
    finish!: () => void;
  const drained = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const start = vi.fn(async () => undefined),
    stop = vi.fn(() => drained);
  const control = budgetAwareConsumer({
    paused: async () => paused,
    start,
    stop,
  });
  await control();
  paused = true;
  const stopping = control();
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  paused = false;
  const starting = control();
  await Promise.resolve();
  expect(start).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([stopping, starting]);
  expect(start).toHaveBeenCalledTimes(2);
});

it("does not start on a failed read and recovers after a temporary control error", async () => {
  const paused = vi
    .fn()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValue(false);
  const start = vi.fn(async () => undefined),
    stop = vi.fn(async () => undefined);
  const control = budgetAwareConsumer({ paused, start, stop });
  await expect(control()).rejects.toThrow("database unavailable");
  expect(start).not.toHaveBeenCalled();
  await control();
  expect(start).toHaveBeenCalledOnce();
});

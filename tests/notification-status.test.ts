import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import { demoViewer, demoProfile } from "../src/lib/demo";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import { readNotificationStatus } from "../src/lib/notification-status";
const pg = new PGlite();
const db = drizzle(pg, { schema });
const viewer = { ...demoViewer, companyId: "a", demo: false };
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const id of ["a", "b"]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db
      .insert(schema.companies)
      .values({ id, ownerId: id, profile: demoProfile });
  }
});
beforeEach(async () => {
  await db.delete(schema.notifications);
  await db.delete(schema.settings);
});
afterAll(async () => {
  await pg.close();
});

it("lo storico usa esclusivamente la ditta autenticata ed esclude errori e contenuto tecnico", async () => {
  for (const companyId of ["a", "b"])
    await db.insert(schema.notifications).values({
      id: companyId,
      companyId,
      dedupeKey: companyId,
      kind: "digest",
      status: "sent",
      subject: `Riepilogo ${companyId}`,
      html: "privato",
      textBody: "privato",
      items: [],
      error: "errore interno",
      messageId: "smtp-private",
      sentAt: new Date("2026-09-16T07:00:00Z"),
    });
  const status = await readNotificationStatus(viewer);
  expect(status.recent.map((row) => row.id)).toEqual(["a"]);
  expect(status.recent[0].status).toBe("Accettata dal server email");
  expect(JSON.stringify(status)).not.toMatch(
    /privato|interno|smtp-private|Riepilogo b/,
  );
});
it("distingue preparazione, revisione manuale e automazione senza inviare messaggi", async () => {
  expect((await readNotificationStatus(viewer)).mode).toBe("preparation");
  await db
    .insert(schema.settings)
    .values({ key: "pilot_started_at", value: "2026-09-16T07:00:00Z" });
  expect((await readNotificationStatus(viewer)).mode).toBe("manual");
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: true });
  expect((await readNotificationStatus(viewer)).mode).toBe("automatic");
  expect(await db.select().from(schema.notifications)).toEqual([]);
});
it("limita lo storico a dieci avvisi ed esclude messaggi estranei al Radar", async () => {
  for (let i = 0; i < 12; i++)
    await db.insert(schema.notifications).values({
      id: `n${i}`,
      companyId: "a",
      dedupeKey: `n${i}`,
      kind: "change",
      status: "uncertain",
      subject: "Modifica",
      html: "",
      textBody: "",
      items: [],
      createdAt: new Date(1000 + i),
    });
  await db
    .insert(schema.notifications)
    .values({
      id: "otp",
      companyId: "a",
      dedupeKey: "otp",
      kind: "otp",
      subject: "Codice",
      html: "",
      textBody: "",
      items: [],
    });
  const status = await readNotificationStatus(viewer);
  expect(status.recent).toHaveLength(10);
  expect(status.recent[0]).toMatchObject({
    id: "n11",
    status: "Esito da verificare",
  });
  expect(status.recent.some((row) => row.id === "otp")).toBe(false);
});

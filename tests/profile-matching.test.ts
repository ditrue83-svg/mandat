import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import { updateCompanyProfile } from "../src/lib/company";
import { enqueueProfileMatching } from "../src/lib/profile-matching";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const queue = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const updatedProfile = { ...demoProfile, keywords: ["potatura"] };

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await queue.start();
  await queue.stop();
  for (const id of ["a", "b"]) {
    await db.insert(schema.user).values({
      id,
      name: id,
      email: `${id}@example.invalid`,
    });
    await db.insert(schema.companies).values({
      id,
      ownerId: id,
      profile: demoProfile,
    });
  }
  const p = getDemoOpportunities()[0];
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId: p.id,
    externalId: p.externalId,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    data: p,
    revision: p.revision,
  });
  for (const id of ["a", "b"]) {
    await db.insert(schema.matches).values({
      id,
      companyId: id,
      publicationId: p.id,
      revision: "original",
      score: 90,
      reason: "Valutazione di prova",
    });
    await db.insert(schema.notifications).values({
      id,
      companyId: id,
      dedupeKey: id,
      kind: "digest",
      subject: "Test locale",
      html: "Test",
      textBody: "Test",
      items: [{ id: p.id, revision: p.revision }],
    });
  }
});

beforeEach(async () => {
  await queue.createQueue("match", {
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await queue.deleteAllJobs("match");
  await db
    .update(schema.companies)
    .set({ profile: demoProfile, onboardedAt: null });
  await db.update(schema.matches).set({
    revision: "original",
    eligible: true,
    approved: true,
    reviewedAt: new Date("2026-01-01T00:00:00Z"),
  });
  await db.update(schema.notifications).set({ status: "pending", error: null });
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await queue.stop();
  await pg.close();
});

async function snapshot() {
  return {
    companies: await db
      .select()
      .from(schema.companies)
      .orderBy(schema.companies.id),
    matches: await db.select().from(schema.matches).orderBy(schema.matches.id),
    notifications: await db
      .select()
      .from(schema.notifications)
      .orderBy(schema.notifications.id),
  };
}

it("salva il profilo e un job consumabile dal worker senza avviare pg-boss nel web", async () => {
  const start = vi.spyOn(PgBoss.prototype, "start");
  const before = await snapshot();
  await updateCompanyProfile("a", updatedProfile);
  const after = await snapshot();
  expect(start).not.toHaveBeenCalled();
  expect(after.companies[0].profile).toEqual(updatedProfile);
  expect(after.companies[0].onboardedAt).not.toBeNull();
  expect(after.matches[0]).toMatchObject({
    eligible: false,
    approved: null,
    reviewedAt: null,
    revision: "original:profile-update",
  });
  expect(after.notifications[0].status).toBe("cancelled");
  expect(after.companies[1]).toEqual(before.companies[1]);
  expect(after.matches[1]).toEqual(before.matches[1]);
  expect(after.notifications[1]).toEqual(before.notifications[1]);
  const jobs = await queue.fetch("match", { includeMetadata: true });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    data: {},
    singletonKey: "all",
    state: "active",
  });
});

it("non perde il nuovo salvataggio quando un job all è già in esecuzione", async () => {
  await updateCompanyProfile("a", demoProfile);
  const [active] = await queue.fetch("match");
  await updateCompanyProfile("a", updatedProfile);
  const jobs = await queue.findJobs("match");
  expect(jobs.map((job) => job.state).sort()).toEqual(["active", "created"]);
  expect(await queue.fetch("match")).toEqual([]);
  await queue.complete("match", active.id);
  const next = await queue.fetch("match");
  expect(next).toHaveLength(1);
  expect(next[0].id).not.toBe(active.id);
});

it("conserva i salvataggi quando un job all è ancora in attesa", async () => {
  await updateCompanyProfile("a", demoProfile);
  await updateCompanyProfile("a", updatedProfile);
  expect(await queue.findJobs("match")).toHaveLength(2);
  const [first] = await queue.fetch("match");
  await queue.complete("match", first.id);
  expect(await queue.fetch("match")).toHaveLength(1);
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, "a"));
  expect(company.profile).toEqual(updatedProfile);
});

it("annulla profilo, invalidazioni e digest se la coda non è disponibile", async () => {
  const before = await snapshot();
  await queue.deleteQueue("match");
  await expect(updateCompanyProfile("a", updatedProfile)).rejects.toThrow(
    "Queue match does not exist",
  );
  expect(await snapshot()).toEqual(before);
});

it("annulla anche il job se un errore successivo interrompe la transazione", async () => {
  const before = await snapshot();
  await expect(
    db.transaction(async (tx) => {
      await tx
        .update(schema.companies)
        .set({ profile: updatedProfile })
        .where(eq(schema.companies.id, "a"));
      await enqueueProfileMatching(tx);
      throw new Error("Errore successivo simulato");
    }),
  ).rejects.toThrow("Errore successivo simulato");
  expect(await queue.findJobs("match")).toHaveLength(0);
  expect(await snapshot()).toEqual(before);
});

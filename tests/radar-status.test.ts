import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, demoViewer, getDemoOpportunities } from "../src/lib/demo";
import { fingerprint } from "../src/sources/common";
import type { Publication, Viewer } from "../src/lib/domain";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import { getRadarStatus } from "../src/lib/queries";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const now = new Date("2026-09-11T16:00:00Z");
const viewer: Viewer = {
  ...demoViewer,
  demo: false,
  companyId: "a",
  userId: "a",
};
const currentRevision = (revision = "v1") =>
  `${revision}:${fingerprint(viewer.profile)}:ready:test-model:true`;

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const id of ["a", "b"]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db
      .insert(schema.companies)
      .values({ id, ownerId: id, profile: demoProfile, onboardedAt: now });
  }
});
beforeEach(async () => {
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  await db.delete(schema.publications);
  await db.delete(schema.settings);
  await db
    .insert(schema.settings)
    .values({ key: "worker_heartbeat", value: now.toISOString() });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

async function publication(id = "p", input: Partial<Publication> = {}) {
  const p = {
    ...getDemoOpportunities()[0],
    id,
    externalId: id,
    source: "simap" as const,
    status: "open" as const,
    visibleAt: "2026-09-11T06:00:00Z",
    deadline: "2026-10-01T12:00:00Z",
    revision: "v1",
    ...input,
  };
  await db
    .insert(schema.publications)
    .values({
      id,
      externalId: id,
      canonicalId: id,
      source: p.source,
      title: p.title,
      status: p.status,
      visibleAt: new Date(p.visibleAt),
      deadline: p.deadline ? new Date(p.deadline) : null,
      data: p,
      revision: p.revision,
    });
}
async function match(
  companyId = "a",
  revision = currentRevision(),
  eligible = false,
  publicationId = "p",
) {
  await db
    .insert(schema.matches)
    .values({
      id: `${companyId}-${publicationId}`,
      companyId,
      publicationId,
      revision,
      score: eligible ? 80 : 0,
      reason: "Esito di prova",
      eligible,
    });
}

it("mostra elaborazione quando il profilo non ha ancora valutazioni", async () => {
  await publication();
  expect(await getRadarStatus(viewer, now)).toEqual({
    state: "processing",
    pendingCount: 1,
  });
});
it("distingue nessun risultato pertinente da una ricerca ancora pendente", async () => {
  await publication();
  await match();
  expect(await getRadarStatus(viewer, now)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
});
it("non usa i match di un'altra ditta per dichiarare pronto il Radar", async () => {
  await publication();
  await match("b");
  expect(await getRadarStatus(viewer, now)).toEqual({
    state: "processing",
    pendingCount: 1,
  });
});
it.each([
  `${currentRevision()}:profile-update`,
  `v1:vecchio-profilo:ready:test-model:true`,
  currentRevision("vecchia-pubblicazione"),
])("attende la rivalutazione di un match obsoleto: %s", async (revision) => {
  await publication();
  await match("a", revision, true);
  expect((await getRadarStatus(viewer, now)).pendingCount).toBe(1);
});
it.each(["pending", "ready:test-model:true:retry"])(
  "un esito AI %s è già valutato, anche se richiede revisione",
  async (suffix) => {
    await publication();
    await match("a", `v1:${fingerprint(viewer.profile)}:${suffix}`);
    expect((await getRadarStatus(viewer, now)).state).toBe("ready");
  },
);
it("esclude scaduti, annullati, aggiudicati, futuri e Foglio senza riutilizzo autorizzato", async () => {
  await publication("expired", { deadline: now.toISOString() });
  await publication("cancelled", { status: "cancelled" });
  await publication("awarded", { status: "awarded" });
  await publication("future", { visibleAt: "2026-09-12T06:00:00Z" });
  await publication("foglio", { source: "foglio-ti" });
  expect(await getRadarStatus(viewer, now)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "true");
  expect((await getRadarStatus(viewer, now)).pendingCount).toBe(1);
});
it("include un bando senza scadenza indicata e termina dopo l'ultimo match", async () => {
  await publication("p", { deadline: null });
  await publication("second");
  await match("a", currentRevision(), true);
  expect((await getRadarStatus(viewer, now)).pendingCount).toBe(1);
  await match("a", currentRevision(), false, "second");
  expect(await getRadarStatus(viewer, now)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
});
it.each(["2026-09-11T15:44:59Z", "non-una-data", "2026-09-12T16:00:00Z"])(
  "segnala ritardo con heartbeat inattendibile: %s",
  async (value) => {
    await publication();
    await db
      .update(schema.settings)
      .set({ value })
      .where(eq(schema.settings.key, "worker_heartbeat"));
    expect(await getRadarStatus(viewer, now)).toEqual({
      state: "delayed",
      pendingCount: 1,
    });
  },
);
it("segnala ritardo anche senza heartbeat e lascia la demo indipendente dal DB", async () => {
  await publication();
  await db.delete(schema.settings);
  expect((await getRadarStatus(viewer, now)).state).toBe("delayed");
  expect(await getRadarStatus(demoViewer, now)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
});

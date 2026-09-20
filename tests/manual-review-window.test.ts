import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoViewer, demoProfile, getDemoOpportunities } from "../src/lib/demo";
import { fingerprint } from "../src/sources/common";
const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/mail", () => ({
  emailLayout: (s: string) => s,
  escapeHtml: (s: string) => s,
  sendMail: vi.fn(),
}));
import { getGate, adminSnapshot } from "../src/lib/admin";
import { startManualReview } from "../src/lib/manual-review-admin";
import {
  MANUAL_REVIEW_WINDOW,
  automationForCompany,
} from "../src/lib/manual-review-window";
import {
  createPilotPrerequisite,
  pilotPrerequisiteSettingKey,
} from "../src/lib/pilot";
import { readNotificationStatus } from "../src/lib/notification-status";
const pg = new PGlite();
const db = drizzle(pg, { schema });
const start = new Date("2026-09-20T10:00:00Z");
const end = new Date("2026-09-27T10:00:00Z");
const viewer = {
  ...demoViewer,
  demo: false,
  companyId: "founder-company",
  userId: "founder",
};
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(async () => pg.close());
beforeEach(async () => {
  await db.delete(schema.matches);
  await db.delete(schema.publications);
  await db.delete(schema.pilotParticipants);
  await db.delete(schema.settings);
  await db.delete(schema.invitations);
  await db.delete(schema.companies);
  await db.delete(schema.administrators);
  await db.delete(schema.user);
  await db.delete(schema.issues);
  for (const id of ["founder", "other"]) {
    await db.insert(schema.user).values({
      id,
      name: "Profilo inventato per test",
      email: `${id}@example.invalid`,
    });
    await db.insert(schema.companies).values({
      id: `${id}-company`,
      ownerId: id,
      profile: demoProfile,
      onboardedAt: start,
    });
    await db.insert(schema.invitations).values({
      id,
      companyId: `${id}-company`,
      email: `${id}@example.invalid`,
      expiresAt: end,
    });
  }
  await db.insert(schema.administrators).values({ userId: "founder" });
  for (const key of ["data_residency", "external_delivery"] as const)
    await db.insert(schema.settings).values({
      key: pilotPrerequisiteSettingKey(key),
      value: createPilotPrerequisite(
        key,
        true,
        "Prerequisito del solo collaudo isolato.",
        "founder",
        start,
      ),
    });
});
async function reviewSet(
  positive = 16,
  total = 20,
  companyId = viewer.companyId,
  at = new Date("2026-09-21T10:00:00Z"),
) {
  const [stored] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId));
  for (let i = 0; i < total; i++) {
    const id = `${companyId}-${at.getTime()}-${i}`;
    const p = {
      ...getDemoOpportunities()[0],
      id,
      externalId: id,
      revision: id,
      source: "simap" as const,
      title: "Potatura e manutenzione giardini inventati",
      originalText: "Potatura alberi e manutenzione giardini.",
      cpv: ["77310000"],
      sectors: ["giardinaggio" as const],
      canton: "TI",
      zone: "Luganese",
      location: "Lugano",
      status: "open" as const,
      publishedAt: start.toISOString(),
      updatedAt: start.toISOString(),
      visibleAt: start.toISOString(),
      deadline: "2027-01-01T10:00:00Z",
      reviewRequired: false,
      reviewReasons: [],
    };
    await db.insert(schema.publications).values({
      id,
      externalId: id,
      canonicalId: id,
      source: "simap",
      title: p.title,
      data: p,
      revision: id,
      status: "open",
      visibleAt: start,
      deadline: new Date(p.deadline),
    });
    await db.insert(schema.matches).values({
      id,
      companyId,
      publicationId: id,
      revision: `${id}:${fingerprint(stored.profile)}:manual`,
      score: 90,
      eligible: true,
      reason: "Valutazione inventata del test",
      approved: i < positive,
      reviewedAt: at,
    });
  }
}
it("avvia una finestra reale di sette giorni per il fondatore senza creare un pilota o invii", async () => {
  const window = await startManualReview(viewer, start);
  expect(window.startedAt).toBe(start.toISOString());
  expect((await getGate(start)).manualReview).toMatchObject({
    companyId: viewer.companyId,
    profileCurrent: true,
  });
  expect((await getGate(start)).allowed).toBe(false);
  expect((await adminSnapshot(false)).pilot.startedAt).toBeNull();
  expect(await db.select().from(schema.pilotParticipants)).toEqual([]);
  expect(await db.select().from(schema.notifications)).toEqual([]);
  expect((await readNotificationStatus(viewer)).mode).toBe("manual");
  expect(
    (await readNotificationStatus({ ...viewer, companyId: "other-company" }))
      .mode,
  ).toBe("preparation");
  await expect(startManualReview(viewer, end)).rejects.toMatchObject({
    status: 409,
  });
});
it("richiede davvero sette giorni, venti giudizi e almeno sedici positivi", async () => {
  await startManualReview(viewer, start);
  await reviewSet();
  expect(await getGate(new Date(end.getTime() - 1))).toMatchObject({
    allowed: false,
    reviewed: 20,
    approved: 16,
  });
  expect(await getGate(end)).toMatchObject({
    allowed: true,
    reviewed: 20,
    approved: 16,
    precision: 0.8,
  });
  const [negative] = await db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.approved, false));
  await db
    .update(schema.matches)
    .set({ approved: null })
    .where(eq(schema.matches.id, negative.id));
  expect(await getGate(end)).toMatchObject({
    allowed: false,
    reviewed: 19,
    approved: 16,
  });
  await db
    .update(schema.matches)
    .set({ approved: false })
    .where(eq(schema.matches.id, negative.id));
  const [positive] = await db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.approved, true));
  await db
    .update(schema.matches)
    .set({ approved: false })
    .where(eq(schema.matches.id, positive.id));
  expect((await getGate(end)).allowed).toBe(false);
});
it("esclude giudizi precedenti, futuri e di un’altra ditta", async () => {
  await startManualReview(viewer, start);
  await reviewSet(20, 20, viewer.companyId, new Date(start.getTime() - 1));
  await reviewSet(20, 20, "other-company");
  await reviewSet(20, 20, viewer.companyId, new Date(end.getTime() + 1));
  expect(await getGate(end)).toMatchObject({
    allowed: false,
    reviewed: 0,
    approved: 0,
  });
});
it("un profilo cambiato blocca il gate e gli invii automatici e riparte senza cancellare lo storico", async () => {
  const window = await startManualReview(viewer, start);
  await reviewSet();
  const config = new Map<string, unknown>([
    ["automation_enabled", true],
    [MANUAL_REVIEW_WINDOW, window],
  ]);
  expect(
    automationForCompany(
      config,
      { id: viewer.companyId, profile: demoProfile },
      end,
    ),
  ).toBe(true);
  expect(
    automationForCompany(
      config,
      { id: "other-company", profile: demoProfile },
      end,
    ),
  ).toBe(false);
  expect(
    automationForCompany(
      config,
      { id: viewer.companyId, profile: demoProfile },
      new Date(end.getTime() - 1),
    ),
  ).toBe(false);
  const profile = {
    ...demoProfile,
    activities: "Manutenzione giardini e potatura alberi per il collaudo.",
  };
  await db
    .update(schema.companies)
    .set({ profile })
    .where(eq(schema.companies.id, viewer.companyId));
  expect(await getGate(end)).toMatchObject({
    allowed: false,
    reviewed: 0,
    manualReview: { profileCurrent: false },
  });
  expect(
    automationForCompany(config, { id: viewer.companyId, profile }, end),
  ).toBe(false);
  const restarted = await startManualReview({ ...viewer, profile }, end);
  expect(restarted.startedAt).toBe(end.toISOString());
  expect(restarted.id).not.toBe(window.id);
  expect(await db.select().from(schema.matches)).toHaveLength(20);
  expect(
    (await db.select().from(schema.settings)).filter((row) =>
      row.key.startsWith(`${MANUAL_REVIEW_WINDOW}:`),
    ),
  ).toHaveLength(2);
});
it.each(["critical", "automatic", "pilot", "prerequisite", "owner"])(
  "non avvia la finestra se manca la condizione %s",
  async (kind) => {
    if (kind === "critical")
      await db.insert(schema.issues).values({
        id: "critical",
        key: "critical",
        severity: "critical",
        title: "Errore inventato",
        detail: "Test",
      });
    if (kind === "automatic")
      await db
        .insert(schema.settings)
        .values({ key: "automation_enabled", value: true });
    if (kind === "pilot")
      await db
        .insert(schema.settings)
        .values({ key: "pilot_started_at", value: start.toISOString() });
    if (kind === "prerequisite")
      await db
        .delete(schema.settings)
        .where(
          eq(
            schema.settings.key,
            pilotPrerequisiteSettingKey("external_delivery"),
          ),
        );
    const input =
      kind === "owner" ? { ...viewer, companyId: "other-company" } : viewer;
    await expect(startManualReview(input, start)).rejects.toBeInstanceOf(Error);
    expect(
      await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, MANUAL_REVIEW_WINDOW)),
    ).toEqual([]);
  },
);
it("una criticità sopraggiunta impedisce l’abilitazione anche con tutte le altre soglie", async () => {
  await startManualReview(viewer, start);
  await reviewSet();
  await db.insert(schema.issues).values({
    id: "critical",
    key: "critical",
    severity: "critical",
    title: "Errore inventato",
    detail: "Test",
  });
  expect(await getGate(end)).toMatchObject({
    allowed: false,
    reviewed: 20,
    approved: 16,
    criticalIssues: 1,
  });
});
it("configurazioni malformate non allargano l’automazione ad altre ditte", async () => {
  const config = new Map<string, unknown>([
    ["automation_enabled", true],
    [MANUAL_REVIEW_WINDOW, { companyId: viewer.companyId }],
  ]);
  expect(
    automationForCompany(
      config,
      { id: viewer.companyId, profile: demoProfile },
      end,
    ),
  ).toBe(false);
  config.set("pilot_started_at", "invalid");
  expect(
    automationForCompany(
      config,
      { id: "other-company", profile: demoProfile },
      end,
    ),
  ).toBe(false);
});
it("un profilo aggiornato dopo la conferma del form non avvia un periodo diverso da quello visto", async () => {
  await db
    .update(schema.companies)
    .set({
      profile: {
        ...demoProfile,
        activities: "Attività cambiata dopo la lettura del form.",
      },
    })
    .where(eq(schema.companies.id, viewer.companyId));
  await expect(startManualReview(viewer, start)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining("profilo è cambiato"),
  });
  expect(
    await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, MANUAL_REVIEW_WINDOW)),
  ).toEqual([]);
});

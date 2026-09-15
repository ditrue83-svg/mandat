import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";

const testContext = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({
  getDb: () => testContext.db,
  closeDb: async () => {},
}));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value,
  sendMail: vi.fn(),
}));

import { provisionInvite } from "../src/lib/admin";
import { saveCompanyFeedback, updateCompanyProfile } from "../src/lib/company";
import {
  readPilotStartedAt,
  recordPilotAudit,
  recordPilotContinuation,
  setPilotPrerequisite,
  startPilot,
} from "../src/lib/pilot-admin";
import { summarizePilot } from "../src/lib/pilot";
import { readProjectQuality } from "../src/lib/project-quality";

const pg = new PGlite();
const db = drizzle(pg, { schema });

beforeAll(async () => {
  testContext.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  const boss = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    schema: "pgboss",
    schedule: false,
    supervise: false,
  });
  await boss.start();
  try {
    await boss.createQueue("match", { policy: "singleton" });
  } finally {
    await boss.stop();
  }
});

afterAll(async () => pg.close());

describe("preparazione e misure del pilota", () => {
  it("separa inviti, avvio esplicito e primo completamento del profilo", async () => {
    const admin = await provisionInvite(
      "pilot-founder@example.invalid",
      "Fondatore",
      true,
    );
    const firms = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        provisionInvite(
          `pilot-${index + 1}@example.invalid`,
          `Ditta pilota ${index + 1}`,
        ),
      ),
    );
    expect(await readPilotStartedAt()).toBeNull();

    await setPilotPrerequisite({
      key: "data_residency",
      confirmed: true,
      note: "Evidenza documentaria verificata per il test.",
      actorId: admin.userId,
      now: new Date("2026-09-15T08:00:00.000Z"),
    });
    await setPilotPrerequisite({
      key: "external_delivery",
      confirmed: true,
      note: "Recapito esterno verificato per il test.",
      actorId: admin.userId,
      now: new Date("2026-09-15T08:01:00.000Z"),
    });
    await expect(
      startPilot(new Date("2026-09-15T09:00:00.000Z")),
    ).rejects.toMatchObject({ status: 400 });

    const acceptedAt = new Date("2026-09-15T09:10:00.000Z");
    const onboardedAt = new Date("2026-09-15T09:18:00.000Z");
    for (const firm of firms) {
      await db
        .update(schema.invitations)
        .set({ acceptedAt })
        .where(eq(schema.invitations.companyId, firm.companyId));
      await db
        .update(schema.companies)
        .set({ profile: demoProfile, onboardedAt })
        .where(eq(schema.companies.id, firm.companyId));
    }

    await updateCompanyProfile(firms[0].companyId, {
      ...demoProfile,
      activities: "Pulizie aggiornate senza riscrivere l’onboarding",
    });
    const [updated] = await db
      .select({ onboardedAt: schema.companies.onboardedAt })
      .from(schema.companies)
      .where(eq(schema.companies.id, firms[0].companyId));
    expect(updated.onboardedAt?.toISOString()).toBe(onboardedAt.toISOString());

    const started = await startPilot(new Date("2026-09-15T10:00:00.000Z"));
    expect(started).toEqual({
      startedAt: "2026-09-15T10:00:00.000Z",
      endsAt: "2026-10-13T10:00:00.000Z",
    });
    expect(await db.select().from(schema.pilotParticipants)).toHaveLength(5);
    await expect(
      provisionInvite("pilot-extra@example.invalid", "Ditta fuori coorte"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      startPilot(new Date("2026-09-15T10:01:00.000Z")),
    ).rejects.toMatchObject({ status: 409 });

    const publication = {
      ...getDemoOpportunities()[0],
      id: "pilot-publication",
      externalId: "pilot-publication",
      canonicalKey: "pilot-canonical",
      source: "simap" as const,
      visibleAt: "2026-09-15T10:30:00.000Z",
      publishedAt: "2026-09-15T10:30:00.000Z",
      revision: "pilot-revision",
    };
    await db.insert(schema.publications).values({
      id: publication.id,
      canonicalId: publication.canonicalKey,
      source: publication.source,
      externalId: publication.externalId,
      title: publication.title,
      status: publication.status,
      visibleAt: new Date(publication.visibleAt),
      deadline: publication.deadline ? new Date(publication.deadline) : null,
      data: publication,
      revision: publication.revision,
    });
    await db.insert(schema.matches).values({
      id: "pilot-match",
      companyId: firms[0].companyId,
      publicationId: publication.id,
      revision: publication.revision,
      score: 0,
      reason: "Campione manuale",
      eligible: false,
    });
    await db.insert(schema.user).values({
      id: "outside-user",
      email: "outside@example.invalid",
      name: "Ditta fuori coorte",
    });
    await db.insert(schema.companies).values({
      id: "outside-company",
      ownerId: "outside-user",
      profile: demoProfile,
      onboardedAt,
    });
    await db.insert(schema.invitations).values({
      id: "outside-invitation",
      email: "outside@example.invalid",
      companyId: "outside-company",
      expiresAt: new Date("2026-09-29T09:10:00.000Z"),
      acceptedAt,
    });
    await db.insert(schema.matches).values({
      id: "outside-match",
      companyId: "outside-company",
      publicationId: publication.id,
      revision: publication.revision,
      score: 90,
      reason: "Valutazione esterna alla coorte",
      eligible: true,
      reviewedAt: new Date("2026-09-16T08:00:00.000Z"),
      approved: true,
    });
    const qualityWindow = {
      reviewedSince: new Date("2026-09-15T10:00:00.000Z"),
      includeCompanyIds: firms.map((firm) => firm.companyId),
    };
    expect(
      (
        await readProjectQuality(
          new Date("2026-09-17T08:00:00.000Z"),
          qualityWindow,
        )
      ).historical.approved,
    ).toBe(0);
    expect(
      (
        await readProjectQuality(new Date("2026-09-17T08:00:00.000Z"), {
          reviewedSince: qualityWindow.reviewedSince,
        })
      ).historical.approved,
    ).toBe(1);
    await saveCompanyFeedback(firms[0].companyId, publication.id, {
      relevant: true,
    });
    await saveCompanyFeedback(firms[0].companyId, publication.id, {
      relevant: false,
    });
    const feedbackEvents = await db
      .select()
      .from(schema.pilotFeedbackEvents)
      .orderBy(schema.pilotFeedbackEvents.occurredAt);
    expect(feedbackEvents.map((event) => event.relevant)).toEqual([
      true,
      false,
    ]);
    await expect(
      db
        .update(schema.pilotFeedbackEvents)
        .set({ relevant: true })
        .where(eq(schema.pilotFeedbackEvents.id, feedbackEvents[0].id)),
    ).rejects.toThrow();
    await recordPilotAudit({
      matchId: "pilot-match",
      relevant: true,
      note: "La fonte conferma un servizio pertinente.",
      reviewerId: admin.userId,
      now: new Date("2026-09-16T09:00:00.000Z"),
    });
    await db.insert(schema.notifications).values({
      id: "pilot-notification-late",
      companyId: firms[0].companyId,
      dedupeKey: "pilot-notification-late",
      kind: "digest",
      status: "sent",
      subject: "Test",
      html: "Test",
      textBody: "Test",
      items: [{ id: publication.id, revision: publication.revision }],
      sentAt: new Date("2026-09-16T10:00:00.000Z"),
    });
    await recordPilotAudit({
      matchId: "pilot-match",
      relevant: true,
      note: "Giudizio corretto, senza attribuire l’invio successivo.",
      reviewerId: admin.userId,
      now: new Date("2026-09-16T11:00:00.000Z"),
    });
    const [audit] = await db.select().from(schema.pilotAudits);
    expect(audit.alertedAt).toBeNull();
    expect(audit.auditedAt.toISOString()).toBe("2026-09-16T09:00:00.000Z");

    await expect(
      recordPilotAudit({
        matchId: "pilot-match",
        relevant: true,
        note: "Controllo tardivo fuori dalla finestra del pilota.",
        reviewerId: admin.userId,
        now: new Date("2026-10-13T10:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setPilotPrerequisite({
        key: "data_residency",
        confirmed: false,
        note: "Tentativo di riscrivere una verifica già fissata.",
        actorId: admin.userId,
        now: new Date("2026-09-16T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 409 });

    await recordPilotContinuation({
      companyId: firms[0].companyId,
      interested: true,
      note: "La ditta desidera continuare dopo il pilota.",
      reviewerId: admin.userId,
      now: new Date("2026-10-13T10:01:00.000Z"),
    });
    expect(await db.select().from(schema.pilotContinuation)).toHaveLength(1);
  });

  it("calcola solo ditte attive e osservazioni nella finestra", () => {
    const start = new Date("2026-09-01T08:00:00.000Z");
    const participant = (companyId: string) => ({
      companyId,
      admin: false,
      cohort: true,
      acceptedAt: new Date("2026-09-01T07:50:00.000Z"),
      onboardedAt: new Date("2026-09-01T07:58:00.000Z"),
      revokedAt: null,
      disabledAt: null,
    });
    const summary = summarizePilot({
      now: new Date("2026-09-08T08:00:00.000Z"),
      startedAt: start,
      participants: [
        ...Array.from({ length: 5 }, (_, index) => participant(`c${index}`)),
        { ...participant("admin"), admin: true },
        { ...participant("revoked"), cohort: false, revokedAt: start },
      ],
      feedback: [
        {
          companyId: "c0",
          canonicalId: "a",
          relevant: false,
          updatedAt: new Date("2026-09-02T08:00:00.000Z"),
        },
        {
          companyId: "c0",
          canonicalId: "a",
          relevant: true,
          updatedAt: new Date("2026-09-03T08:00:00.000Z"),
        },
        {
          companyId: "admin",
          canonicalId: "b",
          relevant: true,
          updatedAt: new Date("2026-09-03T08:00:00.000Z"),
        },
      ],
      deliveries: [
        {
          companyId: "c0",
          canonicalId: "a",
          visibleAt: new Date("2026-09-02T08:00:00.000Z"),
          sentAt: new Date("2026-09-02T14:00:00.000Z"),
        },
        {
          companyId: "c1",
          canonicalId: "b",
          visibleAt: new Date("2026-09-02T08:00:00.000Z"),
          sentAt: new Date("2026-09-04T08:00:00.000Z"),
        },
      ],
      audits: [
        {
          companyId: "c0",
          relevant: true,
          alertedAt: new Date("2026-09-02T14:00:00.000Z"),
          auditedAt: new Date("2026-09-03T08:00:00.000Z"),
        },
        {
          companyId: "c1",
          relevant: true,
          alertedAt: null,
          auditedAt: new Date("2026-09-03T08:00:00.000Z"),
        },
        {
          companyId: "c2",
          relevant: false,
          alertedAt: null,
          auditedAt: new Date("2026-09-03T08:00:00.000Z"),
        },
      ],
      continuation: [
        {
          companyId: "c0",
          interested: true,
          updatedAt: new Date("2026-09-08T07:00:00.000Z"),
        },
      ],
      prerequisites: {
        data_residency: null,
        external_delivery: null,
      },
    });
    expect(summary.participants).toEqual({
      active: 5,
      accepted: 5,
      onboarded: 5,
      target: 5,
    });
    expect(summary.onboarding).toMatchObject({
      measured: 5,
      withinLimit: 5,
      rate: 1,
      medianMinutes: 8,
    });
    expect(summary.relevance).toMatchObject({
      evaluated: 1,
      relevant: 1,
      rate: 1,
    });
    expect(summary.delivery).toMatchObject({
      measured: 2,
      withinLimit: 1,
      rate: 0.5,
      medianHours: 27,
    });
    expect(summary.recall).toMatchObject({
      audited: 3,
      relevant: 2,
      detected: 1,
      rate: 0.5,
    });
    expect(summary.continuation).toMatchObject({
      responses: 1,
      interested: 1,
    });
  });
});

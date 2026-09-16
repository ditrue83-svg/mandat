import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { CompanyProfile } from "../src/lib/domain";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  viewer: undefined as unknown,
}));
vi.mock("@/db", () => ({
  getDb: () => context.db,
  closeDb: async () => {},
}));
vi.mock("@/lib/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/viewer")>();
  return { ...actual, requireViewer: async () => context.viewer };
});
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value,
  sendMail: vi.fn(),
}));

import { adminSnapshot, provisionInvite } from "../src/lib/admin";
import { POST as adminPost } from "../src/app/api/admin/route";
import { updateCompanyProfile } from "../src/lib/company";
import { sendMail } from "../src/lib/mail";
import { setPilotPrerequisite, startPilot } from "../src/lib/pilot-admin";
import {
  acceptPilotParticipation,
  PILOT_PARTICIPATION_TERMS_VERSION,
} from "../src/lib/pilot-consent";
import { SECTORS } from "../src/lib/domain";
import { inviteSchema, profileSchema } from "../src/lib/validation";

const pg = new PGlite();
const db = drizzle(pg, { schema });

type TestFirm = {
  name: string;
  email: string;
  preliminaryAcceptance: {
    confirmed: true;
    channel: "collaudo isolato";
    recordedAt: string;
  };
  profile: CompanyProfile;
};

const firms: TestFirm[] = [
  {
    name: "TEST Alfa Pulito Verde",
    email: "alfa.pulito-verde@example.invalid",
    preliminaryAcceptance: {
      confirmed: true,
      channel: "collaudo isolato",
      recordedAt: "2026-09-16T07:50:00.000Z",
    },
    profile: {
      name: "TEST Alfa Pulito Verde",
      activities:
        "Pulizia di uffici, scuole e spazi comuni; manutenzione di giardini, sfalcio e potatura.",
      employees: 8,
      sectors: ["pulizie", "giardinaggio"],
      zones: ["Luganese", "Mendrisiotto"],
      keywords: ["pulizia uffici", "sfalcio", "potatura"],
      exclusions: ["disinfestazione", "lavori forestali in quota"],
      minValue: 2_000,
      maxValue: 180_000,
      emailEnabled: true,
    },
  },
  {
    name: "TEST Beta Casa Tecnica",
    email: "beta.casa-tecnica@example.invalid",
    preliminaryAcceptance: {
      confirmed: true,
      channel: "collaudo isolato",
      recordedAt: "2026-09-16T07:51:00.000Z",
    },
    profile: {
      name: "TEST Beta Casa Tecnica",
      activities:
        "Manutenzione ordinaria di edifici e piccoli impianti elettrici, idraulici e di riscaldamento.",
      employees: 12,
      sectors: ["manutenzioni", "impianti"],
      zones: ["Bellinzonese", "Riviera", "Leventina"],
      keywords: ["manutenzione edifici", "impianti elettrici", "idraulica"],
      exclusions: ["alta tensione", "grandi impianti industriali"],
      minValue: 5_000,
      maxValue: 500_000,
      emailEnabled: true,
    },
  },
  {
    name: "TEST Gamma Edilizia Minore",
    email: "gamma.edilizia@example.invalid",
    preliminaryAcceptance: {
      confirmed: true,
      channel: "collaudo isolato",
      recordedAt: "2026-09-16T07:52:00.000Z",
    },
    profile: {
      name: "TEST Gamma Edilizia Minore",
      activities:
        "Piccoli risanamenti, muratura, pavimentazioni e riparazioni edili per edifici pubblici.",
      employees: 10,
      sectors: ["edilizia"],
      zones: ["Locarnese", "Vallemaggia"],
      keywords: ["risanamento", "muratura", "pavimentazione"],
      exclusions: [
        "scavi profondi",
        "opere da impresario costruttore generale",
      ],
      minValue: 10_000,
      maxValue: 750_000,
      emailEnabled: true,
    },
  },
  {
    name: "TEST Delta Sicurezza",
    email: "delta.sicurezza@example.invalid",
    preliminaryAcceptance: {
      confirmed: true,
      channel: "collaudo isolato",
      recordedAt: "2026-09-16T07:53:00.000Z",
    },
    profile: {
      name: "TEST Delta Sicurezza",
      activities:
        "Servizi di vigilanza, controllo accessi e sorveglianza per edifici ed eventi pubblici.",
      employees: 15,
      sectors: ["sicurezza"],
      zones: ["Tutto il Ticino"],
      keywords: ["vigilanza", "controllo accessi", "sorveglianza"],
      exclusions: ["cybersecurity", "trasporto valori"],
      minValue: 5_000,
      maxValue: 400_000,
      emailEnabled: true,
    },
  },
  {
    name: "TEST Epsilon Pasti e Trasporti",
    email: "epsilon.pasti-trasporti@example.invalid",
    preliminaryAcceptance: {
      confirmed: true,
      channel: "collaudo isolato",
      recordedAt: "2026-09-16T07:54:00.000Z",
    },
    profile: {
      name: "TEST Epsilon Pasti e Trasporti",
      activities:
        "Preparazione e consegna di pasti per mense, con trasporto locale di persone e materiali leggeri.",
      employees: 14,
      sectors: ["catering", "trasporti"],
      zones: ["Luganese", "Bellinzonese", "Locarnese"],
      keywords: ["mensa", "pasti", "consegna", "trasporto locale"],
      exclusions: ["trasporto merci pericolose", "linee internazionali"],
      minValue: 3_000,
      maxValue: 600_000,
      emailEnabled: true,
    },
  },
];

function inviteRequest(body: unknown) {
  return new Request("http://localhost:3456/api/admin", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3456",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  context.db = db;
  vi.stubEnv("APP_URL", "http://localhost:3456");
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

afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

describe("collaudo isolato con cinque ditte complete", () => {
  it("raccoglie tutti i profili, blocca l’avvio incompleto e congela esattamente la coorte pronta", async () => {
    expect(
      [...new Set(firms.flatMap((firm) => firm.profile.sectors))].sort(),
    ).toEqual(SECTORS.map((sector) => sector.id).sort());
    expect(
      firms.every(
        (firm) =>
          firm.preliminaryAcceptance.confirmed &&
          firm.preliminaryAcceptance.channel.length > 0 &&
          Number.isFinite(
            new Date(firm.preliminaryAcceptance.recordedAt).getTime(),
          ),
      ),
    ).toBe(true);

    const founder = await provisionInvite(
      "founder.five-company-test@example.invalid",
      "Fondatore collaudo cinque ditte",
      true,
    );
    context.viewer = {
      userId: founder.userId,
      companyId: founder.companyId,
      admin: true,
      demo: false,
    };
    await setPilotPrerequisite({
      key: "data_residency",
      confirmed: true,
      note: "Residenza simulata come verificata nel collaudo isolato.",
      actorId: founder.userId,
    });
    await setPilotPrerequisite({
      key: "external_delivery",
      confirmed: true,
      note: "Recapito simulato come verificato nel collaudo isolato.",
      actorId: founder.userId,
    });

    const invalidInvite = await adminPost(
      inviteRequest({
        action: "invite",
        name: firms[0].name,
        email: firms[0].email,
        contactConsentConfirmed: false,
      }),
    );
    expect(invalidInvite.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();

    const created = [];
    for (const firm of firms) {
      const invitation = inviteSchema.parse({
        name: firm.name,
        email: firm.email,
      });
      const response = await adminPost(
        inviteRequest({
          action: "invite",
          ...invitation,
          contactConsentConfirmed: firm.preliminaryAcceptance.confirmed,
        }),
      );
      expect(response.status).toBe(200);
      const [row] = await db
        .select({
          userId: schema.user.id,
          companyId: schema.companies.id,
          inviteId: schema.invitations.id,
        })
        .from(schema.user)
        .innerJoin(
          schema.companies,
          eq(schema.companies.ownerId, schema.user.id),
        )
        .innerJoin(
          schema.invitations,
          eq(schema.invitations.companyId, schema.companies.id),
        )
        .where(eq(schema.user.email, firm.email));
      expect(row).toBeDefined();
      const accepted = await acceptPilotParticipation({
        userId: row.userId,
        termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
        participationConfirmed: true,
        emailProcessingConfirmed: true,
        now: new Date(),
      });
      expect(accepted).toMatchObject({
        termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
        alreadyAccepted: false,
      });
      created.push(row);
    }

    for (let index = 0; index < firms.length - 1; index++)
      await updateCompanyProfile(
        created[index].companyId,
        profileSchema.parse(firms[index].profile),
      );

    const incomplete = await adminSnapshot(false);
    expect(incomplete.pilot).toMatchObject({
      status: "preparing",
      readyToStart: false,
      participants: { active: 5, accepted: 5, onboarded: 4, target: 5 },
    });
    await expect(startPilot()).rejects.toMatchObject({ status: 400 });

    await updateCompanyProfile(
      created[4].companyId,
      profileSchema.parse(firms[4].profile),
    );
    const ready = await adminSnapshot(false);
    expect(ready.pilot).toMatchObject({
      status: "ready",
      readyToStart: true,
      participants: { active: 5, accepted: 5, onboarded: 5, target: 5 },
      onboarding: { measured: 5, withinLimit: 5, rate: 1 },
    });
    expect(ready.pilot.onboarding.medianMinutes).not.toBeNull();
    expect(ready.pilot.onboarding.medianMinutes!).toBeLessThanOrEqual(10);

    const startClock = new Date();
    const started = await startPilot(startClock);
    expect(started).toEqual({
      startedAt: startClock.toISOString(),
      endsAt: new Date(startClock.getTime() + 28 * 86_400_000).toISOString(),
    });

    const running = await adminSnapshot(false);
    expect(running.pilot).toMatchObject({
      status: "running",
      readyToStart: false,
      participants: { active: 5, accepted: 5, onboarded: 5, target: 5 },
      firstWeekReview: true,
    });
    expect(running.invites.filter((invite) => !invite.admin)).toHaveLength(5);
    expect(
      running.invites
        .filter((invite) => !invite.admin)
        .every(
          (invite) =>
            invite.acceptanceCurrent &&
            invite.onboardedAt &&
            invite.cohort &&
            invite.sectors.length > 0,
        ),
    ).toBe(true);

    const stored = await db
      .select({
        companyId: schema.companies.id,
        email: schema.user.email,
        profile: schema.companies.profile,
        onboardedAt: schema.companies.onboardedAt,
        acceptedAt: schema.invitations.acceptedAt,
        acceptedVersion: schema.invitations.acceptedVersion,
        pilotStartedAt: schema.pilotParticipants.startedAt,
      })
      .from(schema.companies)
      .innerJoin(schema.user, eq(schema.user.id, schema.companies.ownerId))
      .innerJoin(
        schema.invitations,
        eq(schema.invitations.companyId, schema.companies.id),
      )
      .innerJoin(
        schema.pilotParticipants,
        eq(schema.pilotParticipants.companyId, schema.companies.id),
      );
    expect(stored).toHaveLength(5);
    for (const firm of firms) {
      const row = stored.find((candidate) => candidate.email === firm.email);
      expect(row).toMatchObject({
        email: firm.email,
        profile: firm.profile,
        acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
      });
      expect(row?.acceptedAt).not.toBeNull();
      expect(row?.onboardedAt).not.toBeNull();
      expect(row?.pilotStartedAt?.toISOString()).toBe(startClock.toISOString());
    }

    await expect(
      provisionInvite("extra.firm@example.invalid", "TEST Ditta extra"),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.matches)).toHaveLength(0);
    expect(await db.select().from(schema.feedback)).toHaveLength(0);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
    expect(await db.select().from(schema.pilotFeedbackEvents)).toHaveLength(0);
    expect(sendMail).toHaveBeenCalledTimes(5);
    expect(
      vi
        .mocked(sendMail)
        .mock.calls.map(([message]) => message.to)
        .sort(),
    ).toEqual(firms.map((firm) => firm.email).sort());
  });
});

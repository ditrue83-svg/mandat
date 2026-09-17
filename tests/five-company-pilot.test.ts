import { BETA_PRIORITY_SECTORS } from "../src/lib/sectors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { CompanyProfile, Publication } from "../src/lib/domain";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  headers: new Headers(),
}));
vi.mock("@/db", () => ({
  getDb: () => context.db,
  closeDb: async () => {},
}));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value,
  sendMail: vi.fn(),
}));

import { adminSnapshot, provisionInvite } from "../src/lib/admin";
import { POST as adminPost } from "../src/app/api/admin/route";
import { POST as authPost } from "../src/app/api/auth/[...all]/route";
import { POST as acceptPost } from "../src/app/api/pilot/accept/route";
import { PUT as profilePut } from "../src/app/api/profile/route";
import { POST as bookmarkPost } from "../src/app/api/catalog/[id]/bookmark/route";
import { sendMail } from "../src/lib/mail";
import { setPilotPrerequisite } from "../src/lib/pilot-admin";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-consent";
import {
  currentViewer,
  requireViewer,
  viewerNeedsPilotAcceptance,
} from "../src/lib/viewer";
import { readCatalog, readCatalogEntry } from "../src/lib/catalog";
import { listOpportunities } from "../src/lib/queries";
import { readNotificationStatus } from "../src/lib/notification-status";
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

const origin = "http://localhost:3456";
function request(path: string, body: unknown, method = "POST") {
  const headers = new Headers(context.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", origin);
  return new Request(`${origin}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}
function inviteRequest(body: unknown) {
  return request("/api/admin", body);
}
async function login(email: string, ip: string, wrongCode = false) {
  context.headers = new Headers({ "x-real-ip": ip });
  const before = vi.mocked(sendMail).mock.calls.length;
  const sent = await authPost(
    request("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    }),
  );
  expect(sent.status, await sent.clone().text()).toBe(200);
  expect(sendMail).toHaveBeenCalledTimes(before + 1);
  const message = vi.mocked(sendMail).mock.calls.at(-1)![0];
  expect(message.to).toBe(email);
  const otp = message.text.match(/\b\d{6}\b/)![0];
  if (wrongCode) {
    const invalid = String((Number(otp) + 1) % 1_000_000).padStart(6, "0");
    expect(
      (
        await authPost(
          request("/api/auth/sign-in/email-otp", { email, otp: invalid }),
        )
      ).status,
    ).toBe(400);
    expect(await currentViewer()).toBeNull();
  }
  const signed = await authPost(
    request("/api/auth/sign-in/email-otp", { email, otp }),
  );
  expect(signed.status, await signed.clone().text()).toBe(200);
  expect(signed.headers.get("set-cookie")).toContain("HttpOnly");
  const cookies = signed.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  expect(cookies).toContain("session_token=");
  context.headers = new Headers({ cookie: cookies, "x-real-ip": ip });
  expect((await currentViewer())?.email).toBe(email);
  return new Headers(context.headers);
}

async function catalogFixtures() {
  const now = Date.now();
  for (const sector of SECTORS.filter((s) =>
    BETA_PRIORITY_SECTORS.includes(s.id),
  )) {
    const id = `test-five-${sector.id}`;
    const data: Publication = {
      id,
      externalId: id,
      canonicalKey: id,
      source: "simap",
      title: `TEST Bando inventato ${sector.label}`,
      buyer: "Ente fittizio del collaudo",
      location: "Lugano",
      canton: "TI",
      zone: "Luganese",
      publishedAt: new Date(now - 3_600_000).toISOString(),
      visibleAt: new Date(now - 3_600_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
      deadline: new Date(now + 7 * 86_400_000).toISOString(),
      valueChf: null,
      procedure: null,
      status: "open",
      sectors: [sector.id],
      cpv: [],
      sourceUrl: `https://source.example.invalid/${id}`,
      sourceUrls: [`https://source.example.invalid/${id}`],
      originalText: `Pubblicazione inventata per provare la ricerca nel settore ${sector.label}.`,
      summary: null,
      requirements: [],
      evidence: [],
      documents: [],
      reviewRequired: true,
      reviewReasons: ["Dato inventato non valutato"],
      revision: `${id}:v1`,
    };
    await db.insert(schema.publications).values({
      id,
      externalId: id,
      canonicalId: id,
      source: data.source,
      title: data.title,
      status: data.status,
      visibleAt: new Date(data.visibleAt),
      deadline: new Date(data.deadline!),
      revision: data.revision,
      data,
    });
  }
}

beforeAll(async () => {
  context.db = db;
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("APP_MODE", "live");
  // The DB module above is replaced by the in-memory database; this value only
  // enables the real auth/viewer guards. No provider or production secrets load.
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://test:test@localhost:1/isolated_test",
  );
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "test-only-five-company-secret-never-use-in-production",
  );
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
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
  it("attraversa OTP, consenso, profili, catalogo, salvataggi e coorte con cinque sessioni isolate", async () => {
    expect(
      [...new Set(firms.flatMap((firm) => firm.profile.sectors))].sort(),
    ).toEqual([...BETA_PRIORITY_SECTORS].sort());
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

    const anonymousProfile = await profilePut(
      request("/api/profile", firms[0].profile, "PUT"),
    );
    expect(anonymousProfile.status).toBe(401);
    const founder = await provisionInvite(
      "founder.five-company-test@example.invalid",
      "Fondatore collaudo cinque ditte",
      true,
    );
    const founderHeaders = await login(
      "founder.five-company-test@example.invalid",
      "192.0.2.10",
    );
    const founderProfile = (await requireViewer()).profile;
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
    expect(
      vi
        .mocked(sendMail)
        .mock.calls.filter(([message]) => message.subject.includes("invitata")),
    ).toHaveLength(0);

    const created = [];
    for (const [index, firm] of firms.entries()) {
      context.headers = founderHeaders;
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
      const firmHeaders = await login(
        firm.email,
        `192.0.2.${20 + index}`,
        index === 0,
      );
      expect(viewerNeedsPilotAcceptance((await currentViewer())!)).toBe(true);
      expect(
        (await profilePut(request("/api/profile", firm.profile, "PUT"))).status,
      ).toBe(403);
      const consent = {
        termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
        participationConfirmed: true,
        emailProcessingConfirmed: true,
      };
      expect(
        (
          await acceptPost(
            request("/api/pilot/accept", {
              ...consent,
              emailProcessingConfirmed: false,
            }),
          )
        ).status,
      ).toBe(400);
      expect(viewerNeedsPilotAcceptance((await currentViewer())!)).toBe(true);
      const acceptance = await acceptPost(
        request("/api/pilot/accept", consent),
      );
      expect(acceptance.status, await acceptance.clone().text()).toBe(200);
      expect(await acceptance.json()).toMatchObject({
        termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
        alreadyAccepted: false,
      });
      const viewer = await requireViewer();
      expect(viewer.companyId).toBe(row.companyId);
      expect(viewer.admin).toBe(false);
      expect(viewerNeedsPilotAcceptance(viewer)).toBe(false);
      expect(
        (await adminPost(inviteRequest({ action: "pilot-start" }))).status,
      ).toBe(403);
      expect(
        (
          await profilePut(
            request("/api/profile", { ...firm.profile, sectors: [] }, "PUT"),
          )
        ).status,
      ).toBe(400);
      created.push({ ...row, headers: firmHeaders });
    }

    for (let index = 0; index < firms.length - 1; index++) {
      context.headers = created[index].headers;
      const saved = await profilePut(
        request(
          "/api/profile",
          {
            ...profileSchema.parse(firms[index].profile),
            // A client-supplied company ID must not redirect the update.
            companyId: founder.companyId,
          },
          "PUT",
        ),
      );
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect((await requireViewer()).profile).toEqual(firms[index].profile);
    }

    context.headers = founderHeaders;
    expect((await requireViewer()).profile).toEqual(founderProfile);
    const incomplete = await adminSnapshot(false);
    expect(incomplete.pilot).toMatchObject({
      status: "preparing",
      readyToStart: false,
      participants: { active: 5, accepted: 5, onboarded: 4, target: 5 },
    });
    expect(
      (await adminPost(inviteRequest({ action: "pilot-start" }))).status,
    ).toBe(400);

    context.headers = created[4].headers;
    const fifthProfile = await profilePut(
      request("/api/profile", profileSchema.parse(firms[4].profile), "PUT"),
    );
    expect(fifthProfile.status, await fifthProfile.clone().text()).toBe(200);
    context.headers = founderHeaders;
    const ready = await adminSnapshot(false);
    expect(ready.pilot).toMatchObject({
      status: "ready",
      readyToStart: true,
      participants: { active: 5, accepted: 5, onboarded: 5, target: 5 },
      onboarding: { measured: 5, withinLimit: 5, rate: 1 },
    });
    expect(ready.pilot.onboarding.medianMinutes).not.toBeNull();
    expect(ready.pilot.onboarding.medianMinutes!).toBeLessThanOrEqual(10);

    // This verifies automatic timestamp recording, not human completion time.
    const started = await adminPost(inviteRequest({ action: "pilot-start" }));
    expect(started.status, await started.clone().text()).toBe(200);

    const running = await adminSnapshot(false);
    const startClock = new Date(running.pilot.startedAt!);
    expect(running.pilot.endsAt).toBe(
      new Date(startClock.getTime() + 28 * 86_400_000).toISOString(),
    );
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

    expect(
      (
        await adminPost(
          inviteRequest({
            action: "invite",
            email: "extra.firm@example.invalid",
            name: "TEST Ditta extra",
            contactConsentConfirmed: true,
          }),
        )
      ).status,
    ).toBe(409);

    await catalogFixtures();
    for (const [index, firm] of firms.entries()) {
      context.headers = created[index].headers;
      const viewer = await requireViewer();
      expect(viewer.profile).toEqual(firm.profile);
      const catalog = await readCatalog(viewer);
      expect(catalog.total).toBe(8);
      expect(catalog.foglioAvailable).toBe(false);
      const selected = await readCatalog(viewer, {
        settore: firm.profile.sectors[0],
        q: "inventato",
      });
      expect(selected.total).toBe(1);
      const id = selected.items[0].id;
      expect((await readCatalogEntry(viewer, id))?.saved).toBe(false);
      expect(await listOpportunities(viewer)).toEqual([]);
      expect(
        await listOpportunities(viewer, { includeInactive: true }),
      ).toEqual([]);
      const bookmark = await bookmarkPost(
        request(`/api/catalog/${id}/bookmark`, { saved: true }),
        { params: Promise.resolve({ id }) },
      );
      expect(bookmark.status, await bookmark.clone().text()).toBe(200);
      expect(
        await listOpportunities(viewer, { includeInactive: true }),
      ).toMatchObject([
        {
          id,
          saved: true,
          catalogOnly: true,
          assessment: "unreviewed",
          feedback: null,
        },
      ]);
      expect(await listOpportunities(viewer)).toEqual([]);
      expect((await readCatalogEntry(viewer, id))?.saved).toBe(true);
      expect(await readNotificationStatus(viewer)).toEqual({
        mode: "manual",
        recent: [],
      });
      // A payload cannot select another tenant, even if its ID is known.
      const attemptedOverride = await bookmarkPost(
        request(`/api/catalog/${id}/bookmark`, {
          saved: false,
          companyId: created[(index + 1) % firms.length].companyId,
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(attemptedOverride.status).toBe(400);
    }

    for (const [index, firm] of firms.entries()) {
      context.headers = created[index].headers;
      const viewer = await requireViewer();
      const id = `test-five-${firm.profile.sectors[0]}`;
      const saved = await listOpportunities(viewer, { includeInactive: true });
      expect(saved.map((item) => item.id)).toEqual([id]);
      expect(
        (await readCatalog(viewer)).items
          .filter((item) => item.saved)
          .map((item) => item.id),
      ).toEqual([id]);
      expect(
        (
          await bookmarkPost(
            request(`/api/catalog/${id}/bookmark`, { saved: false }),
            { params: Promise.resolve({ id }) },
          )
        ).status,
      ).toBe(200);
      expect(
        await listOpportunities(viewer, { includeInactive: true }),
      ).toEqual([]);
      const signedOut = await authPost(request("/api/auth/sign-out", {}));
      expect(signedOut.status, await signedOut.clone().text()).toBe(200);
      // The old cookie is still present here: it must no longer authenticate.
      expect(await currentViewer()).toBeNull();
      expect(
        (await profilePut(request("/api/profile", firm.profile, "PUT"))).status,
      ).toBe(401);
    }
    context.headers = founderHeaders;
    expect((await requireViewer()).profile).toEqual(founderProfile);
    expect(await db.select().from(schema.matches)).toHaveLength(0);
    const bookmarkRows = await db.select().from(schema.feedback);
    expect(bookmarkRows).toHaveLength(5);
    expect(
      bookmarkRows.every((row) => !row.saved && row.relevant === null),
    ).toBe(true);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
    expect(await db.select().from(schema.pilotFeedbackEvents)).toHaveLength(0);
    expect(sendMail).toHaveBeenCalledTimes(11);
    expect(
      vi
        .mocked(sendMail)
        .mock.calls.filter(([message]) => message.subject.includes("invitata"))
        .map(([message]) => message.to)
        .sort(),
    ).toEqual(firms.map((firm) => firm.email).sort());
    expect(
      (await db.select().from(schema.session)).map((session) => session.userId),
    ).toEqual([founder.userId]);
  });
});

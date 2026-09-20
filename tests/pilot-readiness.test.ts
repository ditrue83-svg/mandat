import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value,
  sendMail: vi.fn(),
}));

import { adminSnapshot } from "../src/lib/admin";
import { demoProfile } from "../src/lib/demo";
import {
  readPilotStartedAt,
  setPilotPrerequisite,
  startPilot,
} from "../src/lib/pilot-admin";
import { createPilotPrerequisite, summarizePilot } from "../src/lib/pilot";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
import { sendMail } from "../src/lib/mail";

const acceptedAt = new Date("2026-09-20T08:00:00.000Z");
const onboardedAt = new Date("2026-09-20T08:08:00.000Z");
const startAt = new Date("2026-09-20T09:00:00.000Z");

function readyInput(): Parameters<typeof summarizePilot>[0] {
  return {
    now: startAt,
    startedAt: null,
    criticalIssues: 0,
    automationEnabled: false,
    participants: Array.from({ length: 5 }, (_, index) => ({
      companyId: `readiness-company-${index}`,
      admin: false,
      cohort: false,
      acceptedAt,
      acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
      onboardedAt,
      revokedAt: null,
      disabledAt: null,
    })),
    feedback: [],
    deliveries: [],
    audits: [],
    continuation: [],
    prerequisites: {
      data_residency: createPilotPrerequisite(
        "data_residency",
        true,
        "Residenza verificata nel collaudo isolato.",
        "readiness-admin",
        acceptedAt,
      ),
      external_delivery: createPilotPrerequisite(
        "external_delivery",
        true,
        "Recapito verificato nel collaudo isolato.",
        "readiness-admin",
        acceptedAt,
      ),
    },
  };
}

describe("riepilogo dei requisiti di avvio", () => {
  it("mostra pronto solo con cinque consensi correnti e nessun ostacolo operativo", () => {
    expect(summarizePilot(readyInput())).toMatchObject({
      status: "ready",
      readyToStart: true,
      startBlockers: [],
      participants: { accepted: 5, onboarded: 5 },
    });
  });

  it("non presenta un consenso precedente come adesione corrente", () => {
    const input = readyInput();
    input.participants[0].acceptedVersion = "legacy-acceptance-v1";
    const summary = summarizePilot(input);
    expect(summary).toMatchObject({
      status: "preparing",
      readyToStart: false,
      participants: { active: 5, accepted: 4, onboarded: 5 },
    });
    expect(summary.startBlockers.join(" ")).toContain("informativa corrente");
  });

  it.each([
    { criticalIssues: 1, automationEnabled: false, reason: "problemi critici" },
    {
      criticalIssues: 0,
      automationEnabled: true,
      reason: "Disattiva l’automazione",
    },
  ])(
    "spiega l’impedimento $reason",
    ({ criticalIssues, automationEnabled, reason }) => {
      const summary = summarizePilot({
        ...readyInput(),
        criticalIssues,
        automationEnabled,
      });
      expect(summary.status).toBe("preparing");
      expect(summary.readyToStart).toBe(false);
      expect(summary.startBlockers.join(" ")).toContain(reason);
    },
  );

  it("non riscrive le adesioni storiche o riapre l’avvio di una coorte iniziata", () => {
    const input = readyInput();
    input.startedAt = startAt;
    input.participants = input.participants.map((participant) => ({
      ...participant,
      cohort: true,
      acceptedVersion: "legacy-acceptance-v1",
    }));
    expect(summarizePilot(input)).toMatchObject({
      status: "running",
      readyToStart: false,
      startBlockers: [],
      participants: { accepted: 5 },
      onboarding: { measured: 5, medianMinutes: 8 },
    });
  });
});

describe("avvio e riepilogo con dati persistiti isolati", () => {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });

  beforeAll(async () => {
    context.db = db;
    await migrate(db, { migrationsFolder: "drizzle" });
  });
  afterAll(async () => pg.close());
  beforeEach(async () => {
    await db.delete(schema.pilotParticipants);
    await db.delete(schema.settings);
    await db.delete(schema.invitations);
    await db.delete(schema.companies);
    await db.delete(schema.user);
    await db.delete(schema.issues);
  });

  async function prepareCohort(
    firstVersion = PILOT_PARTICIPATION_TERMS_VERSION as string,
  ) {
    const firms = readyInput().participants;
    await db.insert(schema.user).values(
      firms.map((firm, index) => ({
        id: `readiness-user-${index}`,
        name: `Ditta inventata ${index}`,
        email: `readiness-${index}@example.invalid`,
      })),
    );
    await db.insert(schema.companies).values(
      firms.map((firm, index) => ({
        id: firm.companyId,
        ownerId: `readiness-user-${index}`,
        profile: demoProfile,
        onboardedAt,
      })),
    );
    await db.insert(schema.invitations).values(
      firms.map((firm, index) => ({
        id: `readiness-invitation-${index}`,
        companyId: firm.companyId,
        email: `readiness-${index}@example.invalid`,
        acceptedAt,
        acceptedVersion:
          index === 0 ? firstVersion : PILOT_PARTICIPATION_TERMS_VERSION,
        expiresAt: new Date("2026-10-01T08:00:00.000Z"),
      })),
    );
    for (const key of ["data_residency", "external_delivery"] as const) {
      await setPilotPrerequisite({
        key,
        confirmed: true,
        note: "Prerequisito verificato nel collaudo isolato.",
        actorId: "readiness-admin",
        now: acceptedAt,
      });
    }
  }

  it("UI e comando rifiutano lo stesso invito con consenso precedente", async () => {
    await prepareCohort("legacy-acceptance-v1");
    const snapshot = await adminSnapshot(false);
    expect(snapshot.pilot.readyToStart).toBe(false);
    expect(snapshot.pilot.participants.accepted).toBe(4);
    expect(snapshot.pilot.startBlockers.join(" ")).toContain(
      "informativa corrente",
    );
    await expect(startPilot(startAt)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("informativa corrente"),
    });
    expect(await readPilotStartedAt()).toBeNull();
    expect(await db.select().from(schema.pilotParticipants)).toHaveLength(0);
  });

  it.each([
    { critical: true, automatic: false, reason: "problemi critici" },
    { critical: false, automatic: true, reason: "Disattiva l’automazione" },
    { critical: true, automatic: true, reason: "revisione manuale" },
  ])(
    "rifiuta senza mutazioni criticità=$critical, automazione=$automatic",
    async ({ critical, automatic, reason }) => {
      await prepareCohort();
      if (critical)
        await db.insert(schema.issues).values({
          id: "readiness-critical",
          key: "readiness-critical",
          severity: "critical",
          title: "Errore critico inventato",
          detail:
            "Un problema critico ancora aperto nel solo database di test.",
        });
      await db
        .insert(schema.settings)
        .values({ key: "automation_enabled", value: automatic });
      const snapshot = await adminSnapshot(false);
      expect(snapshot.pilot.readyToStart).toBe(false);
      expect(snapshot.pilot.startBlockers.join(" ")).toContain(reason);
      await expect(startPilot(startAt)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(reason),
      });
      expect(await readPilotStartedAt()).toBeNull();
      expect(await db.select().from(schema.pilotParticipants)).toHaveLength(0);
      const [setting] = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "automation_enabled"));
      expect(setting.value).toBe(automatic);
      expect(
        (await db.select().from(schema.issues)).every(
          (issue) => issue.resolvedAt === null,
        ),
      ).toBe(true);
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it("consente l’avvio con criticità risolte, avvisi non critici e automazione assente", async () => {
    await prepareCohort();
    await db.insert(schema.issues).values([
      {
        id: "readiness-resolved",
        key: "readiness-resolved",
        severity: "critical",
        title: "Problema risolto",
        detail: "Criticità risolta prima dell’avvio nel collaudo.",
        resolvedAt: onboardedAt,
      },
      {
        id: "readiness-warning",
        key: "readiness-warning",
        severity: "warning",
        title: "Avviso non critico",
        detail: "L’avviso non richiede una nuova barriera di avvio.",
      },
    ]);
    expect((await adminSnapshot(false)).pilot.readyToStart).toBe(true);
    await expect(startPilot(startAt)).resolves.toEqual({
      startedAt: startAt.toISOString(),
      endsAt: "2026-10-18T09:00:00.000Z",
    });
    expect(await db.select().from(schema.pilotParticipants)).toHaveLength(5);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

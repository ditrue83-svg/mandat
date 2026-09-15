import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({
  getDb: () => context.db,
  closeDb: async () => {},
}));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value,
  sendMail: vi.fn(),
}));

import { provisionInvite } from "../src/lib/admin";
import { demoProfile } from "../src/lib/demo";
import {
  readPilotStartedAt,
  setPilotPrerequisite,
  startPilot,
} from "../src/lib/pilot-admin";
import {
  acceptPilotParticipation,
  PILOT_PARTICIPATION_TERMS_VERSION,
} from "../src/lib/pilot-consent";

const pg = new PGlite();
const db = drizzle(pg, { schema });

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => pg.close());

describe("avvio atomico della coorte pilota", () => {
  it("non può avviare cinque ditte e creare contemporaneamente un sesto invito", async () => {
    const founder = await provisionInvite(
      "atomic-founder@example.invalid",
      "Fondatore atomico",
      true,
    );
    const firms = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        provisionInvite(
          `atomic-${index + 1}@example.invalid`,
          `Ditta atomica ${index + 1}`,
        ),
      ),
    );
    await setPilotPrerequisite({
      key: "data_residency",
      confirmed: true,
      note: "Residenza verificata per il collaudo atomico.",
      actorId: founder.userId,
    });
    await setPilotPrerequisite({
      key: "external_delivery",
      confirmed: true,
      note: "Recapito verificato per il collaudo atomico.",
      actorId: founder.userId,
    });
    for (const firm of firms) {
      await acceptPilotParticipation({
        userId: firm.userId,
        termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
        participationConfirmed: true,
        emailProcessingConfirmed: true,
      });
      await db
        .update(schema.companies)
        .set({ profile: demoProfile, onboardedAt: new Date() })
        .where(eq(schema.companies.id, firm.companyId));
    }

    const [start, extraInvite] = await Promise.allSettled([
      startPilot(new Date("2026-09-15T18:00:00.000Z")),
      provisionInvite("atomic-extra@example.invalid", "Ditta atomica extra"),
    ]);
    const startedAt = await readPilotStartedAt();
    const participants = await db.select().from(schema.pilotParticipants);
    const companies = await db.select().from(schema.companies);

    expect(
      start.status === "fulfilled" && extraInvite.status === "fulfilled",
    ).toBe(false);
    if (startedAt) {
      expect(start.status).toBe("fulfilled");
      expect(extraInvite.status).toBe("rejected");
      expect(participants).toHaveLength(5);
      expect(companies).toHaveLength(6);
    } else {
      expect(start.status).toBe("rejected");
      expect(extraInvite.status).toBe("fulfilled");
      expect(participants).toHaveLength(0);
      expect(companies).toHaveLength(7);
    }
  });
});

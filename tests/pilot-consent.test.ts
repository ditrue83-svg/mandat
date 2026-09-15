import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

import { notifyInvitation, provisionInvite } from "../src/lib/admin";
import { sendMail } from "../src/lib/mail";
import {
  acceptPilotParticipation,
  PILOT_PARTICIPATION_TERMS_VERSION,
} from "../src/lib/pilot-consent";
import { viewerNeedsPilotAcceptance } from "../src/lib/viewer";
import { PilotAcceptanceForm } from "../src/components/pilot-acceptance-form";

const pg = new PGlite();
const db = drizzle(pg, { schema });

beforeAll(async () => {
  context.db = db;
  vi.stubEnv("APP_URL", "https://mandat.example.invalid");
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

describe("accettazione esplicita del pilota", () => {
  it("registra una sola volta data e versione correnti", async () => {
    const invitation = await provisionInvite(
      "consent@example.invalid",
      "Ditta consenso",
    );
    const first = await acceptPilotParticipation({
      userId: invitation.userId,
      termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
      participationConfirmed: true,
      emailProcessingConfirmed: true,
      now: new Date("2026-09-15T16:00:00.000Z"),
    });
    expect(first).toEqual({
      acceptedAt: "2026-09-15T16:00:00.000Z",
      termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
      alreadyAccepted: false,
    });
    const second = await acceptPilotParticipation({
      userId: invitation.userId,
      termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
      participationConfirmed: true,
      emailProcessingConfirmed: true,
      now: new Date("2026-09-15T16:05:00.000Z"),
    });
    expect(second).toEqual({ ...first, alreadyAccepted: true });
    await expect(
      db
        .update(schema.invitations)
        .set({ acceptedVersion: "rewritten-version" })
        .where(eq(schema.invitations.id, invitation.inviteId)),
    ).rejects.toThrow();
    const [stored] = await db
      .select({ acceptedVersion: schema.invitations.acceptedVersion })
      .from(schema.invitations)
      .where(eq(schema.invitations.id, invitation.inviteId));
    expect(stored.acceptedVersion).toBe(PILOT_PARTICIPATION_TERMS_VERSION);
  });

  it("rifiuta un invito scaduto senza registrare l’adesione", async () => {
    const invitation = await provisionInvite(
      "expired-consent@example.invalid",
      "Ditta scaduta",
    );
    await db
      .update(schema.invitations)
      .set({ expiresAt: new Date("2026-09-14T00:00:00.000Z") })
      .where(eq(schema.invitations.id, invitation.inviteId));
    await expect(
      acceptPilotParticipation({
        userId: invitation.userId,
        termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
        participationConfirmed: true,
        emailProcessingConfirmed: true,
        now: new Date("2026-09-15T16:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 410 });
    const [stored] = await db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, invitation.inviteId));
    expect(stored.acceptedAt).toBeNull();
    expect(stored.acceptedVersion).toBeNull();
  });

  it("distingue inviti pendenti, account fondatore e demo", () => {
    expect(
      viewerNeedsPilotAcceptance({
        demo: false,
        admin: false,
        invitationAcceptedAt: null,
        invitationAcceptanceVersion: null,
      }),
    ).toBe(true);
    expect(
      viewerNeedsPilotAcceptance({
        demo: false,
        admin: true,
        invitationAcceptedAt: null,
        invitationAcceptanceVersion: null,
      }),
    ).toBe(false);
    expect(
      viewerNeedsPilotAcceptance({
        demo: true,
        admin: false,
        invitationAcceptedAt: null,
        invitationAcceptanceVersion: null,
      }),
    ).toBe(false);
    expect(
      viewerNeedsPilotAcceptance({
        demo: false,
        admin: false,
        invitationAcceptedAt: "2026-09-15T16:00:00.000Z",
        invitationAcceptanceVersion: "legacy-acceptance-v1",
      }),
    ).toBe(true);
    expect(
      viewerNeedsPilotAcceptance({
        demo: false,
        admin: false,
        invitationAcceptedAt: "2026-09-15T16:00:00.000Z",
        invitationAcceptanceVersion: PILOT_PARTICIPATION_TERMS_VERSION,
      }),
    ).toBe(false);
  });

  it("presenta separatamente partecipazione e trattamento email", () => {
    const html = renderToStaticMarkup(
      createElement(PilotAcceptanceForm, {
        email: "titolare@example.invalid",
      }),
    );
    expect(html).toContain("Conferma la partecipazione");
    expect(html).toContain("pilota di quattro settimane");
    expect(html).toContain("Aruba in Italia");
    expect(html).toContain("Database, applicazione, log e backup operativi");
    expect(html).toContain("Accetta e configura la mia ditta");
    expect(html.match(/type=\"checkbox\"/g) ?? []).toHaveLength(2);
  });

  it("anticipa nell’invito durata, informativa email e limite del Radar", async () => {
    vi.mocked(sendMail).mockClear();
    await notifyInvitation("invited-copy@example.invalid", "Ditta informata");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0][0]).toMatchObject({
      to: "invited-copy@example.invalid",
      subject: "La tua ditta è invitata a provare Mandat",
    });
    const message = vi.mocked(sendMail).mock.calls[0][0];
    expect(message.text).toContain("quattro settimane");
    expect(message.text).toContain("Aruba in Italia");
    expect(message.text).toContain(
      "pubblicazione ufficiale resta determinante",
    );
  });
});

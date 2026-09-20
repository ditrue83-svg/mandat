import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import type { Publication, SourceScopeReview } from "../src/lib/domain";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
import { fingerprint } from "../src/sources/common";
import {
  MANUAL_REVIEW_WINDOW,
  manualReviewProfileRevision,
} from "../src/lib/manual-review-window";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (text: string) => text.replace(/</g, "&lt;"),
  sendMail: vi.fn(async (message: { to: string }) => ({
    accepted: [message.to],
    messageId: "local-source-scope-test",
  })),
}));
import { sendMail } from "../src/lib/mail";
import { queueDigests, sendPending } from "../src/worker/notifications";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const now = new Date("2030-01-01T10:00:00Z");
const profile = { ...demoProfile, emailEnabled: true };
let profileRevision: string;
const publication: Publication = {
  ...getDemoOpportunities()[1],
  id: "local-scope-mail-publication",
  externalId: "local-scope-mail-publication",
  canonicalKey: "local-scope-mail-publication",
  source: "simap",
  title: "Pulizia di locali — fixture sintetica",
  status: "open",
  visibleAt: "2020-01-01T00:00:00Z",
  deadline: "2035-01-01T10:00:00Z",
  revision: "local-content-v1",
  summary: "Riassunto sintetico per il solo test delle notifiche.",
  reviewRequired: false,
  reviewReasons: [],
};
const matchRevision = (token?: string) =>
  `${publication.revision}:${profileRevision}:ready:local-model:true${token ? `:source-scope:${token}` : ""}`;
const required: SourceScopeReview = {
  status: "required",
  kind: "conflicting",
  token: "fb562597-ed21-4106-bbef-0816c64b0c65",
  sourceRevision: "local-source-v1",
  updatedAt: "2030-01-01T09:00:00Z",
};
const resolved: SourceScopeReview = {
  ...required,
  status: "resolved",
  token: "e53bfe86-fd4b-402a-8649-fc9f6d3aab52",
  updatedAt: "2030-01-01T09:30:00Z",
};

async function setScope(scope: SourceScopeReview) {
  await db
    .update(schema.publications)
    .set({
      data: { ...publication, sourceScopeReview: scope },
      updatedAt: now,
    })
    .where(eq(schema.publications.id, publication.id));
}
async function manualApproval() {
  await db
    .update(schema.matches)
    .set({ approved: true, reviewedAt: now })
    .where(eq(schema.matches.id, "local-scope-mail-match"));
}
async function insertPending(kind: "digest" | "change" = "digest") {
  const id = `local-pending-${kind}`;
  await db.insert(schema.notifications).values({
    id,
    companyId: "local-scope-mail-company",
    dedupeKey: id,
    kind,
    subject: "Notifica sintetica",
    html: "Contenuto sintetico",
    textBody: "Contenuto sintetico",
    items: [{ id: publication.id, revision: publication.revision }],
  });
  return id;
}
const notificationRows = () => db.select().from(schema.notifications);
async function replaceInvitationVersion(version: string) {
  const [invitation] = await db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.companyId, "local-scope-mail-company"));
  await db
    .delete(schema.invitations)
    .where(eq(schema.invitations.id, invitation.id));
  await db
    .insert(schema.invitations)
    .values({ ...invitation, acceptedVersion: version });
}

beforeAll(async () => {
  context.db = db;
  vi.stubEnv("APP_MODE", "live");
  vi.stubEnv("APP_URL", "http://localhost:3456");
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values({
    id: "local-scope-mail-owner",
    name: "Fixture",
    email: "fixture@example.invalid",
  });
  await db.insert(schema.companies).values({
    id: "local-scope-mail-company",
    ownerId: "local-scope-mail-owner",
    profile,
    onboardedAt: now,
  });
  // The worker hashes the profile read from JSONB, whose key order can differ.
  const [storedCompany] = await db.select().from(schema.companies);
  profileRevision = fingerprint(storedCompany.profile);
  await db.insert(schema.invitations).values({
    id: "local-scope-mail-invite",
    email: "fixture@example.invalid",
    companyId: "local-scope-mail-company",
    expiresAt: new Date("2035-01-01"),
    acceptedAt: now,
    acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
  });
}, 20000);

beforeEach(async () => {
  vi.clearAllMocks();
  context.db = db;
  await replaceInvitationVersion(PILOT_PARTICIPATION_TERMS_VERSION);
  await db.delete(schema.notifications);
  await db.delete(schema.issues);
  await db.delete(schema.matches);
  await db.delete(schema.publicationVersions);
  await db.delete(schema.publications);
  await db.delete(schema.sourceRuns);
  await db.delete(schema.settings);
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: true });
  await db.insert(schema.sourceRuns).values({
    id: "local-scope-mail-source-run",
    source: "simap",
    status: "success",
    startedAt: now,
    finishedAt: now,
  });
  await db.insert(schema.publications).values({
    id: publication.id,
    canonicalId: publication.id,
    source: "simap",
    externalId: publication.externalId,
    title: publication.title,
    status: "open",
    visibleAt: new Date(publication.visibleAt),
    deadline: new Date(publication.deadline!),
    data: publication,
    revision: "local-source-v1",
    aiRevision: publication.revision,
  });
  await db.insert(schema.matches).values({
    id: "local-scope-mail-match",
    companyId: "local-scope-mail-company",
    publicationId: publication.id,
    revision: matchRevision(),
    score: 90,
    reason: "Motivazione sintetica precedente alla verifica della fonte.",
    eligible: true,
    approved: null,
    reviewedAt: null,
    reviewNotes: null,
  });
});

afterAll(async () => {
  await pg.close();
  vi.unstubAllEnvs();
});

it("non prepara né invia email legacy quando il consenso non è più corrente", async () => {
  await replaceInvitationVersion("pilot-participation-previous");
  await queueDigests(now);
  expect(await notificationRows()).toHaveLength(0);

  await insertPending();
  await sendPending();
  expect(sendMail).not.toHaveBeenCalled();
  expect((await notificationRows())[0]).toMatchObject({
    status: "cancelled",
    error: expect.stringContaining("consenso"),
  });
});
it.each(["own", "other", "too-early"])(
  "la validazione del fondatore limita davvero la selezione automatica: %s",
  async (scope) => {
    await db.insert(schema.settings).values({
      key: MANUAL_REVIEW_WINDOW,
      value: {
        version: "manual-review-window-v1",
        id: crypto.randomUUID(),
        companyId:
          scope === "other" ? "another-company" : "local-scope-mail-company",
        actorId: "founder",
        startedAt: new Date(
          now.getTime() - (scope === "too-early" ? 6 : 7) * 86400000,
        ).toISOString(),
        profileRevision: manualReviewProfileRevision(profile),
        realActivityConfirmed: true,
      },
    });
    await queueDigests(now);
    expect(await notificationRows()).toHaveLength(scope === "own" ? 1 : 0);
    expect(sendMail).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "required blocca la selezione digest con reviewRequired=false e approvazione manuale=%s",
  async (manual) => {
    if (manual) await manualApproval();
    await setScope(required);
    await queueDigests(now);
    expect(await notificationRows()).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "required blocca un digest già pending anche con approvazione manuale=%s",
  async (manual) => {
    if (manual) await manualApproval();
    await insertPending();
    await setScope(required);
    await sendPending();
    expect(sendMail).not.toHaveBeenCalled();
    const [notification] = await notificationRows();
    expect(notification.attempts).toBe(0);
    expect(["pending", "cancelled"]).toContain(notification.status);
  },
);

it("dopo mark e resolve non invia il payload vecchio neppure con una nuova valutazione pronta", async () => {
  await queueDigests(now);
  const [original] = await notificationRows();
  expect(original.items[0].sourceScopeToken).toBeUndefined();
  expect(original.textBody).toContain("precedente alla verifica");
  await setScope(required);
  await setScope(resolved);
  // A newly completed assessment is represented directly; no classifier runs.
  await db
    .update(schema.matches)
    .set({
      revision: matchRevision(resolved.token),
      reason: "Nuova motivazione sintetica successiva alla verifica.",
    })
    .where(eq(schema.matches.id, "local-scope-mail-match"));

  await sendPending();
  expect(sendMail).not.toHaveBeenCalled();
  const [cancelled] = await notificationRows();
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.attempts).toBe(0);
  expect(cancelled.textBody).toBe(original.textBody);

  await queueDigests(now);
  const [fresh] = await notificationRows();
  expect(fresh.id).toBe(original.id);
  expect(fresh.status).toBe("pending");
  expect(fresh.items[0].sourceScopeToken).toBe(resolved.token);
  expect(fresh.textBody).toContain("successiva alla verifica");
  expect(fresh.textBody).not.toContain("precedente alla verifica");
  await sendPending();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(vi.mocked(sendMail).mock.calls[0][0].text).toBe(fresh.textBody);
  expect((await notificationRows())[0].status).toBe("sent");
});

it("resolved non seleziona una vecchia cache automatica con token precedente", async () => {
  await setScope(resolved);
  await queueDigests(now);
  expect(await notificationRows()).toHaveLength(0);
  expect(sendMail).not.toHaveBeenCalled();
});

it("un digest legacy senza token continua a funzionare per una fonte senza flag", async () => {
  await insertPending();
  await sendPending();
  expect(sendMail).toHaveBeenCalledTimes(1);
  const [notification] = await notificationRows();
  expect(notification.status).toBe("sent");
  expect(notification.attempts).toBe(1);
  expect(notification.items[0].sourceScopeToken).toBeUndefined();
});

it("required blocca un avviso di modifica pending anche senza il vecchio flag generico", async () => {
  await insertPending("change");
  await setScope(required);
  await sendPending();
  expect(sendMail).not.toHaveBeenCalled();
  const [notification] = await notificationRows();
  expect(notification.status).toBe("pending");
  expect(notification.attempts).toBe(0);
});

it("rilegge required sotto lock se il mark arriva dopo i controlli preliminari e prima del claim", async () => {
  await insertPending();
  let injected = false;
  context.db = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return async (...args: Parameters<typeof db.transaction>) => {
          if (!injected) {
            injected = true;
            await setScope(required);
          }
          return db.transaction(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await sendPending();
  } finally {
    context.db = db;
  }
  expect(injected).toBe(true);
  expect(sendMail).not.toHaveBeenCalled();
  const [notification] = await notificationRows();
  expect(notification.status).toBe("pending");
  expect(notification.attempts).toBe(0);
});

it("non invia se il rifiuto manuale arriva dopo i controlli preliminari e prima del claim", async () => {
  await setScope(resolved);
  await db
    .update(schema.matches)
    .set({ revision: matchRevision(resolved.token) })
    .where(eq(schema.matches.id, "local-scope-mail-match"));
  await queueDigests(now);
  let injected = false;
  context.db = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return async (...args: Parameters<typeof db.transaction>) => {
          if (!injected) {
            injected = true;
            await db
              .update(schema.matches)
              .set({
                approved: false,
                eligible: false,
                reviewedAt: now,
              })
              .where(eq(schema.matches.id, "local-scope-mail-match"));
          }
          return db.transaction(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await sendPending();
  } finally {
    context.db = db;
  }
  expect(injected).toBe(true);
  const [rejected] = await db.select().from(schema.matches);
  expect(rejected.approved).toBe(false);
  expect(rejected.eligible).toBe(false);
  expect(sendMail).not.toHaveBeenCalled();
  const [notification] = await notificationRows();
  expect(notification.attempts).toBe(0);
  expect(notification.status).not.toBe("sent");
});

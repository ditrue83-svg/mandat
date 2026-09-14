import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import type { Publication, Viewer } from "../src/lib/domain";
import { fingerprint } from "../src/sources/common";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  viewer: undefined as unknown,
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/viewer", () => ({
  requireViewer: vi.fn(async () => context.viewer),
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/worker/ai", async (original) => ({
  ...(await original<typeof import("../src/worker/ai")>()),
  summarize: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (text: string) => text.replace(/</g, "&lt;"),
  sendMail: vi.fn(async (message: { to: string }) => ({
    accepted: [message.to],
    messageId: "cpv-local-test",
  })),
}));
import { classify, summarize } from "../src/worker/ai";
import { sendMail } from "../src/lib/mail";
import { enrichAndMatch } from "../src/worker/pipeline";
import { queueDigests, sendPending } from "../src/worker/notifications";
import { listOpportunities, getRadarStatus } from "../src/lib/queries";
import { POST as adminPost } from "../src/app/api/admin/route";
import { matchReviewToken } from "../src/lib/match-review-token";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const now = new Date("2030-01-01T10:00:00Z");
const url = "https://example.invalid/cpv-pipeline";
const profile = {
  ...demoProfile,
  sectors: ["pulizie"] as ["pulizie"],
  keywords: [],
  exclusions: [],
  zones: ["Tutto il Ticino"],
  minValue: null,
  maxValue: null,
  emailEnabled: true,
};
const publication: Publication = {
  ...getDemoOpportunities(now)[0],
  id: "cpv-pipeline",
  externalId: "cpv-pipeline",
  canonicalKey: "cpv-pipeline",
  source: "simap",
  title: "Prestazioni secondo capitolato",
  originalText: "Prestazioni descritte negli allegati.",
  originalTitles: [],
  originalDescriptions: [
    { text: "Services de nettoyage de bâtiments.", language: "fr", url },
  ],
  documentPages: [],
  documents: [],
  sourceUrl: url,
  sourceUrls: [url],
  sectors: [],
  cpv: [],
  canton: "TI",
  zone: "Luganese",
  valueChf: null,
  visibleAt: "2020-01-01T00:00:00Z",
  deadline: "2035-01-01T10:00:00Z",
  status: "open",
  revision: "cpv-content-v1",
  summary: "Sintesi di prova già disponibile.",
  reviewRequired: false,
  reviewReasons: [],
};
let profileRevision: string;
let viewer: Viewer;
const baseRevision = () =>
  `${publication.revision}:${profileRevision}:ready:test-model:true`;
const rows = () => db.select().from(schema.matches);
const mailRows = () => db.select().from(schema.notifications);
const run = () => enrichAndMatch({ publicationId: publication.id, now });
async function reviewCommand() {
  const [match] = await rows();
  const [p] = await db.select().from(schema.publications);
  const [firm] = await db.select().from(schema.companies);
  return {
    action: "review",
    id: match.id,
    approved: true,
    expectedEvaluationRevision: match.revision,
    expectedEvaluationToken: matchReviewToken(match),
    expectedContentRevision: p.data.revision,
    expectedProfileRevision: fingerprint(firm.profile),
    expectedSourceReviewDependency: null,
  };
}
async function review(body: unknown) {
  return adminPost(
    new Request("http://localhost:3456/api/admin", {
      method: "POST",
      headers: {
        origin: "http://localhost:3456",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}
async function amend(changes: Partial<Publication>) {
  const [p] = await db.select().from(schema.publications);
  await db
    .update(schema.publications)
    .set({ data: { ...p.data, ...changes }, updatedAt: new Date() })
    .where(eq(schema.publications.id, publication.id));
}
async function insertMatch(
  changes: Partial<typeof schema.matches.$inferInsert> = {},
) {
  await db.insert(schema.matches).values({
    id: "cpv-match",
    companyId: "cpv-firm",
    publicationId: publication.id,
    revision: baseRevision(),
    eligible: true,
    score: 95,
    reason: "Voto precedente",
    approved: null,
    reviewedAt: null,
    reviewNotes: null,
    ...changes,
  });
}
async function pending() {
  await db.insert(schema.notifications).values({
    id: "cpv-mail",
    companyId: "cpv-firm",
    dedupeKey: "cpv-mail",
    kind: "digest",
    subject: "Test",
    html: "Test",
    textBody: "Test",
    items: [{ id: publication.id, revision: publication.revision }],
  });
}

beforeAll(async () => {
  context.db = db;
  vi.stubEnv("APP_MODE", "live");
  vi.stubEnv("APP_URL", "http://localhost:3456");
  vi.stubEnv("LLM_MODEL", "test-model");
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values({
    id: "cpv-owner",
    name: "Ditta inventata",
    email: "cpv@example.invalid",
  });
  await db.insert(schema.companies).values({
    id: "cpv-firm",
    ownerId: "cpv-owner",
    profile,
    onboardedAt: now,
  });
  const [firm] = await db.select().from(schema.companies);
  profileRevision = fingerprint(firm.profile);
  viewer = {
    userId: "cpv-owner",
    companyId: "cpv-firm",
    email: "cpv@example.invalid",
    name: "Test",
    admin: false,
    demo: false,
    profile: firm.profile,
  };
  context.viewer = { ...viewer, admin: true };
  await db.insert(schema.invitations).values({
    id: "cpv-invite",
    email: viewer.email,
    companyId: viewer.companyId,
    expiresAt: new Date("2035-01-01"),
    acceptedAt: now,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Network forbidden in CPV tests");
    }),
  );
}, 20000);
beforeEach(async () => {
  context.db = db;
  context.viewer = { ...viewer, admin: true };
  await db.update(schema.companies).set({ profile });
  await db.delete(schema.notifications);
  await db.delete(schema.issues);
  await db.delete(schema.matches);
  await db.delete(schema.publications);
  await db.delete(schema.sourceRuns);
  await db.delete(schema.settings);
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: true });
  await db.insert(schema.sourceRuns).values({
    id: "cpv-run",
    source: "simap",
    status: "success",
    startedAt: now,
    finishedAt: now,
  });
  await db.insert(schema.publications).values({
    id: publication.id,
    externalId: publication.id,
    canonicalId: publication.id,
    source: "simap",
    title: publication.title,
    status: "open",
    visibleAt: new Date(publication.visibleAt),
    deadline: new Date(publication.deadline!),
    revision: publication.revision,
    data: publication,
    aiRevision: publication.revision,
  });
  vi.mocked(classify).mockReset().mockResolvedValue({
    score: 95,
    reason: "Simulazione favorevole",
    uncertain: false,
    needsReview: false,
  });
  vi.mocked(summarize)
    .mockReset()
    .mockResolvedValue({
      summary: "Sintesi di prova",
      sectors: ["pulizie"],
      evidence: [],
      requirements: [],
    });
  vi.mocked(sendMail).mockClear();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await pg.close();
});

async function useDoorProfile() {
  await db.update(schema.companies).set({
    profile: {
      ...profile,
      sectors: ["manutenzioni"],
      activities: "Ripariamo porte e cancelli negli edifici.",
    },
  });
  const [firm] = await db.select().from(schema.companies);
  const localViewer = { ...viewer, profile: firm.profile };
  context.viewer = { ...localViewer, admin: true };
  await amend({
    sectors: ["edilizia"],
    cpv: ["45421100"],
    originalDescriptions: [],
  });
  return localViewer;
}

it("recupera il CPV delle porte senza confronto AI e resiste all’arricchimento della sintesi", async () => {
  const localViewer = await useDoorProfile();
  await amend({ summary: null });
  await db.update(schema.publications).set({ aiRevision: null });
  vi.mocked(summarize).mockResolvedValue({
    summary: "Sintesi inventata",
    sectors: ["manutenzioni"],
    evidence: [],
    requirements: [],
  });
  await run();
  const [first] = await rows();
  expect(first).toMatchObject({ eligible: true, score: 0, approved: null });
  expect(first.revision).toContain(
    ":activity-review:published-building-object-review-v1:",
  );
  expect(classify).not.toHaveBeenCalled();
  expect((await listOpportunities(localViewer))[0]).toMatchObject({
    assessment: "uncertain",
    score: 0,
  });
  await run();
  expect(await rows()).toEqual([first]);
  expect(classify).not.toHaveBeenCalled();
});

it("il recupero di componenti blocca vecchi invii e richiede l’approvazione manuale corrente", async () => {
  const localViewer = await useDoorProfile();
  await insertMatch({
    revision: `${publication.revision}:${fingerprint(localViewer.profile)}:ready:test-model:true`,
  });
  await queueDigests(now);
  expect(await mailRows()).toHaveLength(0);
  await pending();
  await sendPending();
  expect(sendMail).not.toHaveBeenCalled();
  expect((await mailRows())[0]).toMatchObject({
    status: "cancelled",
    attempts: 0,
  });
  await db.delete(schema.notifications);
  await run();
  expect(classify).not.toHaveBeenCalled();
  const command = await reviewCommand();
  expect((await review(command)).status).toBe(200);
  await queueDigests(now);
  await sendPending();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect((await mailRows())[0].status).toBe("sent");
});

it("recupera una vecchia esclusione senza classificatore, completa il Radar e conserva la cache", async () => {
  await insertMatch({
    eligible: false,
    score: 0,
    revision: baseRevision().replace(/true$/, "false"),
  });
  expect((await getRadarStatus(viewer, now)).pendingCount).toBe(1);
  await run();
  const [first] = await rows();
  expect(first).toMatchObject({ eligible: true, score: 0, approved: null });
  expect(first.reviewNotes).toBeTruthy();
  expect(first.revision).toContain(":activity-review:cpv-labels-v1:");
  expect(classify).not.toHaveBeenCalled();
  expect((await getRadarStatus(viewer, now)).pendingCount).toBe(0);
  expect((await listOpportunities(viewer))[0]).toMatchObject({
    assessment: "uncertain",
    score: 0,
    reason: expect.stringContaining("Services de nettoyage"),
  });
  await run();
  expect(await rows()).toEqual([first]);
  expect(classify).not.toHaveBeenCalled();
});

it("una sintesi che aggiunge settori non promuove il recupero ora o al job successivo", async () => {
  await amend({ summary: null });
  await db.update(schema.publications).set({ aiRevision: null });
  await run();
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).not.toHaveBeenCalled();
  expect((await rows())[0]).toMatchObject({ eligible: true, score: 0 });
  expect(
    (await db.select().from(schema.publications))[0].data.sectors,
  ).toContain("pulizie");
  await run();
  expect(classify).not.toHaveBeenCalled();
  expect((await rows())[0].score).toBe(0);
});

it("lega la cache alla citazione aggiornata anche se il contenuto conserva la revisione", async () => {
  await run();
  const [first] = await rows();
  await amend({
    originalDescriptions: [{ text: "Gebäudereinigung.", language: "de", url }],
  });
  await run();
  const [second] = await rows();
  expect(second.revision).not.toBe(first.revision);
  expect(second.reason).toContain("Gebäudereinigung");
  expect(second.score).toBe(0);
  expect(classify).not.toHaveBeenCalled();
});

it.each([true, false])(
  "conserva la decisione manuale corrente approved=%s",
  async (approved) => {
    await insertMatch({
      approved,
      reviewedAt: now,
      eligible: approved,
      score: approved ? 85 : 0,
    });
    const before = await rows();
    await run();
    expect(await rows()).toEqual(before);
    expect(classify).not.toHaveBeenCalled();
  },
);

it("esclude il recupero anche dopo una valutazione quando il territorio è fuori Ticino", async () => {
  await run();
  await amend({ canton: "ZH" });
  await run();
  expect((await rows())[0]).toMatchObject({ eligible: false, score: 0 });
  expect(classify).not.toHaveBeenCalled();
});

it("blocca selezione e invio di un vecchio voto alto prima della rivalutazione", async () => {
  await insertMatch();
  await queueDigests(now);
  expect(await mailRows()).toHaveLength(0);
  await pending();
  await sendPending();
  expect(sendMail).not.toHaveBeenCalled();
  expect((await mailRows())[0]).toMatchObject({
    status: "cancelled",
    attempts: 0,
  });
});

it("l'approvazione manuale esplicita permette il digest simulato della proposta recuperata", async () => {
  await run();
  expect((await review(await reviewCommand())).status).toBe(200);
  await queueDigests(now);
  expect(await mailRows()).toHaveLength(1);
  await sendPending();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect((await mailRows())[0].status).toBe("sent");
});

it("richiede una vista corrente prima di approvare un recupero senza eventi fonte", async () => {
  await run();
  const [match] = await rows();
  expect(
    (await review({ action: "review", id: match.id, approved: true })).status,
  ).toBe(409);
  const stale = await reviewCommand();
  await db
    .update(schema.matches)
    .set({ reason: "Motivazione aggiornata dopo apertura del modulo" });
  expect((await review(stale)).status).toBe(409);
  expect((await rows())[0].approved).toBeNull();
  expect((await review(await reviewCommand())).status).toBe(200);
});

it("rifiuta l'approvazione precedente a una modifica del profilo e lega quella nuova al contenuto corrente", async () => {
  await run();
  const stale = await reviewCommand();
  await db.update(schema.companies).set({
    profile: {
      ...profile,
      activities: "Nuova descrizione inventata della ditta",
    },
  });
  expect((await review(stale)).status).toBe(409);
  await amend({ revision: "cpv-content-v2" });
  const fresh = await reviewCommand();
  expect((await review(fresh)).status).toBe(200);
  const [approved] = await rows();
  expect(approved.revision).toContain(
    `cpv-content-v2:${fresh.expectedProfileRevision}:ready:manual-activity-review:true:activity-review:`,
  );
});

it("non seleziona l'approvazione di un recupero relativa a un vecchio profilo", async () => {
  await run();
  expect((await review(await reviewCommand())).status).toBe(200);
  await db.update(schema.companies).set({
    profile: { ...profile, activities: "Profilo inventato aggiornato" },
  });
  await queueDigests(now);
  expect(await mailRows()).toHaveLength(0);
  expect(sendMail).not.toHaveBeenCalled();
});

it("rilegge il recupero immediatamente prima del claim SMTP simulato", async () => {
  await amend({ sectors: ["pulizie"] });
  await insertMatch();
  await pending();
  let injected = false;
  context.db = new Proxy(db, {
    get(target, key) {
      if (key === "transaction")
        return async (...args: Parameters<typeof db.transaction>) => {
          if (!injected) {
            injected = true;
            await amend({ sectors: [] });
          }
          return db.transaction(...args);
        };
      const value = Reflect.get(target, key, target);
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
  expect((await mailRows())[0]).toMatchObject({
    status: "pending",
    attempts: 0,
  });
});

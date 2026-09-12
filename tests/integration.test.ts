import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { getDemoOpportunities, demoProfile } from "../src/lib/demo";
import type { Viewer } from "../src/lib/domain";
const testContext = vi.hoisted(() => ({
  db: undefined as unknown,
  mail: [] as { to: string; text: string }[],
}));
vi.mock("@/db", () => ({
  getDb: () => testContext.db,
  closeDb: async () => {},
}));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (s: string) => s.replace(/</g, "&lt;"),
  sendMail: async (message: { to: string; text: string }) => {
    testContext.mail.push(message);
    return { accepted: [message.to], messageId: "test" };
  },
}));
import { provisionInvite } from "../src/lib/admin";
import { getAuth } from "../src/lib/auth";
import { listOpportunities, getOpportunity } from "../src/lib/queries";
import { storePublication, enrichAndMatch } from "../src/worker/pipeline";
import { legacySimapRevision, normalizeSimap } from "../src/sources/simap";
import { updateCompanyProfile, saveCompanyFeedback } from "../src/lib/company";
import {
  summarize,
  configuredTransport,
  buildSummaryRequest,
} from "../src/worker/ai";
import {
  queueDigests,
  sendPending,
  recoverUncertainDeliveries,
  queueChangeNotices,
  reconcileDelivery,
  queueOutstandingChanges,
} from "../src/worker/notifications";
const pg = new PGlite();
const db = drizzle(pg, { schema });
let a: Viewer, b: Viewer;
beforeAll(async () => {
  testContext.db = db;
  process.env.APP_MODE = "live";
  process.env.APP_URL = "http://localhost:3456";
  process.env.BETTER_AUTH_SECRET =
    "test-only-secret-never-use-in-production-123456789";
  process.env.FOGLIO_REUSE_CONFIRMED = "true";
  await migrate(db, { migrationsFolder: "drizzle" });
  const queue = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    schema: "pgboss",
    schedule: false,
    supervise: false,
  });
  await queue.start();
  try {
    await queue.createQueue("match", { policy: "singleton" });
  } finally {
    await queue.stop();
  }
  const x = await provisionInvite("a@example.invalid", "Ditta A");
  const y = await provisionInvite("b@example.invalid", "Ditta B");
  a = {
    ...x,
    userId: x.userId,
    companyId: x.companyId,
    name: "A",
    email: "a@example.invalid",
    admin: false,
    demo: false,
    profile: demoProfile,
  };
  b = {
    ...y,
    userId: y.userId,
    companyId: y.companyId,
    name: "B",
    email: "b@example.invalid",
    admin: false,
    demo: false,
    profile: demoProfile,
  };
  await db
    .update(schema.companies)
    .set({ profile: demoProfile, onboardedAt: new Date() });
});

describe("Regressioni di revisione e invio", () => {
  beforeEach(async () => {
    await db.delete(schema.notifications);
    await db.delete(schema.issues);
    await db
      .update(schema.companies)
      .set({ profile: demoProfile })
      .where(eq(schema.companies.id, a.companyId));
  });
  async function ready(id: string, source: "simap" | "foglio-ti" = "simap") {
    const p = {
      ...getDemoOpportunities()[1],
      id,
      externalId: id,
      source,
      canonicalKey: id,
      reviewRequired: false,
      reviewReasons: [],
      revision: "v1",
    };
    await storePublication(p);
    await db.insert(schema.matches).values({
      id: `match-${id}`,
      companyId: a.companyId,
      publicationId: id,
      revision: p.revision,
      score: 90,
      reason: "Servizi di pulizia nel territorio selezionato",
      eligible: true,
      approved: true,
      reviewedAt: new Date(),
    });
    return p;
  }
  async function pending(
    p: ReturnType<typeof getDemoOpportunities>[number],
    kind = "digest",
  ) {
    const id = crypto.randomUUID();
    await db.insert(schema.notifications).values({
      id,
      companyId: a.companyId,
      dedupeKey: id,
      kind,
      subject: "Test",
      html: "test",
      textBody: "test",
      items: [{ id: p.id, revision: p.revision }],
    });
    return id;
  }
  function simapResponse(projectId = crypto.randomUUID()) {
    const entry = {
      id: projectId,
      raw: {
        id: projectId,
        publicationId: crypto.randomUUID(),
        publicationDate: "2030-09-01",
        projectNumber: projectId,
        pubType: "tender",
        processType: "open",
        title: { it: "Pulizia di locali — esempio" },
        procOfficeName: { it: "Ente inventato" } as unknown,
      },
    };
    const detail = {
      id: entry.raw.publicationId,
      type: "tender",
      dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
      procurement: {
        orderDescription: { it: "Pulizia ordinaria di locali inventati." },
        orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
      },
    };
    return { entry, detail };
  }
  async function readyLegacySimap(response: ReturnType<typeof simapResponse>) {
    const incoming = normalizeSimap(response.entry, response.detail);
    const legacy = { ...incoming, revision: legacySimapRevision(incoming)! };
    await storePublication(legacy);
    const corrected = {
      ...legacy,
      revision: "editorial-correction",
      summary: "Riassunto controllato manualmente",
      requirements: ["Un requisito già verificato"],
      reviewRequired: true,
      reviewReasons: ["Revisione editoriale in corso"],
    };
    await db
      .update(schema.publications)
      .set({ data: corrected, aiRevision: corrected.revision })
      .where(eq(schema.publications.id, legacy.id));
    await db.insert(schema.matches).values({
      id: `match-${legacy.id}`,
      companyId: a.companyId,
      publicationId: legacy.id,
      revision: corrected.revision,
      score: 90,
      reason: "Valutazione già controllata",
      eligible: true,
      approved: true,
      reviewedAt: new Date(),
    });
    return { incoming, legacy, corrected };
  }
  it("adotta il nuovo fingerprint soltanto con prova legacy esatta, preservando dati e match", async () => {
    const response = simapResponse();
    const { incoming, legacy, corrected } = await readyLegacySimap(response);
    const [before] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, incoming.id));
    const beforeMatches = await db
      .select()
      .from(schema.matches)
      .where(eq(schema.matches.publicationId, incoming.id));

    expect(await storePublication(incoming)).toBe(false);
    const [current] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, incoming.id));
    expect(current).toEqual({ ...before, revision: incoming.revision });
    expect(current.data).toEqual(corrected);
    expect(
      await db
        .select()
        .from(schema.matches)
        .where(eq(schema.matches.publicationId, incoming.id)),
    ).toEqual(beforeMatches);
    const versions = await db
      .select()
      .from(schema.publicationVersions)
      .where(eq(schema.publicationVersions.publicationId, incoming.id));
    expect(versions.map((v) => v.revision).sort()).toEqual(
      [legacy.revision, incoming.revision].sort(),
    );
    expect(
      versions.find((v) => v.revision === incoming.revision)?.data,
    ).toEqual(incoming);

    response.entry.raw.procOfficeName = "Ente inventato";
    const refresh = normalizeSimap(response.entry, response.detail);
    expect(legacySimapRevision(refresh)).not.toBe(legacy.revision);
    expect(await storePublication(refresh)).toBe(false);
    const [afterRefresh] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, incoming.id));
    expect(afterRefresh).toEqual(current);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
  });

  it("non scambia per prova legacy la sola uguaglianza dei dati normalizzati", async () => {
    const response = simapResponse();
    const { incoming, legacy } = await readyLegacySimap(response);
    response.entry.raw.procOfficeName = "Ente inventato";
    const refresh = normalizeSimap(response.entry, response.detail);
    expect(refresh.revision).toBe(incoming.revision);
    expect(legacySimapRevision(refresh)).not.toBe(legacy.revision);

    expect(await storePublication(refresh)).toBe(true);
    const [current] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, incoming.id));
    expect(current.data).toEqual(refresh);
    expect(current.aiRevision).toBeNull();
    const [match] = await db
      .select()
      .from(schema.matches)
      .where(eq(schema.matches.publicationId, incoming.id));
    expect(match.approved).toBeNull();
    expect(match.reviewedAt).toBeNull();
    expect(match.revision).toBe(refresh.revision);
  });

  it("non nasconde una nuova pubblicazione identica durante la migrazione legacy", async () => {
    const response = simapResponse();
    const { incoming } = await readyLegacySimap(response);
    response.entry.raw.publicationId = crypto.randomUUID();
    response.detail.id = response.entry.raw.publicationId;
    const next = normalizeSimap(response.entry, response.detail);
    expect(next.originalText).toBe(incoming.originalText);
    expect(next.revision).not.toBe(incoming.revision);
    expect(await storePublication(next)).toBe(true);
    const [current] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, incoming.id));
    expect(current.data.revision).toBe(next.revision);
    expect(current.aiRevision).toBeNull();
  });
  it("conserva una correzione manuale quando la fonte viene importata invariata", async () => {
    const p = await ready("manual-correction-source-unchanged");
    const corrected = {
      ...p,
      revision: "manual-v2",
      summary: "Riassunto verificato e corretto dal fondatore",
    };
    await db
      .update(schema.publications)
      .set({ data: corrected, aiRevision: corrected.revision })
      .where(eq(schema.publications.id, p.id));

    expect(await storePublication(p)).toBe(false);
    const [current] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, p.id));
    expect(current.revision).toBe(p.revision);
    expect(current.aiRevision).toBe(corrected.revision);
    expect(current.data).toEqual(corrected);
  });
  it("recupera un annullamento arrivato prima della conferma SMTP tardiva", async () => {
    const p = await ready("late-confirmation"),
      id = await pending(p);
    await db
      .update(schema.notifications)
      .set({ status: "uncertain" })
      .where(eq(schema.notifications.id, id));
    await storePublication({ ...p, status: "cancelled", revision: "v2" });
    expect(
      await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, "change")),
    ).toHaveLength(0);
    await reconcileDelivery(
      id,
      "sent",
      "Consegna confermata nel registro SMTP",
      a.userId,
    );
    const notices = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "change"));
    expect(notices).toHaveLength(1);
    expect(notices[0].items).toEqual([{ id: p.id, revision: "v2" }]);
    await queueOutstandingChanges();
    expect(
      await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, "change")),
    ).toHaveLength(1);
    const before = testContext.mail.length;
    await sendPending();
    expect(testContext.mail.length - before).toBe(1);
    await expect(
      reconcileDelivery(
        id,
        "retry",
        "Seconda conferma concorrente non ammessa",
        a.userId,
      ),
    ).rejects.toThrow("già stata riconciliata");
  });
  it("ricostruisce nello stesso giorno il riepilogo annullato mantenendo i bandi validi", async () => {
    await db
      .update(schema.matches)
      .set({ eligible: false })
      .where(eq(schema.matches.companyId, a.companyId));
    const p = await ready("rebuild-one"),
      other = await ready("rebuild-two");
    const now = new Date();
    now.setUTCHours(12);
    for (const source of ["simap", "foglio-ti"])
      await db
        .insert(schema.sourceRuns)
        .values({
          id: crypto.randomUUID(),
          source,
          status: "success",
          finishedAt: now,
        });
    await queueDigests(now);
    const [first] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.companyId, a.companyId));
    expect(first.items.map((i) => i.id).sort()).toEqual(
      [p.id, other.id].sort(),
    );
    await saveCompanyFeedback(a.companyId, p.id, { dismissed: true });
    await sendPending();
    await queueDigests(now);
    const [rebuilt] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, first.id));
    expect(rebuilt.status).toBe("pending");
    expect(rebuilt.items).toEqual([{ id: other.id, revision: other.revision }]);
    const before = testContext.mail.length;
    await sendPending();
    await queueDigests(now);
    await sendPending();
    expect(testContext.mail.length - before).toBe(1);
  });
  it("l’annullamento manuale non viene rigenerato dai lavori automatici", async () => {
    const p = await ready("manual-discard"),
      id = await pending(p);
    await db
      .update(schema.notifications)
      .set({ status: "uncertain" })
      .where(eq(schema.notifications.id, id));
    await reconcileDelivery(
      id,
      "cancelled",
      "Il fondatore decide di non inviare",
      a.userId,
    );
    expect(
      (
        await db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.id, id))
      )[0].status,
    ).toBe("discarded");
    const now = new Date();
    now.setUTCHours(12);
    await queueDigests(now);
    const other = await db
      .select()
      .from(schema.notifications)
      .where(sql`${schema.notifications.id}<>${id}`);
    expect(other.some((n) => n.items.some((i) => i.id === p.id))).toBe(false);
  });
  it("trattiene una rettifica discordante senza bloccare annullamenti già verificati", async () => {
    const p = await ready("conflicting-change"),
      id = await pending(p);
    await db
      .update(schema.notifications)
      .set({ status: "sent" })
      .where(eq(schema.notifications.id, id));
    await storePublication({
      ...p,
      deadline: new Date(Date.now() + 86400000).toISOString(),
      revision: "v2",
      reviewRequired: true,
      reviewReasons: ["Scadenze discordanti"],
    });
    await db
      .insert(schema.issues)
      .values({
        id: "critical-conflict",
        key: `conflict:${p.canonicalKey}`,
        title: "Fonti discordanti",
        detail: "Verificare la scadenza",
        severity: "critical",
        publicationId: p.id,
      });
    const before = testContext.mail.length;
    await sendPending();
    expect(testContext.mail.length).toBe(before);
    const current = (
      await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, p.id))
    )[0];
    await db
      .update(schema.publications)
      .set({
        data: { ...current.data, reviewRequired: false, reviewReasons: [] },
      })
      .where(eq(schema.publications.id, p.id));
    await sendPending();
    expect(testContext.mail.length).toBe(before);
    await db
      .update(schema.issues)
      .set({ resolvedAt: new Date() })
      .where(eq(schema.issues.id, "critical-conflict"));
    await db
      .insert(schema.issues)
      .values({
        id: "unrelated-critical",
        key: "source:unrelated",
        title: "Problema estraneo",
        detail: "Verifica indipendente",
        severity: "critical",
      });
    await sendPending();
    expect(testContext.mail.length - before).toBe(1);
  });
  it("ritira l’email se la ditta esclude un bando già accodato", async () => {
    const p = await ready("dismiss-before-send"),
      id = await pending(p);
    await saveCompanyFeedback(a.companyId, p.id, { dismissed: true });
    const before = testContext.mail.length;
    await sendPending();
    expect(testContext.mail.length).toBe(before);
    expect(
      (
        await db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.id, id))
      )[0].status,
    ).toBe("cancelled");
  });
  it("la modifica del profilo invalida soltanto valutazioni e digest della propria ditta", async () => {
    const p = await ready("profile-before-send"),
      id = await pending(p);
    await updateCompanyProfile(a.companyId, {
      ...demoProfile,
      exclusions: ["pulizie"],
    });
    expect(
      (
        await db
          .select()
          .from(schema.matches)
          .where(eq(schema.matches.id, `match-${p.id}`))
      )[0].eligible,
    ).toBe(false);
    expect(
      (
        await db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.id, id))
      )[0].status,
    ).toBe("cancelled");
    expect(
      (
        await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, b.companyId))
      )[0].profile.exclusions,
    ).toEqual(demoProfile.exclusions);
  });
  it("blocca un contenuto Foglio se la fonte viene disattivata prima dell’invio", async () => {
    const p = await ready("disabled-foglio", "foglio-ti"),
      id = await pending(p);
    process.env.FOGLIO_REUSE_CONFIRMED = "false";
    try {
      await sendPending();
      expect(
        (
          await db
            .select()
            .from(schema.notifications)
            .where(eq(schema.notifications.id, id))
        )[0].status,
      ).toBe("cancelled");
    } finally {
      process.env.FOGLIO_REUSE_CONFIRMED = "true";
    }
  });
  it("invia solo l’ultima rettifica e conserva i salvati annullati", async () => {
    const p = await ready("amendments");
    await saveCompanyFeedback(a.companyId, p.id, { saved: true });
    const sentId = await pending(p);
    await db
      .update(schema.notifications)
      .set({ status: "sent" })
      .where(eq(schema.notifications.id, sentId));
    await storePublication({
      ...p,
      deadline: new Date(Date.now() + 86400000).toISOString(),
      revision: "v2",
    });
    await storePublication({ ...p, status: "cancelled", revision: "v3" });
    const before = testContext.mail.length;
    await sendPending();
    expect(testContext.mail.length - before).toBe(1);
    const change = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "change"));
    expect(change.find((n) => n.items[0].revision === "v2")?.status).toBe(
      "cancelled",
    );
    expect(change.find((n) => n.items[0].revision === "v3")?.status).toBe(
      "sent",
    );
    expect(
      (await listOpportunities(a, { includeInactive: true })).find(
        (o) => o.id === p.id,
      )?.status,
    ).toBe("cancelled");
    expect((await listOpportunities(a)).some((o) => o.id === p.id)).toBe(false);
  });
  it("collega una nuova edizione Foglio allo storico e avvisa la ditta", async () => {
    const p = await ready("foglio-edition-1", "foglio-ti");
    await saveCompanyFeedback(a.companyId, p.id, { saved: true });
    const id = await pending(p);
    await db
      .update(schema.notifications)
      .set({ status: "sent" })
      .where(eq(schema.notifications.id, id));
    const next = {
      ...p,
      id: "foglio-edition-2",
      externalId: "foglio-edition-2",
      projectId: "500-02",
      publishedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
      revision: "edition2",
    };
    await storePublication(next);
    expect((await getOpportunity(a, next.id))?.saved).toBe(true);
    expect(await getOpportunity(b, next.id)).toBeNull();
    const changes = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "change"));
    expect(changes).toHaveLength(1);
    expect(changes[0].items[0].id).toBe(next.id);
    expect((await getOpportunity(a, p.id))?.status).toBe("closed");
    await saveCompanyFeedback(a.companyId, next.id, { saved: false });
    expect((await getOpportunity(a, p.id))?.saved).toBe(false);
  });
  it("rivaluta una pubblicazione dopo le 08:00 senza cambiare versione", async () => {
    const base = {
      ...getDemoOpportunities()[1],
      id: "embargo",
      externalId: "embargo",
      summary: null,
      visibleAt: "2026-09-10T06:00:00Z",
      deadline: "2026-10-20T10:00:00Z",
    };
    await storePublication(base);
    await enrichAndMatch({
      publicationId: base.id,
      now: new Date("2026-09-10T05:59:00Z"),
    });
    let [m] = await db
      .select()
      .from(schema.matches)
      .where(
        and(
          eq(schema.matches.companyId, a.companyId),
          eq(schema.matches.publicationId, base.id),
        ),
      );
    expect(m.eligible).toBe(false);
    await enrichAndMatch({
      publicationId: base.id,
      now: new Date("2026-09-10T06:01:00Z"),
    });
    [m] = await db
      .select()
      .from(schema.matches)
      .where(
        and(
          eq(schema.matches.companyId, a.companyId),
          eq(schema.matches.publicationId, base.id),
        ),
      );
    expect(m.eligible).toBe(true);
  });
});

describe("AI: budget e aggiornamenti concorrenti", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_API_KEY", "test-transport-only");
    vi.stubEnv("LLM_INPUT_CHF_PER_MILLION", "1");
    vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "2");
    vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "40");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("usa la richiesta condivisa e registra il costo di un riassunto valido", async () => {
    const publication = {
      ...getDemoOpportunities()[1],
      id: "summary-request-contract",
      originalText:
        "Il servizio richiede la pulizia ordinaria degli uffici comunali.",
      documentPages: [
        {
          page: 3,
          url: "https://example.invalid/annexe-francaise.pdf",
          text: "Une référence pour des prestations similaires est exigée.",
        },
      ],
    };
    const request = buildSummaryRequest(publication);
    const original = request.passages.find((p) => p.documentIndex === null)!;
    const attachment = request.passages.find((p) => p.documentIndex === 0)!;
    const output = {
      summary:
        "È richiesta la pulizia ordinaria degli uffici comunali, con una referenza per servizi analoghi.",
      requirements: [
        { text: "Presentare una referenza.", quoteId: attachment.id },
      ],
      sectors: ["pulizie"],
      evidence: [{ field: "oggetto", quoteId: original.id }],
    };
    const complete = vi.fn(async () => ({
      text: JSON.stringify(output),
      inputTokens: 100,
      outputTokens: 50,
    }));
    await expect(summarize(publication, { complete })).resolves.toEqual({
      summary: output.summary,
      sectors: output.sectors,
      requirements: [
        {
          text: "Presentare una referenza.",
          quote: publication.documentPages[0].text,
          url: publication.documentPages[0].url,
          page: 3,
        },
      ],
      evidence: [
        {
          field: "oggetto",
          quote: publication.originalText,
          url: publication.sourceUrl,
        },
      ],
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      request.system,
      request.prompt,
      request.maxTokens,
    );
    const [usage] = await db
      .select()
      .from(schema.aiUsage)
      .where(eq(schema.aiUsage.publicationId, publication.id));
    expect(usage.status).toBe("completed");
    expect(Number(usage.costChf)).toBe(0.0002);
  });
  it.each(
    (["requirements", "evidence"] as const).flatMap((field) =>
      (["unknown-id", "legacy-quote"] as const).map((kind) => ({
        field,
        kind,
      })),
    ),
  )(
    "registra il costo ma non salva il riassunto con $kind in $field",
    async ({ field, kind }) => {
      const publication = {
        ...getDemoOpportunities()[1],
        id: `invalid-citation-${field}-${kind}`,
        externalId: `invalid-citation-${field}-${kind}`,
        canonicalKey: `invalid-citation-${field}-${kind}`,
        originalText:
          "The contract covers cleaning the offices. References for comparable services are required.",
        documentPages: [],
        summary: null,
        revision: "original-language-v1",
      };
      const request = buildSummaryRequest(publication);
      const quoteId = request.passages[0].id;
      const output = {
        summary:
          "Il servizio comprende la pulizia degli uffici e richiede referenze per servizi analoghi.",
        requirements: [
          {
            text: "Presentare referenze per servizi analoghi.",
            quoteId,
          },
        ],
        sectors: ["pulizie"],
        evidence: [
          {
            field: "oggetto",
            quoteId,
          },
        ],
      };
      const unknownId = "s999999";
      expect(request.passages.some((p) => p.id === unknownId)).toBe(false);
      const entry =
        field === "requirements"
          ? { text: output.requirements[0].text }
          : { field: output.evidence[0].field };
      const invalidOutput = {
        ...output,
        [field]: [
          kind === "unknown-id"
            ? { ...entry, quoteId: unknownId }
            : {
                ...entry,
                quote:
                  field === "requirements"
                    ? "Sono richieste referenze per servizi analoghi."
                    : "Il servizio comprende la pulizia degli uffici.",
              },
        ],
      };
      const complete = vi
        .spyOn(configuredTransport, "complete")
        .mockResolvedValue({
          text: JSON.stringify(invalidOutput),
          inputTokens: 120,
          outputTokens: 80,
        });
      await storePublication(publication);
      const [before] = await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, publication.id));

      await expect(
        enrichAndMatch({ publicationId: publication.id }),
      ).rejects.toThrow("Analisi AI da ritentare");

      expect(complete).toHaveBeenCalledTimes(1);
      const usages = await db
        .select()
        .from(schema.aiUsage)
        .where(eq(schema.aiUsage.publicationId, publication.id));
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        purpose: "summary",
        status: "completed",
        inputTokens: 120,
        outputTokens: 80,
      });
      expect(Number(usages[0].costChf)).toBeCloseTo(0.00028, 8);
      const [current] = await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, publication.id));
      expect(current.data.summary).toBeNull();
      expect(current.aiRevision).toBeNull();
      expect(current.data).toEqual(before.data);
      const problems = await db
        .select()
        .from(schema.issues)
        .where(eq(schema.issues.key, `ai:${publication.id}`));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        publicationId: publication.id,
        severity: "warning",
        resolvedAt: null,
      });
      expect(problems[0].detail.length).toBeGreaterThan(0);
    },
  );
  it("salva la pagina selezionata dal modello senza riassegnare una citazione duplicata", async () => {
    const originalQuote = "Les références pour des travaux similaires sont exigées.";
    const publication = {
      ...getDemoOpportunities()[1],
      id: "selected-evidence-page",
      externalId: "selected-evidence-page",
      canonicalKey: "selected-evidence-page",
      canton: "ZH",
      originalText: originalQuote,
      documentPages: [
        {
          page: 1,
          text: originalQuote,
          url: "https://example.invalid/premier-document.pdf",
        },
        {
          page: 7,
          text: originalQuote,
          url: "https://example.invalid/deuxieme-document.pdf",
        },
      ],
      summary: null,
      revision: "duplicate-evidence-v1",
    };
    const selected = buildSummaryRequest(publication).passages.find(
      (p) => p.documentIndex === 1,
    )!;
    const complete = vi
      .spyOn(configuredTransport, "complete")
      .mockResolvedValue({
        text: JSON.stringify({
          summary: "Sono richieste referenze per lavori analoghi.",
          requirements: [
            { text: "Presentare referenze.", quoteId: selected.id },
          ],
          sectors: ["pulizie"],
          evidence: [{ field: "requisiti", quoteId: selected.id }],
        }),
        inputTokens: 100,
        outputTokens: 50,
      });
    await storePublication(publication);

    await enrichAndMatch({ publicationId: publication.id });

    expect(complete).toHaveBeenCalledTimes(1);
    const [current] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, publication.id));
    expect(current.aiRevision).toBe(publication.revision);
    expect(current.data.requirements).toEqual(["Presentare referenze."]);
    expect(current.data.evidence).toEqual(
      expect.arrayContaining([
        {
          field: "requisiti",
          quote: originalQuote,
          url: publication.documentPages[1].url,
          page: 7,
        },
        {
          field: "Requisito",
          quote: originalQuote,
          url: publication.documentPages[1].url,
          page: 7,
        },
      ]),
    );
  });
  it("non chiama il modello a budget esaurito e registra il blocco", async () => {
    vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "0");
    const complete = vi.fn();
    await expect(
      summarize(getDemoOpportunities()[1], { complete }),
    ).rejects.toThrow("Limite mensile");
    expect(complete).not.toHaveBeenCalled();
    expect(
      (
        await db
          .select()
          .from(schema.settings)
          .where(eq(schema.settings.key, "ai_budget_blocked"))
      ).length,
    ).toBe(1);
  });
  it("mantiene la riserva di spesa quando l’esito AI è incerto", async () => {
    const p = { ...getDemoOpportunities()[1], id: "uncertain-ai" };
    await expect(
      summarize(p, {
        complete: async () => {
          throw new Error("Timeout simulato");
        },
      }),
    ).rejects.toThrow("Timeout");
    const [usage] = await db
      .select()
      .from(schema.aiUsage)
      .where(eq(schema.aiUsage.publicationId, p.id));
    expect(usage.status).toBe("uncertain");
    expect(Number(usage.reservedChf)).toBeGreaterThan(0);
    expect(usage.costChf).toBeNull();
  });
  it("una risposta AI tardiva non sovrascrive una rettifica", async () => {
    const p = {
      ...getDemoOpportunities()[1],
      id: "concurrent-ai",
      externalId: "concurrent-ai",
      summary: null,
      revision: "first",
    };
    await storePublication(p);
    let started!: () => void,
      finish!: (value: {
        text: string;
        inputTokens: number;
        outputTokens: number;
      }) => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new Promise<{
      text: string;
      inputTokens: number;
      outputTokens: number;
    }>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(configuredTransport, "complete").mockImplementationOnce(
      async () => {
        started();
        return result;
      },
    );
    const running = enrichAndMatch({ publicationId: p.id });
    await waiting;
    await storePublication({ ...p, revision: "second", status: "cancelled" });
    finish({
      text: JSON.stringify({
        summary: "Servizio di pulizia per gli spazi dell’ente.",
        requirements: [],
        sectors: ["pulizie"],
        evidence: [
          { field: "oggetto", quoteId: buildSummaryRequest(p).passages[0].id },
        ],
      }),
      inputTokens: 100,
      outputTokens: 100,
    });
    await running;
    const [current] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, p.id));
    expect(current.data.revision).toBe("second");
    expect(current.status).toBe("cancelled");
    expect(current.aiRevision).toBeNull();
  });
});
afterAll(async () => {
  await pg.close();
});
describe("Database, inviti e isolamento delle ditte", () => {
  it("non permette di leggere un bando associato a un’altra ditta", async () => {
    const p = {
      ...getDemoOpportunities()[1],
      id: "test-tender",
      externalId: "test-tender",
      reviewRequired: false,
    };
    await storePublication(p);
    await db.insert(schema.matches).values({
      id: "ma",
      companyId: a.companyId,
      publicationId: p.id,
      revision: p.revision,
      score: 90,
      reason: "Pulizie nel territorio selezionato",
      eligible: true,
      approved: true,
      reviewedAt: new Date(),
    });
    expect((await listOpportunities(a)).map((o) => o.id)).toContain(p.id);
    expect(await getOpportunity(b, p.id)).toBeNull();
    expect((await listOpportunities(b)).map((o) => o.id)).not.toContain(p.id);
  });
  it("isola salvataggi e feedback a parità di bando", async () => {
    await db.insert(schema.matches).values({
      id: "mb",
      companyId: b.companyId,
      publicationId: "test-tender",
      revision: "demo-v1",
      score: 90,
      reason: "Pertinente",
      eligible: true,
    });
    await db.insert(schema.feedback).values({
      id: "fa",
      companyId: a.companyId,
      publicationId: "test-tender",
      saved: true,
      relevant: true,
    });
    expect((await getOpportunity(a, "test-tender"))?.saved).toBe(true);
    expect((await getOpportunity(b, "test-tender"))?.saved).toBe(false);
  });
  it("reimportare la stessa versione non duplica i dati", async () => {
    const [p] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, "test-tender"));
    expect(await storePublication(p.data)).toBe(false);
    const versions = await db
      .select()
      .from(schema.publicationVersions)
      .where(eq(schema.publicationVersions.publicationId, p.id));
    expect(versions.length).toBe(1);
  });
  it("aggiornare una scadenza conserva la versione precedente e ritira l’approvazione", async () => {
    const [row] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, "test-tender"));
    await storePublication({
      ...row.data,
      deadline: new Date(Date.now() + 10 * 86400000).toISOString(),
      revision: "changed",
    });
    const versions = await db
      .select()
      .from(schema.publicationVersions)
      .where(eq(schema.publicationVersions.publicationId, row.id));
    expect(versions.length).toBe(2);
    const [m] = await db
      .select()
      .from(schema.matches)
      .where(eq(schema.matches.id, "ma"));
    expect(m.approved).toBeNull();
  });
  it("non crea account per email non invitate", async () => {
    const before = await db.select().from(schema.user);
    const r = await getAuth().handler(
      new Request(
        "http://localhost:3456/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin: "http://localhost:3456",
            "x-real-ip": "192.0.2.1",
          },
          body: JSON.stringify({
            email: "unknown@example.invalid",
            type: "sign-in",
          }),
        },
      ),
    );
    expect(r.status).toBeLessThan(500);
    expect((await db.select().from(schema.user)).length).toBe(before.length);
    expect(
      testContext.mail.some((m) => m.to === "unknown@example.invalid"),
    ).toBe(false);
  });
  it("genera OTP hash, rifiuta codici scaduti e crea sessione solo con codice valido", async () => {
    const auth = getAuth();
    const request = (path: string, body: unknown, ip = "192.0.2.2") =>
      auth.handler(
        new Request(`http://localhost:3456/api/auth${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin: "http://localhost:3456",
            "x-real-ip": ip,
          },
          body: JSON.stringify(body),
        }),
      );
    await request("/email-otp/send-verification-otp", {
      email: a.email,
      type: "sign-in",
    });
    const code = testContext.mail.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const [v] = await db
      .select()
      .from(schema.verification)
      .where(sql`${schema.verification.identifier} like ${`%${a.email}%`}`);
    expect(v.value).not.toContain(code);
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verification.id, v.id));
    expect(
      (await request("/sign-in/email-otp", { email: a.email, otp: code }))
        .status,
    ).toBe(400);
    await request(
      "/email-otp/send-verification-otp",
      { email: a.email, type: "sign-in" },
      "192.0.2.3",
    );
    const fresh = testContext.mail.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const success = await request(
      "/sign-in/email-otp",
      { email: a.email, otp: fresh },
      "192.0.2.3",
    );
    expect(success.status, await success.clone().text()).toBe(200);
    expect(success.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("la revoca blocca nuove sessioni anche con OTP già ricevuto", async () => {
    const auth = getAuth();
    const call = (path: string, body: unknown) =>
      auth.handler(
        new Request(`http://localhost:3456/api/auth${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin: "http://localhost:3456",
            "x-real-ip": "192.0.2.4",
          },
          body: JSON.stringify(body),
        }),
      );
    await call("/email-otp/send-verification-otp", {
      email: b.email,
      type: "sign-in",
    });
    const code = testContext.mail.at(-1)!.text.match(/\b\d{6}\b/)![0];
    await db
      .update(schema.invitations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.invitations.email, b.email));
    expect(
      (await call("/sign-in/email-otp", { email: b.email, otp: code })).status,
    ).not.toBe(200);
  });
});
describe("Outbox email", () => {
  it("prepara un solo digest giornaliero e non invia i match non approvati", async () => {
    await db
      .update(schema.matches)
      .set({ approved: true, reviewedAt: new Date() })
      .where(eq(schema.matches.id, "ma"));
    for (const source of ["simap", "foglio-ti"])
      await db.insert(schema.sourceRuns).values({
        id: crypto.randomUUID(),
        source,
        status: "success",
        finishedAt: new Date(),
      });
    const now = new Date();
    now.setUTCHours(12);
    await queueDigests(now);
    await queueDigests(now);
    const mails = await db.select().from(schema.notifications);
    expect(
      mails.filter((m) => m.companyId === a.companyId && m.kind === "digest")
        .length,
    ).toBe(1);
    expect(
      mails.filter((m) => m.companyId === b.companyId && m.kind === "digest")
        .length,
    ).toBe(0);
  });
  it("invia un digest una sola volta anche ripetendo il job", async () => {
    const before = testContext.mail.length;
    await sendPending();
    await sendPending();
    expect(testContext.mail.length - before).toBe(1);
    const [n] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.companyId, a.companyId));
    expect(n.status).toBe("sent");
  });
  it("sospende un invio rimasto a metà senza ritentarlo automaticamente", async () => {
    await db
      .update(schema.notifications)
      .set({ status: "sending" })
      .where(eq(schema.notifications.companyId, a.companyId));
    await recoverUncertainDeliveries();
    const [n] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.companyId, a.companyId));
    expect(n.status).toBe("uncertain");
    const before = testContext.mail.length;
    await sendPending();
    expect(testContext.mail.length).toBe(before);
  });
});

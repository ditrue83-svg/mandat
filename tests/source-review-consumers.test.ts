import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, demoViewer, getDemoOpportunities } from "../src/lib/demo";
import type { Publication, Viewer } from "../src/lib/domain";
import type { HumanSourceForm } from "../src/lib/source-review-context";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
import { fingerprint } from "../src/sources/common";
import { matchReviewToken } from "../src/lib/match-review-token";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  viewer: undefined as unknown,
  requireViewer: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/viewer", () => ({
  requireViewer: context.requireViewer,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value.replace(/</g, "&lt;"),
  sendMail: vi.fn(async (message: { to: string }) => ({
    accepted: [message.to],
    messageId: "invented-local-mail-id",
  })),
}));
vi.mock("@/worker/ai", () => ({
  AiUnavailable: class extends Error {},
  summarize: vi.fn(),
  classify: vi.fn(),
}));
import { POST as sourcePost } from "../src/app/api/admin/source-reviews/route";
import { POST as adminPost } from "../src/app/api/admin/route";
import { loadSourceReviewContext } from "../src/lib/source-reviews";
import {
  getOpportunity,
  getRadarStatus,
  listOpportunities,
} from "../src/lib/queries";
import { queueDigests, sendPending } from "../src/worker/notifications";
import { sendMail } from "../src/lib/mail";
import { enrichAndMatch } from "../src/worker/pipeline";
import { summarize, classify } from "../src/worker/ai";

// Only invented records in a fresh, in-memory database for every test.
// Session resolution and mail/AI transports are mocked; routes, repository,
// migrations and downstream readers execute their real implementation.
let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let viewer: Viewer;
let profileRevision: string;
const origin = "https://mandat.example.invalid";
const now = new Date("2030-02-01T10:00:00.000Z");
const publicationId = "invented-source-consumer";
const matchId = "invented-consumer-match";
const note =
  "PRIVATE SOURCE NOTE: osservazione inventata riservata al fondatore.";
const sourceUrl = "https://source.example.invalid/invented-notice";
const publication: Publication = {
  ...getDemoOpportunities()[1],
  id: publicationId,
  externalId: publicationId,
  canonicalKey: publicationId,
  title: "Pulizia dei locali della scuola immaginaria",
  buyer: "Ente completamente inventato",
  source: "simap",
  status: "open",
  canton: "TI",
  zone: "Luganese",
  location: "Comune inventato",
  sectors: ["pulizie"],
  cpv: [],
  visibleAt: "2020-01-01T00:00:00.000Z",
  deadline: "2099-01-01T10:00:00.000Z",
  publishedAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  originalText:
    "Testo inventato: pulire pavimenti e vetri degli uffici della scuola immaginaria.",
  originalTitles: [
    {
      language: "it",
      text: "Pulizia degli uffici inventati",
      path: "title.it",
      url: sourceUrl,
    },
  ],
  originalDescriptions: [],
  documentPages: [],
  documents: [],
  evidence: [],
  sourceUrl,
  sourceUrls: [sourceUrl],
  requirements: [],
  sourceConditions: [],
  revision: "invented-content-v1",
  summary: "Sintesi inventata precedente alla revisione della fonte.",
  reviewRequired: false,
  reviewReasons: [],
};
const revision = () =>
  `${publication.revision}:${profileRevision}:ready:invented-model:true`;
const rows = () => db.select().from(schema.matches);
const notifications = () => db.select().from(schema.notifications);
async function storedPublication() {
  const [row] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publicationId));
  return row;
}
async function updateSource(
  patch: Partial<Publication>,
  sourceRevision?: string,
) {
  const current = await storedPublication();
  await db
    .update(schema.publications)
    .set({
      data: { ...current.data, ...patch },
      ...(sourceRevision ? { revision: sourceRevision } : {}),
    })
    .where(eq(schema.publications.id, publicationId));
}
async function post(body: unknown, route = sourcePost) {
  return route(
    new Request(`${origin}/api/admin/source-reviews`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
async function sourceCommand(
  action: "opened" | "recorded" = "recorded",
  form: HumanSourceForm = "defined_service",
) {
  const loaded = await loadSourceReviewContext(publicationId, viewer);
  const unit = loaded.snapshot.source.accepted
    ? loaded.snapshot.source.corpus.units[0]
    : null;
  return {
    publicationId,
    expectedEventId: loaded.expected.eventId,
    expectedSourceSnapshotHash: loaded.expected.sourceSnapshotHash,
    expectedCorpusHash: loaded.expected.corpusHash,
    action,
    form: action === "opened" ? null : form,
    references:
      action === "recorded" && unit
        ? [
            {
              unitId: unit.id,
              originIndex: 0,
              startUtf16: 0,
              endUtf16: unit.text.length,
            },
          ]
        : [],
    note,
  };
}
async function sourceReview(
  action: "opened" | "recorded" = "recorded",
  form: HumanSourceForm = "defined_service",
) {
  const response = await post(await sourceCommand(action, form));
  expect(response.status).toBe(200);
  return loadSourceReviewContext(publicationId, viewer);
}
async function bindCurrent(form: HumanSourceForm = "defined_service") {
  const loaded = await sourceReview("recorded", form);
  await db
    .update(schema.matches)
    .set({ sourceReviewDependency: loaded.context.dependency })
    .where(eq(schema.matches.id, matchId));
  return loaded;
}
async function approve(body: Record<string, unknown> = {}) {
  const [currentMatch] = await rows();
  const currentPublication = await storedPublication();
  return post(
    {
      action: "review",
      id: matchId,
      approved: true,
      expectedProfileRevision: profileRevision,
      expectedEvaluationToken: matchReviewToken(currentMatch),
      expectedContentRevision: currentPublication.data.revision,
      ...body,
    },
    adminPost,
  );
}
async function approveCurrentSource() {
  const loaded = await bindCurrent();
  const [currentMatch] = await rows();
  expect(
    (
      await approve({
        expectedEvaluationRevision: currentMatch.revision,
        expectedSourceReviewDependency: loaded.context.dependency,
      })
    ).status,
  ).toBe(200);
  return loaded;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("APP_MODE", "live");
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  vi.stubEnv("LLM_MODEL", "invented-model");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network access in local consumer test");
    }),
  );
  pg = new PGlite();
  db = drizzle(pg, { schema });
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values([
    {
      id: "private-founder-identity",
      name: "Fondatore inventato",
      email: "founder@example.invalid",
    },
    {
      id: "invented-non-admin",
      name: "Utente inventato",
      email: "other@example.invalid",
    },
  ]);
  await db
    .insert(schema.administrators)
    .values({ userId: "private-founder-identity" });
  await db.insert(schema.companies).values({
    id: "invented-company",
    ownerId: "private-founder-identity",
    profile: {
      ...demoProfile,
      name: "Ditta inventata",
      sectors: ["pulizie"],
      exclusions: [],
      emailEnabled: true,
    },
    onboardedAt: now,
  });
  const [firm] = await db.select().from(schema.companies);
  profileRevision = fingerprint(firm.profile);
  viewer = {
    ...demoViewer,
    userId: firm.ownerId,
    companyId: firm.id,
    profile: firm.profile,
    admin: true,
    demo: false,
  };
  context.viewer = viewer;
  context.requireViewer.mockImplementation(async () => context.viewer);
  await db.insert(schema.invitations).values({
    id: "invented-invitation",
    email: "founder@example.invalid",
    companyId: firm.id,
    expiresAt: new Date("2099-01-01"),
    acceptedAt: now,
    acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
  });
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: true });
  await db.insert(schema.sourceRuns).values({
    id: "invented-source-run",
    source: "simap",
    status: "success",
    startedAt: now,
    finishedAt: now,
  });
  await db.insert(schema.publications).values({
    id: publicationId,
    canonicalId: publicationId,
    source: "simap",
    externalId: publicationId,
    title: publication.title,
    status: "open",
    visibleAt: new Date(publication.visibleAt),
    deadline: new Date(publication.deadline!),
    revision: "invented-source-v1",
    aiRevision: publication.revision,
    data: publication,
  });
  await db.insert(schema.matches).values({
    id: matchId,
    companyId: firm.id,
    publicationId,
    revision: revision(),
    score: 92,
    eligible: true,
    reason: "Motivazione inventata del confronto precedente.",
    approved: null,
    reviewedAt: null,
    reviewNotes: null,
  });
  vi.mocked(summarize).mockResolvedValue({
    summary: "Nuova sintesi inventata, senza variazioni degli originali.",
    sectors: ["pulizie"],
    requirements: [],
    evidence: [],
  });
  vi.mocked(classify).mockResolvedValue({
    score: 92,
    reason: "Confronto AI inventato nel test locale.",
    uncertain: false,
    needsReview: false,
  });
}, 30000);
afterEach(async () => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    context.db = db;
    await pg?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

describe("API privata della fonte con repository reale", () => {
  it.each(["nonadmin", "demo", "revoked-admin"])(
    "rifiuta %s senza creare eventi",
    async (kind) => {
      const command = await sourceCommand();
      context.viewer =
        kind === "demo"
          ? { ...viewer, demo: true }
          : kind === "nonadmin"
            ? { ...viewer, admin: false }
            : { ...viewer, userId: "invented-non-admin" };
      expect((await post(command)).status).toBe(403);
      expect(await db.select().from(schema.sourceReviewEvents)).toHaveLength(0);
      expect(context.requireViewer).toHaveBeenCalledWith({
        admin: true,
        mutation: true,
      });
    },
  );
  it("rifiuta actorId nel body e registra soltanto l’attore autenticato; riusare la stessa attesa produce 409", async () => {
    const command = await sourceCommand();
    expect((await post({ ...command, actorId: "forged-actor" })).status).toBe(
      400,
    );
    expect((await post(command)).status).toBe(200);
    expect((await post(command)).status).toBe(409);
    const history = await db.select().from(schema.sourceReviewEvents);
    expect(history).toHaveLength(1);
    expect(history[0].event.actorId).toBe(viewer.userId);
    expect(history[0].event.note).toBe(note);
  });
  it("risponde 409 se cambia un originale dopo l’apertura del modulo", async () => {
    const command = await sourceCommand();
    await updateSource({
      originalText: `${publication.originalText} Nuova prestazione inventata aggiunta.`,
    });
    expect((await post(command)).status).toBe(409);
    expect(await db.select().from(schema.sourceReviewEvents)).toHaveLength(0);
  });
});

describe("lettura Radar e decisioni manuali", () => {
  it("la policy solo umana recupera anche un low AI corrente come revisione, senza trasformarlo in uno scarto certo", async () => {
    await bindCurrent();
    await db
      .update(schema.matches)
      .set({ score: 12, eligible: false })
      .where(eq(schema.matches.id, matchId));
    // This replaces the earlier current-low exclusion test because the public
    // release now requires a separate human company decision for every tracked
    // source. Frozen diagnostic labels and the old campaign remain unchanged.
    expect(await listOpportunities(viewer)).toEqual([
      expect.objectContaining({ assessment: "uncertain", score: 0 }),
    ]);
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "uncertain",
      score: 0,
    });
    await db.insert(schema.feedback).values({
      id: "invented-saved-low",
      companyId: viewer.companyId,
      publicationId,
      saved: true,
    });
    expect(await listOpportunities(viewer, { includeInactive: true })).toEqual([
      expect.objectContaining({
        assessment: "uncertain",
        score: 0,
        saved: true,
      }),
    ]);
  });
  it("sospende anche un high automatico corrente e completa la revisione senza chiamate AI o pending perpetuo", async () => {
    await bindCurrent();
    expect((await rows())[0]).toMatchObject({ score: 92, approved: null });
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "uncertain",
      score: 0,
    });
    expect(await listOpportunities(viewer)).toEqual([
      expect.objectContaining({ assessment: "uncertain", score: 0 }),
    ]);
    await enrichAndMatch({ publicationId, now });
    expect(summarize).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({
      score: 0,
      eligible: true,
      approved: null,
    });
    expect(await getRadarStatus(viewer, now)).toEqual({
      state: "ready",
      pendingCount: 0,
    });
  });
  it("mantiene score zero anche quando una verifica legacy aperta precede il guard automatico della fonte", async () => {
    await updateSource({
      sourceScopeReview: {
        status: "required",
        kind: "ambiguous",
        token: "invented-legacy-review-token",
        sourceRevision: "invented-source-v1",
        updatedAt: now.toISOString(),
      },
    });
    await bindCurrent();
    await db
      .update(schema.matches)
      .set({
        revision: `${revision()}:source-scope:invented-legacy-review-token`,
      })
      .where(eq(schema.matches.id, matchId));
    expect((await rows())[0]).toMatchObject({ score: 92, approved: null });
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "uncertain",
      score: 0,
    });
    expect(await listOpportunities(viewer)).toEqual([
      expect.objectContaining({ assessment: "uncertain", score: 0 }),
    ]);
    expect((await storedPublication()).data.sourceScopeReview?.status).toBe(
      "required",
    );
  });
  it.each(["stale", "blocked"])(
    "recupera un low automatico %s con score zero, senza divulgare lo storico privato",
    async (state) => {
      await db
        .update(schema.matches)
        .set({ score: 12, eligible: false })
        .where(eq(schema.matches.id, matchId));
      await sourceReview(state === "blocked" ? "opened" : "recorded");
      const list = await listOpportunities(viewer);
      const detail = await getOpportunity(viewer, publicationId);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ assessment: "uncertain", score: 0 });
      expect(detail).toMatchObject({ assessment: "uncertain", score: 0 });
      const json = JSON.stringify({ list, detail });
      for (const privateValue of [
        note,
        viewer.userId,
        "sourceSnapshotHash",
        "reviewEventHash",
        "actorId",
        "history",
      ])
        expect(json).not.toContain(privateValue);
      expect((await rows())[0]).toMatchObject({ score: 12, eligible: false });
    },
  );
  it("preserva il rifiuto manuale e non ripropone la scheda durante la verifica della fonte", async () => {
    await db
      .update(schema.matches)
      .set({
        approved: false,
        eligible: false,
        reviewedAt: now,
        reviewNotes: "Decisione privata inventata da conservare.",
      })
      .where(eq(schema.matches.id, matchId));
    const before = (await rows())[0];
    await sourceReview("opened");
    expect(await listOpportunities(viewer)).toHaveLength(0);
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "rejected",
    });
    expect((await rows())[0]).toEqual(before);
  });
  it.each(["territory", "profile-exclusion"])(
    "conserva lo scarto del prefiltro per %s anche con fonte bloccata",
    async (kind) => {
      if (kind === "territory") await updateSource({ canton: "ZH" });
      else {
        viewer.profile = {
          ...viewer.profile,
          exclusions: ["scuola immaginaria"],
        };
        await db
          .update(schema.companies)
          .set({ profile: viewer.profile })
          .where(eq(schema.companies.id, viewer.companyId));
      }
      await sourceReview("opened");
      expect(await listOpportunities(viewer)).toHaveLength(0);
      expect(await getOpportunity(viewer, publicationId)).toMatchObject({
        assessment: "excluded",
        score: 0,
      });
    },
  );
  it("sospende il positivo legacy e consente una nuova approvazione soltanto con entrambe le attese correnti", async () => {
    await db
      .update(schema.matches)
      .set({ approved: true, reviewedAt: now })
      .where(eq(schema.matches.id, matchId));
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "reviewed",
    });
    const before = (await rows())[0];
    const loaded = await sourceReview();
    expect((await rows())[0]).toEqual(before);
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "uncertain",
      score: 0,
    });
    expect((await approve()).status).toBe(409);
    expect(
      (
        await approve({
          expectedEvaluationRevision: "obsolete-revision",
          expectedSourceReviewDependency: loaded.context.dependency,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await approve({
          expectedEvaluationRevision: before.revision,
          expectedSourceReviewDependency: loaded.context.dependency,
          expectedProfileRevision: undefined,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await approve({
          expectedEvaluationRevision: before.revision,
          expectedSourceReviewDependency: {
            ...loaded.context.dependency,
            sourceSnapshotHash: "0".repeat(64),
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await approve({
          expectedEvaluationRevision: before.revision,
          expectedSourceReviewDependency: loaded.context.dependency,
        })
      ).status,
    ).toBe(200);
    expect((await rows())[0].sourceReviewDependency).toEqual(
      loaded.context.dependency,
    );
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "reviewed",
    });
  });
  it("un secondo evento rende obsoleta anche un’attesa riferita allo stesso testo", async () => {
    const first = await sourceReview();
    await sourceReview();
    expect(
      (
        await approve({
          expectedEvaluationRevision: revision(),
          expectedSourceReviewDependency: first.context.dependency,
        })
      ).status,
    ).toBe(409);
  });
  it("non approva una fonte generica anche con attese correnti", async () => {
    const loaded = await sourceReview("recorded", "broad_scope");
    expect(
      (
        await approve({
          expectedEvaluationRevision: revision(),
          expectedSourceReviewDependency: loaded.context.dependency,
        })
      ).status,
    ).toBe(400);
    expect((await rows())[0].approved).toBeNull();
  });
  it("l’approvazione tracked rispetta un’esclusione esplicita del profilo e non modifica il match", async () => {
    await db
      .update(schema.companies)
      .set({
        profile: { ...viewer.profile, exclusions: ["scuola immaginaria"] },
      })
      .where(eq(schema.companies.id, viewer.companyId));
    const [firm] = await db.select().from(schema.companies);
    viewer.profile = firm.profile;
    profileRevision = fingerprint(firm.profile);
    const current = await sourceReview();
    const before = (await rows())[0];
    const response = await approve({
      expectedEvaluationRevision: before.revision,
      expectedSourceReviewDependency: current.context.dependency,
    });
    expect(response.status).toBe(400);
    expect((await rows())[0]).toEqual(before);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("la riapprovazione esplicita usa i contenuti attuali senza conservare il prefisso del vecchio match", async () => {
    await db
      .update(schema.matches)
      .set({ approved: true, reviewedAt: now })
      .where(eq(schema.matches.id, matchId));
    await sourceReview();
    await updateSource(
      {
        originalText: `${publication.originalText} Rettifica inventata dell’oggetto.`,
        revision: "invented-content-v2",
      },
      "invented-source-v2",
    );
    const current = await sourceReview();
    const response = await approve({
      expectedEvaluationRevision: revision(),
      expectedSourceReviewDependency: current.context.dependency,
    });
    expect(response.status).toBe(200);
    expect((await rows())[0].revision).toBe(
      `invented-content-v2:${profileRevision}:ready:manual-source-review:true`,
    );
    expect((await rows())[0].sourceReviewDependency).toEqual(
      current.context.dependency,
    );
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "reviewed",
    });
  });
  it("rifiuta un’approvazione aperta prima di una correzione editoriale, anche con fonte e match invariati", async () => {
    const source = await sourceReview();
    const before = (await rows())[0];
    const viewedContentRevision = (await storedPublication()).data.revision;
    const viewedEvaluationToken = matchReviewToken(before);
    await updateSource({
      summary: "Correzione editoriale inventata dopo l’apertura del modulo.",
      revision: "invented-editorial-after-view",
    });
    const fresh = await loadSourceReviewContext(publicationId, viewer);
    expect(fresh.context.dependency).toEqual(source.context.dependency);
    expect((await rows())[0]).toEqual(before);
    expect(
      (
        await approve({
          expectedEvaluationRevision: before.revision,
          expectedEvaluationToken: viewedEvaluationToken,
          expectedContentRevision: viewedContentRevision,
          expectedSourceReviewDependency: source.context.dependency,
        })
      ).status,
    ).toBe(409);
    expect((await rows())[0]).toEqual(before);
    expect(
      (
        await approve({
          expectedEvaluationRevision: before.revision,
          expectedEvaluationToken: viewedEvaluationToken,
          expectedContentRevision: fresh.publication.contentRevision,
          expectedSourceReviewDependency: fresh.context.dependency,
        })
      ).status,
    ).toBe(200);
    expect((await rows())[0].revision).toBe(
      `invented-editorial-after-view:${profileRevision}:ready:manual-source-review:true`,
    );
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "reviewed",
    });
  });
  it("rifiuta un’approvazione aperta sul profilo precedente e lega la nuova revisione al profilo letto dal database", async () => {
    const current = await sourceReview();
    await db
      .update(schema.companies)
      .set({
        profile: {
          ...viewer.profile,
          activities: "Attività inventata aggiornata per la prova del profilo.",
        },
      })
      .where(eq(schema.companies.id, viewer.companyId));
    expect(
      (
        await approve({
          expectedEvaluationRevision: revision(),
          expectedSourceReviewDependency: current.context.dependency,
        })
      ).status,
    ).toBe(409);
    const [firm] = await db.select().from(schema.companies);
    viewer.profile = firm.profile;
    const freshProfileRevision = fingerprint(firm.profile);
    expect(
      (
        await approve({
          expectedEvaluationRevision: revision(),
          expectedSourceReviewDependency: current.context.dependency,
          expectedProfileRevision: freshProfileRevision,
        })
      ).status,
    ).toBe(200);
    expect((await rows())[0].revision).toBe(
      `${publication.revision}:${freshProfileRevision}:ready:manual-source-review:true`,
    );
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "reviewed",
    });
  });
});

it.each(["editor-only", "profile"])(
  "un positivo manuale conservato dopo cambio %s richiede revisione, senza punteggio vecchio o pending perpetuo",
  async (change) => {
    const loaded = await bindCurrent();
    await db
      .update(schema.matches)
      .set({ approved: true, reviewedAt: now })
      .where(eq(schema.matches.id, matchId));
    const beforeMatch = (await rows())[0];
    if (change === "editor-only") {
      await updateSource({
        summary: "Sintesi editoriale inventata aggiornata.",
        revision: "invented-editorial-v2",
      });
      await db
        .update(schema.publications)
        .set({ aiRevision: "invented-editorial-v2" })
        .where(eq(schema.publications.id, publicationId));
    } else {
      await db
        .update(schema.companies)
        .set({
          profile: {
            ...viewer.profile,
            activities: "Servizi di pulizia aggiornati nel profilo inventato.",
          },
        })
        .where(eq(schema.companies.id, viewer.companyId));
      const [firm] = await db.select().from(schema.companies);
      viewer.profile = firm.profile;
    }
    // This fixture represents a retained human decision. The normal profile
    // update route may clear that decision; these readers must also handle a
    // preserved manual row without expecting the worker to overwrite it.
    await enrichAndMatch({ publicationId, now });
    expect((await rows())[0]).toEqual(beforeMatch);
    expect(classify).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(
      (await loadSourceReviewContext(publicationId, viewer)).context.dependency,
    ).toEqual(loaded.context.dependency);
    expect(await getRadarStatus(viewer, now)).toEqual({
      state: "ready",
      pendingCount: 0,
    });
    expect(await getOpportunity(viewer, publicationId)).toMatchObject({
      assessment: "uncertain",
      score: 0,
    });
    expect(await listOpportunities(viewer)).toEqual([
      expect.objectContaining({ assessment: "uncertain", score: 0 }),
    ]);
  },
);

describe("preparazione e presa in carico delle notifiche", () => {
  it("prepara e invia solo il controllo positivo approvato manualmente con dipendenza corrente, mantenendo note e attore fuori dall’email", async () => {
    const loaded = await approveCurrentSource();
    await queueDigests(now);
    const [queued] = await notifications();
    expect(queued).toBeDefined();
    expect(queued.items[0].sourceReviewDependency).toEqual(
      loaded.context.dependency,
    );
    await sendPending();
    expect(sendMail).toHaveBeenCalledOnce();
    expect((await notifications())[0].status).toBe("sent");
    const message = JSON.stringify(vi.mocked(sendMail).mock.calls[0][0]);
    expect(message).not.toContain(note);
    expect(message).not.toContain(viewer.userId);
  });
  it("non prepara né invia un digest high automatico tracked, anche con dipendenza corrente e automazione abilitata", async () => {
    const loaded = await bindCurrent();
    await queueDigests(now);
    expect(await notifications()).toHaveLength(0);
    // A legacy pending notification is also checked by the real send path.
    await db.insert(schema.notifications).values({
      id: "invented-old-automatic-digest",
      companyId: viewer.companyId,
      dedupeKey: "invented-old-automatic-digest",
      kind: "digest",
      subject: "Digest automatico inventato",
      html: "Testo inventato",
      textBody: "Testo inventato",
      items: [
        {
          id: publicationId,
          revision: publication.revision,
          sourceReviewDependency: loaded.context.dependency,
        },
      ],
    });
    await sendPending();
    expect(sendMail).not.toHaveBeenCalled();
    const [queued] = await notifications();
    expect(queued.attempts).toBe(0);
    expect(queued.status).not.toBe("sent");
  });
  it.each(["stale", "broad"])(
    "non prepara un digest per una dipendenza %s",
    async (kind) => {
      if (kind === "stale") {
        await approveCurrentSource();
        await sourceReview();
      } else await bindCurrent("broad_scope");
      await queueDigests(now);
      expect(await notifications()).toHaveLength(0);
      expect(sendMail).not.toHaveBeenCalled();
    },
  );
  it.each(["opened", "original-changed", "manual-rejected"])(
    "rilegge i dati quando %s arriva dopo i controlli preliminari e prima del claim",
    async (change) => {
      await approveCurrentSource();
      await queueDigests(now);
      expect(await notifications()).toHaveLength(1);
      let injected = false;
      // One PGlite connection, with a controlled commit immediately before the
      // claim transaction. This is not a two-connection PostgreSQL locking test.
      context.db = new Proxy(db, {
        get(target, property) {
          if (property === "transaction")
            return async (...args: Parameters<typeof db.transaction>) => {
              if (!injected) {
                injected = true;
                if (change === "opened") await sourceReview("opened");
                else if (change === "original-changed")
                  await updateSource({
                    originalText: `${publication.originalText} Originale cambiato prima del claim.`,
                  });
                else
                  expect(
                    (
                      await post(
                        { action: "review", id: matchId, approved: false },
                        adminPost,
                      )
                    ).status,
                  ).toBe(200);
              }
              return db.transaction(...args);
            };
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
      const [queued] = await notifications();
      expect(queued.attempts).toBe(0);
      expect(queued.status).not.toBe("sent");
      expect(queued.status).not.toBe("sending");
    },
  );
});

it("la policy solo umana non arricchisce la sintesi di una fonte tracked e conserva dipendenza e decisione manuale", async () => {
  const loaded = await bindCurrent();
  await db
    .update(schema.matches)
    .set({ approved: true, reviewedAt: now })
    .where(eq(schema.matches.id, matchId));
  const beforeMatch = (await rows())[0];
  const beforeHistory = await db.select().from(schema.sourceReviewEvents);
  await updateSource({ summary: null });
  await db
    .update(schema.publications)
    .set({ aiRevision: null })
    .where(eq(schema.publications.id, publicationId));
  await enrichAndMatch({ publicationId, now });
  expect(summarize).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect((await storedPublication()).data.summary).toBeNull();
  const after = await loadSourceReviewContext(publicationId, viewer);
  expect(after.context.dependency).toEqual(loaded.context.dependency);
  expect(after.snapshot).toEqual(loaded.snapshot);
  expect((await rows())[0]).toEqual(beforeMatch);
  expect(await db.select().from(schema.sourceReviewEvents)).toEqual(
    beforeHistory,
  );
});

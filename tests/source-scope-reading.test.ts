import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, demoViewer, getDemoOpportunities } from "../src/lib/demo";
import type {
  CompanyProfile,
  Publication,
  SourceScopeReview,
  Viewer,
} from "../src/lib/domain";
import { fingerprint } from "../src/sources/common";
import { preliminaryMatch } from "../src/lib/matching";
import { presentMatch } from "../src/lib/match-presentation";
import {
  hasSourceScopeReview,
  isMatchContentCurrent,
  isMatchRevisionCurrent,
  sourceScopeReviewReason,
  sourceScopeReviewSuffix,
} from "../src/lib/source-scope-review";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  viewer: undefined as unknown,
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/viewer", () => ({
  pageViewer: async () => context.viewer,
  HttpError: class extends Error {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/",
  notFound: () => {
    throw new Error("Not found");
  },
}));
import {
  getOpportunity,
  getRadarStatus,
  listOpportunities,
} from "../src/lib/queries";
import { adminSnapshot } from "../src/lib/admin";
import { Dashboard } from "../src/components/dashboard";
import { AdminDashboard } from "../src/components/admin-dashboard";
import Detail from "../src/app/bandi/[id]/page";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const required: SourceScopeReview = {
  status: "required",
  kind: "conflicting",
  token: "11111111-1111-4111-8111-111111111111",
  sourceRevision: "source-v1",
  updatedAt: "2030-01-01T00:00:00Z",
};
const resolved: SourceScopeReview = {
  ...required,
  status: "resolved",
  token: "22222222-2222-4222-8222-222222222222",
};
let viewers: Viewer[];
const revision = (viewer: Viewer, suffix = "") =>
  `content-v1:${fingerprint(viewer.profile)}:ready:test-model:true${suffix}`;
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const [id, activities] of [
    ["a", "Curiamo parchi e siepi."],
    ["b", "Piantiamo alberi e arbusti."],
  ]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db.insert(schema.companies).values({
      id,
      ownerId: id,
      profile: {
        ...demoProfile,
        name: `Ditta ${id}`,
        activities,
        sectors: ["giardinaggio"],
      },
      onboardedAt: new Date(),
    });
  }
  const companies = await db
    .select()
    .from(schema.companies)
    .orderBy(schema.companies.id);
  viewers = companies.map((c) => ({
    ...demoViewer,
    userId: c.id,
    companyId: c.id,
    demo: false,
    profile: c.profile,
  }));
  context.viewer = viewers[0];
});
beforeEach(async () => {
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  context.viewer = viewers[0];
  await db.delete(schema.publications);
  await db.delete(schema.issues);
  await db.delete(schema.settings);
  await db
    .insert(schema.settings)
    .values({ key: "worker_heartbeat", value: new Date().toISOString() });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

async function candidate(input: Partial<Publication> = {}, id = "p") {
  const p: Publication = {
    ...getDemoOpportunities()[0],
    id,
    externalId: id,
    source: "simap",
    revision: "content-v1",
    summary: "Sintesi già corretta.",
    reviewRequired: false,
    reviewReasons: [],
    sourceScopeReview: required,
    publishedAt: "2020-01-01T06:00:00Z",
    visibleAt: "2020-01-01T06:00:00Z",
    deadline: "2035-01-01T12:00:00Z",
    status: "open",
    canton: "TI",
    originalTitles: [
      {
        language: "it",
        text: "Titolo inventato",
        url: "https://example.invalid/title",
        path: "project-info.title.it",
      },
    ],
    ...input,
  };
  await db.insert(schema.publications).values({
    id,
    externalId: id,
    canonicalId: id,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    deadline: p.deadline ? new Date(p.deadline) : null,
    revision: "source-v1",
    aiRevision: "content-v1",
    data: p,
  });
  return p;
}
async function match(
  viewer = viewers[0],
  input: Partial<typeof schema.matches.$inferInsert> = {},
  publicationId = "p",
) {
  await db.insert(schema.matches).values({
    id: `${viewer.companyId}-${publicationId}`,
    companyId: viewer.companyId,
    publicationId,
    revision: revision(viewer),
    score: 90,
    reason: "Certezza AI precedente",
    eligible: true,
    ...input,
  });
}
const snapshot = async () => ({
  publications: await db
    .select({ row: schema.publications, token: sql<string>`updated_at::text` })
    .from(schema.publications),
  versions: await db.select().from(schema.publicationVersions),
  matches: await db
    .select({ row: schema.matches, token: sql<string>`updated_at::text` })
    .from(schema.matches),
});

describe("Token della revisione della fonte", () => {
  it("non risolve implicitamente uno stato aperto quando cambia la revisione fonte", () => {
    expect(hasSourceScopeReview({ sourceScopeReview: required })).toBe(true);
    expect(
      hasSourceScopeReview({
        sourceScopeReview: { ...required, sourceRevision: "old" },
      }),
    ).toBe(true);
    expect(hasSourceScopeReview({ sourceScopeReview: resolved })).toBe(false);
    expect(sourceScopeReviewSuffix({})).toBe("");
    expect(sourceScopeReviewSuffix({ sourceScopeReview: resolved })).toBe(
      `:source-scope:${resolved.token}`,
    );
  });
  it("riconosce il token terminale prima di retry e respinge token vecchi o disposizioni errate", () => {
    const p = { revision: "v1", sourceScopeReview: resolved };
    const base = "v1:profile:ready:model:true";
    const token = sourceScopeReviewSuffix(p);
    const current = (value: string) =>
      isMatchRevisionCurrent({
        revision: value,
        publication: p,
        profileRevision: "profile",
      });
    expect(current(base + token)).toBe(true);
    expect(current(base + token + ":retry")).toBe(true);
    for (const value of [
      base,
      base + sourceScopeReviewSuffix({ sourceScopeReview: required }),
      base + ":retry" + token,
      base + token + ":retry:retry",
      base + token + ":profile-update",
      base + token + token,
    ])
      expect(current(value)).toBe(false);
  });
  it("preserva le revisioni manuali soltanto sullo stesso contenuto e profilo", () => {
    const p = { revision: "v1", sourceScopeReview: resolved };
    const args = {
      publication: p,
      profileRevision: "profile",
      manuallyReviewed: true,
    };
    expect(
      isMatchRevisionCurrent({
        ...args,
        revision: "v1:profile:ready:model:true:retry",
      }),
    ).toBe(true);
    expect(
      isMatchRevisionCurrent({
        ...args,
        revision: "v0:profile:ready:model:true",
      }),
    ).toBe(false);
    expect(
      isMatchRevisionCurrent({
        ...args,
        revision: "v1:old-profile:ready:model:true",
      }),
    ).toBe(false);
    expect(
      isMatchContentCurrent({
        publication: p,
        profileRevision: "profile",
        revision: "v1:profile:ready:model:true",
      }),
    ).toBe(true);
  });
});

it("riporta due cache opposte alla verifica per due profili senza modificare i record", async () => {
  await candidate();
  await match(viewers[0]);
  await match(viewers[1], {
    eligible: false,
    score: 0,
    reason: "Scarto AI precedente",
  });
  const before = await snapshot();
  for (const viewer of viewers) {
    const listed = await listOpportunities(viewer);
    expect(listed).toHaveLength(1);
    expect(listed[0].assessment).toBe("uncertain");
    expect(listed[0].reason).toBe(sourceScopeReviewReason);
    expect((await getOpportunity(viewer, "p"))?.assessment).toBe("uncertain");
    expect(await getRadarStatus(viewer)).toEqual({
      state: "ready",
      pendingCount: 0,
    });
  }
  const data = await adminSnapshot(false);
  expect(data.matches.map((m) => m.assessment)).toEqual([
    "uncertain",
    "uncertain",
  ]);
  for (const item of data.matches) {
    expect(item.reviewRequired).toBe(true);
    expect(item.sourceScopeReview).toEqual(required);
    expect(item.sourceRevision).toBe("source-v1");
    expect(item.contentRevision).toBe("content-v1");
    expect(item.originalTitles).toHaveLength(1);
  }
  expect(await snapshot()).toEqual(before);
});

it("non crea un match o una proposta per la seconda ditta senza valutazione", async () => {
  await candidate();
  await match();
  expect(await listOpportunities(viewers[1])).toEqual([]);
  expect(await getOpportunity(viewers[1], "p")).toBeNull();
  expect((await getRadarStatus(viewers[1])).pendingCount).toBe(1);
});

it.each([
  {
    label: "territorio",
    p: { canton: "ZH" },
    profile: {},
    reason: "fuori dal Ticino",
  },
  {
    label: "zona",
    p: {},
    profile: { zones: ["Bellinzonese"] },
    reason: "zone selezionate",
  },
  {
    label: "esclusione",
    p: {},
    profile: { exclusions: ["verde"] },
    reason: "attività esclusa",
  },
  {
    label: "attività e parole chiave",
    p: {},
    profile: { sectors: [], keywords: ["inesistente"] },
    reason: "Nessun segnale di attività riconosciuto",
  },
  {
    label: "importo",
    p: { valueChf: 5000 },
    profile: { minValue: 10000 },
    reason: "fascia selezionata",
  },
])(
  "conserva il prefiltro $label nel Radar, dettaglio e admin",
  async ({ p, profile, reason }) => {
    const originalProfile = viewers[0].profile;
    try {
      await db
        .update(schema.companies)
        .set({ profile: { ...originalProfile, ...profile } as CompanyProfile })
        .where(eq(schema.companies.id, "a"));
      const [company] = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, "a"));
      const viewer = { ...viewers[0], profile: company.profile };
      await candidate(p);
      await match(viewer, {
        eligible: false,
        score: 0,
        reason: "Negativo AI non valido",
      });
      expect(await listOpportunities(viewer)).toEqual([]);
      const detail = await getOpportunity(viewer, "p");
      expect(detail?.assessment).toBe("excluded");
      expect(detail?.reason).toContain(reason);
      const data = await adminSnapshot(false);
      expect(data.matches[0].assessment).toBe("excluded");
      expect(data.matches[0].reason).toBe(detail?.reason);
    } finally {
      await db
        .update(schema.companies)
        .set({ profile: originalProfile })
        .where(eq(schema.companies.id, "a"));
    }
  },
);

it("conserva il rifiuto manuale nei salvati e non lo reintroduce nel Radar", async () => {
  await candidate();
  await match(viewers[0], {
    approved: false,
    reviewedAt: new Date(),
    eligible: false,
    reviewNotes: "private-actor: da conservare",
  });
  await db
    .insert(schema.feedback)
    .values({ id: "saved", companyId: "a", publicationId: "p", saved: true });
  const before = await snapshot();
  expect(await listOpportunities(viewers[0])).toEqual([]);
  expect(
    (await listOpportunities(viewers[0], { includeInactive: true }))[0]
      .assessment,
  ).toBe("rejected");
  expect((await getOpportunity(viewers[0], "p"))?.assessment).toBe("rejected");
  expect((await getRadarStatus(viewers[0])).pendingCount).toBe(0);
  expect(await snapshot()).toEqual(before);
});

it("mostra incerta una precedente approvazione manuale sotto flag, preservandola nel DB", async () => {
  await candidate();
  await match(viewers[0], {
    approved: true,
    reviewedAt: new Date(),
    reviewNotes: "private-reviewer",
  });
  const before = await snapshot();
  const [item] = await listOpportunities(viewers[0]);
  expect(item.assessment).toBe("uncertain");
  expect(JSON.stringify(item)).not.toContain("private-reviewer");
  const data = await adminSnapshot(false);
  expect(data.matches[0].approved).toBe(true);
  expect(data.matches[0].reviewed).toBe(true);
  expect(data.matches[0].assessment).toBe("uncertain");
  expect(await snapshot()).toEqual(before);
});

it("dopo resolved attende una nuova valutazione automatica senza cancellare i manuali correnti", async () => {
  const p = await candidate();
  await match(viewers[0], {
    revision: revision(viewers[0], sourceScopeReviewSuffix(p)),
  });
  await match(viewers[1], {
    revision: revision(viewers[1], sourceScopeReviewSuffix(p)),
    approved: true,
    reviewedAt: new Date(),
  });
  await db
    .update(schema.publications)
    .set({ data: { ...p, sourceScopeReview: resolved } })
    .where(eq(schema.publications.id, "p"));
  expect((await getOpportunity(viewers[0], "p"))?.assessment).toBe(
    "preliminary",
  );
  expect((await getRadarStatus(viewers[0])).pendingCount).toBe(1);
  expect((await getOpportunity(viewers[1], "p"))?.assessment).toBe("reviewed");
  expect((await getRadarStatus(viewers[1])).pendingCount).toBe(0);
  await db
    .update(schema.matches)
    .set({
      revision: revision(
        viewers[0],
        sourceScopeReviewSuffix({ sourceScopeReview: resolved }),
      ),
    })
    .where(eq(schema.matches.id, "a-p"));
  expect((await getOpportunity(viewers[0], "p"))?.assessment).toBe("ai");
  expect((await getRadarStatus(viewers[0])).pendingCount).toBe(0);
});

it("non ripristina una revisione manuale di contenuto o profilo diversi dopo resolved", async () => {
  await candidate({ sourceScopeReview: resolved });
  await match(viewers[0], {
    revision: "old-content:old-profile:ready:model:true",
    approved: true,
    reviewedAt: new Date(),
  });
  expect((await getOpportunity(viewers[0], "p"))?.assessment).toBe(
    "preliminary",
  );
  expect((await getRadarStatus(viewers[0])).pendingCount).toBe(1);
});

it("conserva salvati, visibilità, stato e autorizzazione Foglio senza espandere il Radar", async () => {
  await candidate({ source: "foglio-ti" }, "foglio");
  await match(viewers[0], { eligible: false }, "foglio");
  await candidate({ visibleAt: "2035-01-01T00:00:00Z" }, "future");
  await match(viewers[0], {}, "future");
  await candidate({ deadline: "2020-01-02T00:00:00Z" }, "expired");
  await match(viewers[0], {}, "expired");
  await candidate({ status: "cancelled" }, "cancelled");
  await match(viewers[0], {}, "cancelled");
  expect(await listOpportunities(viewers[0])).toEqual([]);
  expect(await getOpportunity(viewers[0], "foglio")).toBeNull();
  expect(await getOpportunity(viewers[0], "future")).toBeNull();
  expect((await getOpportunity(viewers[0], "expired"))?.reason).toContain(
    "scaduto",
  );
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "true");
  expect((await listOpportunities(viewers[0])).map((p) => p.id)).toEqual([
    "foglio",
  ]);
  expect(
    await listOpportunities(viewers[0], { includeInactive: true }),
  ).toEqual([]);
});

it("rende la cautela visibile in card, dettaglio e admin senza vecchie certezze", async () => {
  await candidate();
  await match(viewers[0], { reviewNotes: "private-actor-sensitive" });
  const opportunities = await listOpportunities(viewers[0]);
  const html = [
    renderToStaticMarkup(
      createElement(Dashboard, { viewer: viewers[0], opportunities }),
    ),
    renderToStaticMarkup(
      await Detail({ params: Promise.resolve({ id: "p" }) }),
    ),
    renderToStaticMarkup(
      createElement(AdminDashboard, {
        viewer: viewers[0],
        data: await adminSnapshot(false),
      }),
    ),
  ];
  for (const value of html) {
    expect(value).toContain("Pertinenza da verificare");
    expect(value).toContain("richiede una verifica della fonte");
    expect(value).not.toContain("Certezza AI precedente");
    expect(value).not.toContain("private-actor-sensitive");
    expect(value).not.toContain("Stima AI · 90/100");
  }
});

it("un solo avviso sulla data non degrada il giudizio AI e un low normale resta escluso", async () => {
  await candidate({
    sourceScopeReview: undefined,
    reviewRequired: true,
    reviewReasons: ["Data da verificare"],
  });
  await match();
  expect((await getOpportunity(viewers[0], "p"))?.assessment).toBe("ai");
  await db
    .update(schema.matches)
    .set({ eligible: false, score: 0 })
    .where(eq(schema.matches.id, "a-p"));
  expect(await listOpportunities(viewers[0])).toEqual([]);
  expect((await getOpportunity(viewers[0], "p"))?.assessment).toBe("excluded");
});

it("il prefiltro vince anche su un positivo manuale sotto flag senza mutare la revisione", async () => {
  const p = await candidate({ canton: "ZH" });
  await match(viewers[0], { approved: true, reviewedAt: new Date() });
  const [m] = await db.select().from(schema.matches);
  const result = presentMatch({
    match: m,
    publication: p,
    aiRevision: p.revision,
    profileRevision: fingerprint(viewers[0].profile),
    preliminary: preliminaryMatch(p, viewers[0].profile),
  });
  expect(result.assessment).toBe("excluded");
  expect(result.reason).toContain("fuori dal Ticino");
});

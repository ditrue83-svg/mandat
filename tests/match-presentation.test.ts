import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, demoViewer, getDemoOpportunities } from "../src/lib/demo";
import type { MatchAssessment, Viewer } from "../src/lib/domain";
import { fingerprint } from "../src/sources/common";

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
import { getOpportunity, listOpportunities } from "../src/lib/queries";
import { adminSnapshot } from "../src/lib/admin";
import { Dashboard } from "../src/components/dashboard";
import { AdminDashboard } from "../src/components/admin-dashboard";
import Detail from "../src/app/bandi/[id]/page";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const viewer: Viewer = {
  ...demoViewer,
  userId: "a",
  companyId: "a",
  demo: false,
};
let revision: string;
const originalReason =
  "Vecchio motivo positivo che non deve sembrare verificato";

beforeAll(async () => {
  context.db = db;
  context.viewer = viewer;
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const id of ["a", "b"]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db.insert(schema.companies).values({
      id,
      ownerId: id,
      profile: demoProfile,
      onboardedAt: new Date(),
    });
  }
  // Match production: both the viewer and the worker read the JSONB profile.
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, "a"));
  viewer.profile = company.profile;
  revision = `v1:${fingerprint(viewer.profile)}:ready:test-model:true`;
});
beforeEach(async () => {
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  await db.delete(schema.publications);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

async function candidate({
  match = {},
  summary = "Riassunto di prova",
  aiRevision = "v1",
  reviewRequired = false,
}: {
  match?: Partial<typeof schema.matches.$inferInsert>;
  summary?: string | null;
  aiRevision?: string | null;
  reviewRequired?: boolean;
} = {}) {
  const p = {
    ...getDemoOpportunities()[0],
    id: "p",
    externalId: "p",
    source: "simap" as const,
    revision: "v1",
    summary,
    reviewRequired,
    reviewReasons: reviewRequired ? ["Date discordanti nella fonte"] : [],
  };
  await db.insert(schema.publications).values({
    id: p.id,
    externalId: p.externalId,
    canonicalId: p.id,
    title: p.title,
    source: p.source,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    deadline: new Date(p.deadline!),
    revision: p.revision,
    aiRevision,
    data: p,
  });
  await db.insert(schema.matches).values({
    id: "a-p",
    companyId: "a",
    publicationId: p.id,
    revision,
    eligible: true,
    score: 85,
    reason: originalReason,
    ...match,
  });
}

it.each<{
  label: string;
  input: () => Parameters<typeof candidate>[0];
  assessment: MatchAssessment;
  keepReason: boolean;
}>([
  {
    label: "riassunto non completato",
    input: () => ({
      summary: null,
      aiRevision: null,
      match: {
        revision: revision.replace(":ready:", ":pending:"),
        reviewNotes: "Richiesta revisione",
      },
    }),
    assessment: "preliminary",
    keepReason: false,
  },
  {
    label: "classificazione fallita",
    input: () => ({
      match: {
        revision: `${revision}:retry`,
        reviewNotes: "Richiesta revisione",
      },
    }),
    assessment: "preliminary",
    keepReason: false,
  },
  {
    label: "classificazione riuscita ma incerta",
    input: () => ({ match: { reviewNotes: "Richiesta revisione" } }),
    assessment: "uncertain",
    keepReason: false,
  },
  {
    label: "AI riuscita in attesa di revisione manuale",
    input: () => ({ match: { approved: null } }),
    assessment: "ai",
    keepReason: true,
  },
  {
    label: "approvazione manuale di una classificazione fallita",
    input: () => ({
      match: {
        revision: `${revision}:retry`,
        approved: true,
        reviewedAt: new Date(),
        reviewNotes: "Revisione manuale: private-user-id",
      },
    }),
    assessment: "reviewed",
    keepReason: false,
  },
  {
    label: "valutazione di un profilo precedente",
    input: () => ({
      match: { revision: "v1:old-profile:ready:test-model:true" },
    }),
    assessment: "preliminary",
    keepReason: false,
  },
])(
  "presenta correttamente $label nelle due query",
  async ({ input, assessment, keepReason }) => {
    await candidate(input());
    const [listed] = await listOpportunities(viewer);
    const detail = await getOpportunity(viewer, "p");
    for (const item of [listed, detail]) {
      expect(item?.assessment).toBe(assessment);
      expect(item?.reason === originalReason).toBe(keepReason);
      expect(item).not.toHaveProperty("reviewNotes");
      expect(JSON.stringify(item)).not.toContain("private-user-id");
    }
  },
);

it("conserva un rifiuto nei salvati senza riproporre il motivo positivo", async () => {
  await candidate({
    match: {
      approved: false,
      eligible: false,
      reviewedAt: new Date(),
      reviewNotes: "Revisione manuale: private-user-id",
    },
  });
  await db.insert(schema.feedback).values({
    id: "saved",
    companyId: "a",
    publicationId: "p",
    saved: true,
  });
  expect(await listOpportunities(viewer)).toEqual([]);
  const [saved] = await listOpportunities(viewer, { includeInactive: true });
  const detail = await getOpportunity(viewer, "p");
  expect(saved.assessment).toBe("rejected");
  expect(detail?.assessment).toBe("rejected");
  expect(saved.reason).not.toBe(originalReason);
  const html = renderToStaticMarkup(
    await Detail({ params: Promise.resolve({ id: "p" }) }),
  );
  expect(html).toContain("Valutata non pertinente");
  expect(html).not.toContain(originalReason);
});

it("non usa valutazioni o revisioni manuali di un'altra ditta", async () => {
  await candidate({ match: { revision: `${revision}:retry` } });
  const other = { ...viewer, companyId: "b", userId: "b" };
  expect(await getOpportunity(other, "p")).toBeNull();
  expect(await listOpportunities(other)).toEqual([]);
  await db.insert(schema.matches).values({
    id: "b-p",
    companyId: "b",
    publicationId: "p",
    revision,
    eligible: true,
    score: 90,
    reason: "Approvata per l'altra ditta",
    approved: true,
    reviewedAt: new Date(),
    reviewNotes: "Revisione manuale: other-private-user",
  });
  expect((await getOpportunity(other, "p"))?.assessment).toBe("reviewed");
  expect((await getOpportunity(viewer, "p"))?.assessment).toBe("preliminary");
  expect(JSON.stringify(await listOpportunities(viewer))).not.toContain(
    "other-private-user",
  );
});

it("segnala analisi incompleta nella card, scheda e area fondatore senza punteggio AI", async () => {
  await candidate({
    match: {
      revision: `${revision}:retry`,
      reviewNotes: "Errore interno da non esporre",
    },
  });
  const opportunities = await listOpportunities(viewer);
  const card = renderToStaticMarkup(
    createElement(Dashboard, { viewer, opportunities }),
  );
  const detail = renderToStaticMarkup(
    await Detail({ params: Promise.resolve({ id: "p" }) }),
  );
  const data = await adminSnapshot(false);
  const admin = renderToStaticMarkup(
    createElement(AdminDashboard, { viewer, data }),
  );
  for (const html of [card, detail, admin]) {
    expect(html).toContain("Pertinenza da verificare");
    expect(html).toContain("non è ancora completata");
    expect(html).not.toContain(originalReason);
    expect(html).not.toContain("Errore interno da non esporre");
    expect(html).not.toContain("85/100");
  }
  expect(data.matches[0].assessment).toBe("preliminary");
  expect(data.matches[0]).not.toHaveProperty("reviewNotes");
});

it("distingue dati del bando da verificare da una classificazione AI riuscita", async () => {
  await candidate({ reviewRequired: true });
  const opportunities = await listOpportunities(viewer);
  expect(opportunities[0].assessment).toBe("ai");
  const card = renderToStaticMarkup(
    createElement(Dashboard, { viewer, opportunities }),
  );
  const detail = renderToStaticMarkup(
    await Detail({ params: Promise.resolve({ id: "p" }) }),
  );
  const data = await adminSnapshot(false);
  const admin = renderToStaticMarkup(
    createElement(AdminDashboard, { viewer, data }),
  );
  expect(card).toContain("Dati del bando da verificare");
  expect(card).toContain("Pertinenza stimata dall’AI");
  expect(detail).toContain("Date discordanti nella fonte");
  expect(admin).toContain("Stima AI · 85/100");
  expect(admin).toContain("Date discordanti nella fonte");
});

it("non attribuisce all'AI un'esclusione dei filtri iniziali", async () => {
  await candidate({
    aiRevision: null,
    summary: null,
    match: {
      revision: revision.replace(":ready:", ":pending:"),
      eligible: false,
      score: 0,
      reason: "Contiene un’attività esclusa dal tuo profilo.",
    },
  });
  expect((await getOpportunity(viewer, "p"))?.assessment).toBe("excluded");
  expect((await getOpportunity(viewer, "p"))?.reason).toContain(
    "attività esclusa",
  );
  await db
    .update(schema.matches)
    .set({ revision: `${revision}:profile-update` })
    .where(eq(schema.matches.id, "a-p"));
  expect((await getOpportunity(viewer, "p"))?.assessment).toBe("preliminary");
});

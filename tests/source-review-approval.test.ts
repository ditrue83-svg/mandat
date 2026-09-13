import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, demoViewer, getDemoOpportunities } from "../src/lib/demo";
import type { Publication, Viewer } from "../src/lib/domain";
import { fingerprint } from "../src/sources/common";
import { matchReviewToken } from "../src/lib/match-review-token";

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
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  escapeHtml: (value: string) => value.replace(/</g, "&lt;"),
  sendMail: vi.fn(async () => {
    throw new Error("Unexpected SMTP in local test");
  }),
}));
import { POST as sourcePost } from "../src/app/api/admin/source-reviews/route";
import { POST as adminPost } from "../src/app/api/admin/route";
import { loadSourceReviewContext } from "../src/lib/source-reviews";
import { queueDigests } from "../src/worker/notifications";
import { sendMail } from "../src/lib/mail";

// Independent regression reproductions: invented fixtures, real route/repository
// and migrations in ephemeral PGlite; no AI or SMTP transport is exercised.
let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let viewer: Viewer;
const origin = "https://approval-test.example.invalid";
const now = new Date("2030-02-01T10:00:00.000Z");
const publicationId = "invented-approval-source";
const matchId = "invented-approval-match";
const oldReason =
  "OLD_NEGATIVE_REASON: la prestazione è stata scartata dall’AI.";
const sourceUrl = "https://source.example.invalid/approval-test";
const publication: Publication = {
  ...getDemoOpportunities()[1],
  id: publicationId,
  externalId: publicationId,
  canonicalKey: publicationId,
  title: "Pulizia degli uffici inventati",
  source: "simap",
  status: "open",
  canton: "TI",
  zone: "Luganese",
  sectors: ["pulizie"],
  cpv: [],
  visibleAt: "2020-01-01T00:00:00.000Z",
  publishedAt: "2020-01-01T00:00:00.000Z",
  deadline: "2099-01-01T10:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  originalText:
    "Testo inventato: pulizia dei pavimenti e dei vetri degli uffici.",
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
  requirements: [],
  sourceConditions: [],
  sourceUrl,
  sourceUrls: [sourceUrl],
  revision: "invented-content-v1",
  summary: "Sintesi inventata.",
  reviewRequired: false,
  reviewReasons: [],
};
const row = async () =>
  (
    await db.select().from(schema.matches).where(eq(schema.matches.id, matchId))
  )[0];
async function post(body: unknown, route = adminPost) {
  return route(
    new Request(`${origin}/api/admin`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
async function approvalCommand() {
  const current = await row();
  const source = await loadSourceReviewContext(publicationId, viewer);
  return {
    action: "review",
    id: matchId,
    approved: true,
    expectedEvaluationRevision: current.revision,
    expectedEvaluationToken: matchReviewToken(current),
    expectedContentRevision: source.publication.contentRevision,
    expectedProfileRevision: fingerprint(viewer.profile),
    expectedSourceReviewDependency: source.context.dependency,
  };
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
      throw new Error("Unexpected network access");
    }),
  );
  pg = new PGlite();
  db = drizzle(pg, { schema });
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values({
    id: "invented-founder",
    name: "Fondatore inventato",
    email: "founder@example.invalid",
  });
  await db.insert(schema.administrators).values({ userId: "invented-founder" });
  await db.insert(schema.companies).values({
    id: "invented-approval-company",
    ownerId: "invented-founder",
    profile: {
      ...demoProfile,
      sectors: ["pulizie"],
      exclusions: [],
      emailEnabled: true,
    },
    onboardedAt: now,
  });
  const [firm] = await db.select().from(schema.companies);
  viewer = {
    ...demoViewer,
    userId: firm.ownerId,
    companyId: firm.id,
    profile: firm.profile,
    admin: true,
    demo: false,
  };
  context.viewer = viewer;
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: true });
  await db.insert(schema.sourceRuns).values({
    id: "invented-approval-run",
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
    revision: `${publication.revision}:${fingerprint(firm.profile)}:ready:invented-model:true`,
    score: 10,
    eligible: false,
    reason: oldReason,
    approved: null,
    reviewedAt: null,
    reviewNotes: null,
  });
  const source = await loadSourceReviewContext(publicationId, viewer);
  if (!source.snapshot.source.accepted)
    throw new Error("Invented complete source must be accepted");
  const unit = source.snapshot.source.corpus.units[0];
  const response = await post(
    {
      publicationId,
      expectedEventId: source.expected.eventId,
      expectedSourceSnapshotHash: source.expected.sourceSnapshotHash,
      expectedCorpusHash: source.expected.corpusHash,
      action: "recorded",
      form: "defined_service",
      references: [
        {
          unitId: unit.id,
          originIndex: 0,
          startUtf16: 0,
          endUtf16: unit.text.length,
        },
      ],
      note: "Nota privata inventata della revisione della fonte.",
    },
    sourcePost,
  );
  expect(response.status).toBe(200);
}, 30000);
afterEach(async () => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  } finally {
    await pg?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

describe("independent regressions for source-bound manual approval", () => {
  it("refuses an approval viewed before a newer rejection, while allowing an explicitly refreshed approval", async () => {
    const staleApproval = await approvalCommand();
    expect(
      (await post({ action: "review", id: matchId, approved: false })).status,
    ).toBe(200);
    const rejected = await row();
    expect(rejected.revision).toBe(staleApproval.expectedEvaluationRevision);
    expect(matchReviewToken(rejected)).not.toBe(
      staleApproval.expectedEvaluationToken,
    );
    expect(rejected).toMatchObject({
      approved: false,
      eligible: false,
      sourceReviewDependency: null,
    });

    expect((await post(staleApproval)).status).toBe(409);
    expect(await row()).toEqual(rejected);

    expect((await post(await approvalCommand())).status).toBe(200);
    const refreshed = await row();
    expect(refreshed).toMatchObject({
      approved: true,
      eligible: true,
      score: 60,
    });
    expect(refreshed.sourceReviewDependency).toEqual(
      staleApproval.expectedSourceReviewDependency,
    );
  });

  it("renders the manual approval rationale in the digest without overwriting the stored old AI reason", async () => {
    expect((await post(await approvalCommand())).status).toBe(200);
    expect((await row()).reason).toBe(oldReason);
    await queueDigests(now);
    const queued = await db.select().from(schema.notifications);
    expect(queued).toHaveLength(1);
    for (const body of [queued[0].html, queued[0].textBody]) {
      expect(body).toContain("Pertinenza revisionata");
      expect(body).toContain(
        "La proposta è stata ritenuta pertinente in una revisione manuale.",
      );
      expect(body).not.toContain("OLD_NEGATIVE_REASON");
      expect(body).not.toContain("invented-founder");
      expect(body).not.toContain("Nota privata inventata");
    }
  });
});

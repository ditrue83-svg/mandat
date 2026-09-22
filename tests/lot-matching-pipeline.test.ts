import {
  inventedSourceEvidenceAnswer,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import type { CompanyProfile } from "../src/lib/domain";
import type { StoredAutomaticComparison } from "../src/lib/automatic-comparison";
import { normalizeSimap } from "../src/sources/simap";
import {
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
} from "../src/sources/simap-documentary";
import { preserveSimapLots } from "../src/lib/source-lots";
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
import { AUTOMATIC_COMPARISON_QUEUE } from "../src/lib/automatic-comparison-queue";
import {
  reconcileAutomaticComparisonLeases,
  runAutomaticComparison,
} from "../src/worker/automatic-matching";
import {
  lotNoticeScope,
  buildLotNotice,
  validateLotNotice,
} from "../src/lib/lot-notice";
import { renderLotNoticeContent } from "../src/lib/notification-content";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
import {
  LOT_WORKER_REVIEW_VERSION,
  matchAdoptedPublication,
} from "../src/worker/lot-matching";

const injected = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
vi.mock("@/lib/viewer", () => ({
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
  infer: vi.fn(),
}));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: vi.fn() }));
vi.mock("@/lib/source-reviews", async (original) => ({
  ...(await original<typeof import("../src/lib/source-reviews")>()),
  readSourceReviewContext: vi.fn(async () => null),
}));
import { summarize, classify, infer } from "../src/worker/ai";
import { readSourceReviewContext } from "../src/lib/source-reviews";
import { enrichAndMatch, storePublication } from "../src/worker/pipeline";
import {
  appendLotSourceReview,
  loadLotSourceReview,
} from "../src/lib/lot-source-reviews";
import {
  appendLotMatchReview,
  loadLotMatchReview,
  lotMatchReviewTarget,
} from "../src/lib/lot-match-reviews";

// Invented sources and firms. Real local migrations and pg-boss producer;
// adoption below is test setup, not an application adoption procedure. PGlite
// interleavings do not prove PostgreSQL two-backend locking or semantic quality.
const pg = new PGlite(),
  db = drizzle(pg, { schema });
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const viewer = { userId: "lot-worker-founder", admin: true, demo: false };
const now = new Date("2030-01-10T10:00:00.000Z");
const commonText = "Progetto inventato: rete elettrica con incarichi separati.";
const lotText = "Potatura degli alberi del parco, lotto inventato.";
const baseProfile: CompanyProfile = {
  name: "Impresa inventata",
  activities: "Potatura e cura degli alberi",
  employees: 3,
  sectors: ["giardinaggio"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
  emailEnabled: true,
};
beforeAll(async () => {
  injected.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await boss.start();
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.createQueue(AUTOMATIC_COMPARISON_QUEUE);
  await boss.stop();
  await db.insert(schema.user).values({
    id: viewer.userId,
    name: "Fondatore inventato",
    email: "lot-worker@example.invalid",
  });
  await db.insert(schema.administrators).values({ userId: viewer.userId });
}, 20000);
beforeEach(async () => {
  vi.stubEnv("DOCUMENTARY_COMPARISON_ENABLED", "false");
  vi.stubEnv("DOCUMENTARY_LLM_MODEL", "");
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "");
  vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "");
  vi.stubEnv("LLM_REASONING_EFFORT", "");
  vi.stubEnv("LLM_MODEL", "invented-documentary-model");
  vi.stubEnv("LLM_INPUT_CHF_PER_MILLION", "1");
  vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "2");
  vi.mocked(infer)
    .mockReset()
    .mockRejectedValue(new Error("Unexpected documentary AI call"));
  injected.db = db;
  await db.update(schema.companies).set({ disabledAt: new Date() });
  vi.mocked(summarize)
    .mockReset()
    .mockRejectedValue(new Error("Unexpected AI call"));
  vi.mocked(classify)
    .mockReset()
    .mockRejectedValue(new Error("Unexpected AI call"));
  vi.mocked(readSourceReviewContext).mockClear();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await boss.stop();
  await pg.close();
});

function inventedAnswer(prompt: string) {
  const data = JSON.parse(prompt);
  if (data.stage === "original_source_evidence")
    return inventedSourceEvidenceAnswer(data);
  if (data.assignedClaims) {
    return {
      chunkId: data.chunkId,
      sourceEvidenceHash: data.sourceEvidenceHash,
      coverage: "complete",
      checks: data.assignedClaims.map(
        (claim: { id: string; sourceRefs: string[] }) => ({
          claimId: claim.id,
          readingRefs: inventedReadingRefs(data, claim),
          verdict: "supported",
          reason:
            "Riscontro inventato per verificare il flusso, non il modello.",
          sourceRefs: claim.sourceRefs,
        }),
      ),
      findings: [],
    };
  }
  if (!data.company) {
    const target = data.passages.find(
      (passage: { scope: string; role: string }) =>
        passage.scope === data.targetScope && passage.role === "service",
    );
    return {
      status: "resolved",
      details: [],
      summary:
        "Potatura degli alberi, fonte inventata per la verifica della coda.",
      classificationReadings: data.classificationContext.map(
        (classification: {
          id: string;
          appliesTo: string;
          code: { sourceRefs: string[] } | null;
          labels: { sourceRefs: string[] }[];
        }) => ({
          classificationId: classification.id,
          use:
            classification.appliesTo === "shared_project_context"
              ? "shared_project_only"
              : "broad_context",
          explanation:
            "Contesto inventato; il lavoro è esplicito nella descrizione.",
          sourceRefs: [
            ...(classification.code?.sourceRefs ?? []),
            ...classification.labels.flatMap((label) => label.sourceRefs),
          ],
        }),
      ),
      components: [
        {
          description: "Potatura degli alberi",
          role: "execute",
          roleEvidence: {
            state: "identified",
            actionText: Array.from(target.text as string)
              .slice(0, 80)
              .join(""),
            sourceRefs: [target.id],
            scope: target.scope,
          },
          importance: "main",
          sourceRefs: [target.id],
          meaning: {
            state: "identified",
            statement: "Potatura degli alberi",
            basis: "explicit_text",
            objectRefs: [target.id],
            classificationContextIds: [],
          },
        },
      ],
      issues: [],
      targetRef: target.id,
    };
  }
  return {
    comparison: "Risposta inventata per la sola verifica tecnica della coda.",
    interpretationHash: data.sourceInterpretation.hash,
    reviewHash: data.sourceInterpretation.reviewHash,
    componentRefs: [data.sourceInterpretation.components[0].id],
    companyRefs: [data.company.activities[0].id],
    facts: {
      companyIdentifiesService: true,
      activitiesOverlap: true,
      sameContractualRole: true,
      mainScopeCovered: true,
      comparisonUncertain: false,
    },
  };
}
async function automaticFixture(
  project = false,
  profile = baseProfile,
  sourceText?: string,
  contextText?: string,
) {
  vi.stubEnv("DOCUMENTARY_COMPARISON_ENABLED", "true");
  const f = await fixture({
      empty: project,
      automaticProject: project,
      sourceText,
      contextText,
    }),
    companyId = await company(profile);
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.publicationId, f.p.id));
  expect(run).toBeDefined();
  const job = { runId: run.id, publicationId: f.p.id, companyId };
  return { f, companyId, run, job };
}

async function automaticJob(publicationId: string, companyId: string) {
  await matchAdoptedPublication({ publicationId, now });
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(
      and(
        eq(schema.automaticMatchRuns.publicationId, publicationId),
        eq(schema.automaticMatchRuns.companyId, companyId),
      ),
    );
  expect(run).toBeDefined();
  return { runId: run.id, publicationId, companyId };
}

async function storedAutomaticResult(runId: string) {
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, runId));
  expect(run.status).toBe("completed");
  return run.result as StoredAutomaticComparison;
}

it("Durably schedules once, completes a referenced comparison, and never creates a human quality vote", async () => {
  const { f, companyId, job } = await automaticFixture();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  expect(
    await db
      .select()
      .from(schema.automaticMatchRuns)
      .where(eq(schema.automaticMatchRuns.publicationId, f.p.id)),
  ).toHaveLength(1);
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "completed",
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  expect(infer).toHaveBeenCalledTimes(4);
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.project.targets[0].automatic?.serviceRelation).toBe("direct");
  expect(loaded.project.qualityEventIds).toEqual([]);
  expect(loaded.project.quality).toBe("unresolved");
  expect((await rows(f.p.id))[0].lotEvaluations).toBeNull();
});

it("Reuses only the public interpretation for another company and creates a fresh private comparison", async () => {
  const activityA =
    "Potatura e cura degli alberi, dettaglio riservato impresa A";
  const activityB = "Manutenzione di alberi, dettaglio riservato impresa B";
  const { f, job } = await automaticFixture(false, {
    ...baseProfile,
    activities: activityA,
  });
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  await runAutomaticComparison(job, { now: () => now });
  const first = await storedAutomaticResult(job.runId);
  const firstCalls = vi.mocked(infer).mock.calls;
  expect(firstCalls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
    "documentary-source-evidence",
    "documentary-source-semantic-review",
    "documentary-service-comparison",
  ]);
  for (const sourceCall of firstCalls.slice(0, 2)) {
    const sourcePrompt = sourceCall[2];
    expect(JSON.parse(sourcePrompt).company).toBeUndefined();
    expect(sourcePrompt).not.toContain(activityA);
    expect(sourcePrompt).not.toContain(activityB);
  }
  expect(JSON.stringify(first.sourceInterpretation)).not.toContain(activityA);
  expect(JSON.stringify(first.sourceReview)).not.toContain(activityA);

  vi.mocked(infer).mockClear();
  const other = await company({ ...baseProfile, activities: activityB });
  const nextJob = await automaticJob(f.p.id, other);
  expect(await runAutomaticComparison(nextJob, { now: () => now })).toEqual({
    status: "completed",
  });
  const second = await storedAutomaticResult(nextJob.runId);
  expect(second.sourceInterpretation).toEqual(first.sourceInterpretation);
  expect(second.sourceReview).toEqual(first.sourceReview);
  expect(second.id).not.toBe(first.id);
  expect(second.companyId).toBe(other);
  expect(infer).toHaveBeenCalledTimes(1);
  const [comparison] = vi.mocked(infer).mock.calls;
  expect(comparison[1]).toBe("documentary-service-comparison");
  expect(comparison[2]).toContain(activityB);
  expect(comparison[2]).not.toContain(activityA);
});

it("An uncertain source is cached as review without ever asking for a company comparison", async () => {
  const { f, companyId, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    expect(purpose).toBe("documentary-source-interpretation");
    const answer = inventedAnswer(prompt);
    if (!("status" in answer)) throw new Error("Expected source-only request");
    return {
      ...answer,
      status: "uncertain",
      classificationReadings: answer.classificationReadings.map(
        (
          reading: StoredAutomaticComparison["sourceInterpretation"]["response"]["classificationReadings"][number],
        ) => ({
          ...reading,
          use: "unresolved",
        }),
      ),
      components: answer.components!.map((component) => ({
        ...component,
        meaning: {
          ...component.meaning,
          state: "ambiguous",
          basis: "unresolved",
          statement: "Il servizio inventato richiede chiarimento.",
        },
      })),
      issues: [
        {
          explanation: "L'oggetto inventato non è determinabile.",
          kind: "object_identity",
          scope: JSON.parse(prompt).targetScope,
          componentIndexes: [0],
          sourceRefs: [answer.targetRef],
        },
      ],
    };
  });
  await runAutomaticComparison(job, { now: () => now });
  const stored = await storedAutomaticResult(job.runId);
  expect(stored.response).toBeNull();
  expect(stored.sourceReview).toBeNull();
  expect(stored.sourceInterpretation.response.components[0].meaning.state).toBe(
    "ambiguous",
  );
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.project.targets[0].automatic).toMatchObject({
    serviceRelation: "review",
    comparisonOrigin: "source_interpretation",
  });
  const other = await company();
  const nextJob = await automaticJob(f.p.id, other);
  await runAutomaticComparison(nextJob, { now: () => now });
  expect((await storedAutomaticResult(nextJob.runId)).response).toBeNull();
  expect(infer).toHaveBeenCalledTimes(1);
});

it("A rejected semantic review beyond twenty older source-only rows is reused across companies without new inference", async () => {
  const { f, companyId, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    const answer = inventedAnswer(prompt);
    if (purpose !== "documentary-source-semantic-review") return answer;
    if (!("checks" in answer)) throw new Error("Expected semantic review");
    return {
      ...answer,
      checks: answer.checks.map(
        (check: { claimId: string }, index: number) => ({
          ...check,
          verdict: index === 0 ? "contradicted" : "supported",
          reason:
            "Contraddizione inventata per verificare l'arresto del confronto.",
        }),
      ),
    };
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "completed",
  });
  const first = await storedAutomaticResult(job.runId);
  expect(first.sourceInterpretation.response.status).toBe("resolved");
  expect(first.sourceReview).not.toBeNull();
  expect(first.response).toBeNull();
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
    "documentary-source-evidence",
    "documentary-source-semantic-review",
  ]);
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.project.targets[0].automatic?.serviceRelation).toBe("review");
  expect(loaded.project.signalEligible).toBe(false);
  expect(loaded.project.qualityEventIds).toEqual([]);
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  const [template] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  // Twenty historical comparison inputs share the same valid draft but have
  // no semantic review. Its later rejection falls outside the source window.
  await db.insert(schema.automaticMatchRuns).values(
    Array.from({ length: 20 }, (_, index) => {
      const inputHash = createHash("sha256")
        .update(`invented-historical-input-${job.runId}-${index}`)
        .digest("hex");
      return {
        ...template,
        id: randomUUID(),
        inputHash,
        result: { ...first, inputHash, sourceReview: null },
        createdAt: new Date(
          `2000-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        ),
      };
    }),
  );
  const other = await company();
  const nextJob = await automaticJob(f.p.id, other);
  vi.mocked(infer).mockClear();
  expect(await runAutomaticComparison(nextJob, { now: () => now })).toEqual({
    status: "completed",
  });
  const second = await storedAutomaticResult(nextJob.runId);
  expect(second.sourceInterpretation).toEqual(first.sourceInterpretation);
  expect(second.sourceReview).toEqual(first.sourceReview);
  expect(second.response).toBeNull();
  expect(infer).not.toHaveBeenCalled();
});

for (const changed of ["missing", "version", "reasoning"] as const)
  it(`A ${changed} semantic review is recomputed while its unchanged source draft is reused`, async () => {
    const { f, job } = await automaticFixture();
    vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
      inventedAnswer(prompt),
    );
    await runAutomaticComparison(job, { now: () => now });
    const first = await storedAutomaticResult(job.runId);
    if (changed === "reasoning")
      vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
    else {
      // The cache query reads only the public envelopes: an older completed
      // comparison may contain a valid source but no current semantic review.
      await db
        .update(schema.automaticMatchRuns)
        .set({
          result: {
            ...first,
            sourceReview:
              changed === "missing"
                ? null
                : {
                    ...first.sourceReview,
                    version: "previous-review-version",
                    inputHash: createHash("sha256")
                      .update("invented-previous-review-plan")
                      .digest("hex"),
                  },
          } as unknown as StoredAutomaticComparison,
        })
        .where(eq(schema.automaticMatchRuns.id, job.runId));
    }
    const other = await company();
    const nextJob = await automaticJob(f.p.id, other);
    vi.mocked(infer).mockClear();
    await runAutomaticComparison(nextJob, { now: () => now });
    const second = await storedAutomaticResult(nextJob.runId);
    expect(second.sourceInterpretation).toEqual(first.sourceInterpretation);
    expect(second.sourceReview).not.toEqual(first.sourceReview);
    expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
      "documentary-source-evidence",
      "documentary-source-semantic-review",
      "documentary-service-comparison",
    ]);
    expect(vi.mocked(infer).mock.calls[0][7]?.reasoningEffort).toBe(
      changed === "reasoning" ? "high" : "none",
    );
    const thirdJob = await automaticJob(f.p.id, await company());
    vi.mocked(infer).mockClear();
    await runAutomaticComparison(thirdJob, { now: () => now });
    expect((await storedAutomaticResult(thirdJob.runId)).sourceReview).toEqual(
      second.sourceReview,
    );
    expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
      "documentary-service-comparison",
    ]);
  });

it("An older row without review cannot hide a later rejection for the same exact draft", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  await runAutomaticComparison(job, { now: () => now });
  const first = await storedAutomaticResult(job.runId);
  await db
    .update(schema.automaticMatchRuns)
    .set({ result: { ...first, sourceReview: null } })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    if (purpose === "documentary-source-evidence")
      return inventedAnswer(prompt);
    expect(purpose).toBe("documentary-source-semantic-review");
    const answer = inventedAnswer(prompt);
    if (!("checks" in answer)) throw new Error("Expected semantic review");
    return {
      ...answer,
      checks: answer.checks.map((check: { claimId: string }) => ({
        ...check,
        verdict: "not_verifiable",
        reason: "Riscontro inventato non determinabile.",
      })),
    };
  });
  const secondJob = await automaticJob(f.p.id, await company());
  await runAutomaticComparison(secondJob, { now: () => now });
  const second = await storedAutomaticResult(secondJob.runId);
  expect(second.sourceInterpretation.hash).toBe(
    first.sourceInterpretation.hash,
  );
  expect(second.sourceReview).not.toBeNull();
  expect(second.response).toBeNull();
  const thirdJob = await automaticJob(f.p.id, await company());
  vi.mocked(infer).mockClear();
  await runAutomaticComparison(thirdJob, { now: () => now });
  const third = await storedAutomaticResult(thirdJob.runId);
  expect(third.sourceInterpretation).toEqual(first.sourceInterpretation);
  expect(third.sourceReview).toEqual(second.sourceReview);
  expect(third.response).toBeNull();
  expect(infer).not.toHaveBeenCalled();
});

it("A corrupted current semantic review fails closed without paid fallback", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  await runAutomaticComparison(job, { now: () => now });
  const altered = structuredClone(await storedAutomaticResult(job.runId));
  expect(altered.sourceReview).not.toBeNull();
  altered.sourceReview!.hash = "0".repeat(64);
  await db
    .update(schema.automaticMatchRuns)
    .set({ result: altered })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  const nextJob = await automaticJob(f.p.id, await company());
  vi.mocked(infer).mockClear();
  await expect(
    runAutomaticComparison(nextJob, { now: () => now }),
  ).rejects.toThrow(/Altered/);
  expect(infer).not.toHaveBeenCalled();
});

it("Reads every long-source chunk before interpretation and reuses those readings for the next company", async () => {
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
  vi.stubEnv("LLM_REASONING_EFFORT", "high");
  const sourceText = `${"Potatura degli alberi, prestazione inventata. ".repeat(600)}ULTIMA PRESTAZIONE INVENTATA.`;
  const contextText = `${"Condizioni inventate da conservare integralmente. ".repeat(80)}ULTIMA CONDIZIONE NON SELEZIONATA DALLA MAPPA.`;
  const { f, job } = await automaticFixture(
    false,
    baseProfile,
    sourceText,
    contextText,
  );
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    if (purpose === "documentary-source-reading") {
      const reading = JSON.parse(prompt);
      expect(reading.company).toBeUndefined();
      return {
        chunkId: reading.chunkId,
        status: "complete",
        sourceRefs: reading.items.flatMap(
          (item: { passage?: { id: string; rawPath: string } }) =>
            item.passage?.rawPath === "/lots/0/orderDescription/it"
              ? [item.passage.id]
              : [],
        ),
      };
    }
    return inventedAnswer(prompt);
  });
  await runAutomaticComparison(job, { now: () => now });
  const first = await storedAutomaticResult(job.runId);
  const calls = vi.mocked(infer).mock.calls;
  const readingCalls = calls.filter(
    (call) => call[1] === "documentary-source-reading",
  );
  const evidenceCalls = calls.filter(
    (call) => call[1] === "documentary-source-evidence",
  );
  const reviewCalls = calls.filter(
    (call) => call[1] === "documentary-source-semantic-review",
  );
  expect(readingCalls.length).toBeGreaterThan(1);
  expect(reviewCalls.length).toBeGreaterThan(0);
  expect(evidenceCalls.length).toBeGreaterThan(0);
  for (const call of evidenceCalls) {
    const body = JSON.parse(call[2]);
    expect(body.draft).toBeUndefined();
    expect(body.company).toBeUndefined();
    expect(body.readings).toBeUndefined();
  }
  for (const reading of readingCalls) {
    expect(reading[3]).toBe(2400);
    expect(reading[7]?.reasoningEffort).toBe("none");
  }
  expect(calls.map((call) => call[1])).toEqual([
    ...readingCalls.map(() => "documentary-source-reading"),
    "documentary-source-interpretation",
    ...evidenceCalls.map(() => "documentary-source-evidence"),
    ...reviewCalls.map(() => "documentary-source-semantic-review"),
    "documentary-service-comparison",
  ]);
  expect(first.sourceInterpretation.readings).toHaveLength(readingCalls.length);
  const interpretationCall = calls.find(
    (call) => call[1] === "documentary-source-interpretation",
  )!;
  expect(interpretationCall[3]).toBe(8192);
  expect(interpretationCall[7]).toMatchObject({
    model: first.sourceInterpretation.model,
    reasoningEffort: "none",
  });
  expect(calls.at(-1)![3]).toBe(8192);
  expect(calls.at(-1)![7]?.reasoningEffort).toBe("high");
  const interpretationPrompt = JSON.parse(interpretationCall[2]);
  expect(interpretationPrompt.coverage.completeProvidedSource).toBe(true);
  expect(interpretationPrompt.coverage.linkedDocumentsRead).toBe(false);
  const described = interpretationPrompt.passages
    .filter(
      (passage: { rawPath: string }) =>
        passage.rawPath === "/lots/0/orderDescription/it",
    )
    .map((passage: { text: string }) => passage.text)
    .join("");
  expect(described).toBe(sourceText);
  expect(
    interpretationPrompt.passages.some((passage: { text: string }) =>
      passage.text.includes("ULTIMA CONDIZIONE NON SELEZIONATA DALLA MAPPA"),
    ),
  ).toBe(false);
  const reviewedPassages = new Map<
    string,
    { text: string; startUtf16: number }
  >();
  const reviewedContext = new Map<
    string,
    { text: string; startUtf16: number }
  >();
  for (const reviewCall of reviewCalls) {
    expect(reviewCall[7]?.reasoningEffort).toBe("high");
    const reviewPrompt = JSON.parse(reviewCall[2]);
    expect(reviewPrompt.company).toBeUndefined();
    for (const passage of reviewPrompt.passages) {
      if (
        passage.rawPath === "/lots/0/orderDescription/it" &&
        reviewPrompt.coverage.passageIds.includes(passage.id)
      )
        reviewedPassages.set(passage.id, passage);
      if (
        passage.rawPath === "/procurement/executionNote/it" &&
        reviewPrompt.coverage.passageIds.includes(passage.id)
      )
        reviewedContext.set(passage.id, passage);
    }
  }
  expect(
    [...reviewedPassages.values()]
      .sort((a, b) => a.startUtf16 - b.startUtf16)
      .map((passage) => passage.text)
      .join(""),
  ).toBe(sourceText);
  expect(
    [...reviewedContext.values()]
      .sort((a, b) => a.startUtf16 - b.startUtf16)
      .map((passage) => passage.text)
      .join(""),
  ).toBe(contextText);
  const other = await company();
  const nextJob = await automaticJob(f.p.id, other);
  vi.mocked(infer).mockClear();
  await runAutomaticComparison(nextJob, { now: () => now });
  const second = await storedAutomaticResult(nextJob.runId);
  expect(second.sourceInterpretation).toEqual(first.sourceInterpretation);
  expect(second.sourceReview).toEqual(first.sourceReview);
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-service-comparison",
  ]);
  expect(vi.mocked(infer).mock.calls[0][7]?.reasoningEffort).toBe("high");
});

it("A corrupted current public interpretation fails closed before any provider fallback", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  await runAutomaticComparison(job, { now: () => now });
  const altered = structuredClone(await storedAutomaticResult(job.runId));
  altered.sourceInterpretation.response.summary =
    "Sintesi alterata dopo la firma.";
  await db
    .update(schema.automaticMatchRuns)
    .set({ result: altered })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  const other = await company();
  const nextJob = await automaticJob(f.p.id, other);
  vi.mocked(infer).mockClear();
  await expect(
    runAutomaticComparison(nextJob, { now: () => now }),
  ).rejects.toThrow("Altered source interpretation record");
  expect(infer).not.toHaveBeenCalled();
  const [failed] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, nextJob.runId));
  expect(failed).toMatchObject({
    status: "failed",
    result: null,
    leaseUntil: null,
  });
});

for (const changed of ["source", "model", "source_reasoning"] as const)
  it(`A changed ${changed} creates a new public interpretation instead of reusing the old cache`, async () => {
    const { f, job } = await automaticFixture();
    vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
      inventedAnswer(prompt),
    );
    await runAutomaticComparison(job, { now: () => now });
    const first = await storedAutomaticResult(job.runId);
    if (changed === "source") {
      const corrected = structuredClone(f.raw);
      corrected.lots[0].orderDescription.it = `${lotText} Rettifica inventata: manutenzione stagionale.`;
      const observation = await f.observation(corrected);
      await f.adopt(observation.id);
    } else if (changed === "model")
      vi.stubEnv("LLM_MODEL", "another-invented-documentary-model");
    else vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "high");
    const other = await company();
    const nextJob = await automaticJob(f.p.id, other);
    vi.mocked(infer).mockClear();
    await runAutomaticComparison(nextJob, { now: () => now });
    const second = await storedAutomaticResult(nextJob.runId);
    expect(second.sourceInterpretation.sourceKey).not.toBe(
      first.sourceInterpretation.sourceKey,
    );
    expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
      "documentary-source-interpretation",
      "documentary-source-evidence",
      "documentary-source-semantic-review",
      "documentary-service-comparison",
    ]);
    if (changed === "source_reasoning") {
      expect(vi.mocked(infer).mock.calls[0][7]?.reasoningEffort).toBe("high");
      expect(vi.mocked(infer).mock.calls[0][3]).toBe(8192);
    }
  });

it("A profile change while the provider runs supersedes its answer without holding an application transaction", async () => {
  const { f, companyId, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) => {
    await db
      .update(schema.companies)
      .set({ profile: { ...baseProfile, activities: "Vendita di mobili" } })
      .where(eq(schema.companies.id, companyId));
    return inventedAnswer(prompt);
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "superseded",
  });
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.project.signalEligible).toBe(false);
  expect(loaded.project.targets[0].automatic).toBeNull();
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
  ]);
});

it("A source correction during interpretation prevents the old source from reaching the company comparison", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    expect(purpose).toBe("documentary-source-interpretation");
    const corrected = structuredClone(f.raw);
    corrected.lots[0].orderDescription.it =
      "Rettifica inventata: fornitura di alberi.";
    const observation = await f.observation(corrected);
    await f.adopt(observation.id);
    return inventedAnswer(prompt);
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "superseded",
  });
  expect(infer).toHaveBeenCalledTimes(1);
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run).toMatchObject({
    status: "superseded",
    result: null,
    leaseUntil: null,
  });
});

it("A source correction during semantic review prevents the final company comparison and clears the lease", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    if (purpose === "documentary-source-semantic-review") {
      const corrected = structuredClone(f.raw);
      corrected.lots[0].orderDescription.it =
        "Rettifica inventata durante la verifica: fornitura di alberi.";
      await f.adopt((await f.observation(corrected)).id);
    }
    return inventedAnswer(prompt);
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "superseded",
  });
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
    "documentary-source-evidence",
    "documentary-source-semantic-review",
  ]);
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run).toMatchObject({
    status: "superseded",
    result: null,
    leaseUntil: null,
  });
});

it("Semantic-review transport errors retain bounded technical retry and never become semantic rejections", async () => {
  const { job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    if (purpose === "documentary-source-semantic-review")
      throw new Error("Invented semantic-review transport error");
    return inventedAnswer(prompt);
  });
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(
      runAutomaticComparison(job, { now: () => now }),
    ).rejects.toThrow("Invented semantic-review transport error");
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual(
    Array.from({ length: 3 }).flatMap(() => [
      "documentary-source-interpretation",
      "documentary-source-evidence",
      "documentary-source-semantic-review",
    ]),
  );
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run).toMatchObject({
    status: "failed",
    result: null,
    attempts: 3,
    issue: "comparison_failed",
  });
});

it("Provider errors retry within the same durable input and stop after three attempts", async () => {
  const { job } = await automaticFixture();
  vi.mocked(infer).mockRejectedValue(new Error("Provider unavailable"));
  for (let attempt = 1; attempt <= 3; attempt++)
    await expect(
      runAutomaticComparison(job, { now: () => now }),
    ).rejects.toThrow("Provider unavailable");
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  expect(infer).toHaveBeenCalledTimes(3);
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run.status).toBe("failed");
  expect(run.issue).toBe("comparison_failed");
});

it("Revoking processing during a provider call discards the answer and clears its lease", async () => {
  const { job, companyId } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) => {
    await db
      .update(schema.companies)
      .set({ disabledAt: now })
      .where(eq(schema.companies.id, companyId));
    return inventedAnswer(prompt);
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "superseded",
  });
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run.status).toBe("superseded");
  expect(run.result).toBeNull();
  expect(run.leaseUntil).toBeNull();
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
  ]);
});

it("An expired lease can be recovered once, while a live lease prevents a duplicate paid request", async () => {
  const { job } = await automaticFixture();
  await db
    .update(schema.automaticMatchRuns)
    .set({
      status: "running",
      attempts: 1,
      leaseUntil: new Date(now.getTime() + 60_000),
    })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  await expect(runAutomaticComparison(job, { now: () => now })).rejects.toThrow(
    "già in elaborazione",
  );
  expect(infer).not.toHaveBeenCalled();
  await db
    .update(schema.automaticMatchRuns)
    .set({ leaseUntil: new Date(now.getTime() - 1) })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "completed",
  });
  expect(infer).toHaveBeenCalledTimes(4);
});

it("An abandoned third attempt is closed once without another provider call", async () => {
  const { job } = await automaticFixture();
  await db
    .update(schema.automaticMatchRuns)
    .set({
      status: "running",
      attempts: 3,
      leaseUntil: new Date(now.getTime() - 1),
    })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  for (let invocation = 0; invocation < 2; invocation++)
    expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
      status: "skipped",
    });
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run).toMatchObject({
    status: "failed",
    attempts: 3,
    leaseUntil: null,
    issue: "comparison_failed",
  });
  const warnings = await db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.key, `automatic-comparison:${job.runId}`));
  expect(warnings).toHaveLength(1);
  expect(warnings[0].severity).toBe("warning");
  expect(infer).not.toHaveBeenCalled();
});

it("A live third attempt remains owned by its current worker", async () => {
  const { job } = await automaticFixture();
  const [before] = await db
    .update(schema.automaticMatchRuns)
    .set({
      status: "running",
      attempts: 3,
      leaseUntil: new Date(now.getTime() + 60_000),
    })
    .where(eq(schema.automaticMatchRuns.id, job.runId))
    .returning();
  await expect(runAutomaticComparison(job, { now: () => now })).rejects.toThrow(
    "già in elaborazione",
  );
  const [after] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(after).toEqual(before);
  expect(infer).not.toHaveBeenCalled();
});

for (const invalidation of ["revoked", "expired", "profile_changed"] as const)
  for (const lease of ["expired", "live"] as const)
    it(`An interrupted ${invalidation} input with a ${lease} lease is reconciled without stealing work`, async () => {
      const { job, companyId } = await automaticFixture(true);
      const clock =
        invalidation === "expired" ? new Date("2032-01-10T10:00:00.000Z") : now;
      const [before] = await db
        .update(schema.automaticMatchRuns)
        .set({
          status: "running",
          attempts: 1,
          leaseUntil: new Date(
            clock.getTime() + (lease === "live" ? 60_000 : -1),
          ),
        })
        .where(eq(schema.automaticMatchRuns.id, job.runId))
        .returning();
      if (invalidation === "revoked")
        await db
          .update(schema.invitations)
          .set({ revokedAt: now })
          .where(eq(schema.invitations.companyId, companyId));
      if (invalidation === "profile_changed")
        await db
          .update(schema.companies)
          .set({ profile: { ...baseProfile, activities: "Vendita di mobili" } })
          .where(eq(schema.companies.id, companyId));
      if (lease === "live" && invalidation !== "revoked")
        await expect(
          runAutomaticComparison(job, { now: () => clock }),
        ).rejects.toThrow("già in elaborazione");
      else
        expect(await runAutomaticComparison(job, { now: () => clock })).toEqual(
          {
            status: "skipped",
          },
        );
      const [after] = await db
        .select()
        .from(schema.automaticMatchRuns)
        .where(eq(schema.automaticMatchRuns.id, job.runId));
      if (lease === "live") expect(after).toEqual(before);
      else
        expect(after).toMatchObject({
          status: "superseded",
          attempts: 1,
          result: null,
          leaseUntil: null,
          issue: "inputs_changed",
        });
      expect(infer).not.toHaveBeenCalled();
    });

for (const input of ["current", "revoked", "expired"] as const)
  it(`The lease reconciler closes an abandoned final ${input} attempt without retrying its job`, async () => {
    const { job, companyId } = await automaticFixture(true);
    const clock =
      input === "expired" ? new Date("2032-01-10T10:00:00.000Z") : now;
    await db
      .update(schema.automaticMatchRuns)
      .set({
        status: "running",
        attempts: 3,
        leaseUntil: new Date(clock.getTime() - 1),
      })
      .where(eq(schema.automaticMatchRuns.id, job.runId));
    if (input === "revoked")
      await db
        .update(schema.invitations)
        .set({ revokedAt: now })
        .where(eq(schema.invitations.companyId, companyId));
    await reconcileAutomaticComparisonLeases(clock);
    const [run] = await db
      .select()
      .from(schema.automaticMatchRuns)
      .where(eq(schema.automaticMatchRuns.id, job.runId));
    expect(run).toMatchObject({
      status: input === "current" ? "failed" : "superseded",
      attempts: 3,
      leaseUntil: null,
      result: null,
    });
    expect(await reconcileAutomaticComparisonLeases(clock)).toBe(0);
    const warnings = await db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.key, `automatic-comparison:${job.runId}`));
    expect(warnings).toHaveLength(input === "current" ? 1 : 0);
    expect(infer).not.toHaveBeenCalled();
  });

it("Lease reconciliation preserves a live attempt, ordinary retries and a paused feature", async () => {
  const { job } = await automaticFixture();
  const [live] = await db
    .update(schema.automaticMatchRuns)
    .set({
      status: "running",
      attempts: 3,
      leaseUntil: new Date(now.getTime() + 60_000),
    })
    .where(eq(schema.automaticMatchRuns.id, job.runId))
    .returning();
  await reconcileAutomaticComparisonLeases(now);
  const readRun = async () =>
    (
      await db
        .select()
        .from(schema.automaticMatchRuns)
        .where(eq(schema.automaticMatchRuns.id, job.runId))
    )[0];
  expect(await readRun()).toEqual(live);
  const [retryable] = await db
    .update(schema.automaticMatchRuns)
    .set({ attempts: 1, leaseUntil: new Date(now.getTime() - 1) })
    .where(eq(schema.automaticMatchRuns.id, job.runId))
    .returning();
  await reconcileAutomaticComparisonLeases(now);
  expect(await readRun()).toEqual(retryable);
  const [paused] = await db
    .update(schema.automaticMatchRuns)
    .set({ attempts: 3 })
    .where(eq(schema.automaticMatchRuns.id, job.runId))
    .returning();
  vi.stubEnv("DOCUMENTARY_COMPARISON_ENABLED", "false");
  expect(await reconcileAutomaticComparisonLeases(now)).toBe(0);
  expect(await readRun()).toEqual(paused);
  expect(infer).not.toHaveBeenCalled();
});

it("Returning to a superseded profile requeues its input once and preserves the attempt ceiling", async () => {
  const { job, companyId, f } = await automaticFixture();
  await db
    .update(schema.companies)
    .set({
      profile: { ...baseProfile, activities: "Servizi inventati diversi" },
    })
    .where(eq(schema.companies.id, companyId));
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  expect(infer).not.toHaveBeenCalled();
  await db
    .update(schema.automaticMatchRuns)
    .set({ attempts: 2 })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  await db
    .update(schema.companies)
    .set({ profile: baseProfile })
    .where(eq(schema.companies.id, companyId));
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  const runs = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.publicationId, f.p.id));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    id: job.runId,
    status: "queued",
    attempts: 2,
  });
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "completed",
  });
  await db
    .update(schema.automaticMatchRuns)
    .set({ status: "superseded", result: null })
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  const [exhausted] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(exhausted).toMatchObject({ status: "superseded", attempts: 3 });
  expect(infer).toHaveBeenCalledTimes(4);
});

it("A job for another company cannot read, run or update the owner's comparison", async () => {
  const { job, run } = await automaticFixture();
  const other = await company();
  expect(
    await runAutomaticComparison(
      { ...job, companyId: other },
      { now: () => now },
    ),
  ).toEqual({ status: "skipped" });
  expect(infer).not.toHaveBeenCalled();
  expect(
    (
      await db
        .select()
        .from(schema.automaticMatchRuns)
        .where(eq(schema.automaticMatchRuns.id, run.id))
    )[0],
  ).toEqual(run);
  await expect(
    db
      .insert(schema.automaticMatchRuns)
      .values({ ...run, id: randomUUID(), companyId: other }),
  ).rejects.toThrow();
});

it("A current AI-positive project cannot produce an email while company automation remains disabled", async () => {
  const { f, companyId, job } = await automaticFixture(true);
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  await runAutomaticComparison(job, { now: () => now });
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.project.signalEligible).toBe(true);
  expect(loaded.project.quality).toBe("unresolved");
  const scope = lotNoticeScope(
    loaded,
    loaded.project.targets[0].target,
    "positive",
  );
  expect(() => buildLotNotice(loaded, [scope], "opportunity", false)).toThrow(
    "automation gate",
  );
  const allowed = buildLotNotice(loaded, [scope], "opportunity", true);
  const alteredStructure = structuredClone(allowed);
  alteredStructure.binding.shapeEpochToken = "0".repeat(64);
  expect(() => validateLotNotice(alteredStructure)).toThrow(
    "Invalid positive assessment structure binding",
  );
  expect(
    renderLotNoticeContent([allowed], "https://example.invalid").textBody,
  ).toContain("Confronto automatico AI");
  expect(await db.select().from(schema.notifications)).toEqual([]);
});
async function company(
  profile = baseProfile,
  options: {
    disabled?: boolean;
    onboarded?: boolean;
    acceptedVersion?: string;
  } = {},
) {
  const id = randomUUID();
  await db
    .insert(schema.user)
    .values({ id, name: profile.name, email: `${id}@example.invalid` });
  await db.insert(schema.companies).values({
    id,
    ownerId: id,
    profile,
    onboardedAt: options.onboarded === false ? null : new Date(),
    disabledAt: options.disabled ? new Date() : null,
  });
  await db.insert(schema.invitations).values({
    id: `${id}-invitation`,
    email: `${id}@example.invalid`,
    companyId: id,
    expiresAt: new Date("2099-01-01"),
    acceptedAt: new Date(),
    acceptedVersion:
      options.acceptedVersion ?? PILOT_PARTICIPATION_TERMS_VERSION,
  });
  return id;
}
async function fixture(
  options: {
    adopt?: boolean;
    empty?: boolean;
    canonicalId?: string;
    automaticProject?: boolean;
    sourceText?: string;
    contextText?: string;
  } = {},
) {
  const projectId = randomUUID(),
    noticeId = randomUUID(),
    lotId = randomUUID();
  const identity = {
    projectId,
    publicationId: noticeId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
  };
  const raw: any = {
    id: noticeId,
    type: "tender",
    "project-info": { title: { it: "Rete elettrica, fonte inventata" } },
    procurement: {
      orderDescription: { it: commonText },
      cpvCode: { code: "45310000" },
      ...(options.contextText
        ? { executionNote: { it: options.contextText } }
        : {}),
    },
    base: {
      id: noticeId,
      projectId,
      lotsType: options.empty ? "without" : "with",
      lots: options.empty
        ? []
        : [{ id: lotId, lotNumber: 1, title: { it: "Alberi" } }],
    },
    lots: options.empty
      ? []
      : [
          {
            id: lotId,
            lotNumber: 1,
            title: { it: "Alberi" },
            orderDescription: { it: options.sourceText ?? lotText },
            cpvCode: { code: "77310000" },
            orderAddressOnlyDescription: "no",
            orderAddress: {
              countryId: "CH",
              cantonId: "TI",
              city: { it: "Lugano" },
            },
          },
        ],
  };
  const entry = {
    id: projectId,
    raw: {
      id: projectId,
      publicationId: noticeId,
      publicationDate: "2026-09-01",
      projectNumber: `INVENTED-WORKER-${projectId}`,
      pubType: "tender",
      processType: "open",
      title: { it: "Rete elettrica inventata" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
  if (options.automaticProject) {
    raw.procurement.orderDescription.it = lotText;
    raw.procurement.orderAddress = {
      countryId: "CH",
      cantonId: "TI",
      city: { it: "Lugano" },
    };
    raw.base.processType = "open";
    raw.dates = {
      offerDeadline: "2031-12-01T12:00:00+01:00",
      processType: "open",
    };
  }
  const normalized = normalizeSimap(entry, raw);
  const p = {
    ...normalized,
    canton: options.automaticProject ? "TI" : "ZH",
    sectors: ["impianti"] as ["impianti"],
    summary: null,
  };
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId: options.canonicalId ?? p.id,
    externalId: p.externalId,
    projectId: p.projectId,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    data: p,
    revision: p.revision,
  });
  async function observation(detail = raw, refused = false) {
    const request = await beginDocumentaryRequest(identity),
      body = JSON.stringify(detail),
      publication = normalizeSimap(entry, detail);
    const receipt = {
      url: identity.detailUrl,
      receivedAt: new Date().toISOString(),
      bodyByteLength: Buffer.byteLength(body),
      bodySha256: createHash("sha256").update(body).digest("hex"),
    };
    const result: SimapAcquisitionResult = refused
      ? {
          publication: null,
          documentaryAcquisition: {
            version: SIMAP_ACQUISITION_VERSION,
            state: "refused",
            identity,
            sourceRevision: null,
            receipt,
            refusal: { stage: "decode", code: "invalid_utf8" },
          },
        }
      : {
          publication,
          documentaryAcquisition: {
            version: SIMAP_ACQUISITION_VERSION,
            state: "accepted",
            identity,
            sourceRevision: publication.revision,
            receipt,
            archive: preserveSimapLots(detail, identity),
          },
        };
    return storeDocumentaryObservation(request, result);
  }
  const initial = await observation();
  async function adopt(id = initial.id) {
    await db
      .update(schema.publications)
      .set({ documentarySnapshotId: id })
      .where(eq(schema.publications.id, p.id));
  }
  if (options.adopt !== false) await adopt();
  return { p, raw, identity, lotId, initial, observation, adopt };
}
const rows = (id: string) =>
  db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.publicationId, id))
    .orderBy(schema.matches.companyId);
function noAI() {
  expect(summarize).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect(readSourceReviewContext).not.toHaveBeenCalled();
}
async function reviewSource(f: Awaited<ReturnType<typeof fixture>>) {
  for (const target of [
    { kind: "project" as const, publicationId: f.p.id },
    {
      kind: "lot" as const,
      publicationId: f.p.id,
      sourceProjectId: f.identity.projectId,
      lotId: f.lotId,
    },
  ]) {
    const loaded = await loadLotSourceReview(target, viewer),
      project = target.kind === "project";
    await appendLotSourceReview(
      {
        target,
        expectedObservationId: loaded.expected.observationId,
        expectedSnapshotHash: loaded.expected.snapshotHash,
        expectedShapeEpochToken: loaded.expected.shapeEpochToken,
        expectedSelectionHash: loaded.expected.selectionHash,
        expectedTargetEventId: loaded.expected.targetEventId,
        expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
        action: "recorded",
        form: project ? "broad_scope" : "defined_service",
        references: [
          {
            selectionHash: loaded.expected.selectionHash!,
            rawPath: project
              ? "/procurement/orderDescription/it"
              : "/lots/0/orderDescription/it",
            startUtf16: 0,
            endUtf16: (project ? commonText : lotText).length,
          },
        ],
        note: "Revisione inventata per il test del worker.",
      },
      viewer,
    );
  }
}
async function reviewLot(
  f: Awaited<ReturnType<typeof fixture>>,
  companyId: string,
) {
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer),
    selected = lotMatchReviewTarget(loaded, f.lotId);
  return appendLotMatchReview(
    {
      companyId,
      publicationId: f.p.id,
      action: "assess_lot",
      target: selected.target,
      expectedSnapshotHash: selected.expected.snapshotHash,
      expectedShapeEpochToken: selected.expected.shapeEpochToken,
      expectedProfileHash: selected.expected.profileHash,
      expectedStateToken: selected.expected.stateToken,
      expectedGroupToken: selected.expected.groupToken,
      expectedSourceDependency: selected.expected.sourceDependency,
      expectedOperationalInputHash: selected.expected.operationalInputHash,
      expectedEvaluationSetToken: selected.expected.evaluationSetToken,
      expectedEntryHash: selected.expected.entryHash,
      result: "direct",
      reason: "Interesse potenziale per il solo lotto inventato degli alberi.",
      references: [
        {
          selectionHash: selected.context.dependency.selectionHash!,
          rawPath: "/lots/0/orderDescription/it",
          startUtf16: 0,
          endUtf16: lotText.length,
        },
      ],
      confirmedReviewReasons: selected.preliminary.reviewReasons,
      note: "Confermo gli avvisi operativi correnti per l'interesse potenziale.",
    },
    viewer,
  );
}
async function beforeTransaction(action: () => Promise<void>) {
  let once = false;
  injected.db = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction")
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          if (!once) {
            once = true;
            await action();
          }
          return db.transaction(callback);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("Creates reviews only for current participants while preserving the founder's internal review company", async () => {
  const f = await fixture(),
    current = await company(),
    stale = await company(baseProfile, {
      acceptedVersion: "pilot-participation-previous",
    }),
    revoked = await company(),
    founderCompany = await company(baseProfile, {
      acceptedVersion: "founder-bootstrap-v1",
    });
  await db
    .update(schema.invitations)
    .set({ revokedAt: new Date() })
    .where(eq(schema.invitations.companyId, revoked));
  await db.insert(schema.administrators).values({ userId: founderCompany });

  await matchAdoptedPublication({ publicationId: f.p.id, now });
  expect((await rows(f.p.id)).map((row) => row.companyId).sort()).toEqual(
    [current, founderCompany].sort(),
  );
  noAI();
});

it("Creates one project review for active onboarded firms despite a parent-only exclusion, without AI or v1 source reader", async () => {
  const f = await fixture(),
    first = await company(),
    second = await company({ ...baseProfile, sectors: ["pulizie"] });
  await company(baseProfile, { disabled: true });
  await company(baseProfile, { onboarded: false });
  await enrichAndMatch({ publicationId: f.p.id, now });
  const matched = await rows(f.p.id);
  expect(matched.map((row) => row.companyId).sort()).toEqual(
    [first, second].sort(),
  );
  expect(
    matched.every(
      (row) =>
        row.score === 0 &&
        !row.eligible &&
        row.approved === null &&
        row.revision.startsWith(LOT_WORKER_REVIEW_VERSION),
    ),
  ).toBe(true);
  const once = structuredClone(matched);
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect(await rows(f.p.id)).toEqual(once);
  noAI();
});

it("Re-reads the adopted pointer, current profiles and newly onboarded companies inside the transaction", async () => {
  const f = await fixture(),
    id = await company();
  let late = "";
  await beforeTransaction(async () => {
    await f.adopt();
    await db
      .update(schema.companies)
      .set({ profile: { ...baseProfile, exclusions: ["potatura"] } })
      .where(eq(schema.companies.id, id));
    late = await company();
  });
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect((await rows(f.p.id)).map((row) => row.companyId).sort()).toEqual(
    [id, late].sort(),
  );
  injected.db = db;
  const loaded = await loadLotMatchReview(id, f.p.id, viewer);
  expect(loaded.project.lots[0].preliminary?.eligible).toBe(false);
  expect(
    (await rows(f.p.id)).find((row) => row.companyId === id)?.revision,
  ).toBe(`${LOT_WORKER_REVIEW_VERSION}:${loaded.project.projectBindingHash}`);
  noAI();
});

it("Preserves human lot decisions, immutable audit and canonical veto; a changed source masks the old positive instead of rewriting it", async () => {
  const f = await fixture(),
    id = await company();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  await reviewSource(f);
  await reviewLot(f, id);
  const loaded = await loadLotMatchReview(id, f.p.id, viewer);
  await appendLotMatchReview(
    {
      companyId: id,
      publicationId: f.p.id,
      action: "veto_project",
      expectedSnapshotHash: loaded.expected.snapshotHash,
      expectedShapeEpochToken: loaded.expected.shapeEpochToken,
      expectedProfileHash: loaded.expected.profileHash,
      expectedStateToken: loaded.expected.stateToken,
      expectedGroupToken: loaded.expected.groupToken,
      expectedProjectBindingHash: loaded.expected.projectBindingHash,
      note: "Veto progetto inventato da mantenere durante il worker.",
    },
    viewer,
  );
  const before = await rows(f.p.id),
    audit = await db.select().from(schema.matchLotReviewEvents),
    settings = await db.select().from(schema.settings);
  const changed = structuredClone(f.raw);
  changed.lots[0].orderDescription.it += " Nuova prestazione inventata.";
  await f.adopt((await f.observation(changed)).id);
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect(await rows(f.p.id)).toEqual(before);
  expect(await db.select().from(schema.matchLotReviewEvents)).toEqual(audit);
  expect(await db.select().from(schema.settings)).toEqual(settings);
  const current = await loadLotMatchReview(id, f.p.id, viewer);
  expect(current.project.signalEligible).toBe(false);
  expect(current.project.suppressed).toBe(true);
  expect(current.project.lots[0].state).toBe("stale");
  noAI();
});

it("Keeps exact legacy approvals and rejections, including SQL timestamp precision, without stamping them as lot reviews", async () => {
  const f = await fixture();
  for (const approved of [true, false]) {
    const id = await company();
    await db.insert(schema.matches).values({
      id: randomUUID(),
      companyId: id,
      publicationId: f.p.id,
      revision: "historic-human-revision",
      score: 97,
      eligible: approved,
      approved,
      reviewedAt: new Date("2026-09-01T10:00:00Z"),
      reviewNotes: "Nota umana originale",
      reason: "Giudizio storico originale",
    });
  }
  await pg.exec(
    "UPDATE matches SET reviewed_at = reviewed_at + interval '0.000123 seconds' WHERE revision = 'historic-human-revision'",
  );
  const before = await pg.query(
    "SELECT id, revision, approved, reviewed_at::text, updated_at::text, review_notes, reason, score, eligible, lot_evaluations FROM matches WHERE publication_id = $1 ORDER BY id",
    [f.p.id],
  );
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect(
    (
      await pg.query(
        "SELECT id, revision, approved, reviewed_at::text, updated_at::text, review_notes, reason, score, eligible, lot_evaluations FROM matches WHERE publication_id = $1 ORDER BY id",
        [f.p.id],
      )
    ).rows,
  ).toEqual(before.rows);
  expect((await rows(f.p.id)).every((row) => row.lotEvaluations === null)).toBe(
    true,
  );
  noAI();
});

it("Refused or empty-lot observations and closed adopted sources finish in review without invented lot verdicts", async () => {
  const id = await company(),
    f = await fixture();
  await f.adopt((await f.observation(f.raw, true)).id);
  await db
    .update(schema.publications)
    .set({ status: "closed", data: { ...f.p, status: "closed" } })
    .where(eq(schema.publications.id, f.p.id));
  await enrichAndMatch({ publicationId: f.p.id, now });
  const refused = await rows(f.p.id);
  expect(refused).toHaveLength(1);
  expect(refused[0].score).toBe(0);
  expect(refused[0].eligible).toBe(false);
  expect((await loadLotMatchReview(id, f.p.id, viewer)).project.state).toBe(
    "input_refused",
  );
  const empty = await fixture({ empty: true });
  await enrichAndMatch({ publicationId: empty.p.id, now });
  expect((await rows(empty.p.id))[0]).toMatchObject({
    score: 0,
    eligible: false,
  });
  const wholeProject = (await loadLotMatchReview(id, empty.p.id, viewer))
    .project;
  expect(wholeProject.shape.kind).toBe("project");
  expect(wholeProject.targets).toHaveLength(1);
  expect(wholeProject.targets[0].target).toEqual({
    kind: "project",
    publicationId: empty.p.id,
  });
  expect(wholeProject.targets[0].evaluation).toBeNull();
  expect(
    (await loadLotMatchReview(id, empty.p.id, viewer)).project.lots,
  ).toEqual([]);
  noAI();
});

it("Rolls back inserted review rows when later resolution fails, and propagates cancellation without partial rows", async () => {
  const f = await fixture();
  const second = [await company(), await company()].sort()[1];
  await pg.exec(
    `CREATE FUNCTION fail_lot_worker_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${second}' THEN RAISE EXCEPTION 'invented worker failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_lot_worker_update BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION fail_lot_worker_update();`,
  );
  try {
    await expect(
      matchAdoptedPublication({ publicationId: f.p.id, now }),
    ).rejects.toThrow();
  } finally {
    await pg.exec(
      "DROP TRIGGER fail_lot_worker_update ON matches; DROP FUNCTION fail_lot_worker_update();",
    );
  }
  expect(await rows(f.p.id)).toEqual([]);
  const abort = new AbortController();
  abort.abort(new Error("invented cancellation"));
  await expect(
    matchAdoptedPublication({
      publicationId: f.p.id,
      now,
      signal: abort.signal,
    }),
  ).rejects.toThrow("invented cancellation");
  expect(await rows(f.p.id)).toEqual([]);
  noAI();
});

it("Legacy import cannot overwrite an adopted archive, and a new canonical copy does not inherit lot judgments", async () => {
  const f = await fixture(),
    id = await company();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  await reviewSource(f);
  await reviewLot(f, id);
  const before = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, f.p.id)),
    matched = await rows(f.p.id),
    audit = await db.select().from(schema.matchLotReviewEvents);
  await expect(
    storePublication({
      ...f.p,
      revision: "new-legacy-revision",
      originalText: "Replacement without archive",
    }),
  ).rejects.toThrow("aggiornamento documentario completo");
  expect(
    await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, f.p.id)),
  ).toEqual(before);
  expect(await rows(f.p.id)).toEqual(matched);
  const copy = {
    ...f.p,
    id: `simap-${randomUUID()}`,
    externalId: randomUUID(),
    canonicalKey: f.p.id,
    sourceUrl: "https://example.invalid/new-canonical-copy",
    sourceUrls: ["https://example.invalid/new-canonical-copy"],
    publishedAt: "2026-09-02T00:00:00.000Z",
    revision: "new-invented-copy",
    projectId: "INVENTED-NEW-2",
  };
  copy.id = `simap-${copy.externalId}`;
  await storePublication(copy);
  const copied = await rows(copy.id);
  expect(copied).toHaveLength(1);
  expect(copied[0].lotEvaluations).toBeNull();
  expect(copied[0].lotSuppression).toBeNull();
  expect(copied[0].approved).toBeNull();
  expect(copied[0].score).toBe(0);
  expect(copied[0].reason).toContain(
    "giudizi dei lotti precedenti restano storici",
  );
  expect(await rows(f.p.id)).toEqual(matched);
  expect(await db.select().from(schema.matchLotReviewEvents)).toEqual(audit);
  expect(
    (
      await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, f.p.id))
    )[0].documentarySnapshotId,
  ).toBe(f.initial.id);
  noAI();
});

it.each(["summary", "classification"] as const)(
  "Discards an already-started legacy %s when adoption commits before its write, then creates only the human review row",
  async (stage) => {
    const f = await fixture({ adopt: false });
    await company();
    const legacy = {
      ...f.p,
      canton: "TI",
      sectors: ["giardinaggio"] as ["giardinaggio"],
      title: "Potatura e cura del verde inventata",
      originalTitles: [],
      cpv: ["77310000"],
      summary: stage === "classification" ? "Existing summary" : null,
    };
    await db
      .update(schema.publications)
      .set({
        data: legacy,
        aiRevision: stage === "classification" ? legacy.revision : null,
      })
      .where(eq(schema.publications.id, f.p.id));
    if (stage === "summary")
      vi.mocked(summarize).mockImplementationOnce(async () => {
        await f.adopt();
        return {
          summary: "STALE AI SUMMARY",
          sectors: ["giardinaggio"],
          requirements: [],
          evidence: [],
        };
      });
    else
      vi.mocked(classify).mockImplementationOnce(async () => {
        await f.adopt();
        return {
          score: 99,
          reason: "STALE AI MATCH",
          uncertain: false,
          needsReview: false,
        };
      });
    await enrichAndMatch({ publicationId: f.p.id, now });
    const matched = await rows(f.p.id),
      [source] = await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, f.p.id));
    expect(source.data.summary).toBe(legacy.summary);
    expect(matched).toHaveLength(1);
    expect(matched[0].score).toBe(0);
    expect(matched[0].eligible).toBe(false);
    expect(matched[0].reason).not.toContain("STALE AI");
    expect(matched[0].revision).toContain(LOT_WORKER_REVIEW_VERSION);
    expect(summarize).toHaveBeenCalledTimes(stage === "summary" ? 1 : 0);
    expect(classify).toHaveBeenCalledTimes(stage === "classification" ? 1 : 0);
  },
);

it("Independent source conflicts stop before draft approval and are reused across companies", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    const answer = inventedAnswer(prompt);
    if (purpose !== "documentary-source-evidence") return answer;
    const data = JSON.parse(prompt);
    expect(data.draft).toBeUndefined();
    expect(data.assignedClaims).toBeUndefined();
    if (!("observations" in answer))
      throw new Error("Expected independent evidence");
    return {
      ...answer,
      issues: [
        {
          kind: "source_conflict",
          reason:
            "Contraddizione inventata per verificare l'arresto prima del draft.",
          evidence: answer.observations[0].evidence,
        },
      ],
    };
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "completed",
  });
  const first = await storedAutomaticResult(job.runId);
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
    "documentary-source-evidence",
  ]);
  expect(first.sourceReview?.responses).toEqual([]);
  expect(first.sourceReview?.sourceEvidence.responses[0].issues).toHaveLength(
    1,
  );
  expect(first.response).toBeNull();
  const secondJob = await automaticJob(f.p.id, await company());
  vi.mocked(infer).mockClear();
  expect(await runAutomaticComparison(secondJob, { now: () => now })).toEqual({
    status: "completed",
  });
  expect((await storedAutomaticResult(secondJob.runId)).sourceReview).toEqual(
    first.sourceReview,
  );
  expect(infer).not.toHaveBeenCalled();
});

it("A source correction during independent reading prevents exposing the draft to the reviewer", async () => {
  const { f, job } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, purpose, prompt) => {
    if (purpose === "documentary-source-evidence") {
      const corrected = structuredClone(f.raw);
      corrected.lots[0].orderDescription.it =
        "Rettifica inventata: fornitura di alberi.";
      await f.adopt((await f.observation(corrected)).id);
    }
    return inventedAnswer(prompt);
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "superseded",
  });
  expect(vi.mocked(infer).mock.calls.map((call) => call[1])).toEqual([
    "documentary-source-interpretation",
    "documentary-source-evidence",
  ]);
});

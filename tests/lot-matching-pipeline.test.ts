import {
  encodeInventedSourceSelections,
  inventedSourceEvidenceAnswer,
  encodeInventedSourceEvidenceAnswer,
  inventedCoverageProof,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
import {
  materializeSourceInterpretationPassages,
  materializeSourceInterpretationFields,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import {
  SOURCE_REVIEW_SUPPORTED_REASON,
  materializeSourceReviewOriginals,
} from "../src/lib/source-semantic-review";
import { buildSourceLiteralCatalogue } from "../src/lib/source-literal-catalogue";
import { resolveSourceSelection } from "../src/lib/source-selection";
import { componentEvidenceGroups } from "../src/lib/source-interpretation";
import { originalClauseTextParts } from "../src/lib/source-clause-literals";
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
import { AI_PROCESSING_NOTICE_HASH } from "../src/lib/ai-processing-permission";
import {
  AI_PROCESSING_NOTICE,
  AI_PROCESSING_NOTICE_VERSION,
  AI_PROCESSING_RECIPIENT,
} from "../src/lib/ai-processing-notice";
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
  vi.stubEnv("DOCUMENTARY_OPERATIONAL_READING_ENABLED", "false");
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "10");
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("DOCUMENTARY_LLM_PROVIDER", "");
  vi.stubEnv("OPENAI_API_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("DOCUMENTARY_LLM_MODEL", "");
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "none");
  vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "none");
  vi.stubEnv("LLM_REASONING_EFFORT", "");
  // Inference is mocked; production provider restrictions and receipt checks
  // remain real. Model-key invalidation is covered in source-interpretation.
  vi.stubEnv("LLM_MODEL", "gpt-6-luna");
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

function inventedReviewWire(prompt: string, data: any): any {
  const call = vi
    .mocked(infer)
    .mock.calls.findLast((args) => args[2] === prompt);
  const schema: any = call?.[6]?.json_schema?.schema;
  if (!schema)
    throw Error("Invented review requires its bound provider schema");
  const deref = (node: any): any =>
    node?.$ref
      ? deref(
          node.$ref
            .slice(2)
            .split("/")
            .reduce(
              (v: any, key: string) =>
                v[key.replace(/~1/g, "/").replace(/~0/g, "~")],
              schema,
            ),
        )
      : node;
  const checks = deref(deref(schema).properties.checksByClaim).properties;
  return {
    chunkId: data.chunkId,
    sourceEvidenceHash: data.sourceEvidenceHash,
    coverage: "complete",
    checksFormat: data.referenceSelectionFormat.checksFormat,
    checksByClaim: Object.fromEntries(
      data.assignedClaims.map((claim: any) => {
        const choice = deref(checks[claim.id]);
        const supported = choice.anyOf
          ? choice.anyOf
              .map(deref)
              .find(
                (s: any) =>
                  deref(s.properties.verdict).const === "supported" ||
                  deref(s.properties.verdict).enum?.includes("supported"),
              )
          : choice;
        const readingShape = deref(
          supported.properties.readingRefsById ??
            supported.properties.readingRefs,
        );
        const readingAlternatives = readingShape.anyOf
          ? readingShape.anyOf.map(deref)
          : [readingShape];
        const readingIds = supported.properties.readingRefs
          ? deref(readingShape.items).enum
          : Object.keys(readingAlternatives[0].properties ?? {});
        if (
          !supported.properties.readingRefs &&
          readingAlternatives.some(
            (branch: any) =>
              JSON.stringify(Object.keys(branch.properties ?? {})) !==
              JSON.stringify(readingIds),
          )
        )
          throw Error("Invented reading alternatives differ in ownership");
        const selected = inventedReadingRefs(data, claim);
        if (selected.some((id: string) => !readingIds.includes(id)))
          throw Error("Invented review choice outside its reading ownership");
        const proof = inventedCoverageProof(
          data.draft,
          claim,
          "supported",
          data,
        );
        const coverage = supported.properties.coverageBySource
          ? deref(supported.properties.coverageBySource).properties
          : {};
        const coverageBySource = Object.fromEntries(
          Object.keys(coverage).map((ref) => {
            const row = proof.find((p: any) => p.sourceRef === ref);
            if (!row)
              throw Error("Invented review missing explicit coverage choice");
            const shape = deref(coverage[ref]);
            const represented = shape.anyOf
              ? shape.anyOf
                  .map(deref)
                  .find(
                    (s: any) =>
                      deref(s.properties?.disposition)?.const ===
                        "represented" ||
                      deref(s.properties?.disposition)?.enum?.includes(
                        "represented",
                      ),
                  )
              : shape;
            return [
              ref,
              row.disposition !== "represented"
                ? { disposition: row.disposition, draftPaths: [] }
                : represented.properties.draftPathsByPath
                  ? {
                      disposition: "represented",
                      draftPathsByPath: Object.fromEntries(
                        Object.keys(
                          deref(represented.properties.draftPathsByPath)
                            .properties,
                        ).map((path) => [
                          path,
                          row.witnesses.some((w: any) => w.draftPath === path),
                        ]),
                      ),
                    }
                  : {
                      disposition: "represented",
                      draftPaths: row.witnesses.map((w: any) => w.draftPath),
                    },
            ];
          }),
        );
        return [
          claim.id,
          {
            verdict: "supported",
            draftQuote: null,
            reason: SOURCE_REVIEW_SUPPORTED_REASON,
            sourceRefs: claim.sourceRefs,
            ...(supported.properties.readingRefs
              ? { readingRefs: selected }
              : {
                  readingRefsById: Object.fromEntries(
                    readingIds.map((id: string) => [id, selected.includes(id)]),
                  ),
                }),
            ...(supported.properties.performanceRef
              ? {
                  performanceRef: selected.find((id: string) =>
                    (
                      deref(supported.properties.performanceRef).enum ?? [
                        deref(supported.properties.performanceRef).const,
                      ]
                    ).includes(id),
                  ),
                }
              : {}),
            coverageBySource,
          },
        ];
      }),
    ),
    findings: [],
  };
}
function inventedNegativeReview(
  prompt: string,
  answer: any,
  firstOnly: boolean,
): any {
  const data = JSON.parse(prompt),
    call = vi.mocked(infer).mock.calls.findLast((args) => args[2] === prompt),
    schema: any = call?.[6]?.json_schema?.schema;
  const deref = (node: any): any =>
    node?.$ref
      ? deref(
          node.$ref
            .slice(2)
            .split("/")
            .reduce(
              (v: any, key: string) =>
                v[key.replace(/~1/g, "/").replace(/~0/g, "~")],
              schema,
            ),
        )
      : node;
  const choices = deref(deref(schema).properties.checksByClaim).properties;
  return {
    ...answer,
    checksByClaim: Object.fromEntries(
      Object.entries(answer.checksByClaim).map(
        ([id, check]: [string, any], index) => {
          if (firstOnly && index !== 0) return [id, check];
          const alternatives = deref(choices[id]).anyOf.map(deref),
            negative = alternatives.find((s: any) =>
              deref(s.properties.verdict).enum?.includes("not_verifiable"),
            );
          const ids = negative.properties.readingRefs
            ? deref(deref(negative.properties.readingRefs).items).enum
            : Object.keys(
                deref(negative.properties.readingRefsById).properties,
              );
          const selected =
            check.readingRefs ??
            Object.entries(check.readingRefsById)
              .filter(([, chosen]) => chosen)
              .map(([ref]) => ref);
          if (selected.some((ref: string) => !ids.includes(ref)))
            throw Error("Invented negative choice loses an original selection");
          const { performanceRef: _performance, ...negativeChoice } = check;
          return [
            id,
            {
              ...negativeChoice,
              verdict: firstOnly ? "contradicted" : "not_verifiable",
              draftQuote: data.assignedClaims
                .find((c: any) => c.id === id)
                .text.slice(0, 1200),
              reason: firstOnly
                ? "Contraddizione inventata per verificare l'arresto del confronto."
                : "Riscontro inventato non determinabile.",
              ...(negative.properties.readingRefs
                ? { readingRefs: selected }
                : {
                    readingRefsById: Object.fromEntries(
                      ids.map((ref: string) => [
                        ref,
                        check.readingRefsById[ref] ?? false,
                      ]),
                    ),
                  }),
            },
          ];
        },
      ),
    ),
  };
}
function inventedAnswer(prompt: string) {
  const data = JSON.parse(prompt);
  if (data.items) {
    const ids = data.items.flatMap((item: any) =>
      item.passage ? [item.passage.id] : [],
    );
    const required = data.requiredPassageIds ?? [];
    return required.length
      ? {
          chunkId: data.chunkId,
          status: "complete",
          referenceFormat: "explicit_required_originals_v2",
          requiredSourceRefs: Object.fromEntries(
            required.map((id: string) => [id, id]),
          ),
          sourceRefs: ids.filter((id: string) => !required.includes(id)),
        }
      : {
          chunkId: data.chunkId,
          status: "complete",
          referenceFormat: "explicit_optional_selection_v2",
          selections: Object.fromEntries(ids.map((id: string) => [id, true])),
        };
  }
  if (data.stage === "original_source_evidence")
    return encodeInventedSourceEvidenceAnswer(
      inventedSourceEvidenceAnswer(data),
    );
  if (data.assignedClaims) return inventedReviewWire(prompt, data);
  if (!data.company) {
    data.passages = materializeSourceInterpretationPassages(prompt);
    data.fields = materializeSourceInterpretationFields(prompt);
    const target = data.passages.find(
      (passage: { scope: string; role: string }) =>
        passage.scope === data.targetScope && passage.role === "service",
    );
    const choice = {
      status: "resolved",
      details:
        data.contractDetailFamilies?.map(
          (family: {
            scope: string;
            sourceRefs: string[];
            originalTextPartCount?: number;
            originalMultilingualExplanation?: string;
            originalScalarExplanation?: string;
          }) => {
            const parts = (family.originalTextPartCount
              ? originalClauseTextParts(
                  data.passages.filter((p: { id: string }) =>
                    family.sourceRefs.includes(p.id),
                  ),
                )
              : undefined) ?? [
              family.originalMultilingualExplanation ??
                family.originalScalarExplanation ??
                "Condizione strutturata inventata.",
            ];
            return {
              kind: "execution_condition",
              scope: family.scope,
              sourceRefs: family.sourceRefs,
              explanation: parts[0],
              ...(parts.length > 1
                ? { originalTextContinuation: parts.slice(1) }
                : {}),
            };
          },
        ) ?? [],
      summary:
        "Potatura degli alberi, fonte inventata per la verifica della coda.",
      summarySourceRefs: [target.id],
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
            objectText: Array.from(target.text as string)
              .slice(0, 100)
              .join(""),
            basis: "explicit_text",
            objectRefs: [target.id],
            classificationContextIds: [],
          },
        },
      ],
      issues: [],
      targetRef: target.id,
    };
    const selected: any = {
      ...choice,
      evidenceFormat: "source_selections_v20",
      details: [],
      contractClauseDetails: {},
      classificationReadingsById: Object.fromEntries(
        data.classificationContext.map((c: any) => [
          c.id,
          {
            ownSourceRef: c.labels[0]?.sourceRefs[0] ?? c.code.sourceRefs[0],
            use:
              c.appliesTo === "shared_project_context"
                ? "shared_project_only"
                : "broad_context",
            sourceRefs: [],
            componentIndexes: [],
          },
        ]),
      ),
    };
    delete selected.classificationReadings;
    selected.summaryAdditionalSourceRefs = choice.summarySourceRefs.filter(
      (id) => id !== choice.targetRef,
    );
    delete selected.summarySourceRefs;
    selected.components = choice.components.map(
      ({ sourceRefs, roleEvidence, meaning, ...c }: any) => ({
        ...c,
        evidence: sourceRefs.map((sourceRef: string) => ({ sourceRef })),
        roleEvidence: {
          state: roleEvidence.state,
          scope: roleEvidence.scope,
          actionSelection: {
            sourceRef: roleEvidence.sourceRefs[0],
            exactText: roleEvidence.actionText,
          },
        },
        meaning: {
          state: meaning.state,
          statement: meaning.statement,
          basis: meaning.basis,
          objectSelection: {
            sourceRef: meaning.objectRefs[0],
            exactText: meaning.objectText,
          },
        },
      }),
    );
    const context: any = {
      binding: {
        target:
          data.target.kind === "lot"
            ? {
                kind: "lot",
                publicationId: "invented-fixture",
                sourceProjectId: "invented-project",
                lotId: data.target.lot.id,
              }
            : { kind: "project", publicationId: "invented-fixture" },
        source: { invented: true },
        fieldsHash: "a".repeat(64),
        shapeEpochToken: "invented-fixture",
        model: "invented-model",
        reasoningEffort: "medium",
        maxTokens: 8192,
      },
      targetScope: data.targetScope,
      coverage: data.coverage,
      body: {
        target: data.target,
        classifications: data.classificationContext.map(
          ({ id, ...c }: any) => ({
            ...c,
            code: c.code
              ? {
                  sourceRefs: c.code.sourceRefs,
                  text: c.code.sourceRefs
                    .map(
                      (ref: string) =>
                        data.passages.find((p: any) => p.id === ref)!.text,
                    )
                    .join(""),
                }
              : null,
            labels: c.labels.map((l: any) => ({
              ...l,
              text: l.sourceRefs
                .map(
                  (ref: string) =>
                    data.passages.find((p: any) => p.id === ref)!.text,
                )
                .join(""),
            })),
          }),
        ),
        fields: data.fields.map(({ id, ...f }: any) => f),
        passages: data.passages.map((p: any) => ({
          ...p,
          url: "https://example.invalid/invented-pipeline-source",
        })),
      },
      readings: data.readings,
    };
    const groups = componentEvidenceGroups(context.body.passages),
      catalogue = buildSourceLiteralCatalogue(context.body.passages, groups);
    const literal = catalogue.selections.find(
      (s) =>
        s.sourceRef === target.id ||
        groups.some(
          (g) => g.id === s.sourceRef && g.sourceRefs.includes(target.id),
        ),
    )!;
    if (!literal)
      throw Error("Invented fixture lacks its declared original literal part");
    const own = resolveSourceSelection(
      {
        sourceRef: literal.sourceRef,
        startUtf16: literal.startUtf16,
        endUtf16: literal.endUtf16,
      },
      context.body.passages,
      groups,
    );
    const encoded = encodeInventedSourceSelections(context, {
      ...selected,
      components: [],
    });
    encoded.evidenceFormat = "source_selections_v21_owned";
    encoded.components = selected.components.map(({ evidence: _oldEvidence, ...c }: any) => ({
      ...c,
      evidenceDeclaration: { basis: "selected_action_object_plus_explicit_additional_originals", additionalEvidence: [] },
      roleEvidence: {
        ...c.roleEvidence,
        actionSelection: { literalSelectionId: literal.id },
      },
      meaning: {
        ...c.meaning,
        objectSelection: { literalSelectionId: literal.id },
      },
    }));
    return encoded;
  }

  return {
    functionCheck: {
      requested: {
        description: "Funzione richiesta simulata per il test della coda.",
        componentRefs: [data.sourceInterpretation.components[0].id],
      },
      declared: {
        description: "Funzione dichiarata simulata per il test della coda.",
        companyRefs: [data.company.activities[0].id],
      },
      relationship: "Rapporto simulato per il solo test tecnico della coda.",
      differences: "Nessuna differenza nella simulazione tecnica.",
    },
    comparison: "Risposta inventata per la sola verifica tecnica della coda.",
    interpretationHash: data.sourceInterpretation.hash,
    reviewHash: data.sourceInterpretation.reviewHash,
    componentRefs: [data.sourceInterpretation.components[0].id],
    companyRefs: [data.company.activities[0].id],
    facts: {
      companyIdentifiesService: true,
      activitiesOverlap: true,
      relatedActivity: "none",
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
  expect(infer).toHaveBeenCalledTimes(6);
  for (const call of vi.mocked(infer).mock.calls)
    expect(call[7]?.timeoutMs).toBe(300_000);
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
    "documentary-source-semantic-review",
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
      classificationReadingsById: Object.fromEntries(
        Object.entries(answer.classificationReadingsById).map(
          ([id, reading]: [string, any]) => [
            id,
            { ...reading, use: "unresolved" },
          ],
        ),
      ),
      components: answer.components!.map(
        (
          component: NonNullable<
            StoredAutomaticComparison["sourceInterpretation"]["response"]["components"]
          >[number],
        ) => ({
          ...component,
          meaning: {
            ...component.meaning,
            state: "ambiguous",
            basis: "unresolved",
            statement: "Il servizio inventato richiede chiarimento.",
          },
        }),
      ),
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
    if (!("checksByClaim" in answer))
      throw new Error("Expected semantic review");
    return {
      ...answer,
      ...inventedNegativeReview(prompt, answer, true),
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
    "documentary-source-semantic-review",
    "documentary-source-semantic-review",
  ]);
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.project.targets[0].automatic?.serviceRelation).toBe("review");
  expect(loaded.project.signalEligible).toBe(false);
  const { relatedReviewTargets, lotOpportunityVisible } =
    await import("../src/lib/lot-readers");
  expect(relatedReviewTargets(loaded)).toEqual([]);
  expect(lotOpportunityVisible(loaded, false, now, true)).toBe(false);
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
      "documentary-source-semantic-review",
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
    if (!("checksByClaim" in answer))
      throw new Error("Expected semantic review");
    return {
      ...answer,
      ...inventedNegativeReview(prompt, answer, false),
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
      const declared: any = inventedAnswer(prompt);
      if (declared.requiredSourceRefs)
        declared.sourceRefs = reading.items.flatMap((item: any) =>
          item.passage?.rawPath === "/lots/0/orderDescription/it" &&
          !reading.requiredPassageIds.includes(item.passage.id)
            ? [item.passage.id]
            : [],
        );
      else
        declared.selections = Object.fromEntries(
          reading.items.flatMap((item: any) =>
            item.passage
              ? [
                  [
                    item.passage.id,
                    item.passage.rawPath === "/lots/0/orderDescription/it",
                  ],
                ]
              : [],
          ),
        );
      return declared;
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
  for (const call of calls) expect(call[7]?.timeoutMs).toBe(300_000);
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
  expect(interpretationCall[3]).toBe(16_384);
  expect(interpretationCall[7]).toMatchObject({
    model: first.sourceInterpretation.model,
    reasoningEffort: "none",
  });
  expect(calls.at(-1)![3]).toBe(8192);
  expect(calls.at(-1)![7]?.reasoningEffort).toBe("high");
  const interpretationPrompt = {
    ...JSON.parse(interpretationCall[2]),
    passages: materializeSourceInterpretationPassages(interpretationCall[2]),
    fields: materializeSourceInterpretationFields(interpretationCall[2]),
  };
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
  const retainedClauses = interpretationPrompt.passages.filter(
    (passage: { rawPath: string }) =>
      passage.rawPath === "/procurement/executionNote/it",
  );
  expect(
    retainedClauses.map((passage: { text: string }) => passage.text).join(""),
  ).toBe(contextText);
  const conditionRefs = first.sourceInterpretation.response.details.flatMap(
    (detail) => detail.sourceRefs,
  );
  expect(
    retainedClauses.every((passage: { id: string }) =>
      conditionRefs.includes(passage.id),
    ),
  ).toBe(true);
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
    for (const passage of materializeSourceReviewOriginals(reviewCall[2])
      .passages) {
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

for (const changed of ["source", "source_reasoning"] as const)
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
    } else vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "high");
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
      "documentary-source-semantic-review",
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

it("The pinned OpenAI model cannot be replaced by an unvalidated model", async () => {
  const { job } = await automaticFixture();
  vi.stubEnv("LLM_MODEL", "another-invented-documentary-model");
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  expect(infer).not.toHaveBeenCalled();
});

it("Pilot participation alone never queues a private AI comparison", async () => {
  vi.stubEnv("DOCUMENTARY_COMPARISON_ENABLED", "true");
  const f = await fixture();
  await company(baseProfile, { aiPermission: false });
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  expect(
    await db
      .select()
      .from(schema.automaticMatchRuns)
      .where(eq(schema.automaticMatchRuns.publicationId, f.p.id)),
  ).toEqual([]);
  expect(infer).not.toHaveBeenCalled();
});

it("A queued comparison is invalidated when the AI permission is revoked", async () => {
  const { job, companyId } = await automaticFixture();
  await db
    .update(schema.aiProcessingReceipts)
    .set({ revokedAt: new Date() })
    .where(eq(schema.aiProcessingReceipts.companyId, companyId));
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "skipped",
  });
  expect(infer).not.toHaveBeenCalled();
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run.result).toBeNull();
  expect(run.status).toBe("superseded");
});

it("Revocation after a public reading prevents the private company request", async () => {
  const { job, companyId } = await automaticFixture();
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) => {
    await db
      .update(schema.aiProcessingReceipts)
      .set({ revokedAt: new Date() })
      .where(eq(schema.aiProcessingReceipts.companyId, companyId));
    return inventedAnswer(prompt);
  });
  expect(await runAutomaticComparison(job, { now: () => now })).toEqual({
    status: "superseded",
  });
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
  expect(infer).toHaveBeenCalledTimes(6);
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
  expect(infer).toHaveBeenCalledTimes(6);
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
    aiPermission?: boolean;
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
  if (options.aiPermission !== false)
    await db.insert(schema.aiProcessingReceipts).values({
      id: randomUUID(),
      companyId: id,
      userId: id,
      recipient: AI_PROCESSING_RECIPIENT,
      noticeVersion: AI_PROCESSING_NOTICE_VERSION,
      noticeHash: AI_PROCESSING_NOTICE_HASH,
      noticeText: AI_PROCESSING_NOTICE.join("\n\n"),
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

it("A verified related-role result has a separate customer view but never enables alerts or crosses companies", async () => {
  const { listOpportunities, getOpportunity } =
    await import("../src/lib/queries");
  const { relatedReviewTargets, lotOpportunityVisible } =
    await import("../src/lib/lot-readers");
  const { demoViewer } = await import("../src/lib/demo");
  const { f, companyId, job } = await automaticFixture(true);
  // Deliberately simulated relationship facts test the reader/worker boundary,
  // not the semantic quality of any real company or source.
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) => {
    const answer = inventedAnswer(prompt);
    if (!("facts" in answer)) return answer;
    return {
      ...answer,
      facts: {
        ...answer.facts,
        activitiesOverlap: false,
        relatedActivity: "shared_professional_function",
        sameContractualRole: false,
        mainScopeCovered: false,
      },
    };
  });
  await runAutomaticComparison(job, { now: () => now });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
    expect(loaded.project.signalEligible).toBe(false);
    expect(loaded.project.qualityEventIds).toEqual([]);
    expect(relatedReviewTargets(loaded)).toHaveLength(1);
    expect(lotOpportunityVisible(loaded, false, now)).toBe(false);
    expect(lotOpportunityVisible(loaded, false, now, true)).toBe(true);
    expect(() =>
      lotNoticeScope(loaded, loaded.project.targets[0].target, "positive"),
    ).toThrow();
    const who = {
      ...demoViewer,
      companyId,
      profile: baseProfile,
      demo: false,
      admin: false,
    };
    expect(await listOpportunities(who)).toEqual([]);
    const candidates = await listOpportunities(who, {
      includeRelatedReview: true,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: f.p.id,
      reviewCandidate: true,
      score: 0,
      assessment: "uncertain",
    });
    expect((await getOpportunity(who, f.p.id))?.reviewCandidate).toBe(true);
    await db
      .update(schema.publications)
      .set({ status: "cancelled" })
      .where(eq(schema.publications.id, f.p.id));
    expect(
      await listOpportunities(who, { includeRelatedReview: true }),
    ).toEqual([]);
    await db
      .update(schema.publications)
      .set({ status: "open", visibleAt: new Date(now.getTime() + 86_400_000) })
      .where(eq(schema.publications.id, f.p.id));
    expect(
      await listOpportunities(who, { includeRelatedReview: true }),
    ).toEqual([]);
    await db
      .update(schema.publications)
      .set({ visibleAt: loaded.publication.visibleAt })
      .where(eq(schema.publications.id, f.p.id));
    expect(
      await listOpportunities(who, { includeRelatedReview: true }),
    ).toHaveLength(1);

    const other = { ...who, companyId: randomUUID() };
    expect(
      await listOpportunities(other, { includeRelatedReview: true }),
    ).toEqual([]);
    expect(await getOpportunity(other, f.p.id)).toBeNull();
    await db
      .update(schema.companies)
      .set({
        profile: { ...baseProfile, activities: "Attività inventata cambiata" },
      })
      .where(eq(schema.companies.id, companyId));
    expect(
      await listOpportunities(who, { includeRelatedReview: true }),
    ).toEqual([]);
    expect((await getOpportunity(who, f.p.id))?.reviewCandidate).toBe(false);
    await db
      .update(schema.companies)
      .set({ profile: baseProfile })
      .where(eq(schema.companies.id, companyId));
    expect(
      await listOpportunities(who, { includeRelatedReview: true }),
    ).toHaveLength(1);
    const changed = structuredClone(f.raw);
    changed.procurement.orderDescription.it +=
      " Prestazione aggiuntiva inventata.";
    await f.adopt((await f.observation(changed)).id);
    expect(
      await listOpportunities(who, { includeRelatedReview: true }),
    ).toEqual([]);

    expect(await db.select().from(schema.notifications)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("A current AI result is visible without a human evaluation, and remains outside the related view", async () => {
  const { listOpportunities } = await import("../src/lib/queries");
  const { demoViewer } = await import("../src/lib/demo");
  const { f, companyId, job } = await automaticFixture(true);
  vi.mocked(infer).mockImplementation(async (_pub, _purpose, prompt) =>
    inventedAnswer(prompt),
  );
  await runAutomaticComparison(job, { now: () => now });
  const [match] = await db
    .select()
    .from(schema.matches)
    .where(
      and(
        eq(schema.matches.publicationId, f.p.id),
        eq(schema.matches.companyId, companyId),
      ),
    );
  expect(match.lotEvaluations).toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    const who = {
      ...demoViewer,
      companyId,
      profile: baseProfile,
      demo: false,
      admin: false,
    };
    for (const includeRelatedReview of [false, true]) {
      const rows = await listOpportunities(who, { includeRelatedReview });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: f.p.id,
        reviewCandidate: false,
        score: 100,
        assessment: "ai",
      });
    }
    expect(await db.select().from(schema.notifications)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

// Operational runtime tests use the real infer budget/usage ledger and injected
// transport, while the existing professional fixture calls remain mocked.
async function operationalFixture() {
  vi.stubEnv("DOCUMENTARY_COMPARISON_ENABLED", "true");
  vi.stubEnv("DOCUMENTARY_OPERATIONAL_READING_ENABLED", "true");
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
  vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-provider-key");
  vi.stubEnv("LLM_INPUT_CHF_PER_MILLION", "0.15");
  vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "0.75");
  const f = await fixture({
    sourceText: "Potatura e cura degli alberi in Ticino.",
  });
  f.raw.lots[0].orderAddressOnlyDescription = "yes";
  f.raw.lots[0].orderAddress = {
    countryId: "CH",
    cantonId: null,
    city: { it: null },
  };
  f.raw.lots[0].orderAddressDescription = { it: "Nei locali dell’offerente" };
  f.raw.lots[0].offerDeadline = "2031-02-01T12:00:00+01:00";
  const observation = await f.observation(f.raw);
  await f.adopt(observation.id);
  const companyId = await company();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.publicationId, f.p.id));
  return {
    f,
    companyId,
    job: { runId: run.id, publicationId: f.p.id, companyId },
  };
}
function operationalAnswer(prompt: string) {
  const data = decodeOperationalTaskPrompt(prompt),
    source = data.source,
    lot = source.selectedLot as any,
    path = source.selectedPath;
  const proof = (suffix: string, quote: string) => ({
    scope: "selected_lot",
    path: path + suffix,
    quote,
  });
  if (data.reading) {
    const reading = data.reading as any;
    return {
      checks: Object.fromEntries(
        ["country", "canton", "city", "deadline"].map((k) => [
          k,
          {
            verdict: reading[k] === null ? "not_verifiable" : "supported",
            evidence: reading[k + "Evidence"],
            rationale: "Invented independent proof check",
          },
        ]),
      ),
      issues: [],
    };
  }
  return {
    country: "CH",
    countryEvidence: [
      proof("/orderAddress/countryId", lot.orderAddress.countryId),
    ],
    canton: "TI",
    cantonEvidence: [proof("/orderDescription/it", lot.orderDescription.it)],
    city: null,
    cityEvidence: [],
    deadline: lot.offerDeadline,
    deadlineAppliesToTarget: true,
    deadlineEvidence: [proof("/offerDeadline", lot.offerDeadline)],
    rationale: "Invented operational reading",
    issues: [],
  };
}
async function useOperationalTransport(
  transform?: (
    answer: any,
    purpose: string,
    prompt: string,
  ) => Promise<any> | any,
) {
  const real =
    await vi.importActual<typeof import("../src/worker/ai")>(
      "../src/worker/ai",
    );
  vi.mocked(infer).mockImplementation(
    async (pub, purpose, prompt, max, unused, system, format, options) => {
      if (!purpose.startsWith("documentary-operational-"))
        return inventedAnswer(prompt);
      return real.infer(
        pub,
        purpose,
        prompt,
        max,
        {
          complete: async () => {
            let answer: any = operationalAnswer(prompt);
            if (transform) answer = await transform(answer, purpose, prompt);
            // Independent audit fixture encoder: keep the same original invented
            // semantic answers; emit the actual field-bound wire instead of v4 quotes.
            const payload = JSON.parse(prompt);
            if (payload.protocolVersion) {
              const decoded = decodeOperationalTaskPrompt(prompt);
              const ref = (p: any) => {
                const index = decoded.originalProofCatalog.findIndex((q: any) => q.scope === p.scope && q.path === p.path && q.quote === p.quote);
                if (index < 0) return "invalid-original-proof";
                const row = payload.originalProofCatalog[index];
                if (row[1] !== p.scope || row[2] !== p.path)
                  throw new Error("Invented transport proof row mismatch");
                return row[0];
              };
              if (answer.checks) answer = {binding:payload.binding,checks:Object.fromEntries(Object.entries(answer.checks).map(([k,v]:[string,any])=>[k,{...v,evidence:v.evidence.map(ref)}])),issues:answer.issues};
              else answer = {binding:payload.binding,country:answer.country,countryEvidence:answer.countryEvidence.map(ref),canton:answer.canton,cantonEvidence:answer.cantonEvidence.map(ref),city:answer.city,cityEvidence:answer.cityEvidence.map(ref),deadline:{value:answer.deadline,appliesToTarget:answer.deadlineAppliesToTarget,dateFieldId:answer.deadlineEvidence.length?ref(answer.deadlineEvidence[0]):null,submissionFieldIds:[],lotApplicabilityFieldIds:[],otherEvidenceFieldIds:answer.deadlineEvidence.slice(1).map(ref)},rationale:answer.rationale,issues:answer.issues};
            }
            return {
              text: JSON.stringify(answer),
              inputTokens: 100,
              outputTokens: 50,
            };
          },
        },
        system,
        format,
        options,
      );
    },
  );
}
async function nextOperationalProfessionalJob(
  companyId: string,
  publicationId: string,
  oldId: string,
) {
  const jobs = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(
      and(
        eq(schema.automaticMatchRuns.companyId, companyId),
        eq(schema.automaticMatchRuns.publicationId, publicationId),
        eq(schema.automaticMatchRuns.status, "queued"),
      ),
    );
  const next = jobs.find((j) => j.id !== oldId);
  expect(next).toBeDefined();
  return { runId: next!.id, publicationId, companyId };
}
it("Operational reading/review persist exact receipts, load into native assessment and enqueue the new professional binding once", async () => {
  const { f, companyId, job } = await operationalFixture();
  await useOperationalTransport();
  await runAutomaticComparison(job, { now: () => now });
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(op.status).toBe("completed");
  expect(op.receiptIds).toHaveLength(2);
  const ledger = await db
    .select()
    .from(schema.aiUsage)
    .where(eq(schema.aiUsage.publicationId, f.p.id));
  expect(ledger).toHaveLength(2);
  expect(
    ledger.every((r) => r.status === "completed" && r.costChf === "0.000056"),
  ).toBe(true);
  expect(new Set(ledger.map((r) => r.id))).toEqual(new Set(op.receiptIds));
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.input.operationalReadings).toHaveLength(1);
  expect(
    loaded.project.targets[0].preliminary?.automaticReviewReasons,
  ).not.toContain("Luogo di esecuzione del lotto da verificare.");
  const next = await nextOperationalProfessionalJob(
    companyId,
    f.p.id,
    job.runId,
  );
  await runAutomaticComparison(next, { now: () => now });
  const final = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(final.project.signalEligible).toBe(true);
  const { presentLotOpportunity, lotOpportunityVisible } =
    await import("../src/lib/lot-readers");
  expect(presentLotOpportunity(final, true).assessment).toBe("ai");
  expect(lotOpportunityVisible(final, false, now)).toBe(true);
  const { readCurrentLotMatch } = await import("../src/lib/lot-readers");
  const expired = await readCurrentLotMatch(
    companyId,
    f.p.id,
    new Date("2031-02-01T11:00:00Z"),
  );
  expect(expired).not.toBeNull();
  expect(
    lotOpportunityVisible(expired!, false, new Date("2031-02-01T11:00:00Z")),
  ).toBe(false);
  expect(final.project.targets[0].preliminary?.operational.deadline).toBe(
    "2031-02-01T12:00:00+01:00",
  );
  const paid = vi
    .mocked(infer)
    .mock.calls.filter((x) => x[1].startsWith("documentary-operational-"));
  expect(paid).toHaveLength(2);
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  await runAutomaticComparison(job, { now: () => now });
  expect(
    vi
      .mocked(infer)
      .mock.calls.filter((x) => x[1].startsWith("documentary-operational-")),
  ).toHaveLength(2);
  vi.stubEnv("DOCUMENTARY_OPERATIONAL_READING_ENABLED", "false");
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(0);
});
it("Rejected operational facts remain review and still permit independent professional work without semantic replay", async () => {
  const { f, companyId, job } = await operationalFixture();
  await useOperationalTransport((answer, purpose) =>
    purpose.includes("reading:")
      ? {
          ...answer,
          countryEvidence: [
            { ...answer.countryEvidence[0], quote: "invented incorrect quote" },
          ],
        }
      : answer,
  );
  await runAutomaticComparison(job, { now: () => now });
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(op.status).toBe("rejected");
  expect(op.receiptIds).toHaveLength(1);
  expect(op.reading).not.toBeNull();
  const next = await nextOperationalProfessionalJob(
    companyId,
    f.p.id,
    job.runId,
  );
  await runAutomaticComparison(next, { now: () => now });
  const final = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(final.input.operationalReadings).toHaveLength(0);
  expect(final.project.signalEligible).toBe(false);
  expect(final.project.targets[0].automatic?.serviceRelation).toBe("direct");
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  expect(
    vi
      .mocked(infer)
      .mock.calls.filter((x) => x[1].startsWith("documentary-operational-")),
  ).toHaveLength(1);
});
it("Revocation during reading prevents review, commit and cache consumption", async () => {
  const { f, companyId, job } = await operationalFixture();
  await useOperationalTransport(async (answer, purpose) => {
    if (purpose.includes("reading:"))
      await db
        .update(schema.aiProcessingReceipts)
        .set({ revokedAt: new Date() })
        .where(eq(schema.aiProcessingReceipts.companyId, companyId));
    return answer;
  });
  await runAutomaticComparison(job, { now: () => now });
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(op.status).toBe("superseded");
  expect(op.result).toBeNull();
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(0);
  expect(
    vi
      .mocked(infer)
      .mock.calls.filter((x) => x[1].startsWith("documentary-operational-")),
  ).toHaveLength(1);
});
it("Ordinary production budget blocks before any operational provider call and does not inherit unlimited test authorization", async () => {
  const { f, companyId, job } = await operationalFixture();
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "0");
  let dispatched = 0;
  await useOperationalTransport((answer) => {
    dispatched++;
    return answer;
  });
  await runAutomaticComparison(job, { now: () => now });
  expect(dispatched).toBe(0);
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(op.status).toBe("blocked");
  expect(op.receiptIds).toHaveLength(0);
  expect(
    await db
      .select()
      .from(schema.aiUsage)
      .where(eq(schema.aiUsage.publicationId, f.p.id)),
  ).toHaveLength(0);
});
it("Source/config changes invalidate a previously completed operational cache", async () => {
  const { f, companyId, job } = await operationalFixture();
  await useOperationalTransport();
  await runAutomaticComparison(job, { now: () => now });
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(1);
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "none");
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(0);
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
  f.raw.lots[0].orderDescription.it += " Fonte rettificata.";
  const obs = await f.observation(f.raw);
  await f.adopt(obs.id);
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(0);
});

import { decodeOperationalTaskPrompt } from "../src/lib/lot-operational-evidence";

import { resumeUnsentOperationalReading } from "../src/worker/automatic-matching";
it("An administrator can serially resume proven zero-POST budget blockage after budget restoration", async () => {
  const { f, companyId, job } = await operationalFixture();
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "0");
  let calls = 0;
  await useOperationalTransport((answer) => {
    calls++;
    return answer;
  });
  await runAutomaticComparison(job, { now: () => now });
  expect(calls).toBe(0);
  const [blocked] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(blocked.status).toBe("blocked");
  expect(blocked.receiptIds).toHaveLength(0);
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "10");
  await expect(
    resumeUnsentOperationalReading(job, { ...viewer, admin: false }, now),
  ).rejects.toThrow("administrator");
  expect(await resumeUnsentOperationalReading(job, viewer, now)).toBe(true);
  expect(await resumeUnsentOperationalReading(job, viewer, now)).toBe(false);
  await runAutomaticComparison(job, { now: () => now });
  expect(calls).toBe(2);
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(op.id).toBe(blocked.id);
  expect(op.status).toBe("completed");
  expect(op.recoveryLog).toHaveLength(1);
  expect(op.receiptIds).toHaveLength(2);
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(1);
  expect(await resumeUnsentOperationalReading(job, viewer, now)).toBe(false);
});

it("An original native territorial veto produces no operational run or provider work", async () => {
  vi.stubEnv("DOCUMENTARY_COMPARISON_ENABLED", "true");
  vi.stubEnv("DOCUMENTARY_OPERATIONAL_READING_ENABLED", "true");
  const f = await fixture();
  f.raw.lots[0].orderAddress = {
    countryId: "CH",
    cantonId: "VD",
    city: { fr: "Lausanne" },
  };
  const obs = await f.observation(f.raw);
  await f.adopt(obs.id);
  await company();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  expect(
    await db
      .select()
      .from(schema.automaticMatchRuns)
      .where(eq(schema.automaticMatchRuns.publicationId, f.p.id)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(schema.operationalReadingRuns)
      .where(eq(schema.operationalReadingRuns.publicationId, f.p.id)),
  ).toHaveLength(0);
  expect(infer).not.toHaveBeenCalled();
});
it("Concurrent deliveries do not duplicate operational reading, review or receipts", async () => {
  const { f, companyId, job } = await operationalFixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  await useOperationalTransport(async (answer, purpose) => {
    if (purpose.includes("reading:")) {
      entered();
      await gate;
    }
    return answer;
  });
  const first = runAutomaticComparison(job, { now: () => now });
  await started;
  await expect(runAutomaticComparison(job, { now: () => now })).rejects.toThrow(
    "già in elaborazione",
  );
  expect(await resumeUnsentOperationalReading(job, viewer, now)).toBe(false);
  release();
  await first;
  expect(
    vi
      .mocked(infer)
      .mock.calls.filter((c) => c[1].startsWith("documentary-operational-")),
  ).toHaveLength(2);
  expect(
    await db
      .select()
      .from(schema.operationalReadingRuns)
      .where(eq(schema.operationalReadingRuns.companyId, companyId)),
  ).toHaveLength(1);
});
it("Null operational facts persist as held, yet professional work proceeds without a repeated reading", async () => {
  const { f, companyId, job } = await operationalFixture();
  await useOperationalTransport((answer, purpose) =>
    purpose.includes("reading:")
      ? { ...answer, canton: null, cantonEvidence: [] }
      : answer,
  );
  await runAutomaticComparison(job, { now: () => now });
  const next = await nextOperationalProfessionalJob(
    companyId,
    f.p.id,
    job.runId,
  );
  await runAutomaticComparison(next, { now: () => now });
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.input.operationalReadings).toHaveLength(1);
  expect(loaded.project.targets[0].automatic?.serviceRelation).toBe("direct");
  expect(loaded.project.signalEligible).toBe(false);
  expect(loaded.project.targets[0].preliminary?.operational.canton).toBeNull();
  expect(
    vi
      .mocked(infer)
      .mock.calls.filter((c) => c[1].startsWith("documentary-operational-")),
  ).toHaveLength(2);
});
it("A source change between the final guard and atomic commit discards the verified operational answer", async () => {
  const { f, companyId, job } = await operationalFixture();
  let afterReview = false,
    transactions = 0;
  await useOperationalTransport(async (answer, purpose) => {
    if (purpose.includes("review:")) {
      afterReview = true;
      injected.db = new Proxy(db, {
        get(target, prop) {
          if (prop === "transaction")
            return async (callback: Parameters<typeof db.transaction>[0]) => {
              if (afterReview && ++transactions === 3) {
                injected.db = db;
                f.raw.lots[0].orderDescription.it +=
                  " Fonte cambiata prima del commit.";
                const obs = await f.observation(f.raw);
                await f.adopt(obs.id);
              }
              return db.transaction(callback);
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return answer;
  });
  await runAutomaticComparison(job, { now: () => now });
  injected.db = db;
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  expect(transactions).toBe(3);
  expect(op.status).toBe("superseded");
  expect(op.result).toBeNull();
  expect(op.receiptIds).toHaveLength(2);
  expect(
    (await loadLotMatchReview(companyId, f.p.id, viewer)).input
      .operationalReadings,
  ).toHaveLength(0);
  const [run] = await db
    .select()
    .from(schema.automaticMatchRuns)
    .where(eq(schema.automaticMatchRuns.id, job.runId));
  expect(run.status).toBe("superseded");
  expect(run.leaseUntil).toBeNull();
});

it("Abandoned operational work stays quarantined, exposes no facts and allows only independent professional work", async () => {
  const { f, companyId, job } = await operationalFixture();
  await useOperationalTransport();
  await runAutomaticComparison(job, { now: () => now });
  const [op] = await db
    .select()
    .from(schema.operationalReadingRuns)
    .where(eq(schema.operationalReadingRuns.companyId, companyId));
  await db
    .update(schema.operationalReadingRuns)
    .set({ status: "running", result: null, updatedAt: new Date(0) })
    .where(eq(schema.operationalReadingRuns.id, op.id));
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer);
  expect(loaded.input.operationalReadings).toHaveLength(0);
  expect(loaded.input.operationalAttemptKeys).toHaveLength(1);
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  expect(
    vi
      .mocked(infer)
      .mock.calls.filter((c) => c[1].startsWith("documentary-operational-")),
  ).toHaveLength(2);
  expect(await resumeUnsentOperationalReading(job, viewer, now)).toBe(false);
});

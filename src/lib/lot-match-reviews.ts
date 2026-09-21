import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  administrators,
  companies,
  feedback,
  matches,
  matchLotReviewEvents,
  publications,
  settings,
  automaticMatchRuns,
} from "@/db/schema";
import { readCanonicalFeedback } from "./canonical-feedback";
import { lockCanonicalPublications } from "./canonical-lock";
import { stableDocumentaryJson } from "./documentary-observation";
import {
  createHumanTargetAssessment,
  lotAssessmentProfileHash,
  lotEvaluationSetToken,
  resolveProjectLotAssessment,
  validateLotEvaluationSet,
  type HumanTargetAssessmentCommand,
  type LotAssessmentInput,
  type ProjectLotSuppression,
} from "./lot-assessment";
import {
  captureLotSourceSnapshot,
  type LotSourceTarget,
  type LotSourceSnapshot,
} from "./lot-source-context";
import {
  readLotSourceState,
  lotSourceTargetSchema,
} from "./lot-source-reviews";
import { preliminaryLotMatch } from "./lot-matching";
import { preliminaryProjectMatch } from "./project-matching";
import { resolveAssessmentSourceContext } from "./assessment-shape";
import { enqueueLotReconciliation } from "./lot-reconciliation";
import {
  legacyLotReviewState,
  readLotProjectSuppression,
  type CanonicalLotSuppression,
} from "./lot-project-suppression";
import type {
  LotMatchReviewRecord,
  LotMatchReviewState,
} from "./lot-review-record";
import { ReviewConflict } from "./source-review-context";
import type {
  SourceReviewExecutor,
  SourceReviewViewer,
} from "./source-reviews";
import { HttpError } from "./viewer";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(200);
const isoDate = z
  .string()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const suppressionSchema = z
  .object({
    active: z.boolean(),
    reason: z.string().min(1).max(4000),
    rejection: z
      .object({ bindingHash: hash, eventId: identifier, at: isoDate })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const common = {
  companyId: identifier,
  publicationId: identifier,
  expectedSnapshotHash: hash,
  expectedProfileHash: hash,
  expectedStateToken: hash,
  expectedGroupToken: hash,
  expectedShapeEpochToken: hash.nullable(),
  note: z.string().trim().min(10).max(800),
};
export const lotMatchReviewInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("assess_lot"),
      expectedShapeEpochToken: hash,
      target: lotSourceTargetSchema.refine((v) => v.kind === "lot"),
      expectedSourceDependency: z.unknown(),
      expectedOperationalInputHash: hash,
      expectedEvaluationSetToken: hash,
      expectedEntryHash: hash.nullable(),
      result: z.enum(["direct", "different", "review"]),
      reason: z.string().trim().min(10).max(4000),
      references: z
        .array(
          z
            .object({
              selectionHash: hash,
              rawPath: z.string().min(1).max(4096),
              startUtf16: z.number().int().nonnegative(),
              endUtf16: z.number().int().positive(),
            })
            .strict(),
        )
        .min(1)
        .max(128),
      confirmedReviewReasons: z.array(z.string().min(1).max(1000)).max(128),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("assess_project"),
      target: lotSourceTargetSchema.refine((v) => v.kind === "project"),
      expectedShapeEpochToken: hash,
      expectedSourceDependency: z.unknown(),
      expectedOperationalInputHash: hash,
      expectedEvaluationSetToken: hash,
      expectedEntryHash: hash.nullable(),
      result: z.enum(["direct", "different", "review"]),
      reason: z.string().trim().min(10).max(4000),
      references: z
        .array(
          z
            .object({
              selectionHash: hash,
              rawPath: z.string().min(1).max(4096),
              startUtf16: z.number().int().nonnegative(),
              endUtf16: z.number().int().positive(),
            })
            .strict(),
        )
        .min(1)
        .max(128),
      confirmedReviewReasons: z.array(z.string().min(1).max(1000)).max(128),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.enum(["veto_project", "reopen_project"]),
      expectedProjectBindingHash: hash,
    })
    .strict(),
]);
export type LotMatchReviewInput = z.infer<typeof lotMatchReviewInputSchema>;
type MatchRow = typeof matches.$inferSelect;
type PublicationRow = typeof publications.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

function assertViewer(viewer: SourceReviewViewer) {
  if (!viewer || viewer.demo || !viewer.admin || !viewer.userId)
    throw new HttpError(403, "Accesso riservato al fondatore autenticato.");
}
async function assertAdministrator(
  tx: SourceReviewExecutor,
  viewer: SourceReviewViewer,
) {
  const [row] = await tx
    .select()
    .from(administrators)
    .where(eq(administrators.userId, viewer.userId))
    .for("share");
  if (!row)
    throw new HttpError(403, "Accesso riservato al fondatore autenticato.");
}
function stateOf(match: MatchRow): LotMatchReviewState {
  return {
    evaluations:
      match.lotEvaluations === null
        ? null
        : validateLotEvaluationSet(
            match.lotEvaluations,
            match.companyId,
            match.publicationId,
          ),
    suppression:
      match.lotSuppression === null
        ? null
        : suppressionSchema.parse(match.lotSuppression),
  };
}
export function lotMatchStateToken(match: MatchRow) {
  return createHash("sha256")
    .update(
      stableDocumentaryJson({
        matchId: match.id,
        companyId: match.companyId,
        publicationId: match.publicationId,
        state: stateOf(match),
        // Preserve the legacy project veto until an explicit current reopening.
        legacy: legacyLotReviewState(match),
      }),
    )
    .digest("hex");
}

const reviewStateSchema = z
  .object({
    evaluations: z.unknown().nullable(),
    suppression: suppressionSchema.nullable(),
  })
  .strict();
const canonicalSuppressionSchema = z
  .object({
    version: z.literal("canonical-lot-suppression-v1"),
    companyId: identifier,
    canonicalId: identifier,
    eventId: identifier,
    suppression: suppressionSchema,
  })
  .strict();
const legacyReviewSchema = z
  .object({
    approved: z.boolean().nullable(),
    reviewedAt: isoDate.nullable(),
    reviewNotes: z.string().nullable(),
    revision: z.string(),
    score: z.number(),
    reason: z.string(),
    eligible: z.boolean(),
    sourceReviewDependency: z.unknown().nullable(),
  })
  .strict();
const auditBody = {
  id: identifier,
  matchId: identifier,
  companyId: identifier,
  publicationId: identifier,
  sequence: z.number().int().positive(),
  actorId: identifier,
  at: isoDate,
  note: z.string().min(10).max(800),
  sourceSnapshotHash: hash,
  evidenceSnapshot: z.unknown(),
  profileHash: hash,
  groupBefore: z
    .object({
      members: z.array(identifier),
      legacy: z.array(
        z
          .object({
            matchId: identifier,
            publicationId: identifier,
            legacy: legacyReviewSchema,
            reviewedSql: z.string().nullable(),
            updatedSql: z.string(),
            localSuppression: suppressionSchema.nullable(),
          })
          .strict(),
      ),
      state: canonicalSuppressionSchema.nullable(),
    })
    .strict(),
  groupAfter: canonicalSuppressionSchema.nullable(),
  before: reviewStateSchema,
  after: reviewStateSchema,
  previousToken: hash,
  nextToken: hash,
};
const auditSchema = z.discriminatedUnion("version", [
  z
    .object({
      ...auditBody,
      version: z.literal("human-lot-match-review-v1"),
      action: z.enum(["assess_lot", "veto_project", "reopen_project"]),
    })
    .strict(),
  z
    .object({
      ...auditBody,
      version: z.literal("human-lot-match-review-v2"),
      action: z.enum([
        "assess_lot",
        "assess_project",
        "veto_project",
        "reopen_project",
      ]),
      shapeEpochToken: hash.nullable(),
    })
    .strict(),
]);

// Decode both original formats. Tokens are checked with the legacy snapshot
// actually stored in groupBefore, never with today's mutable match fields.
export function decodeLotMatchReviewRecord(
  value: unknown,
): LotMatchReviewRecord {
  const event = auditSchema.parse(structuredClone(value));
  for (const state of [event.before, event.after]) {
    if (state.evaluations !== null) {
      const checked = validateLotEvaluationSet(
        state.evaluations,
        event.companyId,
        event.publicationId,
      );
      if (
        stableDocumentaryJson(checked) !==
        stableDocumentaryJson(state.evaluations)
      )
        throw new Error("Insieme storico della valutazione alterato.");
      if (
        event.version === "human-lot-match-review-v1" &&
        checked.version !== "lot-evaluations-v1"
      )
        throw new Error("Formato dell’insieme discordante dall’evento v1.");
    }
  }
  const snapshot = event.evidenceSnapshot as LotSourceSnapshot;
  const { snapshotHash, version, ...input } = snapshot;
  const verified = captureLotSourceSnapshot(input);
  if (
    snapshot.publicationId !== event.publicationId ||
    version !== verified.version ||
    snapshotHash !== verified.snapshotHash ||
    stableDocumentaryJson(snapshot) !== stableDocumentaryJson(verified) ||
    snapshotHash !== event.sourceSnapshotHash
  )
    throw new Error("Snapshot storico della valutazione alterato.");
  const members = event.groupBefore.members;
  const legacy = event.groupBefore.legacy;
  if (
    new Set(members).size !== members.length ||
    !members.includes(event.publicationId) ||
    new Set(legacy.map((row) => row.matchId)).size !== legacy.length ||
    legacy.some((row) => !members.includes(row.publicationId))
  )
    throw new Error("Gruppo storico della valutazione discordante.");
  const original = legacy.find((row) => row.matchId === event.matchId);
  if (!original || original.publicationId !== event.publicationId)
    throw new Error("Stato legacy originale della valutazione mancante.");
  for (const [state, expected] of [
    [event.before, event.previousToken],
    [event.after, event.nextToken],
  ] as const) {
    const token = createHash("sha256")
      .update(
        stableDocumentaryJson({
          matchId: event.matchId,
          companyId: event.companyId,
          publicationId: event.publicationId,
          state,
          legacy: original.legacy,
        }),
      )
      .digest("hex");
    if (token !== expected)
      throw new Error("Token storico della valutazione alterato.");
  }
  for (const group of [event.groupBefore.state, event.groupAfter]) {
    if (group && group.companyId !== event.companyId)
      throw new Error("Gruppo storico di un’altra ditta.");
  }
  if (
    event.version === "human-lot-match-review-v2" &&
    ["assess_project", "assess_lot"].includes(event.action) &&
    !event.shapeEpochToken
  )
    throw new Error("Epoca della valutazione storica mancante.");
  return event as LotMatchReviewRecord;
}

// Private server loader. Caller holds source/company/match locks in this order.
// Historical snapshots come from the actual immutable review record, preserving
// the editorial flag seen then as well as the source archive and observation ID.
export async function readLotMatchReview(
  tx: SourceReviewExecutor,
  publication: PublicationRow,
  company: CompanyRow,
  match: MatchRow,
  now = new Date(),
) {
  if (match.companyId !== company.id || match.publicationId !== publication.id)
    throw new Error("Valutazione associata a un’altra ditta o pubblicazione.");
  const source = await readLotSourceState(tx, publication);
  if (!source)
    throw new HttpError(
      409,
      "La fonte non usa ancora le valutazioni per lotto.",
    );
  const auditRows = await tx
    .select()
    .from(matchLotReviewEvents)
    .where(eq(matchLotReviewEvents.matchId, match.id))
    .orderBy(matchLotReviewEvents.sequence);
  const evidenceSnapshots: LotSourceSnapshot[] = [];
  const history: LotMatchReviewRecord[] = [];
  for (const row of auditRows) {
    const event = decodeLotMatchReviewRecord(row.event);
    if (
      event.id !== row.id ||
      event.matchId !== match.id ||
      event.companyId !== company.id ||
      event.publicationId !== publication.id ||
      event.sequence !== row.sequence ||
      event.sourceSnapshotHash !== event.evidenceSnapshot.snapshotHash ||
      event.sequence !== history.length + 1 ||
      (history.length > 0 && event.previousToken !== history.at(-1)!.nextToken)
    )
      throw new Error("Storico della valutazione discordante.");
    evidenceSnapshots.push(event.evidenceSnapshot);
    history.push(event);
  }
  const [currentFeedback] = await tx
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.companyId, company.id),
        eq(feedback.publicationId, publication.id),
      ),
    )
    .for("share");
  const canonicalFeedback = await readCanonicalFeedback(
    tx,
    company.id,
    publication.canonicalId,
  );
  const state = stateOf(match);
  const group = await readLotProjectSuppression(
    tx,
    company.id,
    publication.canonicalId,
  );
  const input: LotAssessmentInput = {
    companyId: company.id,
    publication: publication.data,
    profile: company.profile,
    ...source,
    evaluationSet: state.evaluations,
    evidenceSnapshots,
    automaticComparisons: (
      await tx
        .select({ result: automaticMatchRuns.result })
        .from(automaticMatchRuns)
        .where(
          and(
            eq(automaticMatchRuns.matchId, match.id),
            eq(automaticMatchRuns.companyId, company.id),
            eq(automaticMatchRuns.publicationId, publication.id),
            eq(automaticMatchRuns.status, "completed"),
          ),
        )
    ).flatMap((row) => (row.result ? [row.result] : [])),
    now,
  };
  const project = resolveProjectLotAssessment({
    ...input,
    suppression: group.suppression,
    feedback: {
      ...canonicalFeedback,
      relevant: currentFeedback?.relevant ?? null,
    },
  });
  return {
    match,
    company,
    publication,
    input,
    shapeState: source.shapeState,
    project,
    state,
    group,
    history,
    feedback: {
      ...canonicalFeedback,
      relevant: currentFeedback?.relevant ?? null,
    },
    expected: {
      snapshotHash: source.snapshot.snapshotHash,
      profileHash: lotAssessmentProfileHash(company.profile),
      stateToken: lotMatchStateToken(match),
      evaluationSetToken: lotEvaluationSetToken(
        state.evaluations,
        company.id,
        publication.id,
      ),
      projectBindingHash: project.projectBindingHash,
      groupToken: group.token,
      shapeEpochToken: source.shapeState.epochToken,
    },
  };
}
export type LoadedLotMatchReview = Awaited<
  ReturnType<typeof readLotMatchReview>
>;

export async function loadLotMatchReview(
  companyId: string,
  publicationId: string,
  viewer: SourceReviewViewer,
) {
  assertViewer(viewer);
  identifier.parse(companyId);
  identifier.parse(publicationId);
  return getDb().transaction(async (tx) => {
    const [publication] = await tx
      .select()
      .from(publications)
      .where(eq(publications.id, publicationId))
      .for("share");
    await assertAdministrator(tx, viewer);
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("share");
    const [match] = await tx
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.companyId, companyId),
          eq(matches.publicationId, publicationId),
        ),
      )
      .for("share");
    if (!publication || !company || !match)
      throw new HttpError(404, "Valutazione della ditta non trovata.");
    return readLotMatchReview(tx, publication, company, match);
  });
}

export async function appendLotMatchReview(
  input: unknown,
  viewer: SourceReviewViewer,
) {
  assertViewer(viewer);
  // Core additionally validates the exact dependency shape and detaches it.
  const draft = lotMatchReviewInputSchema.parse(structuredClone(input));
  return getDb().transaction(async (tx) => {
    const locked = await lockCanonicalPublications(tx, draft.publicationId);
    await assertAdministrator(tx, viewer);
    if (!locked) throw new HttpError(404, "Bando non trovato.");
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, draft.companyId))
      .for("share");
    const [match] = await tx
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.companyId, draft.companyId),
          eq(matches.publicationId, draft.publicationId),
        ),
      )
      .for("update");
    if (!company || company.disabledAt || !match)
      throw new HttpError(404, "Ditta o valutazione non disponibile.");
    const loaded = await readLotMatchReview(
      tx,
      locked.publication,
      company,
      match,
    );
    if (
      draft.expectedSnapshotHash !== loaded.expected.snapshotHash ||
      draft.expectedProfileHash !== loaded.expected.profileHash ||
      draft.expectedStateToken !== loaded.expected.stateToken ||
      draft.expectedGroupToken !== loaded.expected.groupToken ||
      draft.expectedShapeEpochToken !== loaded.expected.shapeEpochToken
    )
      throw new HttpError(
        409,
        "Fonte, profilo o valutazione cambiati. Aggiorna la pagina.",
      );
    const id = randomUUID(),
      at = new Date().toISOString();
    let nextState: LotMatchReviewState = loaded.state;
    let nextGroup: CanonicalLotSuppression | null = loaded.group.state;
    try {
      if (draft.action === "assess_lot" || draft.action === "assess_project") {
        if (
          draft.target.kind !==
            (draft.action === "assess_lot" ? "lot" : "project") ||
          draft.target.publicationId !== draft.publicationId
        )
          throw new HttpError(
            400,
            "Target di un’altra pubblicazione o struttura.",
          );
        const {
          companyId: _company,
          publicationId: _publication,
          action: _action,
          expectedStateToken: _state,
          expectedGroupToken: _group,
          note: _note,
          ...command
        } = draft;
        const outcome = createHumanTargetAssessment(
          { ...command, origin: "human" } as HumanTargetAssessmentCommand,
          loaded.input,
          { id, actorId: viewer.userId, at, note: draft.note },
        );
        nextState = { ...loaded.state, evaluations: outcome.evaluationSet };
        if (!nextGroup && loaded.group.suppression)
          nextGroup = {
            version: "canonical-lot-suppression-v1",
            companyId: company.id,
            canonicalId: locked.canonicalId,
            eventId: id,
            suppression: loaded.group.suppression,
          };
      } else {
        if (
          draft.expectedProjectBindingHash !== loaded.project.projectBindingHash
        )
          throw new HttpError(
            409,
            "La portata del progetto è cambiata. Aggiorna la pagina.",
          );
        if (
          draft.action === "reopen_project" &&
          !loaded.group.suppression?.active
        )
          throw new HttpError(
            409,
            "Il progetto non ha un’esclusione da riconsiderare.",
          );
        nextGroup = {
          version: "canonical-lot-suppression-v1",
          companyId: company.id,
          canonicalId: locked.canonicalId,
          eventId: id,
          suppression:
            draft.action === "veto_project"
              ? {
                  active: true,
                  reason: "Progetto escluso dal fondatore.",
                  rejection: {
                    bindingHash: loaded.project.projectBindingHash,
                    eventId: id,
                    at,
                  },
                }
              : {
                  active: false,
                  reason: "Esclusione del progetto ritirata dal fondatore.",
                  rejection: null,
                },
        };
      }
    } catch (error) {
      if (error instanceof ReviewConflict)
        throw new HttpError(
          409,
          "Fonte, profilo o valutazione cambiati. Aggiorna la pagina.",
        );
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        400,
        "Il giudizio o i riferimenti non sono validi per il target corrente.",
      );
    }
    const nextMatch = {
      ...match,
      lotEvaluations: nextState.evaluations,
      lotSuppression: nextState.suppression,
    };
    const event: LotMatchReviewRecord = {
      version: "human-lot-match-review-v2",
      id,
      matchId: match.id,
      companyId: company.id,
      publicationId: locked.publication.id,
      sequence: (loaded.history.at(-1)?.sequence ?? 0) + 1,
      action: draft.action,
      actorId: viewer.userId,
      at,
      note: draft.note,
      sourceSnapshotHash: loaded.expected.snapshotHash,
      evidenceSnapshot: loaded.input.snapshot,
      profileHash: loaded.expected.profileHash,
      shapeEpochToken: loaded.expected.shapeEpochToken,
      groupBefore: loaded.group.before,
      groupAfter: nextGroup,
      before: loaded.state,
      after: nextState,
      previousToken: loaded.expected.stateToken,
      nextToken: lotMatchStateToken(nextMatch),
    };
    await tx
      .update(matches)
      .set({
        lotEvaluations: nextState.evaluations,
        lotSuppression: nextState.suppression,
        updatedAt: new Date(at),
      })
      .where(eq(matches.id, match.id));
    if (nextGroup !== loaded.group.state && nextGroup)
      await tx
        .insert(settings)
        .values({ key: loaded.group.key, value: nextGroup })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: nextGroup },
        });
    await tx.insert(matchLotReviewEvents).values({
      id,
      matchId: match.id,
      companyId: company.id,
      publicationId: locked.publication.id,
      sequence: event.sequence,
      event,
    });
    await enqueueLotReconciliation(tx, {
      publicationId: locked.publication.id,
      canonicalId: locked.canonicalId,
      eventId: id,
    });
    return readLotMatchReview(tx, locked.publication, company, nextMatch);
  });
}

// Server-side preparation for a selected lot. This supplies current CAS tokens,
// not a verdict; the client cannot replace the actor or the profile being read.
export function lotMatchReviewTarget(
  loaded: LoadedLotMatchReview,
  lotId: string,
) {
  return assessmentReviewTarget(loaded, {
    kind: "lot" as const,
    publicationId: loaded.publication.id,
    sourceProjectId: loaded.publication.data.externalId,
    lotId: lotId.toLowerCase(),
  });
}

// A real target is selected from the verified shape. Empty lot directories are
// never interpreted here as an implicit project or a synthetic lot.
export function assessmentReviewTarget(
  loaded: LoadedLotMatchReview,
  target: LotSourceTarget,
) {
  const key = (value: LotSourceTarget) =>
    value.kind === "project"
      ? `project:${value.publicationId}`
      : `lot:${value.publicationId}:${value.sourceProjectId.toLowerCase()}:${value.lotId.toLowerCase()}`;
  if (
    !loaded.shapeState.shape.targets.some((item) => key(item) === key(target))
  )
    throw new HttpError(
      409,
      "Il target non appartiene alla struttura corrente.",
    );
  const context = resolveAssessmentSourceContext(
    loaded.input.snapshot,
    target,
    loaded.input.history,
    loaded.shapeState,
  );
  const preliminary = (
    target.kind === "project" ? preliminaryProjectMatch : preliminaryLotMatch
  )({
    publication: loaded.publication.data,
    profile: loaded.company.profile,
    context,
    now: loaded.input.now,
  });
  return {
    target,
    context,
    preliminary,
    expected: {
      ...loaded.expected,
      sourceDependency: context.dependency,
      operationalInputHash: preliminary.operationalInputHash,
      entryHash:
        loaded.state.evaluations?.entries.find(
          (entry) => key(entry.target) === key(target),
        )?.entryHash ?? null,
    },
  };
}

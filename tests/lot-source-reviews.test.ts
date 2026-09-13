import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import type { SourceScopeReview } from "../src/lib/domain";
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
import {
  LOT_SOURCE_CONTEXT_VERSION,
  type LotSourceTarget,
} from "../src/lib/lot-source-context";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";

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
import {
  appendLotSourceReview,
  loadLotSourceReview,
  readLotSourceState,
  type LoadedLotSourceReview,
  type LotSourceReviewInput,
} from "../src/lib/lot-source-reviews";
import {
  appendSourceReview,
  loadSourceReviewContext,
  readSourceReviewContext,
  readSourceReviewContexts,
  type LoadedSourceReview,
  type SourceReviewExecutor,
} from "../src/lib/source-reviews";

// Invented source/body/profile only. Real PGlite migrations and pg-boss producer;
// no HTTP, AI, SMTP, operational adoption function or real PostgreSQL connection.
const pg = new PGlite();
const db = drizzle(pg, { schema });
const executor = db as unknown as SourceReviewExecutor;
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const viewer = { userId: "lot-source-founder", admin: true, demo: false };
const companyId = "lot-source-company";
const commonText = "Progetto inventato suddiviso in due lotti.";
const aText = "🌳 Potatura inventata del lotto A.";
const bText = "Installazione inventata del lotto B.";

beforeAll(async () => {
  injected.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await boss.start();
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.stop();
  await db.insert(schema.user).values([
    {
      id: viewer.userId,
      name: "Fondatore inventato",
      email: "lot-founder@example.invalid",
    },
    {
      id: "lot-not-admin",
      name: "Non amministratore",
      email: "lot-no-admin@example.invalid",
    },
  ]);
  await db.insert(schema.administrators).values({ userId: viewer.userId });
  await db.insert(schema.companies).values({
    id: companyId,
    ownerId: viewer.userId,
    profile: {
      name: "Ditta inventata",
      activities: "Servizi inventati",
      employees: 1,
      sectors: [],
      zones: [],
      keywords: [],
      exclusions: [],
      minValue: null,
      maxValue: null,
      emailEnabled: false,
    },
  });
}, 20000);
afterAll(async () => {
  await boss.stop();
  await pg.close();
});

async function publicationRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, id));
  return row;
}
async function fixture(
  options: { adopt?: boolean; flag?: SourceScopeReview } = {},
) {
  const projectId = randomUUID(),
    noticeId = randomUUID(),
    aId = randomUUID(),
    bId = randomUUID();
  const identity = {
    projectId,
    publicationId: noticeId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
  };
  const raw = {
    id: noticeId,
    type: "tender",
    "project-info": { title: { it: "Progetto a lotti inventato" } },
    procurement: {
      orderDescription: { it: commonText },
      orderAddress: { city: "Lugano", cantonId: "TI" },
    },
    base: {
      id: noticeId,
      projectId,
      lotsType: "with",
      lots: [
        { id: aId, lotNumber: 1, title: { it: "Verde inventato" } },
        { id: bId, lotNumber: 2, title: { it: "Impianti inventati" } },
      ],
    },
    lots: [
      {
        id: aId,
        lotNumber: 1,
        title: { it: "Verde inventato" },
        orderDescription: { it: aText },
      },
      {
        id: bId,
        lotNumber: 2,
        title: { it: "Impianti inventati" },
        orderDescription: { it: bText },
      },
    ],
  };
  const p = normalizeSimap(
    {
      id: projectId,
      raw: {
        id: projectId,
        publicationId: noticeId,
        publicationDate: "2030-01-01",
        projectNumber: "INVENTED-LOT-REVIEW",
        pubType: "tender",
        processType: "open",
        title: { it: "Progetto inventato" },
        procOfficeName: { it: "Ente inventato" },
      },
    },
    raw,
  );
  if (options.flag) p.sourceScopeReview = options.flag;
  await db
    .insert(schema.publications)
    .values({
      id: p.id,
      canonicalId: p.id,
      externalId: p.externalId,
      projectId: p.projectId,
      source: p.source,
      title: p.title,
      status: p.status,
      visibleAt: new Date(p.visibleAt),
      data: p,
      revision: p.revision,
      aiRevision: p.revision,
    });
  const body = JSON.stringify(raw);
  const result = (): SimapAcquisitionResult => ({
    publication: p,
    documentaryAcquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      state: "accepted",
      identity,
      sourceRevision: p.revision,
      archive: preserveSimapLots(raw, identity),
      receipt: {
        url: identity.detailUrl,
        receivedAt: new Date().toISOString(),
        bodyByteLength: Buffer.byteLength(body),
        bodySha256: createHash("sha256").update(body).digest("hex"),
      },
    },
  });
  const appendObservation = async () => {
    const request = await beginDocumentaryRequest(identity);
    return storeDocumentaryObservation(request, result());
  };
  const observation = await appendObservation();
  const adopt = async (id = observation.id) => {
    // Test setup only: the application still has no runtime adoption function.
    await db
      .update(schema.publications)
      .set({ documentarySnapshotId: id })
      .where(eq(schema.publications.id, p.id));
  };
  if (options.adopt !== false) await adopt();
  const project: LotSourceTarget = { kind: "project", publicationId: p.id };
  const a: LotSourceTarget = {
    kind: "lot",
    publicationId: p.id,
    sourceProjectId: projectId,
    lotId: aId,
  };
  const b: LotSourceTarget = {
    kind: "lot",
    publicationId: p.id,
    sourceProjectId: projectId,
    lotId: bId,
  };
  return { p, identity, project, a, b, adopt, observation, appendObservation };
}
function draft(
  loaded: LoadedLotSourceReview,
  action: "recorded" | "opened" = "recorded",
): LotSourceReviewInput {
  const target = loaded.context.target;
  const selected = loaded.context.targetContent?.selectedLot;
  const rawPath =
    target.kind === "project"
      ? "/procurement/orderDescription/it"
      : `${selected!.path}/orderDescription/it`;
  const value =
    target.kind === "project"
      ? commonText
      : (selected!.record as { orderDescription: { it: string } })
          .orderDescription.it;
  return {
    target,
    expectedObservationId: loaded.expected.observationId,
    expectedSnapshotHash: loaded.expected.snapshotHash,
    expectedSelectionHash: loaded.expected.selectionHash,
    expectedTargetEventId: loaded.expected.targetEventId,
    expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
    action,
    form:
      action === "opened"
        ? null
        : target.kind === "project"
          ? "broad_scope"
          : "defined_service",
    references:
      action === "opened"
        ? []
        : [
            {
              selectionHash: loaded.expected.selectionHash!,
              rawPath,
              startUtf16: 0,
              endUtf16: value.length,
            },
          ],
    note: "Revisione umana inventata per il test del repository.",
    resolveLegacyScope: false,
  };
}
function legacyDraft(loaded: LoadedSourceReview) {
  if (!loaded.snapshot.source.accepted)
    throw new Error("Invalid invented legacy source");
  const unit = loaded.snapshot.source.corpus.units[0];
  return {
    publicationId: loaded.publication.id,
    expectedEventId: loaded.expected.eventId,
    expectedSourceSnapshotHash: loaded.expected.sourceSnapshotHash,
    expectedCorpusHash: loaded.expected.corpusHash,
    action: "recorded",
    form: "broad_scope",
    references: [
      {
        unitId: unit.id,
        originIndex: 0,
        startUtf16: 0,
        endUtf16: unit.text.length,
      },
    ],
    note: "Revisione precedente inventata da conservare nello storico.",
  };
}
async function jobs(id: string) {
  return (
    await pg.query<{
      id: string;
      data: { publicationId: string; canonicalId: string; eventId: string };
    }>(
      "SELECT id, data FROM pgboss.job WHERE name=$1 AND data->>'publicationId'=$2 ORDER BY id",
      [LOT_RECONCILIATION_QUEUE, id],
    )
  ).rows;
}
async function sourceRows(id: string) {
  return db
    .select()
    .from(schema.sourceReviewEvents)
    .where(eq(schema.sourceReviewEvents.publicationId, id))
    .orderBy(schema.sourceReviewEvents.sequence);
}
async function businessState() {
  return {
    matches: await db.select().from(schema.matches).orderBy(schema.matches.id),
    feedback: await db
      .select()
      .from(schema.feedback)
      .orderBy(schema.feedback.id),
    notifications: await db
      .select()
      .from(schema.notifications)
      .orderBy(schema.notifications.id),
  };
}
function requiredFlag(): SourceScopeReview {
  return {
    status: "required",
    kind: "ambiguous",
    token: randomUUID(),
    sourceRevision: "previous-source",
    updatedAt: "2030-01-01T12:00:00.000Z",
  };
}

it("requires the authenticated server administrator on reads and writes; JSON cannot choose the actor", async () => {
  const f = await fixture();
  const input = draft(await loadLotSourceReview(f.project, viewer));
  for (const actor of [
    { ...viewer, demo: true },
    { ...viewer, admin: false },
    { ...viewer, userId: "lot-not-admin" },
  ]) {
    await expect(loadLotSourceReview(f.project, actor)).rejects.toMatchObject({
      status: 403,
    });
    await expect(appendLotSourceReview(input, actor)).rejects.toMatchObject({
      status: 403,
    });
  }
  await expect(
    appendLotSourceReview({ ...input, actorId: "forged-json-actor" }, viewer),
  ).rejects.toThrow();
  await db
    .delete(schema.administrators)
    .where(eq(schema.administrators.userId, viewer.userId));
  try {
    await expect(appendLotSourceReview(input, viewer)).rejects.toMatchObject({
      status: 403,
    });
  } finally {
    await db.insert(schema.administrators).values({ userId: viewer.userId });
  }
  expect(await sourceRows(f.p.id)).toHaveLength(0);
  expect(await jobs(f.p.id)).toHaveLength(0);
  const saved = await appendLotSourceReview(input, viewer);
  expect(saved.history[0].event.actorId).toBe(viewer.userId);
  expect(saved.history[0].event.sourceRevision).toBe(
    (await publicationRow(f.p.id)).revision,
  );
  await expect(
    loadLotSourceReview({ kind: "project", publicationId: "missing" }, viewer),
  ).rejects.toMatchObject({ status: 404 });
});

it("shadow observations do not select the lot branch; adopted pointers block legacy readers before any v2 event", async () => {
  const f = await fixture({ adopt: false });
  expect(
    await readLotSourceState(executor, await publicationRow(f.p.id)),
  ).toBeNull();
  await expect(loadLotSourceReview(f.project, viewer)).rejects.toMatchObject({
    status: 409,
  });
  const legacy = await loadSourceReviewContext(f.p.id, viewer);
  const oldDraft = legacyDraft(legacy);
  const oldReview = await appendSourceReview(oldDraft, viewer);
  expect(await readSourceReviewContext(executor, f.p)).toEqual(
    oldReview.context,
  );
  await f.adopt();
  await expect(loadSourceReviewContext(f.p.id, viewer)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    appendSourceReview(legacyDraft(oldReview), viewer),
  ).rejects.toMatchObject({ status: 409 });
  // Passing the older Publication/data object cannot bypass the authoritative pointer.
  await expect(readSourceReviewContext(executor, f.p)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    readSourceReviewContexts(executor, [{ id: f.p.id, data: f.p }]),
  ).rejects.toMatchObject({ status: 409 });
  const withoutEvents = await fixture();
  await expect(
    readSourceReviewContext(executor, withoutEvents.p),
  ).rejects.toMatchObject({ status: 409 });
});

it("appends a v2 chain after the unchanged v1 prefix and commits one real pg-boss job per new event", async () => {
  const f = await fixture({ adopt: false });
  const old = await appendSourceReview(
    legacyDraft(await loadSourceReviewContext(f.p.id, viewer)),
    viewer,
  );
  const original = await sourceRows(f.p.id);
  await f.adopt();
  const initial = await loadLotSourceReview(f.project, viewer);
  expect(initial.context.projectBarrier.reason).toBe("source_changed");
  expect(initial.history[0]).toEqual(old.history[0]);
  const saved = await appendLotSourceReview(draft(initial), viewer);
  const event = saved.history[1].event;
  expect(event.version).toBe(LOT_SOURCE_CONTEXT_VERSION);
  expect(event.sequence).toBe(2);
  expect(event.previousEventId).toBe(original[0].id);
  if (event.version !== LOT_SOURCE_CONTEXT_VERSION)
    throw new Error("Expected v2");
  expect(event.previousEventHash).toBe(original[0].event.eventHash);
  expect((await sourceRows(f.p.id))[0]).toEqual(original[0]);
  const queued = await jobs(f.p.id);
  expect(queued).toHaveLength(1);
  expect(queued[0].data).toEqual({
    publicationId: f.p.id,
    canonicalId: f.p.id,
    eventId: event.id,
  });
  await expect(readSourceReviewContext(executor, f.p)).rejects.toMatchObject({
    status: 409,
  });
});

it("rereads A/B history under the transaction, rejects cross-lot evidence and stale CAS, and binds a changed pointer", async () => {
  const f = await fixture();
  await appendLotSourceReview(
    draft(await loadLotSourceReview(f.project, viewer)),
    viewer,
  );
  const loadedA = await loadLotSourceReview(f.a, viewer),
    loadedB = await loadLotSourceReview(f.b, viewer);
  const aInput = draft(loadedA),
    bInput = draft(loadedB);
  await expect(
    appendLotSourceReview(
      {
        ...aInput,
        references: [
          {
            ...aInput.references[0],
            rawPath: "/lots/1/orderDescription/it",
            endUtf16: bText.length,
          },
        ],
      },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 400 });
  for (const patch of [
    { expectedSnapshotHash: "0".repeat(64) },
    { expectedSelectionHash: "0".repeat(64) },
    { expectedProjectBarrierHash: "0".repeat(64) },
    { expectedTargetEventId: "foreign-event" },
  ])
    await expect(
      appendLotSourceReview({ ...aInput, ...patch }, viewer),
    ).rejects.toMatchObject({ status: 409 });
  const savedB = await appendLotSourceReview(bInput, viewer);
  const savedA = await appendLotSourceReview(aInput, viewer);
  const eventA = savedA.history.at(-1)!.event;
  expect(eventA.sequence).toBe(3);
  expect(eventA.previousEventId).toBe(savedB.history.at(-1)!.event.id);
  expect(eventA.evidence[0]).toMatchObject({
    quote: aText,
    origin: {
      scope: "selected_lot",
      language: "it",
      url: f.identity.detailUrl,
    },
  });
  expect((await loadLotSourceReview(f.a, viewer)).context.state).toBe(
    "manual_source",
  );
  expect((await loadLotSourceReview(f.b, viewer)).context.state).toBe(
    "manual_source",
  );
  await expect(appendLotSourceReview(aInput, viewer)).rejects.toMatchObject({
    status: 409,
  });
  const stalePointer = draft(await loadLotSourceReview(f.b, viewer));
  const next = await f.appendObservation();
  await f.adopt(next.id);
  await expect(
    appendLotSourceReview(stalePointer, viewer),
  ).rejects.toMatchObject({ status: 409 });
  expect((await loadLotSourceReview(f.b, viewer)).context.state).toBe(
    "manual_source",
  );
  expect(await jobs(f.p.id)).toHaveLength(3);
});

it("only an explicit current project defined/broad command resolves the legacy flag and audits a post-change snapshot", async () => {
  const flag = requiredFlag(),
    f = await fixture({ flag });
  const before = await publicationRow(f.p.id);
  const loaded = await loadLotSourceReview(f.project, viewer),
    input = { ...draft(loaded), resolveLegacyScope: true };
  for (const [rejected, status] of [
    [{ ...input, expectedSnapshotHash: "0".repeat(64) }, 409],
    [
      {
        ...draft(await loadLotSourceReview(f.a, viewer)),
        resolveLegacyScope: true,
      },
      400,
    ],
    [{ ...draft(loaded, "opened"), resolveLegacyScope: true }, 400],
    [{ ...input, form: "conflicting" }, 400],
  ]) {
    await expect(appendLotSourceReview(rejected, viewer)).rejects.toMatchObject(
      { status },
    );
    expect(await publicationRow(f.p.id)).toEqual(before);
    expect(await sourceRows(f.p.id)).toHaveLength(0);
    expect(await jobs(f.p.id)).toHaveLength(0);
  }
  const saved = await appendLotSourceReview(input, viewer),
    after = await publicationRow(f.p.id);
  expect(after.data.sourceScopeReview).toMatchObject({
    status: "resolved",
    sourceRevision: before.revision,
  });
  expect(after.data.sourceScopeReview?.token).not.toBe(flag.token);
  expect(saved.snapshot.sourceScopeReview).toEqual(
    after.data.sourceScopeReview,
  );
  expect(saved.snapshot.snapshotHash).not.toBe(loaded.snapshot.snapshotHash);
  expect(saved.history[0].snapshot).toEqual(saved.snapshot);
  expect(saved.context.projectBarrier.state).toBe("clear");
  const audit = await db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.publicationId, f.p.id));
  expect(audit).toHaveLength(1);
  expect(JSON.parse(audit[0].detail)).toMatchObject({
    action: "resolve-source-scope",
    actorId: viewer.userId,
    previousScopeToken: flag.token,
    sourceReviewEventId: saved.history[0].event.id,
    status: "resolved",
  });
  expect(audit[0].resolvedAt).not.toBeNull();
  await expect(appendLotSourceReview(input, viewer)).rejects.toMatchObject({
    status: 409,
  });
  expect(await jobs(f.p.id)).toHaveLength(1);
  const defined = await fixture({ flag: requiredFlag() });
  const definedResult = await appendLotSourceReview(
    {
      ...draft(await loadLotSourceReview(defined.project, viewer)),
      form: "defined_service",
      resolveLegacyScope: true,
    },
    viewer,
  );
  expect(definedResult.context).toMatchObject({
    state: "manual_source",
    form: "defined_service",
  });
  expect(definedResult.snapshot.sourceScopeReview?.status).toBe("resolved");
});

it("a real job insert failure rolls back source flag, audit and event; the same pre-change command can then commit once", async () => {
  const f = await fixture({ flag: requiredFlag() });
  const input = {
    ...draft(await loadLotSourceReview(f.project, viewer)),
    resolveLegacyScope: true,
  };
  const before = {
    publication: await publicationRow(f.p.id),
    history: await sourceRows(f.p.id),
    issues: await db.select().from(schema.issues).orderBy(schema.issues.id),
    business: await businessState(),
  };
  await pg.exec(
    "ALTER TABLE pgboss.job ADD CONSTRAINT test_reject_lot_reconciliation CHECK (name <> 'lot-notice-reconcile') NOT VALID",
  );
  let failure: unknown;
  try {
    await appendLotSourceReview(input, viewer);
  } catch (error) {
    failure = error;
  } finally {
    await pg.exec(
      "ALTER TABLE pgboss.job DROP CONSTRAINT test_reject_lot_reconciliation",
    );
  }
  // Prove that execution reached the intended job constraint, not an earlier
  // input/CAS failure that happened to leave all rows unchanged too.
  const causes: { constraint?: string; cause?: unknown }[] = [];
  for (
    let error = failure;
    error && typeof error === "object";
    error = (error as { cause?: unknown }).cause
  )
    causes.push(error);
  expect(
    causes.some(
      (error) => error.constraint === "test_reject_lot_reconciliation",
    ),
  ).toBe(true);
  expect(await publicationRow(f.p.id)).toEqual(before.publication);
  expect(await sourceRows(f.p.id)).toEqual(before.history);
  expect(
    await db.select().from(schema.issues).orderBy(schema.issues.id),
  ).toEqual(before.issues);
  expect(await businessState()).toEqual(before.business);
  expect(await jobs(f.p.id)).toHaveLength(0);
  await appendLotSourceReview(input, viewer);
  expect(await sourceRows(f.p.id)).toHaveLength(1);
  expect(await jobs(f.p.id)).toHaveLength(1);
  await expect(appendLotSourceReview(input, viewer)).rejects.toMatchObject({
    status: 409,
  });
});

it("source forms and durable reconciliation leave manual matches, customer feedback and prepared emails unchanged", async () => {
  const f = await fixture(),
    manualAt = new Date("2030-01-01T12:00:00.000Z");
  await db
    .insert(schema.matches)
    .values({
      id: f.p.id,
      companyId,
      publicationId: f.p.id,
      revision: "manual-existing",
      score: 87,
      reason: "Giudizio manuale esistente",
      eligible: true,
      approved: true,
      reviewedAt: manualAt,
      reviewNotes: "Nota privata esistente",
    });
  await db
    .insert(schema.feedback)
    .values({
      id: f.p.id,
      companyId,
      publicationId: f.p.id,
      saved: true,
      dismissed: true,
      relevant: false,
    });
  await db
    .insert(schema.notifications)
    .values({
      id: f.p.id,
      companyId,
      dedupeKey: f.p.id,
      kind: "digest",
      status: "pending",
      subject: "Notifica esistente",
      html: "<p>Notifica esistente</p>",
      textBody: "Notifica esistente",
      items: [{ id: f.p.id, revision: "manual-existing" }],
    });
  const before = await businessState(),
    publication = await publicationRow(f.p.id);
  await appendLotSourceReview(
    draft(await loadLotSourceReview(f.project, viewer)),
    viewer,
  );
  await appendLotSourceReview(
    draft(await loadLotSourceReview(f.a, viewer)),
    viewer,
  );
  await appendLotSourceReview(
    draft(await loadLotSourceReview(f.b, viewer), "opened"),
    viewer,
  );
  expect(await businessState()).toEqual(before);
  expect(await publicationRow(f.p.id)).toEqual(publication);
  expect(await jobs(f.p.id)).toHaveLength(3);
});

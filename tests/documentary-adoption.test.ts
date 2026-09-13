import { createHash, randomUUID } from "node:crypto";
import { PgBoss, fromPglite } from "pg-boss";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema";
import { normalizeSimap, legacySimapRevision } from "../src/sources/simap";
import {
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
} from "../src/sources/simap-documentary";
import { preserveSimapLots, type Identity } from "../src/lib/source-lots";
import { type DocumentaryRequest } from "../src/lib/documentary-observation";

const injected = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";

import {
  adoptDocumentaryObservation,
  DocumentaryAdoptionDisabled,
  DocumentaryAdoptionConflict,
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_ADOPTION_CONSUMERS,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  type DocumentaryAdoptionActivation,
  type DocumentaryReleaseAttestation,
} from "../src/lib/documentary-adoption";
import { createDocumentaryRequest } from "../src/lib/documentary-observation";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
import {
  loadLotSourceReview,
  appendLotSourceReview,
} from "../src/lib/lot-source-reviews";
import {
  loadLotMatchReview,
  lotMatchReviewTarget,
  appendLotMatchReview,
} from "../src/lib/lot-match-reviews";
import { readCurrentLotMatch } from "../src/lib/lot-readers";

test("a proven legacy fingerprint migration preserves every current data field and judgment without counting a source change", async () => {
  const f = fixture();
  await seedBusiness(f);
  const legacy = legacySimapRevision(f.publication)!;
  expect(legacy).toMatch(/^[a-f0-9]{64}$/);
  const legacyData = { ...f.publication, revision: legacy };
  await db
    .insert(schema.publicationVersions)
    .values({
      id: randomUUID(),
      publicationId: f.publication.id,
      revision: legacy,
      data: legacyData,
    });
  const current = {
    ...legacyData,
    title: "Titolo corretto del dato legacy",
    summary: "Sintesi legacy aggiornata",
    requirements: ["Requisito già elaborato"],
    documentPages: [
      {
        page: 3,
        text: "Originale legacy conservato",
        url: f.publication.sourceUrl,
      },
    ],
    sourceScopeReview: {
      status: "required" as const,
      kind: "ambiguous" as const,
      token: "legacy-doubt",
      sourceRevision: legacy,
      updatedAt: "2026-09-13T10:00:00.000Z",
    },
  };
  await db
    .update(schema.publications)
    .set({
      revision: legacy,
      data: current,
      aiRevision: "existing-legacy-summary",
    })
    .where(eq(schema.publications.id, f.publication.id));
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f),
    before = await businessState();
  const adopted = await adoptDocumentaryObservation(
      request,
      result,
      activation(),
    ),
    after = await businessState();
  expect(adopted).toMatchObject({ changed: true, sourceChanged: false });
  const row = await publicationRow(f),
    previousRow = before.publications[0];
  expect(row).toEqual({
    ...previousRow,
    revision: f.publication.revision,
    documentarySnapshotId: request.id,
  });
  expect(row.data).toEqual(current);
  expect({ ...after, publications: [], versions: [] }).toEqual({
    ...before,
    publications: [],
    versions: [],
  });
  expect(after.versions).toHaveLength(3);
  expect(after.versions.find((v) => v.revision === legacy)?.data).toEqual(
    legacyData,
  );
  expect(
    after.versions.find((v) => v.revision.startsWith("documentary-history-v1:"))
      ?.data,
  ).toEqual(current);
  expect(
    after.versions.find((v) => v.revision === f.publication.revision)?.data,
  ).toEqual(f.publication);
  const beforeReplay = await businessState(),
    jobs = await queued();
  expect(
    await adoptDocumentaryObservation(request, result, activation()),
  ).toMatchObject({ changed: false, sourceChanged: false });
  expect(await businessState()).toEqual(beforeReplay);
  expect(await queued()).toEqual(jobs);
});

test("legacy source without original normalizer proof is refused; a proven different legacy hash is a real source change", async () => {
  const f = fixture();
  await seedBusiness(f);
  const legacy = legacySimapRevision(f.publication)!;
  const current = {
    ...f.publication,
    revision: legacy,
    summary: "Sintesi legacy da conservare nello storico",
  };
  await db
    .update(schema.publications)
    .set({ revision: legacy, data: current })
    .where(eq(schema.publications.id, f.publication.id));
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f),
    before = await businessState();
  await expect(
    adoptDocumentaryObservation(request, structuredClone(result), activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await businessState()).toEqual(before);
  expect(await snapshotRow(request.id)).toBeUndefined();
  const next = nextFixture(f);
  expect(legacySimapRevision(next.publication)).not.toBe(legacy);
  expect(
    await adoptDocumentaryObservation(
      request,
      acceptedResult(next),
      activation(),
    ),
  ).toMatchObject({ changed: true, sourceChanged: true });
  expect((await publicationRow(f)).data.summary).toBeNull();
  expect(
    (await businessState()).versions.find(
      (version) => version.revision === legacy,
    )?.data,
  ).toEqual(current);
});

test("identical accepted acquisitions are a verified no-op without a new receipt, except for an already deposited shadow", async () => {
  const f = fixture();
  await seedBusiness(f);
  const first = await beginDocumentaryRequest(f.identity),
    firstResult = acceptedResult(f);
  await adoptDocumentaryObservation(first, firstResult, activation());
  const before = await businessState(),
    firstSnapshot = await snapshotRow(first.id),
    jobs = await queued();
  const next = await beginDocumentaryRequest(f.identity),
    nextResult = acceptedResult(f);
  expect(next.id).not.toBe(first.id);
  expect(
    await adoptDocumentaryObservation(next, nextResult, activation()),
  ).toMatchObject({
    observationId: first.id,
    changed: false,
    sourceChanged: false,
    jobId: null,
  });
  expect(await snapshotRow(next.id)).toBeUndefined();
  expect(await snapshotRow(first.id)).toEqual(firstSnapshot);
  expect(await businessState()).toEqual(before);
  expect(await queued()).toEqual(jobs);
  const shadow = await beginDocumentaryRequest(f.identity),
    shadowResult = acceptedResult(f);
  await storeDocumentaryObservation(shadow, shadowResult);
  const shadowRow = await snapshotRow(shadow.id);
  expect(
    await adoptDocumentaryObservation(shadow, shadowResult, activation()),
  ).toMatchObject({
    observationId: shadow.id,
    changed: true,
    sourceChanged: false,
  });
  expect((await publicationRow(f)).documentarySnapshotId).toBe(shadow.id);
  expect(await snapshotRow(shadow.id)).toEqual(shadowRow);
  expect(await queued()).toHaveLength(jobs.length + 1);
});

test("documentary no-op never skips transitions, a changed archive, or a changed source revision", async () => {
  const f = fixture();
  await seedBusiness(f);
  await adoptDocumentaryObservation(
    await beginDocumentaryRequest(f.identity),
    acceptedResult(f),
    activation(),
  );
  const refused = await beginDocumentaryRequest(f.identity);
  expect(
    await adoptDocumentaryObservation(refused, refusedResult(f), activation()),
  ).toMatchObject({
    changed: true,
    sourceChanged: false,
    observationId: refused.id,
  });
  const restored = await beginDocumentaryRequest(f.identity);
  expect(
    await adoptDocumentaryObservation(
      restored,
      acceptedResult(f),
      activation(),
    ),
  ).toMatchObject({
    changed: true,
    sourceChanged: false,
    observationId: restored.id,
  });
  // Synthetic consistency contrast: even a caller claiming the same revision
  // cannot have a different archive silently treated as an identical GET.
  const body = mutableClone(f.raw);
  body.lots[0].metadata.array.push("additional preserved value");
  const altered = acceptedResult(f);
  if (altered.documentaryAcquisition.state !== "accepted")
    throw new Error("fixture");
  const bytes = Buffer.from(JSON.stringify(body));
  const changedArchive = {
    ...altered,
    documentaryAcquisition: {
      ...altered.documentaryAcquisition,
      archive: preserveSimapLots(body, f.identity),
      receipt: {
        ...altered.documentaryAcquisition.receipt,
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
        bodyByteLength: bytes.byteLength,
      },
    },
  } as SimapAcquisitionResult;
  const archiveRequest = await beginDocumentaryRequest(f.identity);
  // Capture a fresh receipt time after the request while retaining its body.
  changedArchive.documentaryAcquisition = {
    ...changedArchive.documentaryAcquisition,
    receipt: {
      ...changedArchive.documentaryAcquisition.receipt,
      receivedAt: new Date().toISOString(),
    },
  };
  expect(
    await adoptDocumentaryObservation(
      archiveRequest,
      changedArchive,
      activation(),
    ),
  ).toMatchObject({
    changed: true,
    sourceChanged: false,
    observationId: archiveRequest.id,
  });
  const next = nextFixture(f),
    nextRequest = await beginDocumentaryRequest(next.identity);
  expect(
    await adoptDocumentaryObservation(
      nextRequest,
      acceptedResult(next),
      activation(),
    ),
  ).toMatchObject({ changed: true, sourceChanged: true });
});

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sequence = 0;
let boss: PgBoss;

// Invented fixtures only. PGlite and these deterministic receipts never contact
// a source or authenticate its response; receipt authenticity is not claimed.
function fixture() {
  const suffix = String(++sequence).padStart(12, "0");
  const projectId = `10000000-0000-4000-8000-${suffix}`;
  const publicationId = `20000000-0000-4000-8000-${suffix}`;
  const lotId = `30000000-0000-4000-8000-${suffix}`;
  const identity: Identity = {
    projectId,
    publicationId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`,
  };
  const raw = {
    id: publicationId,
    type: "tender",
    "project-info": { title: { it: "Parco inventato", de: "Erfundener Park" } },
    procurement: {
      orderDescription: { it: "Contesto comune.", fr: "Contexte commun." },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
    },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    base: {
      id: publicationId,
      projectId,
      lotsType: "with",
      lots: [{ id: lotId, lotNumber: 1, title: { it: "Verde inventato" } }],
    },
    lots: [
      {
        id: lotId,
        lotNumber: 1,
        title: { it: "Verde inventato", fr: "Jardin fictif" },
        orderDescription: {
          it: "  🌳 <b>Potatura</b> e\u0301 / é.  ",
          fr: "Taille des arbres.",
        },
        metadata: { array: ["z", "a", "", null, false], "a/b~c": "letterale" },
      },
    ],
  };
  const entry = {
    id: projectId,
    raw: {
      id: projectId,
      publicationId,
      publicationDate: "2030-09-10",
      projectNumber: `INVENTED-STORE-${suffix}`,
      pubType: "tender",
      processType: "open",
      title: { it: "Titolo inventato" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
  const publication = normalizeSimap(entry, raw);
  return { identity, raw, publication, entry };
}
type Fixture = ReturnType<typeof fixture>;
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
function mutableClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}
function nextFixture(f: Fixture) {
  const next = mutableClone(f);
  next.raw["project-info"].title.it = "Parco inventato: nuova fonte";
  next.raw.procurement.orderDescription.fr = "Nouveau contexte commun.";
  next.raw.lots[0].orderDescription.it =
    "Nuova descrizione inventata della potatura.";
  next.raw.dates.offerDeadline = "2030-12-05T09:00:00+01:00";
  next.publication = normalizeSimap(next.entry, next.raw);
  expect(next.publication.revision).not.toBe(f.publication.revision);
  return next;
}

function acceptedResult(f: Fixture): SimapAcquisitionResult {
  const body = Buffer.from(JSON.stringify(f.raw));
  return {
    publication: f.publication,
    documentaryAcquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      identity: f.identity,
      state: "accepted",
      sourceRevision: f.publication.revision,
      archive: preserveSimapLots(f.raw, f.identity),
      receipt: {
        url: f.identity.detailUrl,
        receivedAt: new Date().toISOString(),
        bodyByteLength: body.byteLength,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      },
    },
  };
}

function refusedResult(f: Fixture): SimapAcquisitionResult {
  const bytes = Uint8Array.of(0xff);
  return {
    publication: null,
    documentaryAcquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      identity: f.identity,
      state: "refused",
      sourceRevision: null,
      refusal: { stage: "decode", code: "invalid_utf8" },
      receipt: {
        url: f.identity.detailUrl,
        receivedAt: new Date().toISOString(),
        bodyByteLength: 1,
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}

async function insertPublication(f: Fixture) {
  const p = f.publication;
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId: p.id,
    source: p.source,
    externalId: p.externalId,
    projectId: p.projectId,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    deadline: p.deadline ? new Date(p.deadline) : null,
    data: p,
    revision: p.revision,
    aiRevision: p.revision,
  });
}

async function publicationRow(f: Fixture) {
  return (
    await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, f.publication.id))
  )[0];
}

async function snapshotRow(id: string) {
  return (
    await db
      .select()
      .from(schema.publicationDocumentarySnapshots)
      .where(eq(schema.publicationDocumentarySnapshots.id, id))
  )[0];
}

async function businessState() {
  return {
    publications: await db
      .select()
      .from(schema.publications)
      .orderBy(schema.publications.id),
    companies: await db
      .select()
      .from(schema.companies)
      .orderBy(schema.companies.id),
    matches: await db.select().from(schema.matches).orderBy(schema.matches.id),
    notifications: await db
      .select()
      .from(schema.notifications)
      .orderBy(schema.notifications.id),
    lotReviews: await db
      .select()
      .from(schema.matchLotReviewEvents)
      .orderBy(schema.matchLotReviewEvents.id),
    feedback: await db
      .select()
      .from(schema.feedback)
      .orderBy(schema.feedback.id),
    versions: await db
      .select()
      .from(schema.publicationVersions)
      .orderBy(schema.publicationVersions.id),
    issues: await db.select().from(schema.issues).orderBy(schema.issues.id),
    settings: await db
      .select()
      .from(schema.settings)
      .orderBy(schema.settings.key),
    sourceReviews: await db
      .select()
      .from(schema.sourceReviewEvents)
      .orderBy(schema.sourceReviewEvents.id),
  };
}

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network in documentary storage test");
    }),
  );
  pg = new PGlite();
  db = drizzle(pg, { schema });
  injected.db = db;
  await pg.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;",
  );
  await migrate(db, { migrationsFolder: "drizzle" });
  boss = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    schema: "pgboss",
    schedule: false,
    supervise: false,
  });
  await boss.start();
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.stop();
});

afterEach(async () => {
  await boss?.stop();
  await pg?.close();
  vi.unstubAllGlobals();
});

const founder = { userId: "adoption-founder", admin: true, demo: false };
function activation(): DocumentaryAdoptionActivation {
  return {
    enabled: true,
    attestation: {
      version: DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
      releaseId: "invented-local-release",
      verifiedAt: new Date().toISOString(),
      evidenceId: "invented-local-rollout-evidence",
      previousProcessesDrained: true,
      consumers: Object.fromEntries(
        DOCUMENTARY_ADOPTION_CONSUMERS.map((name) => [
          name,
          {
            capability: DOCUMENTARY_ADOPTION_CAPABILITY,
            buildId: "a".repeat(40),
          },
        ]),
      ) as DocumentaryReleaseAttestation["consumers"],
    },
  };
}
async function queued() {
  return (
    await pg.query<{
      id: string;
      data: { publicationId: string; canonicalId: string; eventId: string };
    }>("SELECT id,data FROM pgboss.job WHERE name=$1 ORDER BY id", [
      LOT_RECONCILIATION_QUEUE,
    ])
  ).rows;
}
async function seedBusiness(f: Fixture) {
  await insertPublication(f);
  await db.insert(schema.user).values([
    {
      id: founder.userId,
      name: "Fondatore inventato",
      email: "adoption-founder@example.invalid",
    },
    {
      id: "owner",
      name: "Titolare inventato",
      email: "adoption-owner@example.invalid",
    },
    {
      id: "owner-negative",
      name: "Titolare negativo",
      email: "adoption-negative@example.invalid",
    },
  ]);
  await db.insert(schema.administrators).values({ userId: founder.userId });
  const profile = {
    name: "Ditta inventata",
    activities: "Potatura e manutenzione del verde",
    employees: 2,
    sectors: ["giardinaggio" as const],
    zones: ["Tutto il Ticino"],
    keywords: [],
    exclusions: [],
    minValue: null,
    maxValue: null,
    emailEnabled: true,
  };
  for (const negative of [false, true]) {
    const id = negative ? "company-negative" : "company";
    await db
      .insert(schema.companies)
      .values({ id, ownerId: negative ? "owner-negative" : "owner", profile });
    await db.insert(schema.matches).values({
      id: `match-${id}`,
      companyId: id,
      publicationId: f.publication.id,
      revision: "legacy-manual-revision",
      score: negative ? 0 : 93,
      reason: "Giudizio legacy da conservare",
      eligible: !negative,
      approved: !negative,
      reviewedAt: new Date("2026-01-01T09:00:00Z"),
      reviewNotes: "Nota legacy privata",
    });
  }
  await db.insert(schema.feedback).values({
    id: "saved-feedback",
    companyId: "company",
    publicationId: f.publication.id,
    saved: true,
    dismissed: false,
    relevant: true,
  });
  await db.insert(schema.notifications).values({
    id: "prepared-notification",
    companyId: "company",
    dedupeKey: "old-prepared",
    kind: "digest",
    status: "pending",
    subject: "Esistente",
    html: "<p>Esistente</p>",
    textBody: "Esistente",
    items: [{ id: f.publication.id, revision: "legacy-manual-revision" }],
  });
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: false });
}
async function recordHumanState(f: Fixture) {
  const project = { kind: "project" as const, publicationId: f.publication.id };
  const lot = {
    kind: "lot" as const,
    publicationId: f.publication.id,
    sourceProjectId: f.identity.projectId,
    lotId: f.raw.lots[0].id,
  };
  for (const target of [project, lot]) {
    const loaded = await loadLotSourceReview(target, founder);
    const text =
      target.kind === "project"
        ? f.raw.procurement.orderDescription.it
        : f.raw.lots[0].orderDescription.it;
    const path =
      target.kind === "project"
        ? "/procurement/orderDescription/it"
        : "/lots/0/orderDescription/it";
    await appendLotSourceReview(
      {
        target,
        expectedObservationId: loaded.expected.observationId,
        expectedSnapshotHash: loaded.expected.snapshotHash,
        expectedSelectionHash: loaded.expected.selectionHash,
        expectedTargetEventId: loaded.expected.targetEventId,
        expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
        action: "recorded",
        form: target.kind === "project" ? "broad_scope" : "defined_service",
        references: [
          {
            selectionHash: loaded.expected.selectionHash!,
            rawPath: path,
            startUtf16: 0,
            endUtf16: text.length,
          },
        ],
        note: "Revisione inventata della fonte.",
        resolveLegacyScope: false,
      },
      founder,
    );
  }
  const loaded = await loadLotMatchReview("company", f.publication.id, founder),
    selected = lotMatchReviewTarget(loaded, lot.lotId);
  await appendLotMatchReview(
    {
      companyId: "company",
      publicationId: f.publication.id,
      action: "assess_lot",
      target: lot,
      expectedSnapshotHash: loaded.expected.snapshotHash,
      expectedProfileHash: loaded.expected.profileHash,
      expectedStateToken: loaded.expected.stateToken,
      expectedGroupToken: loaded.expected.groupToken,
      expectedSourceDependency: selected.expected.sourceDependency,
      expectedOperationalInputHash: selected.expected.operationalInputHash,
      expectedEvaluationSetToken: selected.expected.evaluationSetToken,
      expectedEntryHash: null,
      result: "review",
      reason: "Valutazione umana inventata da approfondire.",
      references: [
        {
          selectionHash: selected.expected.sourceDependency.selectionHash!,
          rawPath: "/lots/0/orderDescription/it",
          startUtf16: 0,
          endUtf16: f.raw.lots[0].orderDescription.it.length,
        },
      ],
      confirmedReviewReasons: [],
      note: "Nota privata della valutazione per lotto.",
    },
    founder,
  );
  const current = await loadLotMatchReview(
    "company",
    f.publication.id,
    founder,
  );
  await appendLotMatchReview(
    {
      companyId: "company",
      publicationId: f.publication.id,
      action: "veto_project",
      expectedSnapshotHash: current.expected.snapshotHash,
      expectedProfileHash: current.expected.profileHash,
      expectedStateToken: current.expected.stateToken,
      expectedGroupToken: current.expected.groupToken,
      expectedProjectBindingHash: current.expected.projectBindingHash,
      note: "Veto manuale inventato da conservare.",
    },
    founder,
  );
}
function withoutPointers(state: Awaited<ReturnType<typeof businessState>>) {
  return {
    ...state,
    publications: state.publications.map(
      ({ documentarySnapshotId: _, ...row }) => row,
    ),
  };
}

test("default-off guard requires the complete versioned capability and a release attestation", async () => {
  const f = fixture();
  await seedBusiness(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f),
    before = await businessState();
  await expect(
    adoptDocumentaryObservation(request, result),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionDisabled);
  const invalid: unknown[] = [
    { enabled: true },
    { ...activation(), enabled: false },
    { ...activation(), unexpected: true },
  ];
  for (const key of DOCUMENTARY_ADOPTION_CONSUMERS) {
    const missing = mutableClone(activation());
    delete (missing.attestation!.consumers as Record<string, unknown>)[key];
    invalid.push(missing);
  }
  const old = mutableClone(activation());
  old.attestation!.consumers.notification_claim.capability = "old" as never;
  invalid.push(old);
  const development = mutableClone(activation());
  development.attestation!.consumers.worker.buildId = "development";
  invalid.push(development);
  const notDrained = mutableClone(activation());
  notDrained.attestation!.previousProcessesDrained = false as never;
  invalid.push(notDrained);
  for (const value of invalid)
    await expect(
      adoptDocumentaryObservation(
        request,
        result,
        value as DocumentaryAdoptionActivation,
      ),
    ).rejects.toBeInstanceOf(DocumentaryAdoptionDisabled);
  expect(await businessState()).toEqual(before);
  expect(await snapshotRow(request.id)).toBeUndefined();
  expect(await queued()).toEqual([]);
});

test("first accepted adoption atomically inserts the snapshot and pointer while preserving all business data and legacy verdicts", async () => {
  const f = fixture();
  await seedBusiness(f);
  const editorial = {
    ...f.publication,
    title: "Titolo corretto dal fondatore",
    summary: "Sintesi già verificata",
    revision: "content-correction-existing",
    sourceScopeReview: {
      status: "required" as const,
      kind: "ambiguous" as const,
      token: "old-editorial-scope-token",
      sourceRevision: f.publication.revision,
      updatedAt: "2026-01-01T09:00:00.000Z",
    },
  };
  await db
    .update(schema.publications)
    .set({ data: editorial, aiRevision: "existing-summary-revision" })
    .where(eq(schema.publications.id, f.publication.id));
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f),
    before = await businessState();
  const adopted = await adoptDocumentaryObservation(
    request,
    result,
    activation(),
  );
  expect(adopted).toMatchObject({
    publicationId: f.publication.id,
    observationId: request.id,
    state: "accepted",
    adopted: true,
    changed: true,
  });
  expect(adopted.jobId).toEqual(expect.any(String));
  expect((await publicationRow(f)).documentarySnapshotId).toBe(request.id);
  expect((await snapshotRow(request.id)).acquisition).toEqual(
    result.documentaryAcquisition,
  );
  expect(withoutPointers(await businessState())).toEqual(
    withoutPointers(before),
  );
  expect(await queued()).toEqual([
    {
      id: adopted.jobId,
      data: {
        publicationId: f.publication.id,
        canonicalId: f.publication.id,
        eventId: `documentary-adoption:${request.id}`,
      },
    },
  ]);
  const loaded = await readCurrentLotMatch("company", f.publication.id);
  expect(loaded?.project.signalEligible).toBe(false);
  expect(loaded?.state.evaluations).toBeNull();
  expect(loaded?.project.lots[0].state).toBe("missing");
});

test("existing shadow snapshot is adopted byte-for-byte and exact current replay creates no duplicate job", async () => {
  const f = fixture();
  await seedBusiness(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f);
  const stored = await storeDocumentaryObservation(request, result),
    snapshot = await snapshotRow(stored.id),
    before = await businessState();
  expect((await publicationRow(f)).documentarySnapshotId).toBeNull();
  await adoptDocumentaryObservation(request, result, activation());
  expect(await snapshotRow(stored.id)).toEqual(snapshot);
  expect(withoutPointers(await businessState())).toEqual(
    withoutPointers(before),
  );
  const jobs = await queued(),
    state = await businessState();
  expect(
    await adoptDocumentaryObservation(request, result, activation()),
  ).toMatchObject({ changed: false, jobId: null });
  expect(await queued()).toEqual(jobs);
  expect(await businessState()).toEqual(state);
  expect(await snapshotRow(stored.id)).toEqual(snapshot);
});

test("shadow outcome with a different receipt or acquisition cannot replace the immutable request result", async () => {
  const f = fixture();
  await seedBusiness(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f);
  await storeDocumentaryObservation(request, result);
  const original = await snapshotRow(request.id),
    before = await businessState();
  const changed = mutableClone(result);
  changed.documentaryAcquisition.receipt.bodySha256 = "f".repeat(64);
  await expect(
    adoptDocumentaryObservation(request, changed, activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  await expect(
    adoptDocumentaryObservation(request, refusedResult(f), activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await snapshotRow(request.id)).toEqual(original);
  expect(await businessState()).toEqual(before);
  expect(await queued()).toEqual([]);
});

test("accepted then refused then accepted advances only the pointer and job, keeping source/match history and canonical veto", async () => {
  const f = fixture();
  await seedBusiness(f);
  const initialRequest = await beginDocumentaryRequest(f.identity),
    initialResult = acceptedResult(f);
  await adoptDocumentaryObservation(
    initialRequest,
    initialResult,
    activation(),
  );
  await recordHumanState(f);
  const before = await businessState(),
    first = await snapshotRow(initialRequest.id),
    jobs = await queued();
  const rejectedRequest = await beginDocumentaryRequest(f.identity),
    rejectedResult = refusedResult(f);
  await adoptDocumentaryObservation(
    rejectedRequest,
    rejectedResult,
    activation(),
  );
  expect((await publicationRow(f)).documentarySnapshotId).toBe(
    rejectedRequest.id,
  );
  expect(withoutPointers(await businessState())).toEqual(
    withoutPointers(before),
  );
  expect(await snapshotRow(initialRequest.id)).toEqual(first);
  expect(
    (await readCurrentLotMatch("company", f.publication.id))?.project
      .signalEligible,
  ).toBe(false);
  const acceptedRequest = await beginDocumentaryRequest(f.identity),
    accepted = acceptedResult(f);
  await adoptDocumentaryObservation(acceptedRequest, accepted, activation());
  expect((await publicationRow(f)).documentarySnapshotId).toBe(
    acceptedRequest.id,
  );
  expect(withoutPointers(await businessState())).toEqual(
    withoutPointers(before),
  );
  expect((await queued()).length).toBe(jobs.length + 2);
  const history = await db
    .select()
    .from(schema.publicationDocumentarySnapshots);
  expect(history).toHaveLength(3);
  expect(
    (await readCurrentLotMatch("company", f.publication.id))?.project
      .suppressed,
  ).toBe(true);
  const current = await businessState();
  await expect(
    adoptDocumentaryObservation(initialRequest, initialResult, activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await businessState()).toEqual(current);
});

test("late accepted and refused requests cannot overtake a newer pointer even when the source revision is unchanged", async () => {
  const f = fixture();
  await seedBusiness(f);
  const oldAccepted = await beginDocumentaryRequest(f.identity),
    oldRefused = await beginDocumentaryRequest(f.identity);
  const first = await beginDocumentaryRequest(f.identity);
  await adoptDocumentaryObservation(first, acceptedResult(f), activation());
  const before = await businessState(),
    jobs = await queued();
  for (const [request, result] of [
    [oldAccepted, acceptedResult(f)],
    [oldRefused, refusedResult(f)],
  ] as const) {
    await expect(
      adoptDocumentaryObservation(request, result, activation()),
    ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
    expect(await snapshotRow(request.id)).toBeUndefined();
  }
  expect(await businessState()).toEqual(before);
  expect(await queued()).toEqual(jobs);
});

test("source revision CAS rejects stale accepted, changed accepted and refused requests", async () => {
  const f = fixture();
  await seedBusiness(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f);
  const next = nextFixture(f);
  await db
    .update(schema.publications)
    .set({ revision: next.publication.revision })
    .where(eq(schema.publications.id, f.publication.id));
  const changed = await businessState();
  for (const response of [result, acceptedResult(next), refusedResult(f)])
    await expect(
      adoptDocumentaryObservation(request, response, activation()),
    ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await businessState()).toEqual(changed);
  expect(await snapshotRow(request.id)).toBeUndefined();
  expect(await queued()).toEqual([]);
});

test.each([false, true])(
  "queue failure rolls back pointer and new snapshot, preserving an existing shadow=%s",
  async (shadow) => {
    const f = fixture();
    await seedBusiness(f);
    const request = await beginDocumentaryRequest(f.identity),
      result = acceptedResult(f);
    if (shadow) await storeDocumentaryObservation(request, result);
    const before = await businessState(),
      stored = await snapshotRow(request.id);
    await pg.exec(
      "ALTER TABLE pgboss.job ADD CONSTRAINT fail_documentary_job CHECK (name <> 'lot-notice-reconcile') NOT VALID",
    );
    let thrown: unknown;
    try {
      await adoptDocumentaryObservation(request, result, activation());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const errors: string[] = [];
    for (
      let error = thrown;
      error;
      error = (error as { cause?: unknown }).cause
    )
      errors.push(String(error));
    expect(errors.join(" ")).toContain("fail_documentary_job");
    expect(await businessState()).toEqual(before);
    expect(await snapshotRow(request.id)).toEqual(stored);
    expect(await queued()).toEqual([]);
    await pg.exec(
      "ALTER TABLE pgboss.job DROP CONSTRAINT fail_documentary_job",
    );
    expect(
      await adoptDocumentaryObservation(request, result, activation()),
    ).toMatchObject({ changed: true });
    expect(await queued()).toHaveLength(1);
  },
);

test("unknown source or request captured before import never fabricates or adopts a Publication", async () => {
  const f = fixture(),
    request = await beginDocumentaryRequest(f.identity),
    result = refusedResult(f);
  expect(request.observedPublication).toBeNull();
  await expect(
    adoptDocumentaryObservation(request, result, activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await publicationRow(f)).toBeUndefined();
  expect(await snapshotRow(request.id)).toBeUndefined();
  const shadow = await storeDocumentaryObservation(request, result);
  expect(shadow.publicationId).toBeNull();
  const snapshot = await snapshotRow(request.id);
  await insertPublication(f);
  await expect(
    adoptDocumentaryObservation(request, result, activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect((await publicationRow(f)).documentarySnapshotId).toBeNull();
  expect(await snapshotRow(request.id)).toEqual(snapshot);
  expect(await queued()).toEqual([]);
});

test("validates request token, response identity and receipt before writing; detaches mutable caller input before awaiting", async () => {
  const f = fixture();
  await seedBusiness(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f),
    before = await businessState();
  await expect(
    adoptDocumentaryObservation(
      { ...request, token: "f".repeat(64) },
      result,
      activation(),
    ),
  ).rejects.toThrow("modificata");
  const wrong = mutableClone(result);
  wrong.documentaryAcquisition.receipt.url = "https://example.invalid/body";
  await expect(
    adoptDocumentaryObservation(request, wrong, activation()),
  ).rejects.toThrow("Ricevuta");
  const altered = mutableClone(result);
  if (altered.documentaryAcquisition.state !== "accepted")
    throw new Error("fixture");
  altered.documentaryAcquisition.archive.archiveHash = "f".repeat(64);
  await expect(
    adoptDocumentaryObservation(request, altered, activation()),
  ).rejects.toThrow();
  expect(await businessState()).toEqual(before);
  expect(await queued()).toEqual([]);
  const mutable = mutableClone(result),
    original = structuredClone(mutable.documentaryAcquisition);
  const pending = adoptDocumentaryObservation(request, mutable, activation());
  mutable.documentaryAcquisition.receipt.bodySha256 = "e".repeat(64);
  await pending;
  expect((await snapshotRow(request.id)).acquisition).toEqual(original);
});

test("rejects discordant current project identity under the canonical lock", async () => {
  const f = fixture();
  await seedBusiness(f);
  const request = await beginDocumentaryRequest(f.identity);
  await db
    .update(schema.publications)
    .set({ projectId: randomUUID() })
    .where(eq(schema.publications.id, f.publication.id));
  const before = await businessState();
  await expect(
    adoptDocumentaryObservation(request, acceptedResult(f), activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await businessState()).toEqual(before);
  expect(await snapshotRow(request.id)).toBeUndefined();
  expect(await queued()).toEqual([]);
});

test.each([false, true])(
  "new source revision atomically preserves exact current history, human records and canonical membership (editorial revision=%s)",
  async (corrected) => {
    const f = fixture();
    await seedBusiness(f);
    await adoptDocumentaryObservation(
      await beginDocumentaryRequest(f.identity),
      acceptedResult(f),
      activation(),
    );
    await recordHumanState(f);
    const cousin = fixture();
    cousin.publication.source = "foglio-ti";
    cousin.publication.sourceUrl =
      "https://example.invalid/official-other-source";
    await insertPublication(cousin);
    await db
      .update(schema.publications)
      .set({ canonicalId: f.publication.id })
      .where(eq(schema.publications.id, cousin.publication.id));
    const previous = (await publicationRow(f)).data;
    const base = {
      ...previous,
      ...(corrected
        ? {
            revision: "editorial-correction-existing",
            title: "Titolo corretto prima della richiesta",
          }
        : {}),
    };
    await db.insert(schema.publicationVersions).values({
      id: randomUUID(),
      publicationId: f.publication.id,
      revision: base.revision,
      data: base,
    });
    const next = nextFixture(f);
    const request = await beginDocumentaryRequest(next.identity),
      result = acceptedResult(next);
    if (corrected) await storeDocumentaryObservation(request, result);
    const shadow = await snapshotRow(request.id);
    if (corrected)
      await db.insert(schema.issues).values({
        id: "existing-group-conflict",
        key: `conflict:${f.publication.id}`,
        title: "Discordanza precedente",
        detail: "Risoluzione storica inventata",
        severity: "critical",
        publicationId: f.publication.id,
        resolvedAt: new Date("2026-09-12T09:00:00.000Z"),
      });
    // This enrichment occurs AFTER request capture. Source CAS still holds, and
    // adoption must read the current row under lock rather than a cached copy.
    const current = {
      ...base,
      summary:
        "Sintesi aggiornata dopo la richiesta, da conservare integralmente.",
      requirements: ["Requisito storico sintetizzato"],
      documentPages: [
        {
          page: 7,
          text: "Originale PDF già archiviato",
          url: f.publication.sourceUrl,
        },
      ],
      sourceUrls: [
        f.publication.sourceUrl,
        "https://example.invalid/not-in-current-group",
      ],
      sourceScopeReview: {
        status: "required" as const,
        kind: "conflicting" as const,
        token: "late-scope-token",
        sourceRevision: f.publication.revision,
        updatedAt: "2026-09-13T10:00:00.000Z",
      },
    };
    await db
      .update(schema.publications)
      .set({ data: current, aiRevision: "late-summary" })
      .where(eq(schema.publications.id, f.publication.id));
    const before = await businessState(),
      jobs = await queued();
    const adopted = await adoptDocumentaryObservation(
      request,
      result,
      activation(),
    );
    const row = await publicationRow(f);
    expect(row).toMatchObject({
      canonicalId: f.publication.id,
      source: "simap",
      externalId: f.identity.projectId,
      projectId: f.identity.projectId,
      documentarySnapshotId: request.id,
      title: next.publication.title,
      revision: next.publication.revision,
      aiRevision: null,
      deadline: new Date(next.publication.deadline!),
      visibleAt: new Date(next.publication.visibleAt),
    });
    expect(row.data).toEqual({
      ...next.publication,
      canonicalKey: f.publication.id,
      sourceUrls: [f.publication.sourceUrl, cousin.publication.sourceUrl],
      sourceScopeReview: current.sourceScopeReview,
      reviewRequired: true,
      reviewReasons: [
        ...next.publication.reviewReasons,
        "L’oggetto del bando contiene informazioni incomplete o in contrasto. La pertinenza richiede una verifica della fonte.",
        "Fonti discordanti su stato o scadenza",
      ],
    });
    expect(row.data.summary).toBeNull();
    expect(row.data.requirements).toEqual([]);
    expect(row.data).not.toHaveProperty("documentPages");
    expect(row.data.revision).toBe(next.publication.revision);
    const after = await businessState();
    expect({ ...after, publications: [], versions: [], issues: [] }).toEqual({
      ...before,
      publications: [],
      versions: [],
      issues: [],
    });
    expect(after.issues).toHaveLength(1);
    expect(after.issues[0]).toMatchObject({
      key: `conflict:${f.publication.id}`,
      severity: "critical",
      publicationId: f.publication.id,
      resolvedAt: null,
    });
    if (corrected) expect(after.issues[0].id).toBe("existing-group-conflict");
    expect(
      after.publications.find((item) => item.id === cousin.publication.id),
    ).toEqual(
      before.publications.find((item) => item.id === cousin.publication.id),
    );
    expect(after.versions).toHaveLength(3);
    expect(
      after.versions.find((version) => version.revision === base.revision)
        ?.data,
    ).toEqual(base);
    const archived = after.versions.find((version) =>
      version.revision.startsWith("documentary-history-v1:"),
    );
    expect(archived?.data).toEqual(current);
    expect(archived?.data.revision).toBe(base.revision);
    expect(
      after.versions.find(
        (version) => version.revision === next.publication.revision,
      )?.data,
    ).toEqual(row.data);
    if (shadow) expect(await snapshotRow(request.id)).toEqual(shadow);
    expect((await queued()).length).toBe(jobs.length + 1);
    expect(adopted).toMatchObject({ changed: true, observationId: request.id });
    const exactState = await businessState(),
      exactJobs = await queued();
    expect(
      await adoptDocumentaryObservation(request, result, activation()),
    ).toMatchObject({ changed: false, jobId: null });
    expect(await businessState()).toEqual(exactState);
    expect(await queued()).toEqual(exactJobs);
    const projected = await readCurrentLotMatch("company", f.publication.id);
    expect(projected?.project.signalEligible).toBe(false);
    expect(projected?.project.suppressed).toBe(true);
  },
);

test.each([false, true])(
  "new source revision queue failure rolls back data, versions, pointer and missing snapshot (shadow=%s)",
  async (shadow) => {
    const f = fixture();
    await seedBusiness(f);
    const cousin = fixture();
    cousin.publication.source = "foglio-ti";
    cousin.publication.sourceUrl =
      "https://example.invalid/other-official-source";
    await insertPublication(cousin);
    await db
      .update(schema.publications)
      .set({ canonicalId: f.publication.id })
      .where(eq(schema.publications.id, cousin.publication.id));
    const next = nextFixture(f),
      request = await beginDocumentaryRequest(next.identity),
      result = acceptedResult(next);
    if (shadow) await storeDocumentaryObservation(request, result);
    const before = await businessState(),
      stored = await snapshotRow(request.id);
    await pg.exec(
      "ALTER TABLE pgboss.job ADD CONSTRAINT fail_documentary_job CHECK (name <> 'lot-notice-reconcile') NOT VALID",
    );
    let failure: unknown;
    try {
      await adoptDocumentaryObservation(request, result, activation());
    } catch (error) {
      failure = error;
    }
    const errors: string[] = [];
    for (
      let error = failure;
      error;
      error = (error as { cause?: unknown }).cause
    )
      errors.push(String(error));
    expect(errors.join(" ")).toContain("fail_documentary_job");
    expect(await businessState()).toEqual(before);
    expect(await snapshotRow(request.id)).toEqual(stored);
    expect(await queued()).toEqual([]);
    await pg.exec(
      "ALTER TABLE pgboss.job DROP CONSTRAINT fail_documentary_job",
    );
    await adoptDocumentaryObservation(request, result, activation());
    expect((await publicationRow(f)).revision).toBe(next.publication.revision);
    const versions = (await businessState()).versions;
    expect(versions).toHaveLength(2);
    expect(
      versions.find((version) => version.revision === f.publication.revision)
        ?.data,
    ).toEqual(before.publications[0].data);
    expect(await queued()).toHaveLength(1);
    expect((await businessState()).issues).toEqual([
      expect.objectContaining({
        key: `conflict:${f.publication.id}`,
        severity: "critical",
      }),
    ]);
  },
);

test("changed normalized publication is detached before await, and late outcomes cannot replay after subsequent pointer advancement", async () => {
  const f = fixture();
  await seedBusiness(f);
  const next = nextFixture(f),
    request = await beginDocumentaryRequest(next.identity),
    result = mutableClone(acceptedResult(next));
  const original = structuredClone(result);
  const pending = adoptDocumentaryObservation(request, result, activation());
  result.publication!.title = "Caller mutation";
  result.publication!.originalTitles![0].text = "Changed language text";
  result.publication!.evidence[0].quote = "Changed evidence";
  result.publication!.summary = "Caller summary";
  await pending;
  expect((await publicationRow(f)).data).toEqual({
    ...original.publication,
    canonicalKey: f.publication.id,
  });
  const stale = await beginDocumentaryRequest(next.identity);
  const refused = await beginDocumentaryRequest(next.identity);
  await adoptDocumentaryObservation(refused, refusedResult(next), activation());
  const before = await businessState(),
    jobs = await queued();
  for (const [oldRequest, response] of [
    [request, original],
    [stale, acceptedResult(next)],
  ] as const)
    await expect(
      adoptDocumentaryObservation(oldRequest, response, activation()),
    ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await businessState()).toEqual(before);
  expect(await queued()).toEqual(jobs);
});

test("rejects incomplete, discordant, enriched or JSONB-unsafe normalized input before any adoption", async () => {
  const f = fixture();
  await seedBusiness(f);
  const next = nextFixture(f),
    request = await beginDocumentaryRequest(next.identity),
    before = await businessState();
  const mutations: ((publication: Record<string, unknown>) => void)[] = [
    (p) => {
      p.id = "simap-wrong";
    },
    (p) => {
      p.projectId = randomUUID();
    },
    (p) => {
      p.revision = `simap-v2:${"f".repeat(64)}`;
    },
    (p) => {
      delete p.title;
    },
    (p) => {
      p.title = "bad\u0000text";
    },
    (p) => {
      p.title = "\ud800";
    },
    (p) => {
      p["bad\u0000key"] = "bad";
    },
    (p) => {
      p["\ud800"] = "bad";
    },
    (p) => {
      p.valueChf = Number.NaN;
    },
    (p) => {
      p.zone = undefined;
    },
    (p) => {
      p.title = () => "side effect";
    },
    (p) => {
      p.title = new String("wrapped");
    },
    (p) => {
      p.summary = "Not source data";
    },
    (p) => {
      p.documentPages = [];
    },
    (p) => {
      p.sourceScopeReview = { status: "resolved" };
    },
    (p) => {
      p.sourceUrls = ["https://example.invalid/foreign"];
    },
    (p) => {
      p.sourceConditions = [
        {
          path: "terms.test",
          url: f.identity.detailUrl,
          value: { nested: "\u0000" },
        },
      ];
    },
    (p) => {
      p.sectors = new Array(1);
    },
    (p) => {
      const sparse: string[] = new Array(1);
      Object.defineProperty(sparse, "4294967295", {
        enumerable: true,
        value: "outside",
      });
      p.cpv = sparse;
    },
    (p) => {
      p.sourceConditions = [
        { path: "terms.test", url: f.identity.detailUrl, value: p },
      ];
    },
    (p) => {
      Object.defineProperty(p, "title", {
        enumerable: true,
        get() {
          throw new Error("Getter must never run");
        },
      });
    },
  ];
  for (const mutate of mutations) {
    const result = mutableClone(acceptedResult(next));
    mutate(result.publication as unknown as Record<string, unknown>);
    await expect(
      adoptDocumentaryObservation(request, result, activation()),
    ).rejects.toThrow();
  }
  expect(await businessState()).toEqual(before);
  expect(await snapshotRow(request.id)).toBeUndefined();
  expect(await queued()).toEqual([]);
});

test("a new notice can replace a refused barrier atomically, preserving a resolved historical scope without manufacturing current approval", async () => {
  const f = fixture();
  await seedBusiness(f);
  const scope = {
    status: "resolved" as const,
    kind: "ambiguous" as const,
    token: "historical-resolution",
    sourceRevision: f.publication.revision,
    updatedAt: "2026-09-13T09:00:00.000Z",
  };
  await db
    .update(schema.publications)
    .set({ data: { ...f.publication, sourceScopeReview: scope } })
    .where(eq(schema.publications.id, f.publication.id));
  await adoptDocumentaryObservation(
    await beginDocumentaryRequest(f.identity),
    refusedResult(f),
    activation(),
  );
  const next = nextFixture(f);
  next.identity.publicationId = randomUUID();
  next.identity.detailUrl = `https://www.simap.ch/api/publications/v1/project/${next.identity.projectId}/publication-details/${next.identity.publicationId}`;
  next.entry.raw.publicationId = next.identity.publicationId;
  next.entry.raw.publicationDate = "2030-09-11";
  next.entry.raw.pubType = "revocation";
  next.raw.id = next.identity.publicationId;
  next.raw.base.id = next.identity.publicationId;
  next.raw.type = "revocation";
  next.publication = normalizeSimap(next.entry, next.raw);
  const request = await beginDocumentaryRequest(next.identity),
    result = acceptedResult(next),
    before = await businessState();
  await adoptDocumentaryObservation(request, result, activation());
  const row = await publicationRow(f);
  expect(row.status).toBe("cancelled");
  expect(row.visibleAt).toEqual(new Date(next.publication.visibleAt));
  expect(row.data).toEqual({
    ...next.publication,
    canonicalKey: f.publication.id,
    sourceScopeReview: scope,
  });
  expect((await snapshotRow(request.id)).sourcePublicationId).toBe(
    next.identity.publicationId,
  );
  expect((await snapshotRow(request.id)).acquisition).toEqual(
    result.documentaryAcquisition,
  );
  expect((await businessState()).matches).toEqual(before.matches);
  expect((await businessState()).sourceReviews).toEqual(before.sourceReviews);
  expect(
    (await readCurrentLotMatch("company", f.publication.id))?.project
      .signalEligible,
  ).toBe(false);
  const after = await businessState();
  expect(
    await adoptDocumentaryObservation(request, result, activation()),
  ).toMatchObject({ changed: false });
  expect(await businessState()).toEqual(after);
});

test("closed historical cousins do not create a conflict against concordant current sources or resolve unrelated issues", async () => {
  const f = fixture();
  await seedBusiness(f);
  const next = nextFixture(f);
  const old = fixture(),
    current = fixture();
  for (const [other, closed] of [
    [old, true],
    [current, false],
  ] as const) {
    other.publication.source = "foglio-ti";
    other.publication.sourceUrl = `https://example.invalid/notice-${closed ? "old" : "current"}`;
    other.publication.status = closed ? "closed" : next.publication.status;
    other.publication.deadline = closed
      ? "2020-01-01T12:00:00.000Z"
      : next.publication.deadline;
    await insertPublication(other);
    await db
      .update(schema.publications)
      .set({ canonicalId: f.publication.id })
      .where(eq(schema.publications.id, other.publication.id));
  }
  await db.insert(schema.issues).values([
    {
      id: "unrelated-open-critical",
      key: "independent-issue",
      title: "Criticità indipendente",
      detail: "Nessuna risoluzione implicita",
      severity: "critical",
      publicationId: f.publication.id,
    },
    {
      id: "previous-resolved-conflict",
      key: `conflict:${f.publication.id}`,
      title: "Conflitto storico",
      detail: "Già risolto",
      severity: "critical",
      publicationId: f.publication.id,
      resolvedAt: new Date("2026-09-12T09:00:00.000Z"),
    },
  ]);
  const before = await businessState();
  await adoptDocumentaryObservation(
    await beginDocumentaryRequest(next.identity),
    acceptedResult(next),
    activation(),
  );
  const row = await publicationRow(f),
    after = await businessState();
  expect(row.status).toBe("open");
  expect(row.data.reviewReasons).toEqual(next.publication.reviewReasons);
  expect(after.issues).toEqual(before.issues);
  expect(
    after.publications.filter((item) => item.id !== f.publication.id),
  ).toEqual(before.publications.filter((item) => item.id !== f.publication.id));
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema";
import { normalizeSimap } from "../src/sources/simap";
import {
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
} from "../src/sources/simap-documentary";
import {
  preserveSimapLots,
  restoreSimapDetail,
  type Identity,
} from "../src/lib/source-lots";
import { type DocumentaryRequest } from "../src/lib/documentary-observation";

const injected = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
import {
  beginDocumentaryRequest,
  DocumentaryObservationConflict,
  readDocumentarySnapshot,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sequence = 0;

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
  const publication = normalizeSimap(
    {
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
    },
    raw,
  );
  return { identity, raw, publication };
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
});

afterEach(async () => {
  await pg?.close();
  vi.unstubAllGlobals();
});

test("Accepted observation survives JSONB and private reads without changing publication, profile, match, notification or pointer", async () => {
  const f = fixture();
  await insertPublication(f);
  await db.insert(schema.user).values({
    id: "owner",
    name: "Titolare inventato",
    email: "owner@example.invalid",
  });
  await db.insert(schema.companies).values({
    id: "company",
    ownerId: "owner",
    profile: {
      name: "Ditta inventata",
      activities: "Cura del verde",
      employees: 2,
      sectors: ["giardinaggio"],
      zones: ["Tutto il Ticino"],
      keywords: [],
      exclusions: [],
      minValue: null,
      maxValue: null,
      emailEnabled: false,
    },
  });
  await db.insert(schema.matches).values({
    id: "match",
    companyId: "company",
    publicationId: f.publication.id,
    revision: "manual-existing",
    score: 81,
    reason: "Valutazione esistente",
    eligible: true,
    approved: true,
    reviewedAt: new Date("2030-01-01T08:00:00Z"),
  });
  await db.insert(schema.notifications).values({
    id: "notification",
    companyId: "company",
    dedupeKey: "invented-existing",
    kind: "digest",
    status: "pending",
    subject: "Titolo esistente",
    html: "<p>Esistente</p>",
    textBody: "Esistente",
    items: [{ id: f.publication.id, revision: "manual-existing" }],
  });
  const before = await businessState();
  const request = await beginDocumentaryRequest(f.identity);
  assert.deepEqual(request.observedPublication, {
    revision: f.publication.revision,
    documentarySnapshotId: null,
  });
  const result = acceptedResult(f);
  const saved = await storeDocumentaryObservation(request, result);
  assert.deepEqual(saved, {
    id: request.id,
    publicationId: f.publication.id,
    state: "accepted",
    adopted: false,
  });
  const stored = await readDocumentarySnapshot(saved.id, f.publication.id);
  assert.ok(stored);
  assert.deepEqual(stored.request, request);
  assert.deepEqual(stored.acquisition, result.documentaryAcquisition);
  assert.equal(stored.acquisition.state, "accepted");
  if (stored.acquisition.state !== "accepted")
    throw new Error("Missing accepted archive");
  assert.deepEqual(restoreSimapDetail(stored.acquisition.archive), f.raw);
  assert.deepEqual(await businessState(), before);
  assert.equal((await publicationRow(f)).documentarySnapshotId, null);
});

test("Refusals persist for imported and unknown projects without creating a fake Publication", async () => {
  const existing = fixture(),
    unknown = fixture();
  await insertPublication(existing);
  const before = await businessState();
  for (const f of [existing, unknown]) {
    const request = await beginDocumentaryRequest(f.identity);
    assert.equal(request.observedPublication === null, f === unknown);
    const result = refusedResult(f);
    const saved = await storeDocumentaryObservation(request, result);
    const expectedId = f === existing ? f.publication.id : null;
    assert.deepEqual(saved, {
      id: request.id,
      publicationId: expectedId,
      state: "refused",
      adopted: false,
    });
    const stored = await readDocumentarySnapshot(saved.id, expectedId);
    assert.ok(stored);
    assert.deepEqual(stored.acquisition, result.documentaryAcquisition);
    assert.equal(stored.acquisition.sourceRevision, null);
    assert.equal("archive" in stored.acquisition, false);
  }
  assert.deepEqual(await businessState(), before);
  assert.equal(await publicationRow(unknown), undefined);
});

test("Accepted observations require a previously stored publication; identity is checked before and after acquisition", async () => {
  const f = fixture();
  const request = await beginDocumentaryRequest(f.identity);
  await expect(
    storeDocumentaryObservation(request, acceptedResult(f)),
  ).rejects.toBeInstanceOf(DocumentaryObservationConflict);
  assert.equal(
    (await db.select().from(schema.publicationDocumentarySnapshots)).length,
    0,
  );
  assert.equal(await publicationRow(f), undefined);
  await insertPublication(f);
  await db
    .update(schema.publications)
    .set({ source: "foglio" })
    .where(eq(schema.publications.id, f.publication.id));
  await expect(beginDocumentaryRequest(f.identity)).rejects.toBeInstanceOf(
    DocumentaryObservationConflict,
  );
  await expect(
    storeDocumentaryObservation(request, acceptedResult(f)),
  ).rejects.toBeInstanceOf(DocumentaryObservationConflict);
  assert.equal(
    (await db.select().from(schema.publicationDocumentarySnapshots)).length,
    0,
  );
});

test("The same request is idempotent through JSON serialization; a changed receipt or outcome cannot reuse its ID", async () => {
  const f = fixture();
  await insertPublication(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f);
  const saved = await storeDocumentaryObservation(request, result);
  assert.deepEqual(
    await storeDocumentaryObservation(
      JSON.parse(JSON.stringify(request)),
      JSON.parse(JSON.stringify(result)),
    ),
    saved,
  );
  const changedReceipt = mutableClone(result);
  changedReceipt.documentaryAcquisition.receipt = {
    ...changedReceipt.documentaryAcquisition.receipt,
    bodySha256: "f".repeat(64),
  };
  await expect(
    storeDocumentaryObservation(request, changedReceipt),
  ).rejects.toBeInstanceOf(DocumentaryObservationConflict);
  await expect(
    storeDocumentaryObservation(request, refusedResult(f)),
  ).rejects.toBeInstanceOf(DocumentaryObservationConflict);
  assert.equal(
    (await db.select().from(schema.publicationDocumentarySnapshots)).length,
    1,
  );
  assert.deepEqual(
    (await snapshotRow(saved.id)).acquisition,
    result.documentaryAcquisition,
  );
});

test("Modified request checksums, identities, receipt fields and archive content never create a snapshot", async () => {
  const f = fixture();
  await insertPublication(f);
  const request = await beginDocumentaryRequest(f.identity),
    result = acceptedResult(f);
  const tamperedRequests: DocumentaryRequest[] = [
    { ...request, token: "0".repeat(64) },
    {
      ...request,
      observedPublication: {
        revision: "changed-context",
        documentarySnapshotId: null,
      },
    },
    {
      ...request,
      identity: {
        ...request.identity,
        detailUrl: "https://example.invalid/wrong",
      },
    },
    { ...request, startedAt: "invalid-time" },
  ];
  for (const modified of tamperedRequests)
    await expect(
      storeDocumentaryObservation(modified, result),
    ).rejects.toThrow();
  const badReceipts = [
    {
      ...result.documentaryAcquisition.receipt,
      url: "https://example.invalid/wrong",
    },
    { ...result.documentaryAcquisition.receipt, bodySha256: "invalid-hash" },
    { ...result.documentaryAcquisition.receipt, bodyByteLength: -1 },
    {
      ...result.documentaryAcquisition.receipt,
      receivedAt: new Date(Date.parse(request.startedAt) - 1).toISOString(),
    },
  ];
  for (const receipt of badReceipts) {
    const modified = mutableClone(result);
    modified.documentaryAcquisition.receipt = receipt;
    await expect(
      storeDocumentaryObservation(request, modified),
    ).rejects.toThrow();
  }
  const other = fixture();
  await expect(
    storeDocumentaryObservation(request, acceptedResult(other)),
  ).rejects.toThrow();
  const archiveChanged = mutableClone(result);
  if (archiveChanged.documentaryAcquisition.state !== "accepted")
    throw new Error("Fixture state");
  (
    archiveChanged.documentaryAcquisition.archive as unknown as {
      archiveHash: string;
    }
  ).archiveHash = "0".repeat(64);
  await expect(
    storeDocumentaryObservation(request, archiveChanged),
  ).rejects.toThrow();
  const forgedPublication = refusedResult(f);
  (forgedPublication as { publication: unknown }).publication = f.publication;
  await expect(
    storeDocumentaryObservation(request, forgedPublication),
  ).rejects.toThrow();
  assert.equal(
    (await db.select().from(schema.publicationDocumentarySnapshots)).length,
    0,
  );
});

test("A request can append historical evidence after the live revision changes without adopting it or changing an existing pointer", async () => {
  const f = fixture();
  await insertPublication(f);
  const initialRequest = await beginDocumentaryRequest(f.identity);
  const initial = await storeDocumentaryObservation(
    initialRequest,
    acceptedResult(f),
  );
  // Explicit SQL fixture for an existing pointer; the tested writer never adopts.
  await db
    .update(schema.publications)
    .set({ documentarySnapshotId: initial.id })
    .where(eq(schema.publications.id, f.publication.id));
  const request = await beginDocumentaryRequest(f.identity);
  assert.deepEqual(request.observedPublication, {
    revision: f.publication.revision,
    documentarySnapshotId: initial.id,
  });
  await db
    .update(schema.publications)
    .set({
      revision: `simap-v2:${"e".repeat(64)}`,
      data: { ...f.publication, title: "Rettifica intervenuta" },
    })
    .where(eq(schema.publications.id, f.publication.id));
  const current = await publicationRow(f);
  const saved = await storeDocumentaryObservation(request, acceptedResult(f));
  assert.equal(saved.adopted, false);
  assert.notEqual(saved.id, initial.id);
  assert.deepEqual(await publicationRow(f), current);
  const stored = await readDocumentarySnapshot(saved.id, f.publication.id);
  assert.equal(stored?.acquisition.sourceRevision, f.publication.revision);
  assert.equal(
    stored?.request.observedPublication?.documentarySnapshotId,
    initial.id,
  );
});

test("Mutation of the caller archive after validation cannot change the snapshot awaiting its transaction", async () => {
  const f = fixture();
  await insertPublication(f);
  const request = await beginDocumentaryRequest(f.identity);
  const callerResult = mutableClone(acceptedResult(f));
  if (callerResult.documentaryAcquisition.state !== "accepted")
    throw new Error("Fixture state");
  const callerArchive = callerResult.documentaryAcquisition.archive;
  const initialAcquisition = structuredClone(
    callerResult.documentaryAcquisition,
  );
  const transaction = db.transaction.bind(db);
  const spy = vi.spyOn(db, "transaction").mockImplementationOnce((async (
    callback,
    config,
  ) => {
    // storeDocumentaryObservation has already validated its input when it
    // enters transaction. Mutate the original before the callback reaches SQL.
    (
      callerArchive.lotField.lots as { orderDescription: { it: string } }[]
    )[0].orderDescription.it = "CALLER_MUTATION_AFTER_VALIDATION";
    await Promise.resolve();
    return transaction(callback, config);
  }) as typeof db.transaction);
  let saved: Awaited<ReturnType<typeof storeDocumentaryObservation>>;
  try {
    saved = await storeDocumentaryObservation(request, callerResult);
    assert.equal(spy.mock.calls.length, 1);
  } finally {
    spy.mockRestore();
  }
  assert.equal(
    (callerArchive.lotField.lots as { orderDescription: { it: string } }[])[0]
      .orderDescription.it,
    "CALLER_MUTATION_AFTER_VALIDATION",
  );
  const stored = await readDocumentarySnapshot(saved.id, f.publication.id);
  assert.ok(stored);
  assert.deepEqual(stored.acquisition, initialAcquisition);
  if (stored.acquisition.state !== "accepted") throw new Error("Stored state");
  assert.deepEqual(restoreSimapDetail(stored.acquisition.archive), f.raw);
  assert.equal((await publicationRow(f)).documentarySnapshotId, null);
});

test("Snapshot SQL is append-only for the owner, and publication deletion cannot cascade into its history", async () => {
  const f = fixture();
  await insertPublication(f);
  const request = await beginDocumentaryRequest(f.identity);
  const saved = await storeDocumentaryObservation(request, acceptedResult(f));
  const original = await snapshotRow(saved.id);
  for (const sql of [
    "UPDATE publication_documentary_snapshots SET state=state",
    "DELETE FROM publication_documentary_snapshots",
  ])
    await expect(pg.exec(sql)).rejects.toThrow(/append-only/i);
  await expect(
    pg.exec("TRUNCATE publication_documentary_snapshots"),
  ).rejects.toThrow();
  // CASCADE bypasses the earlier FK refusal, so exercise the actual history
  // trigger too. This statement must fail atomically in the isolated database.
  await expect(
    pg.exec("TRUNCATE publication_documentary_snapshots CASCADE"),
  ).rejects.toThrow(/Documentary snapshot history is append-only/i);
  await expect(
    db
      .delete(schema.publications)
      .where(eq(schema.publications.id, f.publication.id)),
  ).rejects.toThrow();
  assert.deepEqual(await snapshotRow(saved.id), original);
  assert.ok(await publicationRow(f));
});

test("RLS and revoked grants protect snapshots even from the BYPASSRLS client role", async () => {
  const protection = await pg.query<{ protected: boolean; policies: number }>(
    "SELECT relrowsecurity protected, (SELECT count(*)::int FROM pg_policies WHERE tablename='publication_documentary_snapshots') policies FROM pg_class WHERE oid='public.publication_documentary_snapshots'::regclass",
  );
  assert.deepEqual(protection.rows[0], { protected: true, policies: 0 });
  for (const role of ["anon", "authenticated", "service_role"]) {
    const permissions = await pg.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('${role}', 'public.publication_documentary_snapshots', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_function_privilege('${role}', 'public.reject_documentary_snapshot_mutation()', 'EXECUTE') AS allowed`,
    );
    assert.equal(permissions.rows[0].allowed, false);
    await pg.exec(`SET ROLE ${role}`);
    try {
      await expect(
        pg.query("SELECT * FROM public.publication_documentary_snapshots"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        pg.query("TRUNCATE public.publication_documentary_snapshots"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await pg.exec("RESET ROLE");
    }
  }
});

test("Composite FK and private reads cannot cross publication boundaries or attach an unknown refusal", async () => {
  const a = fixture(),
    b = fixture(),
    unknown = fixture();
  await insertPublication(a);
  await insertPublication(b);
  const requestA = await beginDocumentaryRequest(a.identity),
    requestB = await beginDocumentaryRequest(b.identity);
  const savedA = await storeDocumentaryObservation(requestA, acceptedResult(a));
  const savedB = await storeDocumentaryObservation(requestB, acceptedResult(b));
  const refused = await storeDocumentaryObservation(
    await beginDocumentaryRequest(unknown.identity),
    refusedResult(unknown),
  );
  await db
    .update(schema.publications)
    .set({ documentarySnapshotId: savedA.id })
    .where(eq(schema.publications.id, a.publication.id));
  await expect(
    db
      .update(schema.publications)
      .set({ documentarySnapshotId: savedB.id })
      .where(eq(schema.publications.id, a.publication.id)),
  ).rejects.toThrow();
  await expect(
    db
      .update(schema.publications)
      .set({ documentarySnapshotId: refused.id })
      .where(eq(schema.publications.id, a.publication.id)),
  ).rejects.toThrow();
  assert.equal((await publicationRow(a)).documentarySnapshotId, savedA.id);
  await expect(
    readDocumentarySnapshot(savedA.id, b.publication.id),
  ).rejects.toBeInstanceOf(DocumentaryObservationConflict);
  await expect(
    readDocumentarySnapshot(refused.id, a.publication.id),
  ).rejects.toBeInstanceOf(DocumentaryObservationConflict);
  assert.ok(await readDocumentarySnapshot(refused.id, null));
});

test("Database identity constraints reject an accepted snapshot without its publication and mismatched source identities", async () => {
  const f = fixture();
  await insertPublication(f);
  const first = await storeDocumentaryObservation(
    await beginDocumentaryRequest(f.identity),
    acceptedResult(f),
  );
  const original = await snapshotRow(first.id);
  const fresh = await beginDocumentaryRequest(f.identity);
  await expect(
    db.insert(schema.publicationDocumentarySnapshots).values({
      ...original,
      id: fresh.id,
      request: fresh,
      publicationId: null,
    }),
  ).rejects.toThrow();
  await expect(
    db.insert(schema.publicationDocumentarySnapshots).values({
      ...original,
      id: fresh.id,
      request: fresh,
      sourceProjectId: fixture().identity.projectId,
    }),
  ).rejects.toThrow();
  assert.equal(
    (await db.select().from(schema.publicationDocumentarySnapshots)).length,
    1,
  );
});

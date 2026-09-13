import { createHash, randomUUID } from "node:crypto";
import { PgBoss, fromPglite } from "pg-boss";
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
import { preserveSimapLots, type Identity } from "../src/lib/source-lots";
const injected = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
import { createDocumentaryPublication } from "../src/lib/documentary-create";
import {
  adoptDocumentaryObservation,
  DocumentaryAdoptionConflict,
  DocumentaryAdoptionDisabled,
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_ADOPTION_CONSUMERS,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  type DocumentaryAdoptionActivation,
  type DocumentaryReleaseAttestation,
} from "../src/lib/documentary-adoption";
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
import {
  appendLotSourceReview,
  loadLotSourceReview,
} from "../src/lib/lot-source-reviews";
import {
  appendLotMatchReview,
  loadLotMatchReview,
} from "../src/lib/lot-match-reviews";
import { matchAdoptedPublication } from "../src/worker/lot-matching";
import { readCurrentLotMatch } from "../src/lib/lot-readers";
import { saveCompanyFeedback } from "../src/lib/company";

let pg: PGlite, db: ReturnType<typeof drizzle<typeof schema>>, boss: PgBoss;
let sequence = 0;
const founder = { userId: "creation-founder", admin: true, demo: false };
function activation(): DocumentaryAdoptionActivation {
  return {
    enabled: true,
    attestation: {
      version: DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
      releaseId: "invented-creation-release",
      verifiedAt: "2026-09-13T10:00:00.000Z",
      evidenceId: "invented-creation-evidence",
      previousProcessesDrained: true,
      consumers: Object.fromEntries(
        DOCUMENTARY_ADOPTION_CONSUMERS.map((key) => [
          key,
          {
            capability: DOCUMENTARY_ADOPTION_CAPABILITY,
            buildId: "a".repeat(40),
          },
        ]),
      ) as DocumentaryReleaseAttestation["consumers"],
    },
  };
}
function fixture(date = "2030-10-10", projectNumber = "INVENTED-CREATION") {
  const suffix = String(++sequence).padStart(12, "0");
  const projectId = `51000000-0000-4000-8000-${suffix}`,
    publicationId = `52000000-0000-4000-8000-${suffix}`,
    lotId = `53000000-0000-4000-8000-${suffix}`;
  const identity: Identity = {
    projectId,
    publicationId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`,
  };
  const raw = {
    id: publicationId,
    type: "tender",
    "project-info": {
      title: {
        it: "Cura del parco comunale inventato",
        fr: "Entretien du parc fictif",
      },
    },
    procurement: {
      orderDescription: {
        it: "Contesto comune del progetto inventato.",
        de: "Erfundener gemeinsamer Kontext.",
      },
      orderAddress: { city: "Lugano", cantonId: "TI" },
    },
    dates: { offerDeadline: "2030-12-20T12:00:00+01:00" },
    base: {
      id: publicationId,
      projectId,
      lotsType: "with",
      lots: [{ id: lotId, lotNumber: 1 }],
    },
    lots: [
      {
        id: lotId,
        lotNumber: 1,
        title: { it: "Verde inventato" },
        orderDescription: {
          it: "🌳 Potatura <b>letterale</b> é / é.",
          fr: "Taille des arbres.",
        },
      },
    ],
  };
  const entry = {
    id: projectId,
    raw: {
      id: projectId,
      publicationId,
      publicationDate: date,
      projectNumber,
      pubType: "tender",
      processType: "open",
      title: { it: "Cura del parco comunale inventato" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
  return { identity, raw, entry, publication: normalizeSimap(entry, raw) };
}
type Fixture = ReturnType<typeof fixture>;
function accepted(f: Fixture): SimapAcquisitionResult {
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
        bodySha256: createHash("sha256").update(body).digest("hex"),
        bodyByteLength: body.byteLength,
      },
    },
  };
}
function refused(f: Fixture): SimapAcquisitionResult {
  return {
    publication: null,
    documentaryAcquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      identity: f.identity,
      state: "refused",
      sourceRevision: null,
      refusal: { stage: "parse", code: "invalid_json" },
      receipt: {
        url: f.identity.detailUrl,
        receivedAt: new Date().toISOString(),
        bodySha256: createHash("sha256").update("{").digest("hex"),
        bodyByteLength: 1,
      },
    },
  };
}
async function insert(f: Fixture, canonicalId = f.publication.canonicalKey!) {
  const p = f.publication;
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId,
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
async function row(id: string) {
  return (
    await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, id))
  )[0];
}
async function state() {
  return {
    publications: await db
      .select()
      .from(schema.publications)
      .orderBy(schema.publications.id),
    snapshots: await db
      .select()
      .from(schema.publicationDocumentarySnapshots)
      .orderBy(schema.publicationDocumentarySnapshots.id),
    versions: await db
      .select()
      .from(schema.publicationVersions)
      .orderBy(schema.publicationVersions.id),
    issues: await db.select().from(schema.issues).orderBy(schema.issues.id),
    matches: await db.select().from(schema.matches).orderBy(schema.matches.id),
    feedback: await db
      .select()
      .from(schema.feedback)
      .orderBy(schema.feedback.id),
    sourceHistory: await db
      .select()
      .from(schema.sourceReviewEvents)
      .orderBy(schema.sourceReviewEvents.id),
    matchHistory: await db
      .select()
      .from(schema.matchLotReviewEvents)
      .orderBy(schema.matchLotReviewEvents.id),
    companies: await db
      .select()
      .from(schema.companies)
      .orderBy(schema.companies.id),
    settings: await db
      .select()
      .from(schema.settings)
      .orderBy(schema.settings.key),
    notifications: await db
      .select()
      .from(schema.notifications)
      .orderBy(schema.notifications.id),
    jobs: (
      await pg.query(
        "SELECT id,data FROM pgboss.job WHERE name='lot-notice-reconcile' ORDER BY id",
      )
    ).rows,
  };
}
beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network in creation test");
    }),
  );
  pg = new PGlite();
  await pg.exec(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;",
  );
  db = drizzle(pg, { schema });
  injected.db = db;
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
}, 20000);
afterEach(async () => {
  await boss?.stop();
  await pg?.close();
  vi.unstubAllGlobals();
});

async function predecessorWithHumanHistory(f: Fixture) {
  await insert(f);
  await db.insert(schema.user).values([
    {
      id: founder.userId,
      name: "Fondatore inventato",
      email: "creation-founder@example.invalid",
    },
    {
      id: "creation-owner",
      name: "Titolare inventato",
      email: "creation-owner@example.invalid",
    },
  ]);
  await db.insert(schema.administrators).values({ userId: founder.userId });
  await db.insert(schema.companies).values({
    id: "creation-company",
    ownerId: "creation-owner",
    onboardedAt: new Date(),
    profile: {
      name: "Ditta inventata",
      activities: "Potatura e cura del verde",
      employees: 2,
      sectors: ["giardinaggio"],
      zones: ["Tutto il Ticino"],
      keywords: [],
      exclusions: [],
      minValue: null,
      maxValue: null,
      emailEnabled: true,
    },
  });
  await db.insert(schema.matches).values({
    id: "legacy-positive",
    companyId: "creation-company",
    publicationId: f.publication.id,
    revision: "legacy-reviewed",
    score: 93,
    eligible: true,
    approved: true,
    reviewedAt: new Date("2026-09-01T10:00:00Z"),
    reason: "Giudizio da conservare",
    reviewNotes: "Nota privata storica",
  });
  await adoptDocumentaryObservation(
    await beginDocumentaryRequest(f.identity),
    accepted(f),
    activation(),
  );
  const target = { kind: "project" as const, publicationId: f.publication.id },
    loaded = await loadLotSourceReview(target, founder);
  await appendLotSourceReview(
    {
      target,
      expectedObservationId: loaded.expected.observationId,
      expectedSnapshotHash: loaded.expected.snapshotHash,
      expectedSelectionHash: loaded.expected.selectionHash,
      expectedTargetEventId: loaded.expected.targetEventId,
      expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
      expectedShapeEpochToken: loaded.expected.shapeEpochToken,
      action: "recorded",
      form: "broad_scope",
      references: [
        {
          selectionHash: loaded.expected.selectionHash!,
          rawPath: "/procurement/orderDescription/it",
          startUtf16: 0,
          endUtf16: f.raw.procurement.orderDescription.it.length,
        },
      ],
      note: "Revisione inventata della fonte precedente.",
      resolveLegacyScope: false,
    },
    founder,
  );
  await saveCompanyFeedback("creation-company", f.publication.id, {
    saved: true,
    dismissed: true,
  });
  const match = await loadLotMatchReview(
    "creation-company",
    f.publication.id,
    founder,
  );
  await appendLotMatchReview(
    {
      companyId: "creation-company",
      publicationId: f.publication.id,
      action: "veto_project",
      expectedSnapshotHash: match.expected.snapshotHash,
      expectedProfileHash: match.expected.profileHash,
      expectedStateToken: match.expected.stateToken,
      expectedGroupToken: match.expected.groupToken,
      expectedShapeEpochToken: match.expected.shapeEpochToken,
      expectedProjectBindingHash: match.expected.projectBindingHash,
      note: "Veto inventato del progetto precedente.",
    },
    founder,
  );
  await db.insert(schema.notifications).values({
    id: "old-pending",
    companyId: "creation-company",
    dedupeKey: "old-pending",
    kind: "digest",
    status: "pending",
    subject: "Storico",
    html: "<p>Storico</p>",
    textBody: "Storico",
    items: [{ id: f.publication.id, revision: "legacy-reviewed" }],
  });
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: false });
}

test("first creation is default off and only accepts an absent observation with a complete accepted result", async () => {
  const f = fixture(),
    request = await beginDocumentaryRequest(f.identity),
    before = await state();
  await expect(
    createDocumentaryPublication(request, accepted(f)),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionDisabled);
  await expect(
    createDocumentaryPublication(request, refused(f), activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  const bad = accepted(f);
  bad.publication!.title = "bad\u0000text";
  await expect(
    createDocumentaryPublication(request, bad, activation()),
  ).rejects.toThrow();
  expect(await state()).toEqual(before);
  f.publication = normalizeSimap(f.entry, f.raw);
  await insert(f);
  const observed = await beginDocumentaryRequest(f.identity),
    inserted = await state();
  await expect(
    createDocumentaryPublication(observed, accepted(f), activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await state()).toEqual(inserted);
});

test("first accepted atomically stores publication/snapshot/version/pointer/job and exact replay is a no-op even after editorial enrichment", async () => {
  const f = fixture(),
    request = await beginDocumentaryRequest(f.identity),
    result = accepted(f),
    original = structuredClone(result);
  const pending = createDocumentaryPublication(request, result, activation());
  result.publication!.title = "Mutazione dopo await";
  result.publication!.originalTitles![0].text = "Testo mutato";
  const created = await pending,
    saved = await row(f.publication.id),
    after = await state();
  expect(created).toMatchObject({
    publicationId: f.publication.id,
    observationId: request.id,
    state: "accepted",
    changed: true,
    adopted: true,
  });
  expect(saved).toMatchObject({
    canonicalId: original.publication!.canonicalKey,
    documentarySnapshotId: request.id,
    aiRevision: null,
    revision: original.publication!.revision,
    data: original.publication,
  });
  expect(after.snapshots).toHaveLength(1);
  expect(after.snapshots[0].acquisition).toEqual(
    original.documentaryAcquisition,
  );
  expect(after.versions).toHaveLength(1);
  expect(after.versions[0].data).toEqual(saved.data);
  expect(after.jobs).toEqual([
    {
      id: created.jobId,
      data: {
        publicationId: f.publication.id,
        canonicalId: original.publication!.canonicalKey,
        eventId: `documentary-adoption:${request.id}`,
      },
    },
  ]);
  expect(after.matches).toEqual([]);
  expect(after.notifications).toEqual([]);
  await db
    .update(schema.publications)
    .set({
      data: {
        ...saved.data,
        summary: "Sintesi editoriale successiva",
        revision: "editorial-after-create",
      },
    })
    .where(eq(schema.publications.id, f.publication.id));
  const editorial = await state();
  expect(
    await createDocumentaryPublication(request, original, activation()),
  ).toMatchObject({ changed: false, jobId: null });
  expect(await state()).toEqual(editorial);
});

test("new group member preserves veto, saved/dismissed, source and match audit; closes only superseded source and carries required scope", async () => {
  const old = fixture("2030-10-01"),
    next = fixture("2030-10-10");
  await predecessorWithHumanHistory(old);
  const current = (await row(old.publication.id)).data;
  const scope = {
    status: "required" as const,
    kind: "conflicting" as const,
    token: "previous-required",
    sourceRevision: current.revision,
    updatedAt: "2026-09-13T10:00:00.000Z",
  };
  await db
    .update(schema.publications)
    .set({
      data: {
        ...current,
        summary: "Sintesi da preservare",
        documentPages: [
          {
            page: 4,
            text: "Testo originale conservato",
            url: current.sourceUrl,
          },
        ],
        sourceScopeReview: scope,
      },
    })
    .where(eq(schema.publications.id, old.publication.id));
  const before = await state();
  await createDocumentaryPublication(
    await beginDocumentaryRequest(next.identity),
    accepted(next),
    activation(),
  );
  const after = await state(),
    previousRow = await row(old.publication.id),
    newRow = await row(next.publication.id);
  expect(newRow.data.sourceScopeReview).toEqual(scope);
  expect(newRow.data.summary).toBeNull();
  expect(newRow.data).not.toHaveProperty("documentPages");
  expect(previousRow.status).toBe("closed");
  expect(previousRow.data).toEqual({
    ...before.publications[0].data,
    status: "closed",
    sourceUrls: [old.publication.sourceUrl, next.publication.sourceUrl],
  });
  expect(previousRow.documentarySnapshotId).toBe(
    before.publications[0].documentarySnapshotId,
  );
  for (const key of [
    "matches",
    "feedback",
    "sourceHistory",
    "matchHistory",
    "companies",
    "settings",
    "notifications",
  ] as const)
    expect(after[key]).toEqual(before[key]);
  expect(after.matches).toHaveLength(1);
  await matchAdoptedPublication({ publicationId: next.publication.id });
  const projected = await readCurrentLotMatch(
    "creation-company",
    next.publication.id,
  );
  expect(projected?.project).toMatchObject({
    signalEligible: false,
    suppressed: true,
    saved: true,
    dismissed: true,
  });
  const matches = (await state()).matches;
  expect(
    matches.find((match) => match.publicationId === old.publication.id),
  ).toEqual(before.matches[0]);
  expect(
    matches.find((match) => match.publicationId === next.publication.id),
  ).toMatchObject({
    score: 0,
    approved: null,
    reviewedAt: null,
    lotEvaluations: null,
  });
});

test.each(["same", "different"] as const)(
  "a row inserted after request capture in %s group is rejected without rebase or writes",
  async (group) => {
    const f = fixture(),
      request = await beginDocumentaryRequest(f.identity),
      result = accepted(f);
    await insert(
      f,
      group === "same"
        ? f.publication.canonicalKey!
        : "different-canonical-group",
    );
    const before = await state();
    await expect(
      createDocumentaryPublication(request, result, activation()),
    ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
    expect(await state()).toEqual(before);
  },
);

test("two initially absent requests cannot overwrite each other, and old first-create replay cannot undo pointer advancement", async () => {
  const f = fixture(),
    a = await beginDocumentaryRequest(f.identity),
    b = await beginDocumentaryRequest(f.identity),
    result = accepted(f);
  await createDocumentaryPublication(a, result, activation());
  const created = await state();
  await expect(
    createDocumentaryPublication(b, result, activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await state()).toEqual(created);
  await adoptDocumentaryObservation(
    await beginDocumentaryRequest(f.identity),
    refused(f),
    activation(),
  );
  const advanced = await state();
  await expect(
    createDocumentaryPublication(a, result, activation()),
  ).rejects.toBeInstanceOf(DocumentaryAdoptionConflict);
  expect(await state()).toEqual(advanced);
});

test("a refused snapshot already bound to the request cannot be replaced by accepted or create a fake row", async () => {
  const f = fixture(),
    request = await beginDocumentaryRequest(f.identity);
  await storeDocumentaryObservation(request, refused(f));
  const before = await state();
  await expect(
    createDocumentaryPublication(request, accepted(f), activation()),
  ).rejects.toThrow();
  expect(await state()).toEqual(before);
  expect(before.snapshots[0].publicationId).toBeNull();
});

test.each(["snapshot", "version", "issue", "pointer", "job"] as const)(
  "SQL %s failure rolls back new publication, versions, receipt, issues and cousin changes",
  async (stage) => {
    const old = fixture("2030-10-01"),
      next = fixture("2030-10-10");
    await insert(old);
    const other = fixture("2030-10-02");
    other.publication.source = "foglio-ti";
    other.publication.status = "cancelled";
    other.publication.sourceUrl = "https://example.invalid/other-official";
    await insert(other);
    const request = await beginDocumentaryRequest(next.identity),
      result = accepted(next),
      before = await state();
    const table = {
      snapshot: "publication_documentary_snapshots",
      version: "publication_versions",
      issue: "issues",
      pointer: "publications",
      job: "pgboss.job",
    }[stage];
    const condition =
      stage === "snapshot"
        ? `source_project_id <> '${next.identity.projectId}'`
        : stage === "pointer"
          ? `id <> '${next.publication.id}' OR documentary_snapshot_id IS NULL`
          : stage === "job"
            ? "name <> 'lot-notice-reconcile'"
            : `publication_id <> '${next.publication.id}'`;
    await pg.exec(
      `ALTER TABLE ${table} ADD CONSTRAINT fail_creation_stage CHECK (${condition}) NOT VALID`,
    );
    let failure: unknown;
    try {
      await createDocumentaryPublication(request, result, activation());
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
    expect(errors.join(" ")).toContain("fail_creation_stage");
    expect(await state()).toEqual(before);
    await pg.exec(`ALTER TABLE ${table} DROP CONSTRAINT fail_creation_stage`);
    await createDocumentaryPublication(request, result, activation());
    const after = await state();
    expect((await row(next.publication.id)).documentarySnapshotId).toBe(
      request.id,
    );
    expect((await row(old.publication.id)).status).toBe("closed");
    expect(after.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `conflict:${next.publication.canonicalKey}`,
          severity: "critical",
        }),
      ]),
    );
    expect(after.jobs).toHaveLength(1);
  },
);

test("historical closed cousins do not create critical conflicts; possible duplicate outside the canonical group remains a warning without merge", async () => {
  const f = fixture();
  const old = fixture("2030-10-01"),
    current = fixture("2030-10-02"),
    ambiguous = fixture("2030-10-10", "OTHER-GROUP");
  old.publication.source = "foglio-ti";
  old.publication.status = "closed";
  old.publication.deadline = "2020-01-01T10:00:00.000Z";
  current.publication.source = "foglio-ti";
  ambiguous.publication.source = "foglio-ti";
  delete ambiguous.publication.canonicalKey;
  await insert(old);
  await insert(current);
  await insert(ambiguous, "unmerged-other-group");
  const outside = await row(ambiguous.publication.id);
  await createDocumentaryPublication(
    await beginDocumentaryRequest(f.identity),
    accepted(f),
    activation(),
  );
  const after = await state();
  expect(after.issues.some((issue) => issue.severity === "critical")).toBe(
    false,
  );
  expect(after.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: `duplicate:${f.publication.id}`,
        severity: "warning",
      }),
    ]),
  );
  expect((await row(f.publication.id)).canonicalId).toBe(
    f.publication.canonicalKey,
  );
  expect(await row(ambiguous.publication.id)).toEqual(outside);
});

test("an earlier source edition is created closed without closing a newer same-source member or inheriting its resolved review", async () => {
  const later = fixture("2030-10-12"),
    earlier = fixture("2030-10-10");
  later.publication.sourceScopeReview = {
    status: "resolved",
    kind: "ambiguous",
    token: "resolved-for-other-notice",
    sourceRevision: later.publication.revision,
    updatedAt: "2026-09-13T10:00:00.000Z",
  };
  await insert(later);
  await createDocumentaryPublication(
    await beginDocumentaryRequest(earlier.identity),
    accepted(earlier),
    activation(),
  );
  expect((await row(earlier.publication.id)).status).toBe("closed");
  expect((await row(earlier.publication.id)).data).not.toHaveProperty(
    "sourceScopeReview",
  );
  expect((await row(later.publication.id)).status).toBe("open");
  expect((await row(later.publication.id)).data.sourceScopeReview).toEqual(
    later.publication.sourceScopeReview,
  );
});

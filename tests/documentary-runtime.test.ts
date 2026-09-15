import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema";
import { normalizeSimap, legacySimapRevision } from "../src/sources/simap";
import type { SourceAdapter, SourceEntry } from "../src/sources/common";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
import {
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_ADOPTION_CONSUMERS,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  type DocumentaryAdoptionActivation,
} from "../src/lib/documentary-adoption";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";

const injected = vi.hoisted(() => ({
  db: undefined as unknown,
  summarize: vi.fn(),
  classify: vi.fn(),
  notices: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
vi.mock("@/worker/ai", () => ({
  AiUnavailable: class extends Error {},
  summarize: injected.summarize,
  classify: injected.classify,
}));
vi.mock("@/worker/notifications", () => ({
  queueChangeNotices: injected.notices,
}));
import { ingest, enrichAndMatch } from "../src/worker/pipeline";
import { collectAndAdoptSimapDocumentary } from "../src/worker/documentary-ingestion";

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "11111111-0000-4000-8000-000000000011";
const publicationId = "22222222-0000-4000-8000-000000000012";
const lotId = "33333333-0000-4000-8000-000000000013";
const since = new Date("2030-09-01T00:00:00.000Z");
const activation: DocumentaryAdoptionActivation = {
  enabled: true,
  attestation: {
    version: DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
    releaseId: "invented-runtime-test",
    verifiedAt: "2026-09-01T00:00:00.000Z",
    evidenceId: "invented-test-not-a-production-release",
    previousProcessesDrained: true,
    consumers: Object.fromEntries(
      DOCUMENTARY_ADOPTION_CONSUMERS.map((name) => [
        name,
        {
          capability: DOCUMENTARY_ADOPTION_CAPABILITY,
          buildId: "a".repeat(40),
        },
      ]),
    ) as NonNullable<DocumentaryAdoptionActivation["attestation"]>["consumers"],
  },
};
const options = { documentaryActivation: activation };
function entry(): SourceEntry {
  return {
    id: projectId,
    raw: {
      id: projectId,
      publicationId,
      publicationDate: "2030-09-10",
      projectNumber: "INVENTED-RUNTIME",
      pubType: "tender",
      processType: "open",
      title: { it: "Parco inventato" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
}
function detail(text = "Potatura degli alberi.") {
  return {
    id: publicationId,
    type: "tender",
    "project-info": { title: { it: "Parco inventato" } },
    procurement: {
      orderDescription: { it: "Servizi nel parco inventato." },
      orderAddress: { city: "Lugano", cantonId: "TI" },
    },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    base: { id: publicationId, projectId, lotsType: "with" },
    lots: [
      {
        id: lotId,
        lotNumber: 1,
        title: { it: "Cura del verde" },
        orderDescription: { it: text },
      },
    ],
  };
}
function header() {
  return {
    id: projectId,
    projectNumber: "INVENTED-RUNTIME",
    processType: "open",
    latestPublication: {
      id: publicationId,
      dates: { publicationDate: "2030-09-10" },
      pubType: "tender",
      title: { it: "Parco inventato" },
    },
  };
}
function adapter(): SourceAdapter {
  return {
    id: "simap",
    list: vi.fn(async () => [entry()]),
    detail: vi.fn(async (e) => normalizeSimap(e, detail())),
  };
}
const current = async () => (await db.select().from(schema.publications))[0];
const fetchDetail = (text?: string) => {
  const fn = vi.fn(async () => new Response(JSON.stringify(detail(text))));
  vi.stubGlobal("fetch", fn);
  return fn;
};
beforeEach(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  injected.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  const boss = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    schema: "pgboss",
    schedule: false,
    supervise: false,
  });
  await boss.start();
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.stop();
  vi.clearAllMocks();
  injected.summarize.mockRejectedValue(new Error("Unexpected AI"));
  injected.classify.mockRejectedValue(new Error("Unexpected AI"));
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
}, 20000);
afterEach(async () => {
  expect(injected.summarize).not.toHaveBeenCalled();
  expect(injected.classify).not.toHaveBeenCalled();
  expect(injected.notices).not.toHaveBeenCalled();
  expect(await db.select().from(schema.notifications)).toHaveLength(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await pg.close();
});

test("invalid activation and conflicting shadow mode stop before HTTP or source-run writes", async () => {
  const source = adapter(),
    http = fetchDetail();
  await expect(
    ingest(source, since, undefined, {
      documentaryActivation: { enabled: true },
    }),
  ).rejects.toThrow();
  await expect(
    ingest(source, since, undefined, { ...options, documentaryMode: "shadow" }),
  ).rejects.toThrow("modalità distinte");
  await expect(
    collectAndAdoptSimapDocumentary(entry(), { enabled: false }),
  ).rejects.toThrow();
  expect(source.list).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(await db.select().from(schema.sourceRuns)).toHaveLength(0);
  expect(await db.select().from(schema.publications)).toHaveLength(0);
});

test("first accepted collection commits source, immutable detail, pointer and job using one detail GET", async () => {
  const source = adapter(),
    http = fetchDetail();
  expect(await ingest(source, since, undefined, options)).toBe(1);
  expect(source.detail).not.toHaveBeenCalled();
  expect(http).toHaveBeenCalledTimes(1);
  const row = await current(),
    snapshots = await db.select().from(schema.publicationDocumentarySnapshots);
  expect(snapshots).toHaveLength(1);
  expect(row.documentarySnapshotId).toBe(snapshots[0].id);
  expect(snapshots[0].request.observedPublication).toBeNull();
  expect(snapshots[0].acquisition).toMatchObject({
    state: "accepted",
    sourceRevision: row.revision,
  });
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(1);
  expect((await pg.query("select * from pgboss.job")).rows).toHaveLength(1);
  expect(row.data.summary).toBeNull();
});

test("unchanged accepted content retains its archive and pointer without duplicating jobs or imported publications", async () => {
  const source = adapter();
  fetchDetail();
  expect(await ingest(source, since, undefined, options)).toBe(1);
  const first = await current();
  expect(await ingest(source, since, undefined, options)).toBe(0);
  const second = await current();
  expect(second).toEqual(first);
  expect(
    await db.select().from(schema.publicationDocumentarySnapshots),
  ).toHaveLength(1);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(1);
  expect((await pg.query("select * from pgboss.job")).rows).toHaveLength(1);
  fetchDetail("Nuova descrizione delle potature.");
  expect(await ingest(source, since, undefined, options)).toBe(1);
  expect((await current()).revision).not.toBe(first.revision);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(2);
});

test("existing legacy data is adopted without invoking legacy storage or discarding an editorial summary", async () => {
  const source = adapter();
  await ingest(source, since);
  const row = await current();
  await db
    .update(schema.publications)
    .set({ data: { ...row.data, summary: "Sintesi editoriale storica" } })
    .where(eq(schema.publications.id, row.id));
  const before = await current();
  vi.mocked(source.detail).mockClear();
  fetchDetail();
  expect(await ingest(source, since, undefined, options)).toBe(0);
  const after = await current();
  expect(after.documentarySnapshotId).not.toBeNull();
  expect({ ...after, documentarySnapshotId: null }).toEqual(before);
  expect(source.detail).not.toHaveBeenCalled();
});

test("an exactly equivalent old hash migrates atomically without being counted as new source content or losing editorial corrections", async () => {
  const normalized = normalizeSimap(entry(), detail());
  const oldHash = legacySimapRevision(normalized)!;
  expect(oldHash).toMatch(/^[a-f0-9]{64}$/);
  const historical = { ...normalized, revision: oldHash };
  const editorial = {
    ...historical,
    title: "Titolo già corretto",
    summary: "Sintesi già controllata",
  };
  await db.insert(schema.publications).values({
    id: normalized.id,
    canonicalId: normalized.canonicalKey!,
    source: "simap",
    externalId: projectId,
    projectId,
    title: editorial.title,
    status: editorial.status,
    visibleAt: new Date(editorial.visibleAt),
    deadline: editorial.deadline ? new Date(editorial.deadline) : null,
    data: editorial,
    revision: oldHash,
    aiRevision: oldHash,
  });
  await db.insert(schema.publicationVersions).values({
    id: randomUUID(),
    publicationId: normalized.id,
    revision: oldHash,
    data: historical,
  });
  const before = await current();
  const source = adapter(),
    http = fetchDetail();
  expect(await ingest(source, since, undefined, options)).toBe(0);
  const after = await current();
  expect(after.revision).toBe(normalized.revision);
  expect(after.data).toEqual(before.data);
  expect({
    ...after,
    revision: before.revision,
    documentarySnapshotId: null,
  }).toEqual(before);
  expect(source.detail).not.toHaveBeenCalled();
  expect(http).toHaveBeenCalledTimes(1);
  expect(await ingest(source, since, undefined, options)).toBe(0);
  expect(await current()).toEqual(after);
  expect(
    await db.select().from(schema.publicationDocumentarySnapshots),
  ).toHaveLength(1);
  expect((await pg.query("select * from pgboss.job")).rows).toHaveLength(1);
});

test("refused unknown input remains an observation and source issue, never a fabricated publication", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{broken")),
  );
  await expect(ingest(adapter(), since, undefined, options)).rejects.toThrow(
    "Importazione parziale",
  );
  expect(await db.select().from(schema.publications)).toHaveLength(0);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(0);
  expect(
    (await db.select().from(schema.publicationDocumentarySnapshots))[0],
  ).toMatchObject({ publicationId: null, state: "refused" });
  expect((await pg.query("select * from pgboss.job")).rows).toHaveLength(0);
  expect(await db.select().from(schema.issues)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: `source-item:simap:${projectId}`,
        severity: "critical",
        resolvedAt: null,
      }),
    ]),
  );
});

test("existing refused input installs a barrier and ordinary refresh recovers it even when business status is closed", async () => {
  fetchDetail();
  await ingest(adapter(), since, undefined, options);
  const first = await current();
  await db
    .update(schema.publications)
    .set({ status: "closed", data: { ...first.data, status: "closed" } })
    .where(eq(schema.publications.id, first.id));
  const before = await current();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{broken")),
  );
  await expect(ingest(adapter(), since, undefined, options)).rejects.toThrow(
    "Importazione parziale",
  );
  const refused = await current();
  expect({
    ...refused,
    documentarySnapshotId: before.documentarySnapshotId,
  }).toEqual(before);
  const source = {
    ...adapter(),
    list: vi.fn(async () => []),
    refresh: vi.fn(async () => {
      throw new Error("legacy refresh forbidden");
    }),
  };
  const http = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(header())))
    .mockResolvedValueOnce(new Response(JSON.stringify(detail())));
  vi.stubGlobal("fetch", http);
  expect(await ingest(source, since, undefined, options)).toBe(0);
  expect(http).toHaveBeenCalledTimes(2);
  expect(source.refresh).not.toHaveBeenCalled();
  expect(http.mock.calls[0][0]).toContain("project-header");
  expect(http.mock.calls[1][0]).toContain(
    `/publication-details/${publicationId}`,
  );
  expect((await current()).documentarySnapshotId).not.toBe(
    refused.documentarySnapshotId,
  );
});

test("entries already returned in the list do not also perform a tracked-project refresh", async () => {
  fetchDetail();
  await ingest(adapter(), since, undefined, options);
  const source = {
    ...adapter(),
    refresh: vi.fn(async () => {
      throw new Error("duplicate refresh");
    }),
  };
  const http = fetchDetail();
  expect(await ingest(source, since, undefined, options)).toBe(0);
  expect(http).toHaveBeenCalledTimes(1);
  expect(source.refresh).not.toHaveBeenCalled();
});

test.each(["revision", "buyer"])(
  "a %s change during header acquisition cannot be silently rebased before the detail",
  async (field) => {
    await ingest(adapter(), since);
    const source = {
      ...adapter(),
      list: vi.fn(async () => []),
      refresh: vi.fn(async () => {
        throw new Error("legacy refresh forbidden");
      }),
    };
    const row = await current();
    const http = vi.fn(async () => {
      await db
        .update(schema.publications)
        .set(
          field === "revision"
            ? { revision: "new-concurrent-source" }
            : { data: { ...row.data, buyer: "Ente corretto nel frattempo" } },
        )
        .where(eq(schema.publications.id, row.id));
      return new Response(JSON.stringify(header()));
    });
    vi.stubGlobal("fetch", http);
    await expect(ingest(source, since, undefined, options)).rejects.toThrow(
      "Importazione parziale",
    );
    expect(http).toHaveBeenCalledTimes(1);
    expect(
      await db.select().from(schema.publicationDocumentarySnapshots),
    ).toHaveLength(0);
    expect((await current()).documentarySnapshotId).toBeNull();
  },
);

test("a source revision changed during the detail rejects the old request without a second GET or recaptured CAS", async () => {
  await ingest(adapter(), since);
  const row = await current();
  const http = vi.fn(async () => {
    await db
      .update(schema.publications)
      .set({ revision: "concurrent-source-revision" })
      .where(eq(schema.publications.id, row.id));
    return new Response(
      JSON.stringify(detail("Testo di una risposta ormai superata.")),
    );
  });
  vi.stubGlobal("fetch", http);
  await expect(ingest(adapter(), since, undefined, options)).rejects.toThrow(
    "Importazione parziale",
  );
  expect(http).toHaveBeenCalledTimes(1);
  expect((await current()).revision).toBe("concurrent-source-revision");
  expect(
    await db.select().from(schema.publicationDocumentarySnapshots),
  ).toHaveLength(0);
});

test.each(["existing", "missing"])(
  "a stale list result cannot rebase on a %s publication created or updated during the list request",
  async (initial) => {
    if (initial === "existing") {
      fetchDetail();
      await ingest(adapter(), since, undefined, options);
    }
    const nextId = "22222222-0000-4000-8000-000000000099";
    const nextEntry = {
      ...entry(),
      raw: {
        ...(entry().raw as Record<string, unknown>),
        publicationId: nextId,
      },
    };
    const nextDetail = detail(
      "Descrizione della nuova pubblicazione concorrente.",
    );
    nextDetail.id = nextId;
    nextDetail.base.id = nextId;
    const http = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(JSON.stringify(nextDetail)),
    );
    vi.stubGlobal("fetch", http);
    let committedPointer: string | null = null;
    const source = {
      ...adapter(),
      list: vi.fn(async () => {
        // A distinct ingestion completes while the outer list HTTP is in flight.
        await collectAndAdoptSimapDocumentary(nextEntry, activation);
        committedPointer = (await current()).documentarySnapshotId;
        return [entry()];
      }),
    };
    await expect(ingest(source, since, undefined, options)).rejects.toThrow(
      "Importazione parziale",
    );
    expect(http).toHaveBeenCalledTimes(1); // Only the concurrent, current detail.
    expect(http.mock.calls[0][0]).toContain(`/publication-details/${nextId}`);
    expect((await current()).documentarySnapshotId).toBe(committedPointer);
    const observations = await db
      .select()
      .from(schema.publicationDocumentarySnapshots);
    expect(observations).toHaveLength(initial === "existing" ? 2 : 1);
    expect(
      observations.find((row) => row.id === committedPointer)
        ?.sourcePublicationId,
    ).toBe(nextId);
  },
);

test("off mode reports an adopted source as suspended before invoking any detail or refresh", async () => {
  fetchDetail();
  await ingest(adapter(), since, undefined, options);
  const before = await current();
  const source = adapter(),
    http = fetchDetail();
  await expect(ingest(source, since)).rejects.toThrow("Importazione parziale");
  expect(source.detail).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  const tracked = {
    ...source,
    list: vi.fn(async () => []),
    refresh: vi.fn(async () => {
      throw new Error("must not run");
    }),
  };
  await expect(ingest(tracked, since)).rejects.toThrow("Importazione parziale");
  expect(tracked.refresh).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(await current()).toEqual(before);
});

test("configured matching waits before adoption and produces a review-only match after the atomic collection", async () => {
  const id = randomUUID();
  await db
    .insert(schema.user)
    .values({ id, name: "Titolare inventato", email: `${id}@example.invalid` });
  await db.insert(schema.companies).values({
    id,
    ownerId: id,
    onboardedAt: new Date(),
    profile: {
      name: "Ditta inventata",
      sectors: ["giardinaggio"],
      activities: "Potatura degli alberi",
      zones: ["Luganese"],
      employees: 3,
      keywords: ["potatura"],
      exclusions: [],
      minValue: null,
      maxValue: null,
      emailEnabled: true,
    },
  });
  await db.insert(schema.invitations).values({
    id: `${id}-invitation`,
    email: `${id}@example.invalid`,
    companyId: id,
    expiresAt: new Date("2099-01-01"),
    acceptedAt: new Date(),
    acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
  });
  await ingest(adapter(), since);
  await enrichAndMatch({ documentaryActivation: activation, now: since });
  expect(await db.select().from(schema.matches)).toHaveLength(0);
  fetchDetail();
  await ingest(adapter(), since, undefined, options);
  await enrichAndMatch({ documentaryActivation: activation, now: since });
  const matched = await db.select().from(schema.matches);
  expect(matched).toHaveLength(1);
  expect(matched[0]).toMatchObject({ score: 0, approved: null });
});
